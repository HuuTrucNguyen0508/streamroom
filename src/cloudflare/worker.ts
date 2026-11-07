import { DEFAULT_SEATS, isRoomId, newRoomId, parseSeats, randomId } from "../shared/protocol.ts";
import { Rooms, type Effect } from "../server/rooms.ts";
import { SignalingSession, closeCode } from "../server/signaling.ts";
import { cloudflareIce, type TurnSecrets } from "./turn.ts";

import { ROOM_IDLE_MS, HostAttempts, hostCookie, hostToken, isHost, passphraseMatches, sameOrigin } from "../shared/host.ts";
const attempts = new HostAttempts();
let warned = false;
interface Env extends TurnSecrets {
  HOST_PASSPHRASE?: string;
  ASSETS: Fetcher;
  ROOMS: DurableObjectNamespace;
}

const SECURITY_HEADERS = {
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), display-capture=(self), fullscreen=(self)",
  "Content-Security-Policy": "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
};

function json(value: unknown): Response {
  return Response.json(value, { headers: { "Cache-Control": "no-store" } });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  const secret = env.HOST_PASSPHRASE ?? "";
  if (!secret && !warned) { console.warn("HOST_PASSPHRASE is unset: room creation and ICE access are open."); warned = true; }
  const host = await isHost(request.headers.get("Cookie"), secret);
  const stub = (id: string) => env.ROOMS.get(env.ROOMS.idFromName(id));
  const exists = async (id: string) => isRoomId(id) && (await stub(id).fetch(new Request(`${url.origin}/api/rooms/${id}`))).ok;
  const create = async (seats: number) => {
    const id = newRoomId();
    await stub(id).fetch(new Request(`${url.origin}/create/${id}?seats=${seats}`, { method: "POST" }));
    return id;
  };
  if (request.method === "POST" && ["/api/host-session", "/api/rooms"].includes(path)) {
    if (!sameOrigin(request.headers.get("Origin"), url)) return new Response("Forbidden origin", { status: 403 });
    if (path === "/api/rooms") {
      if (!host) return new Response("Host session required", { status: 403 });
      // Optional body: { seats }. No body keeps the default size.
      const text = await request.text();
      if (text.length > 4096) return new Response("Too large", { status: 413 });
      let seats: number | null = DEFAULT_SEATS;
      if (text.trim()) {
        try { const parsed: unknown = JSON.parse(text); seats = typeof parsed === "object" && parsed !== null && "seats" in parsed ? parseSeats(parsed.seats) : DEFAULT_SEATS; }
        catch { return new Response("Invalid JSON", { status: 400 }); }
      }
      if (seats === null) return new Response("Seats must be a whole number from 2 to 10.", { status: 400 });
      return json({ id: await create(seats), seats });
    }
    if (!attempts.allow(request.headers.get("CF-Connecting-IP") ?? "unknown")) return new Response("Too many attempts. Try again in a minute.", { status: 429 });
    if (Number(request.headers.get("Content-Length")) > 4096) return new Response("Too large", { status: 413 });
    const text = await request.text();
    if (text.length > 4096) return new Response("Too large", { status: 413 });
    let body: unknown;
    try { body = JSON.parse(text); } catch { return new Response("Invalid JSON", { status: 400 }); }
    if (typeof body !== "object" || body === null || !("passphrase" in body) || typeof body.passphrase !== "string") return new Response("Passphrase required", { status: 400 });
    if (secret && !await passphraseMatches(body.passphrase, secret)) return new Response("That passphrase isn't right.", { status: 403 });
    return new Response(null, { status: 204, headers: { "Set-Cookie": hostCookie(await hostToken(secret || "open"), url), "Cache-Control": "no-store" } });
  }
  if (request.method !== "GET" && request.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
  // The start screen picks the seat count. "/?seats=N" from a host creates the room directly.
  const startSeats = path === "/" && host ? parseSeats(url.searchParams.get("seats")) : null;
  if (startSeats !== null) {
    const id = await create(startSeats);
    url.searchParams.delete("seats"); // keep debug flags such as ?relay=1
    return new Response(null, { status: 302, headers: { Location: `/r/${id}${url.search}`, "Cache-Control": "no-store" } });
  }
  if (path === "/healthz") return json({ ok: true });
  // Lets the start screen skip the passphrase field for a remembered host.
  if (path === "/api/host-session") return json({ host });
  if (path === "/api/ice") {
    if (!host && !await exists(url.searchParams.get("room") ?? "")) return new Response("Invite or host session required", { status: 403 });
    return json(await cloudflareIce(env));
  }
  const peek = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (peek || path === "/ws") {
    const room = peek ? peek[1] : url.searchParams.get("room");
    if (!isRoomId(room)) return new Response("Unknown room", { status: 404 });
    if (path === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("WebSocket required", { status: 426 });
      const origin = request.headers.get("Origin");
      if (origin !== null) {
        try { if (new URL(origin).host !== url.host) return new Response("Forbidden", { status: 403 }); }
        catch { return new Response("Forbidden", { status: 403 }); }
      }
    }
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(request);
  }
  if (path.startsWith("/api/")) return new Response("Not found", { status: 404 });
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const response = await route(request, env);
    if (response.status === 101) return response;
    const headers = new Headers(response.headers);
    for (const [key, value] of Object.entries(SECURITY_HEADERS)) headers.set(key, value);
    return new Response(request.method === "HEAD" ? null : response.body, { status: response.status, headers });
  },
};

/** Ephemeral state, like Node: ordinary accepted sockets prevent hibernation. */
export class Room {
  constructor(private readonly ctx: DurableObjectState) {}
  /** One room per object; its seat count lives in storage next to the expiry. */
  private seats = DEFAULT_SEATS;
  private readonly rooms = new Rooms({ capacityOf: () => this.seats });

  async alarm(): Promise<void> {
    if (this.sockets.size > 0) { await this.touch(); return; }
    const expiry = await this.ctx.storage.get<number>("expires");
    if (expiry && expiry > Date.now()) { await this.ctx.storage.setAlarm(expiry); return; }
    await this.ctx.storage.deleteAll();
  }

  private async touch(): Promise<void> {
    const expires = Date.now() + ROOM_IDLE_MS;
    await this.ctx.storage.put("expires", expires);
    await this.ctx.storage.setAlarm(expires);
  }
  private readonly sockets = new Map<string, WebSocket>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const room = url.pathname === "/ws" ? url.searchParams.get("room") : url.pathname.split("/").at(-1);
    if (!isRoomId(room)) return new Response("Unknown room", { status: 404 });
    if (url.pathname.startsWith("/create/") && request.method === "POST") {
      this.seats = parseSeats(url.searchParams.get("seats")) ?? DEFAULT_SEATS;
      await this.ctx.storage.put("seats", this.seats);
      await this.touch();
      return json({ id: room });
    }
    const expires = await this.ctx.storage.get<number>("expires");
    this.seats = (await this.ctx.storage.get<number>("seats")) ?? DEFAULT_SEATS;
    if (!expires || (expires <= Date.now() && this.sockets.size === 0)) return new Response("Unknown room", { status: 404 });
    if (url.pathname !== "/ws") return json(this.rooms.peek(room));
    await this.touch();
    const pair = new WebSocketPair();
    const client = pair[0];
    const socket = pair[1];
    socket.accept();
    const conn = randomId(12);
    const session = new SignalingSession(this.rooms, conn, room);
    this.sockets.set(conn, socket);
    const cleanup = () => {
      if (this.sockets.get(conn) !== socket) return;
      this.sockets.delete(conn);
      this.ctx.waitUntil(this.touch());
      this.apply(this.rooms.leave(conn));
    };
    socket.addEventListener("message", (event) => this.apply(session.receive(event.data)));
    socket.addEventListener("close", cleanup);
    socket.addEventListener("error", () => { cleanup(); socket.close(1011, "socket error"); });
    return new Response(null, { status: 101, webSocket: client });
  }

  private apply(effects: Effect[]): void {
    for (const effect of effects) {
      const socket = this.sockets.get(effect.to);
      if (!socket) continue;
      if (effect.kind === "close") {
        this.sockets.delete(effect.to);
        socket.close(closeCode(effect.reason), effect.reason);
        // Replaced connections were already removed by Rooms.join().
        this.apply(this.rooms.leave(effect.to));
      } else if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(effect.msg));
      }
    }
  }
}
