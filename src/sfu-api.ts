const SFU_API_BASE = "https://rtc.live.cloudflare.com/v1";

export type SFUConfig = { appId: string; apiToken: string };

export type SFUTrackRef = { sessionId: string; mids: string[] };

export async function closeSFUWebSocketAdapters(config: SFUConfig, adapterIds: string[]): Promise<void> {
  const tracks = adapterIds.filter(Boolean).map(adapterId => ({ adapterId }));
  if (tracks.length === 0) return;
  const response = await fetch(`${SFU_API_BASE}/apps/${config.appId}/adapters/websocket/close`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tracks }),
  });
  if (!response.ok) throw new Error(`SFU adapter close failed: ${response.status}`);
}

export async function closeSFUTracks(config: SFUConfig, sessionId: string, mids: string[]): Promise<void> {
  const tracks = mids.filter(Boolean).map(mid => ({ mid }));
  if (!sessionId || tracks.length === 0) return;
  const response = await fetch(`${SFU_API_BASE}/apps/${config.appId}/sessions/${sessionId}/tracks/close`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${config.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tracks, force: true }),
  });
  if (!response.ok) throw new Error(`SFU close failed: ${response.status}`);
}

/** Best-effort cleanup for partially-created media resources. */
export async function cleanupSFUResources(
  config: SFUConfig,
  adapterIds: string[],
  tracks: SFUTrackRef[],
): Promise<void> {
  await Promise.allSettled([
    closeSFUWebSocketAdapters(config, adapterIds),
    ...tracks.map(track => closeSFUTracks(config, track.sessionId, track.mids)),
  ]);
}
