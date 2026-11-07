// Bun entry point: static web app, room redirect, ICE config, and the signaling WebSocket.
// All room behavior lives in rooms.ts; this file only moves bytes.

import type { Server, ServerWebSocket } from "bun";
import { type RoomId, DEFAULT_SEATS, MAX_MESSAGE_BYTES, isRoomId, newRoomId, parseSeats, randomId } from "../shared/protocol.ts";
import { Rooms, type ConnId, type Effect } from "./rooms.ts";
import { SignalingSession, closeCode } from "./signaling.ts";
import { iceServers } from "./turn.ts";

import { HostAttempts, RoomInvites, hostCookie, hostToken, isHost, passphraseMatches, sameOrigin } from "../shared/host.ts";
const env = Bun.env;
const hostSecret = env.HOST_PASSPHRASE ?? "";
if (!hostSecret) console.warn("HOST_PASSPHRASE is unset: room creation and ICE access are open.");
const attempts = new HostAttempts();
const invites = new RoomInvites();
const PORT = Number(env.PORT ?? 8080);
const HOST = env.HOST ?? "0.0.0.0";
const TURN_SECRET = env.TURN_SECRET ?? "";
const TURN_HOST = env.TURN_HOST ?? "";
const TURN_PORT = Number(env.TURN_PORT ?? 3478);
const TURN_TTL = Number(env.TURN_TTL_SECONDS ?? 12 * 3600);
const STUN_URLS = (env.STUN_URLS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const publicRoot = env.PUBLIC_DIR
  ? new URL(`${env.PUBLIC_DIR.replace(/\/$/, "")}/`, Bun.pathToFileURL(`${process.cwd()}/`))
  : new URL("../../dist/web/", import.meta.url);
const PUBLIC_DIR = Bun.fileURLToPath(publicRoot);

interface SocketData {
  conn: ConnId;
  room: RoomId;
  session: SignalingSession;
  alive: boolean;
  heartbeat: ReturnType<typeof setInterval> | undefined;
}

const rooms = new Rooms({ capacityOf: (id) => invites.seats(id) });
const sockets = new Map<ConnId, ServerWebSocket<SocketData>>();
setInterval(() => invites.prune((id) => rooms.peek(id).members > 0), 60_000).unref();

const SECURITY_HEADERS: Record<string, string> = {
  // Room IDs are secrets in the URL: never leak them through Referer.
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "microphone=(self), display-capture=(self), fullscreen=(self)",
  "Content-Security-Policy":
    "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'none'",
};

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

function send(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : body, { status, headers: {
    ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers,
  } });
}

function sendJson(value: unknown): Response {
  return send(200, JSON.stringify(value), { "Content-Type": "application/json" });
}

async function serveFile(relPath: string, cache: string): Promise<Response | null> {
  // Only append ordinary path segments to the configured root, never an absolute path.
  const relative = relPath.replace(/^\/+/, "");
  if (relative.split("/").some((part) => part === "..") || /[\\\x00]/.test(relative)) return null;
  const filePath = PUBLIC_DIR + relative;
  try {
    const file = Bun.file(filePath);
    const info = await file.stat();
    if (!info.isFile()) return null;
    const extension = /\.[^/.]+$/.exec(filePath)?.[0] ?? "";
    return new Response(file, { headers: {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extension] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": cache,
    } });
  } catch {
    return null;
  }
}

async function handleIce(req: Request): Promise<Response> {
  const host = TURN_HOST || new URL(req.url).hostname;
  const stun = STUN_URLS.length > 0 ? STUN_URLS : [`stun:${host}:${TURN_PORT}`];
  const turn = TURN_SECRET
    ? { secret: TURN_SECRET, ttlSeconds: TURN_TTL, urls: [`turn:${host}:${TURN_PORT}?transport=udp`, `turn:${host}:${TURN_PORT}?transport=tcp`] }
    : null;
  // A unique username per client: coturn's user-quota counts allocations per username.
  const servers = await iceServers({ stunUrls: stun, turn, nowSec: Math.floor(Date.now() / 1000), label: `sr-${randomId(6)}` });
  return sendJson({ iceServers: servers, ttlSeconds: turn ? TURN_TTL : null });
}

async function route(req: Request, server: Server<SocketData>): Promise<Response> {
  const url = new URL(req.url);
  if (req.headers.get("x-forwarded-proto") === "https") url.protocol = "https:";
  const path = url.pathname;
  const host = await isHost(req.headers.get("cookie"), hostSecret);
  const existing = (id: string) => isRoomId(id) && invites.exists(id, rooms.peek(id).members > 0);
  if (req.method === "POST" && ["/api/host-session", "/api/rooms"].includes(path)) {
    if (!sameOrigin(req.headers.get("origin"), url)) return send(403, "Forbidden origin");
    if (path === "/api/rooms" && !host) return send(403, "Host session required");
    if (path === "/api/host-session" && !attempts.allow(server.requestIP(req)?.address ?? "unknown")) return send(429, "Too many attempts. Try again in a minute.");
    let body = "";
    const reader = req.body?.pipeThrough(new TextDecoderStream()).getReader();
    if (reader) {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        body += chunk.value;
        if (body.length > 4096) { await reader.cancel(); return send(413, "Too large"); }
      }
    }
    if (path === "/api/rooms") {
      // Optional body: { seats }. No body keeps the default size.
      let seats: number | null = DEFAULT_SEATS;
      if (body.trim()) {
        try { const parsed: unknown = JSON.parse(body); seats = typeof parsed === "object" && parsed !== null && "seats" in parsed ? parseSeats(parsed.seats) : DEFAULT_SEATS; }
        catch { return send(400, "Invalid JSON"); }
      }
      if (seats === null) return send(400, "Seats must be a whole number from 2 to 10.");
      const id = newRoomId(); invites.create(id, seats); return sendJson({ id, seats });
    }
    let candidate: unknown;
    try { candidate = JSON.parse(body); } catch { return send(400, "Invalid JSON"); }
    if (typeof candidate !== "object" || candidate === null || !("passphrase" in candidate) || typeof candidate.passphrase !== "string") return send(400, "Passphrase required");
    if (hostSecret && !await passphraseMatches(candidate.passphrase, hostSecret)) return send(403, "That passphrase isn't right.");
    return send(204, "", { "Set-Cookie": hostCookie(await hostToken(hostSecret || "open", Date.now()), url) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(405, "Method not allowed");

  if (path === "/healthz") return sendJson({ ok: true, rooms: rooms.roomCount, sockets: sockets.size });
  // Lets the start screen skip the passphrase field for a remembered host.
  if (path === "/api/host-session") return sendJson({ host });
  if (path === "/api/ice") {
    if (!host && !existing(url.searchParams.get("room") ?? "")) return send(403, "Invite or host session required");
    return handleIce(req);
  }

  const peek = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (peek) {
    const id = peek[1];
    return isRoomId(id) && existing(id) ? sendJson(rooms.peek(id)) : send(404, "Unknown room");
  }

  if (path === "/") {
    // The start screen picks the seat count. "/?seats=N" from a host creates the room directly.
    const seats = parseSeats(url.searchParams.get("seats"));
    if (!host || seats === null) return await serveFile("index.html", "no-cache") ?? send(503, "Web app not built");
    const id = newRoomId(); invites.create(id, seats);
    url.searchParams.delete("seats"); // keep debug flags such as ?relay=1
    return send(302, "", { Location: `/r/${id}${url.search}` });
  }

  if (path.startsWith("/r/")) return await serveFile("index.html", "no-cache") ?? send(503, "Web app not built");

  if (path.startsWith("/assets/")) {
    const file = await serveFile(path, "public, max-age=31536000, immutable");
    if (file) return file;
  }
  if (/^\/[\w.-]+\.(svg|png|ico|webmanifest)$/.test(path)) {
    const file = await serveFile(path, "public, max-age=3600");
    if (file) return file;
  }
  return send(404, "Not found");
}

// ---------------------------------------------------------------------------
// Signaling

function apply(effects: Effect[]): void {
  for (const effect of effects) {
    const socket = sockets.get(effect.to);
    if (!socket) continue;
    if (effect.kind === "close") {
      sockets.delete(effect.to);
      socket.close(closeCode(effect.reason), effect.reason);
      apply(rooms.leave(effect.to));
    } else if (socket.readyState === 1) {
      socket.send(JSON.stringify(effect.msg));
    }
  }
}

const server = Bun.serve<SocketData>({
  hostname: HOST,
  port: PORT,
  async fetch(req, server) {
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
      const url = new URL(req.url);
      const room = url.searchParams.get("room");
      if (!isRoomId(room) || !invites.exists(room, rooms.peek(room).members > 0)) return send(404, "Not found");
      // Same rule as the Node server: browsers must come from this host; non-browser clients send no Origin.
      const origin = req.headers.get("origin");
      let originOk = origin === null;
      try {
        originOk ||= new URL(origin ?? "").host === req.headers.get("host");
      } catch {
        originOk = false;
      }
      if (url.pathname !== "/ws" || !originOk) return send(403, "Forbidden");
      const conn: ConnId = randomId(12);
      if (server.upgrade(req, { data: {
        conn, room, session: new SignalingSession(rooms, conn, room), alive: true, heartbeat: undefined,
      } })) return;
      return send(400, "Invalid WebSocket upgrade");
    }
    return route(req, server);
  },
  error(err) {
    console.error("request failed", err);
    return send(500, "Internal error");
  },
  websocket: {
    maxPayloadLength: MAX_MESSAGE_BYTES,
    // Keep the existing explicit 15-second ping/pong heartbeat.
    idleTimeout: 0,
    sendPings: false,
    open(ws) {
      sockets.set(ws.data.conn, ws);
      ws.data.heartbeat = setInterval(() => {
        if (!ws.data.alive) return ws.terminate();
        ws.data.alive = false;
        ws.ping();
      }, 15_000);
    },
    pong(ws) { ws.data.alive = true; },
    message(ws, raw) {
      invites.touch(ws.data.room);
      apply(ws.data.session.receive(typeof raw === "string" ? raw : new ArrayBuffer(0)));
    },
    close(ws) {
      clearInterval(ws.data.heartbeat);
      invites.touch(ws.data.room);
      // A replaced socket was already removed from sockets and from its room.
      if (sockets.get(ws.data.conn) === ws) {
        sockets.delete(ws.data.conn);
        apply(rooms.leave(ws.data.conn));
      }
    },
  },
});

console.log(`streamroom listening on http://${HOST}:${PORT} (static: ${PUBLIC_DIR}, turn: ${TURN_SECRET ? "on" : "off"})`);

function shutdown(): void {
  for (const ws of sockets.values()) ws.close(1001, "server restarting");
  void server.stop().then(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
