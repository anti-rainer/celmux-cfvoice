import { PCM16_20MS_BYTES } from "./protocol";

export function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  if (!right.byteLength) return left as Uint8Array<ArrayBuffer>;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

export type PcmLevel = { rms: number; span: number };

export function pcmLevel(pcm: Uint8Array, offset: number, length: number): PcmLevel {
  const samples = Math.floor(length / 2);
  if (!samples) return { rms: 0, span: 0 };
  const view = new DataView(pcm.buffer, pcm.byteOffset + offset, samples * 2);
  let sum = 0;
  let minimum = 32_767;
  let maximum = -32_768;
  for (let index = 0; index < samples; index += 1) {
    const sample = view.getInt16(index * 2, true);
    sum += sample;
    minimum = Math.min(minimum, sample);
    maximum = Math.max(maximum, sample);
  }
  const mean = sum / samples;
  let squares = 0;
  for (let index = 0; index < samples; index += 1) {
    const centered = view.getInt16(index * 2, true) - mean;
    squares += centered * centered;
  }
  return { rms: Math.sqrt(squares / samples), span: maximum - minimum };
}

export function hasLikelySpeechFrame(pcm: Uint8Array): boolean {
  for (let offset = 0; offset + PCM16_20MS_BYTES <= pcm.byteLength; offset += PCM16_20MS_BYTES) {
    const level = pcmLevel(pcm, offset, PCM16_20MS_BYTES);
    if (level.rms >= 160 && level.span >= 800) return true;
  }
  return false;
}

/** Conservative pre-inference VAD for independent Whisper chunks. Four
 * voiced 20 ms frames are enough to retain short words, while isolated PCM
 * clicks and idle microphone noise never reach the generative decoder. */
export function containsLikelySpeech(pcm: Uint8Array): boolean {
  const levels: PcmLevel[] = [];
  for (let offset = 0; offset + PCM16_20MS_BYTES <= pcm.byteLength; offset += PCM16_20MS_BYTES) {
    levels.push(pcmLevel(pcm, offset, PCM16_20MS_BYTES));
  }
  if (levels.length < 4) return false;
  const sortedRms = levels.map(level => level.rms).sort((left, right) => left - right);
  const noiseFloor = sortedRms[Math.floor(sortedRms.length * 0.2)] || 0;
  const threshold = Math.max(140, Math.min(600, noiseFloor * 2 + 60));
  let voicedFrames = 0;
  let maximumRms = 0;
  let maximumSpan = 0;
  for (const level of levels) {
    maximumRms = Math.max(maximumRms, level.rms);
    maximumSpan = Math.max(maximumSpan, level.span);
    if (level.rms >= threshold && level.span >= 800) voicedFrames += 1;
  }
  return voicedFrames >= 4 && maximumRms >= 220 && maximumSpan >= 1_000;
}

/** Apply a tiny (2 ms) linear fade-in to each synthesized utterance. Some TTS
 * providers begin a PCM response at a non-zero sample, which is heard as a
 * short click immediately before every translated phrase. */
export function softenPcmStart(frame: Uint8Array): void {
  const samples = Math.min(32, Math.floor(frame.byteLength / 2));
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let index = 0; index < samples; index += 1) {
    const gain = index / samples;
    view.setInt16(index * 2, Math.round(view.getInt16(index * 2, true) * gain), true);
  }
}

/** Convert one or more 16 kHz mono PCM frames to 48 kHz stereo PCM.
 *
 * The SFU adapter consumes signed little-endian PCM. A sample-and-hold 3x
 * expansion is technically valid, but its staircase edges contain a strong
 * image in the telephone band and make consonant onsets sound like a tiny
 * burst. Linear interpolation keeps the same exact 20 ms clock while
 * removing that artificial high-frequency component.
 */
export function upsample16kMonoTo48kStereoLinear(
  mono16k: ArrayBufferLike,
  previousSample: number | null,
): { audio: Uint8Array; lastSample: number | null } {
  const input = new DataView(mono16k);
  const sampleCount = Math.floor(mono16k.byteLength / 2);
  const output = new Uint8Array(sampleCount * 3 * 4);
  const view = new DataView(output.buffer);
  let previous = previousSample;
  for (let index = 0; index < sampleCount; index += 1) {
    const current = input.getInt16(index * 2, true);
    const from = previous ?? current;
    const values = [
      Math.round((from * 2 + current) / 3),
      Math.round((from + current * 2) / 3),
      current,
    ];
    for (let phase = 0; phase < 3; phase += 1) {
      const offset = (index * 3 + phase) * 4;
      view.setInt16(offset, values[phase], true);
      view.setInt16(offset + 2, values[phase], true);
    }
    previous = current;
  }
  return { audio: output, lastSample: previous };
}

export function pcmToWavBase64(pcm: Uint8Array): string {
  const wav = new Uint8Array(44 + pcm.byteLength);
  const view = new DataView(wav.buffer);
  const write = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index += 1) wav[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, 36 + pcm.byteLength, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, pcm.byteLength, true);
  wav.set(pcm, 44);
  let binary = "";
  for (let offset = 0; offset < wav.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...wav.subarray(offset, Math.min(offset + 0x8000, wav.byteLength)));
  }
  return btoa(binary);
}
