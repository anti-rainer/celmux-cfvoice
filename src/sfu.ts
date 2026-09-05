import {
  addSFUTracks,
  createSFUSession,
  createSFUWebSocketAdapter,
} from "@cloudflare/voice";
import { authorized, corsHeaders, jsonError } from "./auth";
import type { CallAccessKind, CallFeatureConfig, RoleTickets } from "./protocol";
import type { SFUConfig } from "./sfu-api";

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

function config(env: Env): SFUConfig | null {
  const appId = env.CLOUDFLARE_REALTIME_APP_ID?.trim();
  const apiToken = env.CLOUDFLARE_REALTIME_API_TOKEN?.trim();
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
    const response = await agent(env, closeMatch[1]).fetch("https://agent.internal/close", {
      method: "POST",
      headers: internalHeaders(env),
    });
    if (!response.ok) return jsonError("close_failed", 502, headers);
    const result = await response.json<Record<string, unknown>>();
    return Response.json(result, { headers });
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
    const sourceLanguage = body.features?.sourceLanguage?.trim() || "auto";
    const targetLanguage = body.features?.targetLanguage?.trim() || "zh-CN";
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
    const downlink = await createSFUWebSocketAdapter(sfu, [{
      location: "local",
      trackName: "celmux-downlink",
      endpoint: roleUrl("sfu-downlink"),
      inputCodec: "pcm",
      mode: "buffer",
    }]) as AdapterResponse;
    const downlinkTrack = downlink.tracks?.[0];
    if (!downlinkTrack?.sessionId || !downlinkTrack.trackName) throw new Error("downlink_adapter_failed");

    const browser = await createSFUSession(sfu);
    const published = await addSFUTracks(sfu, browser.sessionId, {
      sessionDescription: { type: "offer", sdp },
      // The downlink adapter is already created above. Add it in the initial
      // tracks request so the first SDP answer contains both directions. This
      // avoids waiting for a second subscribe/renegotiate round before the
      // caller can hear carrier audio.
      tracks: [
        { location: "local", mid, trackName: "browser-uplink" },
        {
          location: "remote",
          sessionId: downlinkTrack.sessionId,
          trackName: downlinkTrack.trackName,
        },
      ],
    }) as TrackResponse;
    const answer = published.sessionDescription;
    if (answer?.type !== "answer" || !answer.sdp) throw new Error("sfu_answer_missing");

    const browserTrack = published.tracks?.find(track => track.trackName === "browser-uplink");
    const browserDownlink = published.tracks?.find(
      track => track.trackName === downlinkTrack.trackName,
    );
    const downlinkReady = !published.requiresImmediateRenegotiation
      && Boolean(browserDownlink?.mid);
    await callAgent.fetch("https://agent.internal/resources", {
      method: "POST",
      headers: internalHeaders(env),
      body: JSON.stringify({
        browserSessionId: browser.sessionId,
        browserTrackMid: browserTrack?.mid || mid,
        browserDownlinkMid: downlinkReady ? browserDownlink?.mid || "" : "",
        downlinkSessionId: downlinkTrack.sessionId,
        downlinkTrackName: downlinkTrack.trackName,
        downlinkTrackMid: downlinkTrack.mid || "",
        downlinkAdapterId: downlinkTrack.adapterId || "",
        uplinkAdapterId: "",
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
    const message = error instanceof Error ? error.message : "sfu_request_failed";
    return Response.json({ error: "sfu_request_failed", message }, { status: 502, headers });
  }
}
