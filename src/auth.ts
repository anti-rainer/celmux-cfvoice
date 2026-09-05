export function corsHeaders(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get("Origin") || "";
  return {
    // The API is protected by the per-installation Bearer token. Reflect the
    // requesting origin so LAN IPs and public hostnames work without an
    // additional origin setting in Celmux.
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "POST, DELETE, OPTIONS",
    Vary: "Origin",
  };
}

export function authorized(request: Request, secret: string | undefined): boolean {
  const expected = secret?.trim();
  return Boolean(expected)
    && timingSafeTextEqual(request.headers.get("Authorization") || "", `Bearer ${expected}`);
}

export function timingSafeTextEqual(actual: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const actualBytes = encoder.encode(actual);
  const expectedBytes = encoder.encode(expected);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(left: ArrayBufferView, right: ArrayBufferView): boolean;
  };
  return actualBytes.byteLength === expectedBytes.byteLength
    && subtle.timingSafeEqual(actualBytes, expectedBytes);
}

export function jsonError(message: string, status: number, headers: HeadersInit = {}): Response {
  return Response.json({ error: message }, { status, headers });
}
