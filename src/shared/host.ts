import { DEFAULT_SEATS, type RoomId } from "./protocol.ts";
const encoder = new TextEncoder();
export const HOST_MAX_AGE = 90 * 24 * 3600;
export const ROOM_IDLE_MS = 24 * 3600 * 1000;

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("");
}
/** Hash both inputs to fixed width before comparing, independent of passphrase length. */
export async function passphraseMatches(candidate: string, secret: string): Promise<boolean> {
  const [a, b] = await Promise.all([crypto.subtle.digest("SHA-256", encoder.encode(candidate)), crypto.subtle.digest("SHA-256", encoder.encode(secret))]);
  const aa = new Uint8Array(a), bb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i]! ^ bb[i]!;
  return diff === 0;
}
export async function hostToken(secret: string, now = Date.now()): Promise<string> {
  const payload = `v1.${Math.floor(now / 1000) + HOST_MAX_AGE}`;
  return `${payload}.${hex(await crypto.subtle.sign("HMAC", await key(secret), encoder.encode(payload)))}`;
}
export async function isHost(cookie: string | null, secret: string, now = Date.now()): Promise<boolean> {
  if (!secret) return true;
  const token = cookie?.split(";").map((s) => s.trim()).find((s) => s.startsWith("sr_host="))?.slice(8);
  const match = /^v1\.(\d+)\.([a-f0-9]{64})$/.exec(token ?? "");
  if (!match || Number(match[1]) <= now / 1000 || Number(match[1]) > now / 1000 + HOST_MAX_AGE + 1) return false;
  const signature = Uint8Array.from(match[2]!.match(/../g)!, (s) => parseInt(s, 16));
  return crypto.subtle.verify("HMAC", await key(secret), signature, encoder.encode(`v1.${match[1]}`));
}
export function hostCookie(token: string, url: URL): string {
  const local = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return `sr_host=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${HOST_MAX_AGE}${local ? "" : "; Secure"}`;
}
export function sameOrigin(origin: string | null, url: URL): boolean {
  return origin === url.origin;
}
/** Per-process/isolate best effort throttle, bounded to avoid storing arbitrary IPs forever. */
export class HostAttempts {
  private readonly attempts = new Map<string, { count: number; until: number }>();
  allow(ip: string, now = Date.now()): boolean {
    for (const [key, value] of this.attempts) if (value.until <= now) this.attempts.delete(key);
    const entry = this.attempts.get(ip) ?? { count: 0, until: now + 60_000 };
    if (this.attempts.size >= 4096 && !this.attempts.has(ip)) return false;
    this.attempts.set(ip, entry);
    return ++entry.count <= 8;
  }
}
export class RoomInvites {
  private readonly records = new Map<RoomId, { expires: number; seats: number }>();
  create(id: RoomId, seats = DEFAULT_SEATS, now = Date.now()): void { this.records.set(id, { expires: now + ROOM_IDLE_MS, seats }); }
  touch(id: RoomId, now = Date.now()): void {
    const record = this.records.get(id);
    if (record) record.expires = now + ROOM_IDLE_MS;
  }
  seats(id: RoomId): number | undefined { return this.records.get(id)?.seats; }
  exists(id: RoomId, active = false, now = Date.now()): boolean {
    const expires = this.records.get(id)?.expires;
    if (expires === undefined) return false;
    if (active || expires > now) return true;
    this.records.delete(id);
    return false;
  }
  prune(active: (id: RoomId) => boolean): void { for (const id of this.records.keys()) this.exists(id, active(id)); }
}
