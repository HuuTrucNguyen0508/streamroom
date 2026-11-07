// TURN REST API credentials (draft-uberti-behave-turn-rest), as coturn's `use-auth-secret` expects:
//   username = "<unix expiry>:<label>", credential = base64(HMAC-SHA1(secret, username)).
// Web Crypto only, so it runs on Bun and on Cloudflare Workers.

export interface IceServer {
  urls: string[];
  username?: string;
  credential?: string;
}

export interface TurnConfig {
  secret: string;
  ttlSeconds: number;
  urls: string[];
}

export async function turnCredentials(secret: string, label: string, expiresAtSec: number): Promise<{ username: string; credential: string }> {
  const username = `${expiresAtSec}:${label}`;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(username)));
  let bin = "";
  for (const b of mac) bin += String.fromCharCode(b);
  return { username, credential: btoa(bin) };
}

export async function iceServers(opts: { stunUrls: string[]; turn: TurnConfig | null; nowSec: number; label: string }): Promise<IceServer[]> {
  const servers: IceServer[] = [];
  if (opts.stunUrls.length > 0) servers.push({ urls: opts.stunUrls });
  if (opts.turn && opts.turn.urls.length > 0) {
    const creds = await turnCredentials(opts.turn.secret, opts.label, opts.nowSec + opts.turn.ttlSeconds);
    servers.push({ urls: opts.turn.urls, ...creds });
  }
  return servers;
}
