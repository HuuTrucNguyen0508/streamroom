import type { IceServer } from "../server/turn.ts";

export interface TurnSecrets {
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

const TTL = 43200;
const STUN: IceServer = { urls: ["stun:stun.cloudflare.com:3478"] };

function parseIceServer(value: unknown): IceServer {
  if (typeof value !== "object" || value === null || !("urls" in value)) throw new Error("Invalid ICE server");
  const urls = typeof value.urls === "string" ? [value.urls] : value.urls;
  if (!Array.isArray(urls) || !urls.every((url): url is string => typeof url === "string" && /^(stun|turn|turns):/.test(url))) {
    throw new Error("Invalid ICE URLs");
  }
  const server: IceServer = { urls };
  if ("username" in value && typeof value.username === "string") server.username = value.username;
  if ("credential" in value && typeof value.credential === "string") server.credential = value.credential;
  return server;
}

export async function cloudflareIce(env: TurnSecrets, request: typeof fetch = fetch): Promise<{ iceServers: IceServer[]; ttlSeconds: number | null }> {
  const fallback = { iceServers: [STUN], ttlSeconds: null };
  if (!env.TURN_KEY_ID || !env.TURN_KEY_API_TOKEN) {
    console.warn("Cloudflare TURN secrets missing; returning STUN only.");
    return fallback;
  }
  try {
    const response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.TURN_KEY_API_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ttl: TTL }),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("TURN credential request failed");
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("iceServers" in body)) throw new Error("Invalid TURN response");
    // Accept the documented array and the single-server response shape.
    const servers = (Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers]).map(parseIceServer);
    if (!servers.some((s) => s.urls.some((url) => /^turns?:/.test(url)) && s.username && s.credential)) throw new Error("Missing TURN credentials");
    return { iceServers: [STUN, ...servers], ttlSeconds: TTL };
  } catch {
    // Never log the upstream response: it can contain credentials.
    console.warn("Cloudflare TURN unavailable; returning STUN only.");
    return fallback;
  }
}
