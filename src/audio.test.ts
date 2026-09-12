import { describe, expect, it } from "vitest";
import {
  appendBytes,
  containsLikelySpeech,
  hasLikelySpeechFrame,
  pcmToWavBase64,
  upsample16kMonoTo48kStereoLinear,
} from "./audio";
import { normalizeLanguage, outgoingTranslationLanguage } from "./providers";
import { PCM16_20MS_BYTES } from "./protocol";

function pcm16(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

function tone(frames: number): Uint8Array {
  const samples: number[] = [];
  for (let index = 0; index < frames * (PCM16_20MS_BYTES / 2); index += 1) {
    samples.push(Math.round(8_000 * Math.sin(index / 4)));
  }
  return pcm16(samples);
}

describe("PCM helpers", () => {
  it("concatenates chunks without changing their bytes", () => {
    const combined = appendBytes(pcm16([1, 2]), pcm16([3, 4]));
    expect(Array.from(combined)).toEqual([1, 0, 2, 0, 3, 0, 4, 0]);
  });

  it("separates digital silence from a voiced tone", () => {
    const silence = pcm16(Array.from({ length: PCM16_20MS_BYTES / 2 }, () => 0));
    expect(hasLikelySpeechFrame(silence)).toBe(false);
    expect(hasLikelySpeechFrame(tone(1))).toBe(true);
    expect(containsLikelySpeech(silence)).toBe(false);
    expect(containsLikelySpeech(tone(8))).toBe(true);
  });

  it("upsamples 16 kHz mono to 48 kHz stereo with the same sample count", () => {
    const input = tone(1);
    const result = upsample16kMonoTo48kStereoLinear(input.buffer, null);
    expect(result.audio.byteLength).toBe((PCM16_20MS_BYTES / 2) * 3 * 4);
    const view = new DataView(input.buffer);
    expect(result.lastSample).toBe(view.getInt16((PCM16_20MS_BYTES / 2 - 1) * 2, true));
  });

  it("wraps PCM in a valid 16 kHz mono WAV container", () => {
    const source = pcm16([1, -1, 2, -2]);
    const bytes = Uint8Array.from(atob(pcmToWavBase64(source)), character => character.charCodeAt(0));
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe("RIFF");
    expect(String.fromCharCode(...bytes.subarray(8, 12))).toBe("WAVE");
    expect(String.fromCharCode(...bytes.subarray(36, 40))).toBe("data");
    expect(bytes.byteLength).toBe(44 + source.byteLength);
  });
});

describe("language normalization", () => {
  it("canonicalizes regional and underscore forms", () => {
    expect(normalizeLanguage("zh-CN", "en")).toBe("zh");
    expect(normalizeLanguage("EN_us", "zh")).toBe("en");
    expect(normalizeLanguage("auto", "en")).toBe("auto");
    expect(normalizeLanguage("", "en")).toBe("en");
  });

  it("defaults synthesized uplink translation to English", () => {
    expect(outgoingTranslationLanguage("auto")).toBe("en");
    expect(outgoingTranslationLanguage("fr")).toBe("fr");
  });
});
