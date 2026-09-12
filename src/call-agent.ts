import { Agent, type Connection, type ConnectionContext, type WSMessage } from "agents";
import {
  WorkersAIFluxSTT,
  addSFUTracks,
  encodePayloadToProtobuf,
  extractPayloadFromProtobuf,
  downsample48kStereoTo16kMono,
  createSFUWebSocketAdapter,
  renegotiateSFUSession,
  type TranscriberSession,
} from "agents/voice";
import {
  PCM16_20MS_BYTES,
  asArrayBuffer,
  roleFromUrl,
  type CallAccessKind,
  type CaptionDirection,
  type CallFeatureConfig,
  type ConnectionState,
  type MediaRole,
  type PersistedCallState,
  type RoleTickets,
} from "./protocol";
import {
  appendBytes,
  containsLikelySpeech,
  hasLikelySpeechFrame,
  pcmLevel,
  pcmToWavBase64,
  softenPcmStart,
  upsample16kMonoTo48kStereoLinear,
} from "./audio";
import {
  explicitLanguage,
  normalizeLanguage,
  outgoingTranslationLanguage,
  translate,
} from "./providers";
import {
  DEFAULT_SPEECH_MODEL,
  normalizeSpeechModel,
  normalizeSpeechVoice,
} from "./voices";
import { timingSafeTextEqual } from "./auth";
import {
  cleanupSFUResources,
  closeSFUWebSocketAdapters,
  sfuConfig,
  type SFUConfig,
} from "./sfu-api";

const EMPTY_DIGESTS: Record<MediaRole, string> = {
  carrier: "",
  access: "",
  "sfu-uplink": "",
  "sfu-downlink": "",
  control: "",
};

const EMPTY_STATE: PersistedCallState = {
  status: "new",
  accessKind: "browser",
  ticketDigests: EMPTY_DIGESTS,
  autoCloseScheduleId: "",
  transcription: false,
  transcriptionMode: "realtime",
  translation: false,
  speechTranslation: false,
  speechModel: DEFAULT_SPEECH_MODEL,
  speechVoice: "asteria",
  sourceLanguage: "auto",
  targetLanguage: "zh",
  browserSessionId: "",
  browserTrackMid: "",
  browserDownlinkMid: "",
  downlinkReady: false,
  pendingDownlinkOfferSdp: "",
  downlinkSessionId: "",
  downlinkTrackName: "",
  downlinkTrackMid: "",
  downlinkAdapterId: "",
  uplinkAdapterId: "",
};

/** Close a call whose carrier leg disappeared without a Celmux DELETE. */
const CARRIER_GRACE_SECONDS = 45;
/** Close a freshly initialized call that never opens its carrier leg. */
const INITIAL_CONNECT_GRACE_SECONDS = 60;
/**
 * Realtime Flux is billed per streaming audio minute. Only hold a session
 * while its direction has speech; 300 ms of pre-roll protects the first
 * phoneme and 20 s of continuous silence closes an idle direction.
 */
const REALTIME_PREROLL_FRAMES = 15;
const REALTIME_IDLE_CLOSE_FRAMES = 1_000;

type InitializeBody = {
  tickets: RoleTickets;
  features: Partial<CallFeatureConfig> & { accessKind?: CallAccessKind };
};

type ResourceBody = Pick<PersistedCallState,
  "browserSessionId" | "browserTrackMid" | "browserDownlinkMid" | "downlinkSessionId" |
  "downlinkTrackName" | "downlinkTrackMid" | "downlinkAdapterId" | "uplinkAdapterId">;

/** Result of pulling the carrier downlink into the browser's session. */
type DownlinkBind = { status: "ready" } | { status: "offer"; sdp: string };

/**
 * One Agent owns one call. It is both the bounded PCM router and the durable
 * AI processor; no browser-only voice pipeline or second room object exists.
 */
export class CelmuxCallAgent extends Agent<Env, PersistedCallState> {
  initialState = EMPTY_STATE;
  private incomingSTT: TranscriberSession | null = null;
  private outgoingSTT: TranscriberSession | null = null;
  private captionJobs = new Set<Promise<void>>();
  private outgoingSpeechTail: Promise<void> = Promise.resolve();
  private speechGeneration = 0;
  private closing = false;
  private closeTask: Promise<void> | null = null;
  private sttRetryAt: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  private pendingInterim: Record<CaptionDirection, string> = { incoming: "", outgoing: "" };
  private audioFrames: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  private recentSpeechAt: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  private chunkBuffers: Record<CaptionDirection, Uint8Array> = {
    incoming: new Uint8Array(0),
    outgoing: new Uint8Array(0),
  };
  private chunkTails: Record<CaptionDirection, Promise<void>> = {
    incoming: Promise.resolve(),
    outgoing: Promise.resolve(),
  };
  private chunkSilenceFrames: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  private chunkVoicedFrames: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  private chunkNoiseFloor: Record<CaptionDirection, number> = { incoming: 120, outgoing: 120 };
  private chunkSpeechActive: Record<CaptionDirection, boolean> = { incoming: false, outgoing: false };
  private chunkPreRoll: Record<CaptionDirection, Uint8Array[]> = { incoming: [], outgoing: [] };
  private lastChunkText: Record<CaptionDirection, string> = { incoming: "", outgoing: "" };
  private pendingCaptions: Array<{
    direction: CaptionDirection;
    text: string;
    translatedText: string;
    occurredAt: string;
  }> = [];
  private downlinkResampleSample: number | null = null;
  /** Alarm-backed eviction guard held for the life of one call. */
  private keepAliveDispose: (() => void) | null = null;
  /** Background creation of the SFU uplink (microphone) adapter. */
  private uplinkAdapterPromise: Promise<void> | null = null;
  /** Background bind of the carrier downlink into the browser session. */
  private downlinkBind: Promise<DownlinkBind> | null = null;
  /** Wall-clock anchor for latency diagnostics. */
  private initializedAt = 0;
  private firstCarrierAudioLogged = false;
  /** Consecutive silent 20 ms frames while a realtime session is open. */
  private realtimeIdleFrames: Record<CaptionDirection, number> = { incoming: 0, outgoing: 0 };
  /** Recent frames replayed when a lazy realtime session starts. */
  private realtimePreRoll: Record<CaptionDirection, Uint8Array[]> = { incoming: [], outgoing: [] };

  shouldSendProtocolMessages(): boolean {
    return false;
  }

  async onStart(): Promise<void> {
    this.ensureCaptionTable();
    // A wake during a live call must re-arm the eviction guard even though
    // constructor fields were reset.
    if (this.state.status === "ready" && !this.keepAliveDispose) {
      this.keepAliveDispose = await this.keepAlive();
    }
    if (this.state.status === "ready" && !this.hasOpenCarrier()) {
      await this.scheduleAutoClose(CARRIER_GRACE_SECONDS);
    }
  }

  onError(connectionOrError: Connection | unknown, error?: unknown): void {
    const detail = error ?? connectionOrError;
    console.error("Celmux call agent error", {
      message: detail instanceof Error ? detail.message : String(detail),
    });
    if (error !== undefined) super.onError(connectionOrError as Connection, error);
    else super.onError(connectionOrError);
  }

  onClose(connection: Connection, code: number, reason: string, wasClean: boolean): void {
    const state = connection.state as ConnectionState | undefined;
    console.info("Celmux call connection closed", {
      role: state?.role ?? "unknown",
      code,
      reason: reason || undefined,
      wasClean,
    });
    if (state?.role === "carrier" && this.state.status === "ready" && !this.closing) {
      void this.scheduleAutoClose(CARRIER_GRACE_SECONDS);
    }
  }

  private hasOpenCarrier(): boolean {
    for (const connection of this.getConnections<ConnectionState>("carrier")) {
      if (connection.readyState === WebSocket.OPEN) return true;
    }
    return false;
  }

  private async scheduleAutoClose(seconds: number): Promise<void> {
    await this.cancelAutoClose();
    const scheduled = await this.schedule(seconds, "autoCloseCall", undefined, {
      idempotent: true,
    });
    this.setState({ ...this.state, autoCloseScheduleId: scheduled.id });
  }

  private async cancelAutoClose(): Promise<void> {
    const id = this.state.autoCloseScheduleId;
    if (!id) return;
    try {
      await this.cancelSchedule(id);
    } catch {
      // The alarm may already have fired; there is nothing left to cancel.
    }
    this.setState({ ...this.state, autoCloseScheduleId: "" });
  }

  async autoCloseCall(): Promise<void> {
    if (this.state.status !== "ready" || this.closing) return;
    if (this.hasOpenCarrier()) return;
    console.warn("Celmux call auto-closing after carrier disconnect", { callId: this.name });
    await this.closeCall();
  }

  private ensureCaptionTable(): void {
    this.sql`
      CREATE TABLE IF NOT EXISTS call_captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )
    `;
  }

  async onRequest(request: Request): Promise<Response> {
    if (!this.internalRequest(request)) return new Response("Unauthorized", { status: 401 });
    const path = new URL(request.url).pathname;
    if (path.endsWith("/initialize") && request.method === "POST") {
      const body = await request.json<InitializeBody>();
      if (!validTickets(body.tickets)) return new Response("Invalid tickets", { status: 400 });
      const digests = await digestTickets(body.tickets);
      const features = body.features || {};
      const accessKind = validAccessKind(features.accessKind) ? features.accessKind : "browser";
      const transcription = features.transcription === true;
      const transcriptionMode = features.transcriptionMode === "chunked" ? "chunked" : "realtime";
      const sourceLanguage = normalizeLanguage(features.sourceLanguage, "auto");
      const targetLanguage = normalizeLanguage(features.targetLanguage, "zh-CN");
      const speechModel = normalizeSpeechModel(features.speechModel);
      const speechVoice = normalizeSpeechVoice(speechModel, features.speechVoice);
      this.closing = false;
      this.closeTask = null;
      this.initializedAt = Date.now();
      this.firstCarrierAudioLogged = false;
      this.keepAliveDispose?.();
      this.keepAliveDispose = await this.keepAlive();
      this.sttRetryAt = { incoming: 0, outgoing: 0 };
      this.pendingInterim = { incoming: "", outgoing: "" };
      this.audioFrames = { incoming: 0, outgoing: 0 };
      this.recentSpeechAt = { incoming: 0, outgoing: 0 };
      this.chunkBuffers = { incoming: new Uint8Array(0), outgoing: new Uint8Array(0) };
      this.chunkTails = { incoming: Promise.resolve(), outgoing: Promise.resolve() };
      this.realtimeIdleFrames = { incoming: 0, outgoing: 0 };
      this.realtimePreRoll = { incoming: [], outgoing: [] };
      this.resetChunkVad();
      this.lastChunkText = { incoming: "", outgoing: "" };
      this.pendingCaptions = [];
      this.downlinkResampleSample = null;
      this.setState({
        ...EMPTY_STATE,
        status: "ready",
        ticketDigests: digests,
        accessKind,
        transcription,
        transcriptionMode,
        translation: transcription && features.translation === true,
        speechTranslation: accessKind !== "automatic"
          && transcription
          && features.speechTranslation === true
          && explicitLanguage(targetLanguage),
        sourceLanguage,
        targetLanguage,
        speechModel,
        speechVoice,
      });
      // The carrier leg is expected to connect immediately. If it never
      // does, the durable alarm closes the call instead of leaving a zombie.
      await this.scheduleAutoClose(INITIAL_CONNECT_GRACE_SECONDS);
      return Response.json({ status: "ready" });
    }
    if (path.endsWith("/resources") && request.method === "POST") {
      const body = await request.json<ResourceBody>();
      this.setState({ ...this.state, ...body });
      const sfu = sfuConfig(this.env);
      // Start the SFU track operation as soon as the browser session exists.
      // The SFU blocks it until that session is connected, and the browser only
      // calls subscribe after it is connected — running the operation in the
      // background removes that serialised wait from the dial path.
      if (sfu
        && this.state.browserSessionId
        && this.state.downlinkSessionId
        && this.state.downlinkTrackName
        && !this.state.downlinkReady) {
        this.ctx.waitUntil(this.bindDownlink(sfu).catch(() => undefined));
      }
      return Response.json({ status: "saved" });
    }
    if (path.endsWith("/subscribe") && request.method === "POST") {
      const body = await request.json<{ uplink_url?: string }>();
      const subscribeStarted = Date.now();
      const sfu = sfuConfig(this.env);
      if (!sfu
        || !this.state.browserSessionId
        || !this.state.downlinkSessionId
        || !this.state.downlinkTrackName) {
        return new Response("SFU session unavailable", { status: 409 });
      }
      // Keep subscribe idempotent: a retry after a successful bind must not
      // create a second downlink.
      if (this.state.downlinkReady) {
        return Response.json({ status: "ready", already_subscribed: true });
      }
      if (this.state.pendingDownlinkOfferSdp) {
        return Response.json({
          offer: { type: "offer", sdp: this.state.pendingDownlinkOfferSdp },
          retry: true,
        });
      }
      const uplinkUrl = body.uplink_url || "";
      const parsedUplink = validRoleUrl(uplinkUrl, "sfu-uplink");
      if (!parsedUplink
        || await digest(parsedUplink.ticket) !== this.state.ticketDigests["sfu-uplink"]) {
        return new Response("Invalid uplink adapter URL", { status: 400 });
      }
      // The uplink adapter carries the browser's microphone to the Agent and
      // is not needed for the downlink audio the caller hears. Create it in
      // the background so the caller can be connected as soon as the downlink
      // is bound.
      const createdUplinkAdapter = !this.state.uplinkAdapterId && !this.uplinkAdapterPromise;
      if (createdUplinkAdapter) {
        this.uplinkAdapterPromise = this.createUplinkAdapter(sfu, uplinkUrl).finally(() => {
          this.uplinkAdapterPromise = null;
        });
        this.ctx.waitUntil(this.uplinkAdapterPromise);
      }
      const prebound = this.downlinkBind !== null;
      const bind = await this.bindDownlink(sfu);
      console.info("Celmux subscribe", {
        sinceInitMs: Date.now() - this.initializedAt,
        durationMs: Date.now() - subscribeStarted,
        createdUplinkAdapter,
        prebound,
        requiresRenegotiation: bind.status === "offer",
      });
      if (bind.status === "offer") {
        return Response.json({ offer: { type: "offer", sdp: bind.sdp } });
      }
      return Response.json({ status: "ready", downlink_ready: true });
    }
    if (path.endsWith("/renegotiate") && request.method === "POST") {
      const body = await request.json<{ answer?: { type?: string; sdp?: string } }>();
      const answer = body.answer;
      if (answer?.type !== "answer" || !answer.sdp || answer.sdp.length > 256 * 1024) {
        return new Response("Invalid answer", { status: 400 });
      }
      const sfu = sfuConfig(this.env);
      if (!sfu || !this.state.browserSessionId || !this.state.browserDownlinkMid) {
        return new Response("SFU subscription unavailable", { status: 409 });
      }
      const renegotiateStarted = Date.now();
      await renegotiateSFUSession(sfu, this.state.browserSessionId, answer.sdp);
      this.setState({
        ...this.state,
        pendingDownlinkOfferSdp: "",
        downlinkReady: true,
      });
      console.info("Celmux renegotiate", {
        sinceInitMs: Date.now() - this.initializedAt,
        durationMs: Date.now() - renegotiateStarted,
      });
      return Response.json({ status: "ready" });
    }
    if (path.endsWith("/close") && request.method === "POST") {
      await this.closeCall();
      return Response.json(this.callResult());
    }
    return new Response("Not found", { status: 404 });
  }

  async onConnect(connection: Connection, context: ConnectionContext): Promise<void> {
    const role = roleFromUrl(context.request);
    const ticket = new URL(context.request.url).searchParams.get("ticket") || "";
    if (!role
      || this.state.status !== "ready"
      || !timingSafeTextEqual(await digest(ticket), this.state.ticketDigests[role])) {
      connection.close(1008, "unauthorized");
      return;
    }
    for (const existing of this.getConnections<ConnectionState>(role)) {
      if (existing.id !== connection.id) existing.close(1000, "replaced");
    }
    connection.setState({ role, authorized: true });
    if (role === "control") this.sendControl(connection, { type: "ready" });
    if (role === "carrier") await this.cancelAutoClose();
    console.info("Celmux connect", {
      role,
      sinceInitMs: Date.now() - this.initializedAt,
    });
  }

  getConnectionTags(_connection: Connection, context: ConnectionContext): string[] {
    const role = roleFromUrl(context.request);
    return role ? [role] : [];
  }

  onMessage(connection: Connection<ConnectionState>, message: WSMessage): void {
    const state = connection.state;
    if (!state?.authorized || this.state.status !== "ready") return;
    if (typeof message === "string") {
      if (state.role === "control") this.handleControl(message);
      return;
    }
    const bytes = asArrayBuffer(message);
    if (state.role === "carrier") this.handleCarrierAudio(bytes);
    if (state.role === "access") this.handleAccessAudio(bytes);
    if (state.role === "sfu-uplink") this.handleBrowserAudio(bytes);
  }

  private handleCarrierAudio(audio: ArrayBuffer): void {
    if (!audio.byteLength || audio.byteLength % PCM16_20MS_BYTES !== 0) return;
    if (!this.firstCarrierAudioLogged) {
      this.firstCarrierAudioLogged = true;
      console.info("Celmux first carrier audio", {
        sinceInitMs: Date.now() - this.initializedAt,
      });
    }
    // Original conversation audio is the real-time path. Never put an AI
    // provider send ahead of it: a congested STT socket must not delay audio.
    // Celmux has already decoded and (when necessary) repaired the carrier
    // RTP stream.  Keep the PCM samples continuous here; applying a second
    // fade at every WebSocket frame audibly softens consonant attacks and was
    // the source of the short "zap" heard before words.  Use linear 3x
    // interpolation instead of sample-and-hold so the 16 kHz carrier does
    // not introduce a staircase transient before SFU's Opus encoder.
    const resampled = upsample16kMonoTo48kStereoLinear(audio, this.downlinkResampleSample);
    this.downlinkResampleSample = resampled.lastSample;
    const pcm48 = resampled.audio;
    this.sendBinary("sfu-downlink", encodePayloadToProtobuf(pcm48));
    this.sendPcmFrames("access", audio);
    this.feed("incoming", audio);
  }

  private handleBrowserAudio(packet: ArrayBuffer): void {
    const payload = extractPayloadFromProtobuf(packet);
    if (!payload) return;
    const pcm = downsample48kStereoTo16kMono(payload);
    if (!this.outgoingSpeechReplacementEnabled()) this.sendPcmFrames("carrier", pcm);
    this.feed("outgoing", pcm);
  }

  private handleAccessAudio(audio: ArrayBuffer): void {
    if (!audio.byteLength || audio.byteLength % PCM16_20MS_BYTES !== 0) return;
    if (!this.outgoingSpeechReplacementEnabled()) this.sendPcmFrames("carrier", audio);
    this.feed("outgoing", audio);
  }

  private feed(direction: CaptionDirection, audio: ArrayBuffer): void {
    if (!this.state.transcription) return;
    this.audioFrames[direction] += audio.byteLength / PCM16_20MS_BYTES;
    if (this.state.transcriptionMode === "chunked") {
      if (hasLikelySpeechFrame(new Uint8Array(audio))) {
        this.recentSpeechAt[direction] = Date.now();
      }
      this.feedChunked(direction, audio);
      return;
    }
    this.feedRealtime(direction, audio);
  }

  /**
   * Realtime Flux is billed per streaming audio minute, and the old path held
   * two sessions open for the whole call. Start a direction's session on its
   * first voiced frame, replay a short pre-roll, and close it after 20 s of
   * continuous silence. Celmux sends 20 ms frames continuously (including
   * digital silence), so silence itself is the idle timer.
   */
  private feedRealtime(direction: CaptionDirection, audio: ArrayBuffer): void {
    for (let offset = 0; offset + PCM16_20MS_BYTES <= audio.byteLength; offset += PCM16_20MS_BYTES) {
      const frame = new Uint8Array(audio.slice(offset, offset + PCM16_20MS_BYTES));
      const voiced = hasLikelySpeechFrame(frame);
      if (voiced) {
        this.recentSpeechAt[direction] = Date.now();
        this.realtimeIdleFrames[direction] = 0;
      } else if (this.realtimeIdleFrames[direction] < REALTIME_IDLE_CLOSE_FRAMES) {
        this.realtimeIdleFrames[direction] += 1;
      }
      const existing = direction === "incoming" ? this.incomingSTT : this.outgoingSTT;
      if (!existing) {
        // Do not open a Flux socket during digital silence: the free tier is
        // spent per streaming minute even when no text is produced.
        const preRoll = this.realtimePreRoll[direction];
        preRoll.push(frame);
        if (preRoll.length > REALTIME_PREROLL_FRAMES) preRoll.shift();
        if (!voiced) continue;
        const session = this.transcriber(direction);
        if (!session) continue;
        for (const buffered of preRoll) session.feed(buffered.buffer as ArrayBuffer);
        preRoll.length = 0;
        continue;
      }
      existing.feed(frame.buffer as ArrayBuffer);
      if (!voiced && this.realtimeIdleFrames[direction] >= REALTIME_IDLE_CLOSE_FRAMES) {
        this.closeRealtimeSession(direction);
      }
    }
  }

  private closeRealtimeSession(direction: CaptionDirection): void {
    const session = direction === "incoming" ? this.incomingSTT : this.outgoingSTT;
    if (!session) return;
    session.close();
    if (direction === "incoming") this.incomingSTT = null;
    else this.outgoingSTT = null;
    this.realtimeIdleFrames[direction] = 0;
    this.realtimePreRoll[direction] = [];
    this.pendingInterim[direction] = "";
  }

  /** Feed short independent PCM chunks to Whisper at the edge.  The media
   * path remains synchronous; inference is chained per direction so a slow
   * request can never reorder captions or stall telephone audio. */
  private feedChunked(direction: CaptionDirection, audio: ArrayBuffer): void {
    for (let offset = 0; offset + PCM16_20MS_BYTES <= audio.byteLength; offset += PCM16_20MS_BYTES) {
      const frame = new Uint8Array(audio.slice(offset, offset + PCM16_20MS_BYTES));
      const level = pcmLevel(frame, 0, frame.byteLength);
      const threshold = Math.max(140, this.chunkNoiseFloor[direction] * 2.7);
      const voiced = level.rms >= threshold && level.span >= 800;
      if (!this.chunkSpeechActive[direction]) {
        if (voiced) {
          this.chunkPreRoll[direction].push(frame);
          if (this.chunkPreRoll[direction].length > 6) this.chunkPreRoll[direction].shift();
          this.chunkVoicedFrames[direction] += 1;
          if (this.chunkVoicedFrames[direction] >= 4) {
            this.chunkSpeechActive[direction] = true;
            for (const buffered of this.chunkPreRoll[direction]) {
              this.chunkBuffers[direction] = appendBytes(this.chunkBuffers[direction], buffered);
            }
            this.chunkPreRoll[direction] = [];
          }
        } else {
          this.chunkVoicedFrames[direction] = 0;
          this.chunkPreRoll[direction] = [];
          this.chunkNoiseFloor[direction] = Math.min(1200, this.chunkNoiseFloor[direction] * 0.96 + level.rms * 0.04);
        }
        continue;
      }
      this.chunkBuffers[direction] = appendBytes(this.chunkBuffers[direction], frame);
      if (voiced) this.chunkSilenceFrames[direction] = 0;
      else this.chunkSilenceFrames[direction] += 1;
      // A 280 ms energy drop is a natural breath/intonation boundary. Keep a
      // short pre-roll on the next utterance so consonant attacks are intact.
      if (this.chunkSilenceFrames[direction] >= 14 || this.chunkBuffers[direction].byteLength >= 16_000 * 2 * 7) {
        this.queueChunk(direction, this.chunkBuffers[direction]);
        this.chunkBuffers[direction] = new Uint8Array(0);
        this.chunkSilenceFrames[direction] = 0;
        this.chunkVoicedFrames[direction] = 0;
        this.chunkSpeechActive[direction] = false;
      }
    }
  }

  private queueChunk(direction: CaptionDirection, chunk: Uint8Array): void {
    if (chunk.byteLength < PCM16_20MS_BYTES * 4) return;
    this.chunkTails[direction] = this.chunkTails[direction]
      .then(() => this.transcribeChunk(direction, chunk))
      .catch(error => this.reportError(error, "Cloudflare Whisper 转写失败"));
    this.ctx.waitUntil(this.chunkTails[direction]);
  }

  private resetChunkVad(): void {
    this.chunkSilenceFrames = { incoming: 0, outgoing: 0 };
    this.chunkVoicedFrames = { incoming: 0, outgoing: 0 };
    this.chunkNoiseFloor = { incoming: 120, outgoing: 120 };
    this.chunkSpeechActive = { incoming: false, outgoing: false };
    this.chunkPreRoll = { incoming: [], outgoing: [] };
  }

  private async transcribeChunk(direction: CaptionDirection, pcm: Uint8Array): Promise<void> {
    if (!this.state.transcription) return;
    if (!containsLikelySpeech(pcm)) {
      // A blank interval separates otherwise identical real phrases. Reset
      // deduplication without paying for Whisper or accepting its well-known
      // subtitle hallucinations on silence/background hiss.
      this.lastChunkText[direction] = "";
      return;
    }
    const result = await this.env.AI.run("@cf/openai/whisper-large-v3-turbo", {
      audio: pcmToWavBase64(pcm),
      task: "transcribe",
      vad_filter: true,
      condition_on_previous_text: false,
      no_speech_threshold: 0.45,
      hallucination_silence_threshold: 0.5,
      ...(explicitLanguage(direction === "incoming" ? this.state.sourceLanguage : this.state.targetLanguage)
        ? { language: direction === "incoming" ? this.state.sourceLanguage : this.state.targetLanguage }
        : {}),
    }) as { text?: unknown };
    const text = typeof result?.text === "string" ? result.text.trim() : "";
    if (!text) return;
    const normalized = text.replace(/\s+/g, " ").toLowerCase();
    if (normalized === this.lastChunkText[direction]) return;
    this.lastChunkText[direction] = normalized;
    this.scheduleCaption(direction, text);
  }

  private transcriber(direction: CaptionDirection): TranscriberSession | null {
    const existing = direction === "incoming" ? this.incomingSTT : this.outgoingSTT;
    if (existing) return existing;
    if (Date.now() < this.sttRetryAt[direction]) return null;
    const provider = new WorkersAIFluxSTT(this.env.AI, {
      sampleRate: 16_000,
      // Flux is the Workers AI WebSocket model available on this account.
      // Use the most responsive documented confidence values, with a short
      // forced timeout so a natural small pause produces a usable sentence.
      eotThreshold: 0.5,
      eagerEotThreshold: 0.3,
      eotTimeoutMs: 800,
    });
    let session: TranscriberSession;
    session = provider.createSession({
      language: direction === "incoming" ? this.state.sourceLanguage : this.state.targetLanguage,
      onInterim: text => {
        if (!this.hasRecentSpeech(direction)) return;
        this.pendingInterim[direction] = text.trim();
        this.broadcastControl({
          type: "caption",
          direction,
          final: false,
          text,
          occurred_at: new Date().toISOString(),
        });
      },
      onUtterance: text => {
        this.pendingInterim[direction] = "";
        if (!this.hasRecentSpeech(direction)) return;
        this.scheduleCaption(direction, text);
      },
      onFatalError: error => {
        const current = direction === "incoming" ? this.incomingSTT : this.outgoingSTT;
        if (current === session) {
          session.close();
          if (direction === "incoming") this.incomingSTT = null;
          else this.outgoingSTT = null;
          this.sttRetryAt[direction] = Date.now() + 1_000;
        }
        this.broadcastControl({ type: "error", message: error.message });
      },
    });
    if (direction === "incoming") this.incomingSTT = session;
    else this.outgoingSTT = session;
    return session;
  }

  private hasRecentSpeech(direction: CaptionDirection): boolean {
    // Flux finalizes after its EOT timeout. Keep a short allowance for that
    // model/network delay, but never accept a transcript from continuous
    // digital silence or idle microphone noise.
    return Date.now() - this.recentSpeechAt[direction] <= 4_000;
  }

  private scheduleCaption(direction: CaptionDirection, text: string): void {
    const replaceOutgoing = direction === "outgoing" && this.outgoingSpeechReplacementEnabled();
    const speechGeneration = this.speechGeneration;
    const work = replaceOutgoing
      ? this.outgoingSpeechTail.then(() => this.finishCaption(direction, text, true, speechGeneration))
      : this.finishCaption(direction, text, false, speechGeneration);
    const job = work
      .catch(error => this.reportError(error, "Cloudflare 字幕处理失败"))
      .finally(() => this.captionJobs.delete(job));
    if (replaceOutgoing) {
      // Keep utterances in telephone order. Convert rejection to fulfillment
      // so one failed sentence never blocks the following sentence.
      this.outgoingSpeechTail = job.then(() => undefined, () => undefined);
    }
    this.captionJobs.add(job);
    this.ctx.waitUntil(job);
  }

  private async finishCaption(
    direction: CaptionDirection,
    text: string,
    replaceOutgoing: boolean,
    speechGeneration: number,
  ): Promise<void> {
    const clean = text.trim();
    if (!clean) return;
    const synthesizeOutgoing = replaceOutgoing && this.speechStreamActive(speechGeneration);
    let translatedText = "";
    let translationErrorReported = false;
    if (this.state.translation || synthesizeOutgoing) {
      const target = direction === "incoming"
        ? this.state.targetLanguage
        : outgoingTranslationLanguage(this.state.sourceLanguage);
      try {
        translatedText = await translate(this.env.AI, clean, target);
      } catch (error) {
        translationErrorReported = true;
        this.reportError(error, "Cloudflare 文本翻译失败");
      }
    }
    const event = {
      type: "caption",
      direction,
      final: true,
      text: clean,
      translated_text: translatedText,
      occurred_at: new Date().toISOString(),
    };
    this.pendingCaptions.push({
      direction,
      text: clean,
      translatedText,
      occurredAt: event.occurred_at,
    });
    this.broadcastControl(event);
    if (synthesizeOutgoing && translatedText) {
      try {
        await this.streamTranslatedSpeech(translatedText, speechGeneration);
      } catch (error) {
        this.reportError(error, "Cloudflare 语音合成失败");
      }
    } else if (synthesizeOutgoing && !translationErrorReported) {
      this.reportError(new Error("Cloudflare 文本翻译返回空内容"), "Cloudflare 文本翻译失败");
    }
  }

  private handleControl(raw: string): void {
    let message: unknown;
    try { message = JSON.parse(raw); } catch { return; }
    if (!message || typeof message !== "object") return;
    const value = message as Record<string, unknown>;
    if (value.type === "diag") {
      // Browser-side phase timings and failures. The dial path is dominated by
      // the browser's own handshakes, so the Agent records what only the
      // browser can observe.
      console.info("Celmux browser diag", {
        sinceInitMs: Date.now() - this.initializedAt,
        kind: value.kind,
        phases: value.phases,
        error: value.error,
      });
      return;
    }
    if (value.type === "speak") {
      // Text typed into the caption board. It replaces the microphone exactly
      // like a spoken sentence: translate to the carrier's language, then
      // synthesize and pace it onto the carrier socket.
      const text = typeof value.text === "string" ? value.text.trim().slice(0, 1_000) : "";
      if (!text) return;
      if (!this.outgoingSpeechReplacementEnabled()) {
        this.reportError(new Error("上行译音未开启"), "Cloudflare 语音合成失败");
        return;
      }
      console.info("Celmux typed speech", {
        sinceInitMs: Date.now() - this.initializedAt,
        characters: text.length,
      });
      this.scheduleCaption("outgoing", text);
      return;
    }
    if (value.type !== "features") return;
    const transcription = value.transcription === true;
    const transcriptionMode = value.transcriptionMode === undefined
      ? this.state.transcriptionMode
      : value.transcriptionMode === "chunked" ? "chunked" : "realtime";
    const requestedSpeechTranslation = value.speechTranslation === true;
    const speechTranslation = requestedSpeechTranslation
      && transcription
      && this.state.accessKind !== "automatic"
      && explicitLanguage(this.state.targetLanguage);
    if (requestedSpeechTranslation && !speechTranslation) {
      this.broadcastControl({
        type: "error",
        message: "Cloudflare 上行语音翻译需要开启转文字并明确选择我的语言",
      });
    }
    const speechModel = value.speechModel === undefined
      ? this.state.speechModel
      : normalizeSpeechModel(value.speechModel);
    const speechVoice = normalizeSpeechVoice(
      speechModel,
      value.speechVoice === undefined ? this.state.speechVoice : value.speechVoice,
    );
    if (transcriptionMode !== this.state.transcriptionMode || !transcription) {
      this.closeRealtimeSession("incoming");
      this.closeRealtimeSession("outgoing");
      this.chunkBuffers = { incoming: new Uint8Array(0), outgoing: new Uint8Array(0) };
      this.resetChunkVad();
      this.lastChunkText = { incoming: "", outgoing: "" };
    }
    if (speechTranslation !== this.state.speechTranslation
      || speechModel !== this.state.speechModel) {
      this.speechGeneration += 1;
    }
    this.setState({
      ...this.state,
      transcription,
      transcriptionMode,
      translation: transcription && value.translation === true,
      speechTranslation,
      speechModel,
      speechVoice,
    });
  }

  private outgoingSpeechReplacementEnabled(): boolean {
    return this.state.accessKind !== "automatic"
      && this.state.transcription
      && this.state.speechTranslation
      && explicitLanguage(this.state.targetLanguage);
  }

  private async streamTranslatedSpeech(text: string, generation: number): Promise<void> {
    if (!this.speechStreamActive(generation)) return;
    const response = await (this.env.AI.run as unknown as (model: string, input: unknown, options: unknown) => Promise<Response>)(this.state.speechModel, {
      text,
      speaker: this.state.speechVoice || "asteria",
      encoding: "linear16",
      container: "none",
      sample_rate: 16_000,
    }, { returnRawResponse: true });
    if (!response.ok || !response.body) {
      throw new Error(`Aura-1 返回 HTTP ${response.status}`);
    }
    const reader = response.body.getReader();
    let buffered = new Uint8Array(0);
    let firstFrame = true;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!this.speechStreamActive(generation)) {
          await reader.cancel();
          return;
        }
        buffered = appendBytes(buffered, value);
        while (buffered.byteLength >= PCM16_20MS_BYTES) {
          if (!this.speechStreamActive(generation)) {
            await reader.cancel();
            return;
          }
          const frame = buffered.slice(0, PCM16_20MS_BYTES);
          buffered = buffered.slice(PCM16_20MS_BYTES);
          if (firstFrame) {
            softenPcmStart(frame);
            firstFrame = false;
          }
          await this.sendPacedSpeechFrame(frame, generation);
        }
      }
      if (buffered.byteLength && this.speechStreamActive(generation)) {
        const frame = new Uint8Array(PCM16_20MS_BYTES);
        frame.set(buffered);
        if (firstFrame) softenPcmStart(frame);
        await this.sendPacedSpeechFrame(frame, generation);
      }
    } finally {
      reader.releaseLock();
    }
  }

  private async sendPacedSpeechFrame(frame: Uint8Array, generation: number): Promise<void> {
    if (!this.speechStreamActive(generation)) return;
    this.sendBinary("carrier", frame.buffer as ArrayBuffer);
    // Aura may return an entire utterance in one network chunk. Pace raw PCM
    // at telephone clock rate so the bounded Celmux media queue is not flooded.
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  private speechStreamActive(generation: number): boolean {
    return !this.closing
      && generation === this.speechGeneration
      && this.outgoingSpeechReplacementEnabled();
  }

  private reportError(error: unknown, fallback: string): void {
    const detail = error instanceof Error ? error.message.trim() : "";
    this.broadcastControl({ type: "error", message: detail || fallback });
  }

  private sendPcmFrames(role: MediaRole, audio: ArrayBuffer): void {
    for (let offset = 0; offset + PCM16_20MS_BYTES <= audio.byteLength; offset += PCM16_20MS_BYTES) {
      this.sendBinary(role, audio.slice(offset, offset + PCM16_20MS_BYTES));
    }
  }

  private sendBinary(role: MediaRole, payload: ArrayBuffer): void {
    for (const connection of this.getConnections<ConnectionState>(role)) {
      if (connection.readyState === WebSocket.OPEN) {
        connection.send(payload);
      }
    }
  }

  private sendControl(connection: Connection, payload: object): void {
    if (connection.readyState === WebSocket.OPEN) connection.send(JSON.stringify(payload));
  }

  private broadcastControl(payload: object): void {
    for (const connection of this.getConnections<ConnectionState>("control")) {
      this.sendControl(connection, payload);
    }
  }

  private internalRequest(request: Request): boolean {
    const expected = this.env.CELMUX_AGENT_TOKEN?.trim();
    return Boolean(expected && timingSafeTextEqual(
      request.headers.get("X-Celmux-Internal-Token") || "",
      expected,
    ));
  }

  private callResult(): object {
    for (const caption of this.pendingCaptions) {
      this.sql`
        INSERT INTO call_captions (direction, text, translated_text, occurred_at)
        VALUES (${caption.direction}, ${caption.text}, ${caption.translatedText}, ${caption.occurredAt})
      `;
    }
    this.pendingCaptions = [];
    const captions = this.sql<{
      id: number;
      direction: CaptionDirection;
      text: string;
      translated_text: string;
      occurred_at: string;
    }>`SELECT id, direction, text, translated_text, occurred_at FROM call_captions ORDER BY id ASC`;
    return {
      status: "closed",
      access_kind: this.state.accessKind,
      transcription_enabled: this.state.transcription,
      transcription_mode: this.state.transcriptionMode,
      translation_enabled: this.state.translation,
      speech_enabled: this.state.speechTranslation,
      source_language: this.state.sourceLanguage,
      target_language: this.state.targetLanguage,
      captions: [...captions],
    };
  }

  private async closeCall(): Promise<void> {
    if (this.state.status === "closed") return;
    if (!this.closeTask) this.closeTask = this.performClose();
    await this.closeTask;
  }

  private async performClose(): Promise<void> {
    // Stop an in-flight Aura stream immediately. Waiting for synthesized audio
    // after the carrier leg has ended can exceed Celmux's bounded close window.
    this.closing = true;
    this.speechGeneration += 1;
    this.keepAliveDispose?.();
    this.keepAliveDispose = null;
    await this.cancelAutoClose();
    // Flux emits the last utterance after end-of-turn detection. Keep the
    // transcription sockets alive for that one final grace
    // interval after Celmux has stopped sending PCM, then close exactly once.
    // Without this, the trailing words of SIP and unattended messages vanish
    // whenever the caller hangs up without a final pause.
    if (this.incomingSTT || this.outgoingSTT) {
      await new Promise(resolve => setTimeout(resolve, 900));
    }
    if (this.state.transcriptionMode === "chunked") {
      for (const direction of ["incoming", "outgoing"] as const) {
        const trailing = this.chunkBuffers[direction];
        this.chunkBuffers[direction] = new Uint8Array(0);
        this.queueChunk(direction, trailing);
      }
      await Promise.allSettled([this.chunkTails.incoming, this.chunkTails.outgoing]);
    }
    // If BYE arrived between Flux's latest interim result and its EndOfTurn
    // event, preserve those trailing words instead of discarding the segment.
    for (const direction of ["incoming", "outgoing"] as const) {
      const trailing = this.pendingInterim[direction];
      this.pendingInterim[direction] = "";
      if (trailing && this.hasRecentSpeech(direction)) this.scheduleCaption(direction, trailing);
    }
    this.incomingSTT?.close();
    this.outgoingSTT?.close();
    this.incomingSTT = null;
    this.outgoingSTT = null;
    // `close()` may synchronously emit the last utterance. Let that callback
    // register its durable write, then wait for every translation/write job
    // before Celmux receives the final call result.
    await Promise.resolve();
    await Promise.allSettled([...this.captionJobs]);
    for (const caption of this.pendingCaptions) {
      this.sql`
        INSERT INTO call_captions (direction, text, translated_text, occurred_at)
        VALUES (${caption.direction}, ${caption.text}, ${caption.translatedText}, ${caption.occurredAt})
      `;
    }
    this.pendingCaptions = [];
    console.info("Celmux call transcription closed", {
      incomingFrames: this.audioFrames.incoming,
      outgoingFrames: this.audioFrames.outgoing,
      captions: [...this.sql<{ id: number }>`SELECT id FROM call_captions`].length,
    });
    this.setState({ ...this.state, status: "closed", ticketDigests: EMPTY_DIGESTS });
    for (const connection of this.getConnections()) connection.close(1000, "call ended");
    // Transcript durability is complete at this point. Realtime resources are
    // best-effort cleanup and must not delay the result Celmux persists.
    this.ctx.waitUntil(this.closeSfuResources());
  }

  /**
   * Pull the carrier downlink into the browser's session.
   *
   * The SFU has to negotiate its own m-line for the track: binding it to the
   * browser's reserved recvonly transceiver answers `sendonly` and reports
   * `requiresImmediateRenegotiation:false`, yet the SFU then never sends a
   * single RTP packet on that m-line (measured: inbound-rtp stays at 0 bytes
   * while carrier audio is flowing), so the caller hears nothing.
   */
  private bindDownlink(sfu: SFUConfig): Promise<DownlinkBind> {
    if (this.downlinkBind) return this.downlinkBind;
    const started = Date.now();
    const task = (async (): Promise<DownlinkBind> => {
      const subscribed = await addSFUTracks(sfu, this.state.browserSessionId, {
        tracks: [{
          location: "remote",
          sessionId: this.state.downlinkSessionId,
          trackName: this.state.downlinkTrackName,
          kind: "audio",
        }],
      }) as {
        sessionDescription?: { type?: string; sdp?: string };
        requiresImmediateRenegotiation?: boolean;
        tracks?: Array<{ trackName?: string; mid?: string }>;
      };
      // Never trim an SDP: Chrome rejects a description whose last line has no
      // CRLF terminator, and the SFU's offer ends with a direction attribute.
      const offerSdp = subscribed.requiresImmediateRenegotiation === true
        ? subscribed.sessionDescription?.sdp || ""
        : "";
      let result: DownlinkBind = { status: "ready" };
      if (offerSdp.trim()) {
        const browserDownlink = subscribed.tracks?.find(
          track => track.trackName === this.state.downlinkTrackName,
        );
        if (!browserDownlink?.mid) throw new Error("downlink_track_mid_unavailable");
        this.setState({
          ...this.state,
          browserDownlinkMid: browserDownlink.mid,
          pendingDownlinkOfferSdp: offerSdp,
        });
        result = { status: "offer", sdp: offerSdp };
      } else {
        this.setState({ ...this.state, downlinkReady: true, pendingDownlinkOfferSdp: "" });
      }
      console.info("Celmux downlink bind", {
        sinceInitMs: Date.now() - this.initializedAt,
        durationMs: Date.now() - started,
        boundMid: subscribed.tracks?.[0]?.mid || "",
        requiresRenegotiation: result.status === "offer",
      });
      return result;
    })();
    this.downlinkBind = task;
    // A failed bind must stay retryable for the next subscribe attempt.
    void task.catch(() => {
      if (this.downlinkBind === task) this.downlinkBind = null;
    });
    return task;
  }

  /**
   * Create the SFU uplink adapter in the background. It carries the browser's
   * microphone to the Agent, so the caller's downlink audio path does not
   * wait for this WebSocket adapter to connect.
   */
  private async createUplinkAdapter(sfu: SFUConfig, uplinkUrl: string): Promise<void> {
    try {
      const uplink = await createSFUWebSocketAdapter(sfu, [{
        location: "remote",
        sessionId: this.state.browserSessionId,
        trackName: "browser-uplink",
        endpoint: uplinkUrl,
        outputCodec: "pcm",
      }]) as {
        errorCode?: string;
        errorDescription?: string;
        tracks?: Array<{
          trackName?: string;
          adapterId?: string;
          errorCode?: string;
          errorDescription?: string;
        }>;
      };
      const uplinkTrack = uplink.tracks?.[0];
      if (!uplinkTrack?.adapterId) {
        const detail = [
          uplinkTrack?.errorCode || uplink.errorCode,
          uplinkTrack?.errorDescription || uplink.errorDescription,
        ].filter(Boolean).join(": ");
        this.broadcastControl({
          type: "error",
          message: `Uplink adapter unavailable${detail ? `: ${detail}` : ""}`,
        });
        return;
      }
      if (this.closing || this.state.status !== "ready") {
        await closeSFUWebSocketAdapters(sfu, [uplinkTrack.adapterId]);
        return;
      }
      this.setState({ ...this.state, uplinkAdapterId: uplinkTrack.adapterId });
    } catch (error) {
      this.reportError(error, "Cloudflare 上行适配器创建失败");
    }
  }

  private async closeSfuResources(): Promise<void> {
    const sfu = sfuConfig(this.env);
    if (sfu) {
      await cleanupSFUResources(sfu, [
        this.state.downlinkAdapterId,
        this.state.uplinkAdapterId,
      ], [
        {
          sessionId: this.state.browserSessionId,
          mids: [
            this.state.browserTrackMid,
            this.state.browserDownlinkMid,
          ],
        },
        {
          sessionId: this.state.downlinkSessionId,
          mids: [this.state.downlinkTrackMid],
        },
      ]);
    }
  }
}

function validAccessKind(value: unknown): value is PersistedCallState["accessKind"] {
  return value === "browser" || value === "sip" || value === "automatic";
}

function validTickets(tickets: RoleTickets | undefined): tickets is RoleTickets {
  return tickets !== undefined
    && [tickets.carrier, tickets.access, tickets["sfu-uplink"], tickets["sfu-downlink"], tickets.control]
      .every(ticket => /^[0-9a-f]{64}$/.test(ticket));
}

async function digestTickets(tickets: RoleTickets): Promise<Record<MediaRole, string>> {
  return {
    carrier: await digest(tickets.carrier),
    access: await digest(tickets.access),
    "sfu-uplink": await digest(tickets["sfu-uplink"]),
    "sfu-downlink": await digest(tickets["sfu-downlink"]),
    control: await digest(tickets.control),
  };
}

async function digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
}

function validRoleUrl(value: string, role: MediaRole): { ticket: string } | null {
  try {
    const url = new URL(value);
    const ticket = url.searchParams.get("ticket") || "";
    if (url.protocol !== "wss:"
      || url.searchParams.get("role") !== role
      || !/^[0-9a-f]{64}$/.test(ticket)) {
      return null;
    }
    return { ticket };
  } catch {
    return null;
  }
}
