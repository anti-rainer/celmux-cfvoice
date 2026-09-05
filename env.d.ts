interface Env {
  AI: Ai;
  CelmuxCallAgent: DurableObjectNamespace;
  CELMUX_AGENT_TOKEN?: string;
  CLOUDFLARE_SFU_APP_ID?: string;
  CLOUDFLARE_SFU_API_TOKEN?: string;
  /** Deprecated aliases kept so existing deployments keep working during migration. */
  CLOUDFLARE_REALTIME_APP_ID?: string;
  CLOUDFLARE_REALTIME_API_TOKEN?: string;
}
