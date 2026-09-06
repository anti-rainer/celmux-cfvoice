export type MediaRole = "carrier" | "access" | "sfu-uplink" | "sfu-downlink" | "control";

export type CallAccessKind = "browser" | "sip" | "automatic";

export type CallFeatureConfig = {
  transcription: boolean;
  /** `realtime` uses Flux WebSocket; `chunked` uses Whisper HTTP inference. */
  transcriptionMode: "realtime" | "chunked";
  translation: boolean;
  speechTranslation: boolean;
  /** Deepgram Aura-1 speaker; voices are model-specific. */
  speechVoice: string;
  sourceLanguage: string;
  targetLanguage: string;
};

export type RoleTickets = Record<MediaRole, string>;

export type PersistedCallState = CallFeatureConfig & {
  status: "new" | "ready" | "closed";
  accessKind: CallAccessKind;
  ticketDigests: Record<MediaRole, string>;
  browserSessionId: string;
  browserTrackMid: string;
  browserDownlinkMid: string;
  pendingDownlinkOfferSdp: string;
  downlinkSessionId: string;
  downlinkTrackName: string;
  downlinkTrackMid: string;
  downlinkAdapterId: string;
  uplinkAdapterId: string;
};

export type ConnectionState = {
  role: MediaRole;
  authorized: boolean;
};

export type CaptionDirection = "incoming" | "outgoing";

export const PCM16_20MS_BYTES = 16_000 / 50 * 2;
export function roleFromUrl(request: Request): MediaRole | null {
  const role = new URL(request.url).searchParams.get("role");
  return role === "carrier" || role === "access" || role === "sfu-uplink" || role === "sfu-downlink" || role === "control"
    ? role
    : null;
}

export function asArrayBuffer(value: ArrayBuffer | ArrayBufferView): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}
