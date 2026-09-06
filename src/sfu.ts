import {
  addSFUTracks,
  createSFUSession,
  createSFUWebSocketAdapter,
} from "@cloudflare/voice";
import { authorized, corsHeaders, jsonError } from "./auth";
import type { CallAccessKind, CallFeatureConfig, RoleTickets } from "./protocol";
import { cleanupSFUResources, type SFUConfig } from "./sfu-api";
import { translate } from "./call-agent";

type AdapterTrack = {
  sessionId?: string;
  trackName?: string;
  adapterId?: string;
  mid?: string;
};

type AdapterResponse = { tracks?: AdapterTrack[] };
type TrackResponse = {
  sessionDescription?: { type?: string; sdp?: string };
  requiresImmediateRenegotiation?: boolean;
  tracks?: AdapterTrack[];
};

type OpenCallBody = {
  access_kind?: CallAccessKind;
  sdp?: string;
  mid?: string;
  features?: Partial<CallFeatureConfig>;
};

type RenegotiateBody = {
  answer?: { type?: string; sdp?: string };
};

type SubscribeBody = { uplink_url?: string };

type VoiceTestBody = {
  kind?: "transcription" | "translation" | "speech";
  audio_base64?: string;
  text?: string;
  target_language?: string;
  voice?: string;
  language?: string;
  translate?: boolean;
};

function config(env: Env): SFUConfig | null {
  const appId = (env.CLOUDFLARE_SFU_APP_ID || env.CLOUDFLARE_REALTIME_APP_ID)?.trim();
  const apiToken = (env.CLOUDFLARE_SFU_API_TOKEN || env.CLOUDFLARE_REALTIME_API_TOKEN)?.trim();
  return appId && apiToken ? { appId, apiToken } : null;
}

function ticket(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
}

function tickets(): RoleTickets {
  return {
    carrier: ticket(),
    access: ticket(),
    "sfu-uplink": ticket(),
    "sfu-downlink": ticket(),
    control: ticket(),
  };
}

function agent(env: Env, callId: string): DurableObjectStub {
  return env.CelmuxCallAgent.get(env.CelmuxCallAgent.idFromName(callId));
}

function internalHeaders(env: Env): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Celmux-Internal-Token": env.CELMUX_AGENT_TOKEN || "",
  };
}

export async function handleCallApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/api/calls")) return null;
  const headers = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (!authorized(request, env.CELMUX_AGENT_TOKEN)) return jsonError("unauthorized", 401, headers);

  const closeMatch = url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)$/i);
  if (closeMatch && request.method === "DELETE") {
    try {
      const response = await agent(env, closeMatch[1]).fetch("https://agent.internal/close", {
        method: "POST",
        headers: internalHeaders(env),
      });
      if (!response.ok) return jsonError("close_failed", 502, headers);
      const result = await response.json<Record<string, unknown>>();
      return Response.json(result, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "close_failed";
      return jsonError(message, 502, headers);
    }
  }

  const renegotiateMatch = url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/renegotiate$/i);
  if (renegotiateMatch && request.method === "POST") {
    try {
      const body = await request.json<RenegotiateBody>();
      const response = await agent(env, renegotiateMatch[1]).fetch("https://agent.internal/renegotiate", {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const message = await response.text();
        return jsonError(message || "renegotiation_failed", response.status, headers);
      }
      return Response.json({ status: "ready" }, { headers });
    } catch (error) {
      const message = error instanceof Error ? error.message : "renegotiation_failed";
      return Response.json({ error: "renegotiation_failed", message }, { status: 502, headers });
    }
  }

  const subscribeMatch = url.pathname.match(/^\/api\/calls\/([0-9a-f-]+)\/subscribe$/i);
  if (subscribeMatch && request.method === "POST") {
    try {
      const body = await request.json<SubscribeBody>();
      const response = await agent(env, subscribeMatch[1]).fetch("https://agent.internal/subscribe", {
        method: "POST",
        headers: internalHeaders(env),
        body: JSON.stringify(body),
      });
      const payload = await response.text();
      if (!response.ok) return jsonError(payload || "subscription_failed", response.status, headers);
      return new Response(payload, { status: 200, headers: { ...headers, "Content-Type": "application/json" } });
    } catch (error) {
      const message = error instanceof Error ? error.message : "subscription_failed";
      return Response.json({ error: "subscription_failed", message }, { status: 502, headers });
    }
  }

  if (url.pathname !== "/api/calls" || request.method !== "POST") {
    return jsonError("method_not_allowed", 405, headers);
  }

  let callId = "";
  let createdSfu: SFUConfig | null = null;
  const createdAdapterIds: string[] = [];
  const createdTracks: Array<{ sessionId: string; mids: string[] }> = [];
  try {
    const body = await request.json<OpenCallBody>();
    const accessKind = body.access_kind || "browser";
    if (accessKind !== "browser" && accessKind !== "sip" && accessKind !== "automatic") {
      return jsonError("invalid_access_kind", 400, headers);
    }
    // SDP is a line-oriented protocol and Cloudflare requires its terminating
    // CRLF. Use trim only for the emptiness check; never mutate the payload.
    const sdp = typeof body.sdp === "string" ? body.sdp : "";
    const mid = body.mid?.trim() || "0";
    if ((accessKind === "browser" && !sdp.trim()) || sdp.length > 256 * 1024 || mid.length > 16) {
      return jsonError("invalid_offer", 400, headers);
    }

    callId = crypto.randomUUID();
    const roleTickets = tickets();
    const callAgent = agent(env, callId);
    const transcription = body.features?.transcription === true;
    const transcriptionMode = body.features?.transcriptionMode === "chunked" ? "chunked" : "realtime";
    const sourceLanguage = normalizeLanguage(body.features?.sourceLanguage, "auto");
    const targetLanguage = normalizeLanguage(body.features?.targetLanguage, "zh");
    const speechTranslation = accessKind !== "automatic"
      && transcription
      && body.features?.speechTranslation === true
      && targetLanguage.toLowerCase() !== "auto";
    const initialized = await callAgent.fetch("https://agent.internal/initialize", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({
        tickets: roleTickets,
        features: {
          transcription,
          transcriptionMode,
          translation: transcription && body.features?.translation === true,
          speechTranslation,
          sourceLanguage,
          targetLanguage,
          accessKind,
        },
      }),
    });
    if (!initialized.ok) throw new Error("agent_initialization_failed");

    const protocol = url.protocol === "https:" ? "wss:" : "ws:";
    const callUrl = `${protocol}//${url.host}/call/${callId}/media`;
    const roleUrl = (role: keyof RoleTickets) =>
      `${callUrl}?protocol=false&role=${role}&ticket=${encodeURIComponent(roleTickets[role])}`;

    const baseResponse = {
      session_id: callId,
      carrier_url: roleUrl("carrier"),
      access_url: accessKind === "sip" || accessKind === "automatic" ? roleUrl("access") : undefined,
      control_url: roleUrl("control"),
    };
    if (accessKind !== "browser") {
      return Response.json(baseResponse, { headers });
    }

    const sfu = config(env);
    if (!sfu) throw new Error("sfu_not_configured");
    createdSfu = sfu;
    // Allocate sequentially so every successful resource is visible to the
    // failure path. Promise.all would hide the successful sibling when one
    // request rejects, leaving an adapter or session behind.
    const downlink = await createSFUWebSocketAdapter(sfu, [{
      location: "local",
      trackName: "celmux-downlink",
      endpoint: roleUrl("sfu-downlink"),
      inputCodec: "pcm",
      mode: "buffer",
    }]) as AdapterResponse;
    const downlinkTrack = downlink.tracks?.[0];
    if (downlinkTrack?.adapterId) createdAdapterIds.push(downlinkTrack.adapterId);
    if (!downlinkTrack?.sessionId || !downlinkTrack.trackName) throw new Error("downlink_adapter_failed");
    if (downlinkTrack.mid) createdTracks.push({ sessionId: downlinkTrack.sessionId, mids: [downlinkTrack.mid] });
    const browser = await createSFUSession(sfu);
    // Realtime SFU currently rejects a request that pushes and pulls tracks at
    // the same time (HTTP 406). Establish the browser uplink first, then the
    // client calls /subscribe for a separate downlink renegotiation.
    const published = await addSFUTracks(sfu, browser.sessionId, {
      sessionDescription: { type: "offer", sdp },
      tracks: [{ location: "local", mid, trackName: "browser-uplink" }],
    }) as TrackResponse;
    const browserTrack = published.tracks?.find(track => track.trackName === "browser-uplink");
    createdTracks.push({ sessionId: browser.sessionId, mids: [browserTrack?.mid || mid] });
    const answer = published.sessionDescription;
    if (answer?.type !== "answer" || !answer.sdp) throw new Error("sfu_answer_missing");

    const downlinkReady = false;
    await callAgent.fetch("https://agent.internal/resources", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({
        browserSessionId: browser.sessionId,
        browserTrackMid: browserTrack?.mid || mid,
        browserDownlinkMid: "",
        downlinkSessionId: downlinkTrack.sessionId,
        downlinkTrackName: downlinkTrack.trackName,
        downlinkTrackMid: downlinkTrack.mid || "",
        downlinkAdapterId: downlinkTrack.adapterId || "",
        uplinkAdapterId: "",
        pendingDownlinkOfferSdp: "",
      }),
    });

    return Response.json({
      ...baseResponse,
      uplink_url: roleUrl("sfu-uplink"),
      downlink_ready: downlinkReady,
      answer: { type: "answer", sdp: answer.sdp },
    }, { headers });
  } catch (error) {
    if (callId) {
      await agent(env, callId).fetch("https://agent.internal/close", {
        method: "POST",
        headers: internalHeaders(env),
      }).catch(() => undefined);
    }
    if (createdSfu) {
      await cleanupSFUResources(createdSfu, createdAdapterIds, createdTracks);
    }
    const message = error instanceof Error ? error.message : "sfu_request_failed";
    return Response.json({ error: "sfu_request_failed", message }, { status: 502, headers });
  }
}

/** Lightweight effect tests used by the Cloudflare Voice settings panel. The
 * endpoint uses the exact Workers AI models and speaker path used by calls,
 * but never creates an SFU session or writes call captions. */
export async function handleVoiceTestApi(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== "/api/test") return null;
  const headers = corsHeaders(request, env);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  if (request.method !== "POST") return jsonError("method_not_allowed", 405, headers);
  if (!authorized(request, env.CELMUX_AGENT_TOKEN)) return jsonError("unauthorized", 401, headers);
  try {
    const body = await request.json<VoiceTestBody>();
    const kind = body.kind;
    if (kind === "translation") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const target = typeof body.target_language === "string" ? body.target_language.trim() : "zh";
      if (!text || text.length > 4_096) return jsonError("invalid_text", 400, headers);
      return Response.json({ status: "ok", text, translated_text: await translate(env.AI, text, target) }, { headers });
    }
    if (kind === "transcription") {
      const audio = typeof body.audio_base64 === "string" ? body.audio_base64.trim() : "";
      if (!audio || audio.length > 8_000_000) return jsonError("invalid_audio", 400, headers);
      const result = await env.AI.run("@cf/openai/whisper-large-v3-turbo", {
        audio,
        task: "transcribe",
        vad_filter: true,
        condition_on_previous_text: false,
        no_speech_threshold: 0.45,
      }) as { text?: unknown; language?: unknown };
      return Response.json({ status: "ok", text: String(result?.text || "").trim(), language: String(result?.language || "auto") }, { headers });
    }
    if (kind === "speech") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const language = typeof body.language === "string" ? body.language.trim() : "en";
      const speechText = body.translate === true ? await translate(env.AI, text, language) : text;
      const voice = typeof body.voice === "string" && /^[a-z][a-z0-9_-]{1,31}$/i.test(body.voice.trim())
        ? body.voice.trim().toLowerCase()
        : "asteria";
      if (!text || text.length > 4_096) return jsonError("invalid_text", 400, headers);
      const response = await (env.AI.run as unknown as (model: string, input: unknown, options: unknown) => Promise<Response>)("@cf/deepgram/aura-1", {
        text: speechText || text,
        speaker: voice,
        encoding: "linear16",
        container: "none",
        sample_rate: 16_000,
      }, { returnRawResponse: true });
      if (!response.ok || !response.body) return jsonError(`speech_failed_${response.status}`, 502, headers);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return Response.json({ status: "ok", voice, language, sample_rate: 16_000, audio_base64: bytesToBase64(bytes) }, { headers });
    }
    return jsonError("invalid_test_kind", 400, headers);
  } catch (error) {
    return jsonError(error instanceof Error ? error.message : "voice_test_failed", 502, headers);
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let output = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 0x8000) {
    output += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.byteLength)));
  }
  return btoa(output);
}

function normalizeLanguage(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  const normalized = value.trim().replaceAll("_", "-").toLowerCase();
  if (normalized === "auto") return "auto";
  if (normalized.startsWith("zh")) return "zh";
  return normalized.split("-", 1)[0] || fallback;
}
