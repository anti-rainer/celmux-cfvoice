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
} from "@cloudflare/voice";
import {
  PCM16_20MS_BYTES,
  asArrayBuffer,
  roleFromUrl,
  type CaptionDirection,
  type ConnectionState,
  type MediaRole,
  type PersistedCallState,
  type RoleTickets,
} from "./protocol";
import { timingSafeTextEqual } from "./auth";
import { cleanupSFUResources, type SFUConfig } from "./sfu-api";

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
  transcription: false,
  transcriptionMode: "realtime",
  translation: false,
  speechTranslation: false,
  sourceLanguage: "auto",
  targetLanguage: "zh",
  browserSessionId: "",
  browserTrackMid: "",
  browserDownlinkMid: "",
  pendingDownlinkOfferSdp: "",
  downlinkSessionId: "",
  downlinkTrackName: "",
  downlinkTrackMid: "",
  downlinkAdapterId: "",
  uplinkAdapterId: "",
};

type InitializeBody = {
  tickets: RoleTickets;
  features: Partial<PersistedCallState>;
};

type ResourceBody = Pick<PersistedCallState,
  "browserSessionId" | "browserTrackMid" | "browserDownlinkMid" | "downlinkSessionId" |
  "downlinkTrackName" | "downlinkTrackMid" | "downlinkAdapterId" | "uplinkAdapterId">;

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
  private lastChunkText: Record<CaptionDirection, string> = { incoming: "", outgoing: "" };
  private downlinkResampleSample: number | null = null;

  shouldSendProtocolMessages(): boolean {
    return false;
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
      this.closing = false;
      this.closeTask = null;
      this.sttRetryAt = { incoming: 0, outgoing: 0 };
      this.pendingInterim = { incoming: "", outgoing: "" };
      this.audioFrames = { incoming: 0, outgoing: 0 };
      this.recentSpeechAt = { incoming: 0, outgoing: 0 };
      this.chunkBuffers = { incoming: new Uint8Array(0), outgoing: new Uint8Array(0) };
      this.chunkTails = { incoming: Promise.resolve(), outgoing: Promise.resolve() };
      this.lastChunkText = { incoming: "", outgoing: "" };
      this.downlinkResampleSample = null;
      this.setState({
        ...EMPTY_STATE,
        ...features,
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
      });
      if (transcription && transcriptionMode === "realtime") {
        // Start both streaming recognizers while the signalling/SFU path is
        // being prepared. The first spoken frame must not pay model startup
        // latency, and a transient failed socket is recreated by feed().
        const sessions = [this.transcriber("incoming"), this.transcriber("outgoing")]
          .filter((session): session is TranscriberSession => session !== null);
        this.ctx.waitUntil(Promise.allSettled(sessions.map(
          session => session.waitUntilReady?.() ?? Promise.resolve(),
        )));
      }
      return Response.json({ status: "ready" });
    }
    if (path.endsWith("/resources") && request.method === "POST") {
      const body = await request.json<ResourceBody>();
      this.setState({ ...this.state, ...body });
      return Response.json({ status: "saved" });
    }
    if (path.endsWith("/subscribe") && request.method === "POST") {
      const body = await request.json<{ uplink_url?: string }>();
      const sfu = sfuConfig(this.env);
      if (!sfu
        || !this.state.browserSessionId
        || !this.state.downlinkSessionId
        || !this.state.downlinkTrackName) {
        return new Response("SFU session unavailable", { status: 409 });
      }
      // The initial tracks request may already include the downlink. Keep
      // subscribe idempotent so older clients can safely call this endpoint
      // without triggering a needless retry/error loop.
      if (this.state.pendingDownlinkOfferSdp) {
        return Response.json({
          offer: { type: "offer", sdp: this.state.pendingDownlinkOfferSdp },
          retry: true,
        });
      }
      if (this.state.browserDownlinkMid) {
        return Response.json({ status: "ready", already_subscribed: true });
      }
      const uplinkUrl = body.uplink_url || "";
      const parsedUplink = validRoleUrl(uplinkUrl, "sfu-uplink");
      if (!parsedUplink
        || await digest(parsedUplink.ticket) !== this.state.ticketDigests["sfu-uplink"]) {
        return new Response("Invalid uplink adapter URL", { status: 400 });
      }
      let uplinkAdapterId = this.state.uplinkAdapterId;
      if (!uplinkAdapterId) {
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
          return new Response(
            `Uplink adapter unavailable${detail ? `: ${detail}` : ""}`,
            { status: 502 },
          );
        }
        uplinkAdapterId = uplinkTrack.adapterId;
        // Persist immediately so a later SFU failure or retry can reuse and
        // close this adapter instead of creating a second one.
        this.setState({ ...this.state, uplinkAdapterId });
      }
      const subscribed = await addSFUTracks(sfu, this.state.browserSessionId, {
        tracks: [{
          location: "remote",
          sessionId: this.state.downlinkSessionId,
          trackName: this.state.downlinkTrackName,
        }],
      }) as {
        sessionDescription?: { type?: string; sdp?: string };
        requiresImmediateRenegotiation?: boolean;
        tracks?: Array<{ trackName?: string; mid?: string }>;
      };
      const offer = subscribed.sessionDescription;
      if (!subscribed.requiresImmediateRenegotiation || offer?.type !== "offer" || !offer.sdp) {
        return new Response("Downlink offer unavailable", { status: 502 });
      }
      const browserDownlink = subscribed.tracks?.find(
        track => track.trackName === this.state.downlinkTrackName,
      );
      if (!browserDownlink?.mid) {
        return new Response("Downlink track mid unavailable", { status: 502 });
      }
      this.setState({
        ...this.state,
        browserDownlinkMid: browserDownlink.mid,
        pendingDownlinkOfferSdp: offer.sdp,
        uplinkAdapterId,
      });
      return Response.json({ offer: { type: "offer", sdp: offer.sdp } });
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
      await renegotiateSFUSession(sfu, this.state.browserSessionId, answer.sdp);
      this.setState({ ...this.state, pendingDownlinkOfferSdp: "" });
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
    if (hasLikelySpeechFrame(new Uint8Array(audio))) {
      this.recentSpeechAt[direction] = Date.now();
    }
    if (this.state.transcriptionMode === "chunked") {
      this.feedChunked(direction, audio);
      return;
    }
    const session = this.transcriber(direction);
    if (!session) return;
    for (let offset = 0; offset + PCM16_20MS_BYTES <= audio.byteLength; offset += PCM16_20MS_BYTES) {
      session.feed(audio.slice(offset, offset + PCM16_20MS_BYTES));
    }
  }

  /** Feed short independent PCM chunks to Whisper at the edge.  The media
   * path remains synchronous; inference is chained per direction so a slow
   * request can never reorder captions or stall telephone audio. */
  private feedChunked(direction: CaptionDirection, audio: ArrayBuffer): void {
    const chunkBytes = 16_000 * 2 * 2; // 2 seconds, mono PCM16 at 16 kHz
    this.chunkBuffers[direction] = appendBytes(this.chunkBuffers[direction], new Uint8Array(audio) as Uint8Array<ArrayBuffer>);
    while (this.chunkBuffers[direction].byteLength >= chunkBytes) {
      const chunk = this.chunkBuffers[direction].slice(0, chunkBytes);
      this.chunkBuffers[direction] = this.chunkBuffers[direction].slice(chunkBytes);
      this.chunkTails[direction] = this.chunkTails[direction]
        .then(() => this.transcribeChunk(direction, chunk))
        .catch(error => this.reportError(error, "Cloudflare Whisper 转写失败"));
      this.ctx.waitUntil(this.chunkTails[direction]);
    }
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
    this.sql`
      CREATE TABLE IF NOT EXISTS call_captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )
    `;
    this.sql`
      INSERT INTO call_captions (direction, text, translated_text, occurred_at)
      VALUES (${direction}, ${clean}, ${translatedText}, ${event.occurred_at})
    `;
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
    if (transcriptionMode !== this.state.transcriptionMode) {
      this.incomingSTT?.close();
      this.outgoingSTT?.close();
      this.incomingSTT = null;
      this.outgoingSTT = null;
      this.chunkBuffers = { incoming: new Uint8Array(0), outgoing: new Uint8Array(0) };
      this.lastChunkText = { incoming: "", outgoing: "" };
    }
    if (speechTranslation !== this.state.speechTranslation) this.speechGeneration += 1;
    this.setState({
      ...this.state,
      transcription,
      transcriptionMode,
      translation: transcription && value.translation === true,
      speechTranslation,
    });
    if (transcription && transcriptionMode === "realtime") {
      this.transcriber("incoming");
      this.transcriber("outgoing");
    }
  }

  private outgoingSpeechReplacementEnabled(): boolean {
    return this.state.accessKind !== "automatic"
      && this.state.transcription
      && this.state.speechTranslation
      && explicitLanguage(this.state.targetLanguage);
  }

  private async streamTranslatedSpeech(text: string, generation: number): Promise<void> {
    if (!this.speechStreamActive(generation)) return;
    const response = await this.env.AI.run("@cf/deepgram/aura-1", {
      text,
      speaker: "asteria",
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
    this.sql`
      CREATE TABLE IF NOT EXISTS call_captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )
    `;
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
        if (trailing.byteLength >= 640) {
          this.chunkTails[direction] = this.chunkTails[direction]
            .then(() => this.transcribeChunk(direction, trailing))
            .catch(error => this.reportError(error, "Cloudflare Whisper 转写失败"));
          this.ctx.waitUntil(this.chunkTails[direction]);
        }
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
    this.sql`
      CREATE TABLE IF NOT EXISTS call_captions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        direction TEXT NOT NULL,
        text TEXT NOT NULL,
        translated_text TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      )
    `;
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

/** Apply a tiny (2 ms) linear fade-in to each synthesized utterance. Some TTS
 * providers begin a PCM response at a non-zero sample, which is heard as a
 * short click immediately before every translated phrase. */
function softenPcmStart(frame: Uint8Array): void {
  const samples = Math.min(32, Math.floor(frame.byteLength / 2));
  const view = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
  for (let index = 0; index < samples; index += 1) {
    const gain = index / samples;
    view.setInt16(index * 2, Math.round(view.getInt16(index * 2, true) * gain), true);
  }
}

function sfuConfig(env: Env): SFUConfig | null {
  const appId = (env.CLOUDFLARE_SFU_APP_ID || env.CLOUDFLARE_REALTIME_APP_ID)?.trim();
  const apiToken = (env.CLOUDFLARE_SFU_API_TOKEN || env.CLOUDFLARE_REALTIME_API_TOKEN)?.trim();
  return appId && apiToken ? { appId, apiToken } : null;
}

function validAccessKind(value: unknown): value is PersistedCallState["accessKind"] {
  return value === "browser" || value === "sip" || value === "automatic";
}

function normalizeLanguage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  // Whisper accepts ISO-639-1 language codes (zh, en, ...), not regional
  // BCP-47 tags such as zh-CN. Keep the Agent state in this canonical form so
  // both realtime Flux and chunked Whisper receive the same value.
  if (normalized === "auto") return "auto";
  if (normalized.startsWith("zh")) return "zh";
  return normalized.split("-", 1)[0] || fallback;
}

function explicitLanguage(value: string): boolean {
  return Boolean(value.trim()) && value.trim().toLowerCase() !== "auto";
}

/**
 * `sourceLanguage` describes the remote party. Automatic detection remains
 * valid for incoming transcription, but synthesized uplink speech needs a
 * concrete target immediately. English is the deterministic default until a
 * remote language is selected explicitly.
 */
function outgoingTranslationLanguage(sourceLanguage: string): string {
  return explicitLanguage(sourceLanguage) ? sourceLanguage.trim() : "en";
}

function appendBytes(
  left: Uint8Array<ArrayBufferLike>,
  right: Uint8Array<ArrayBufferLike>,
): Uint8Array<ArrayBuffer> {
  if (!right.byteLength) return left as Uint8Array<ArrayBuffer>;
  const combined = new Uint8Array(left.byteLength + right.byteLength);
  combined.set(left);
  combined.set(right, left.byteLength);
  return combined;
}

type PcmLevel = { rms: number; span: number };

function pcmLevel(pcm: Uint8Array, offset: number, length: number): PcmLevel {
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

function hasLikelySpeechFrame(pcm: Uint8Array): boolean {
  for (let offset = 0; offset + PCM16_20MS_BYTES <= pcm.byteLength; offset += PCM16_20MS_BYTES) {
    const level = pcmLevel(pcm, offset, PCM16_20MS_BYTES);
    if (level.rms >= 160 && level.span >= 800) return true;
  }
  return false;
}

/** Conservative pre-inference VAD for independent Whisper chunks. Four
 * voiced 20 ms frames are enough to retain short words, while isolated PCM
 * clicks and idle microphone noise never reach the generative decoder. */
function containsLikelySpeech(pcm: Uint8Array): boolean {
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

/** Convert one or more 16 kHz mono PCM frames to 48 kHz stereo PCM.
 *
 * The SFU adapter consumes signed little-endian PCM.  A sample-and-hold 3x
 * expansion is technically valid, but its staircase edges contain a strong
 * image in the telephone band and make consonant onsets sound like a tiny
 * burst.  Linear interpolation keeps the same exact 20 ms clock while
 * removing that artificial high-frequency component.
 */
function upsample16kMonoTo48kStereoLinear(
  mono16k: ArrayBuffer,
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

function pcmToWavBase64(pcm: Uint8Array): string {
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

async function translate(ai: Ai, text: string, target: string): Promise<string> {
  if (!target || target.toLowerCase() === "auto") return "";
  const result = await ai.run("@cf/meta/llama-3.2-3b-instruct", {
    messages: [
      { role: "system", content: `Translate telephone speech to ${target}. Return only the translation.` },
      { role: "user", content: text },
    ],
    max_tokens: 256,
    temperature: 0,
  });
  if (!result || typeof result !== "object" || !("response" in result)) return "";
  return String((result as { response?: unknown }).response || "").trim();
}
