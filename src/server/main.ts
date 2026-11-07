// Node entry point: static web app, room redirect, ICE config, and the signaling WebSocket.
// All room behavior lives in rooms.ts; this file only moves bytes.

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { type RoomId, MAX_MESSAGE_BYTES, isRoomId, newRoomId, randomId } from "../shared/protocol.ts";
import { Rooms, type ConnId, type Effect } from "./rooms.ts";
import { SignalingSession, closeCode } from "./signaling.ts";
import { iceServers } from "./turn.ts";

import { HostAttempts, RoomInvites, hostCookie, hostToken, isHost, passphraseMatches, sameOrigin } from "../shared/host.ts";
const env = process.env;
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
const PUBLIC_DIR = resolve(env.PUBLIC_DIR ?? fileURLToPath(new URL("../../web", import.meta.url)));

const rooms = new Rooms();
const sockets = new Map<ConnId, WebSocket>();
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

function send(res: ServerResponse, status: number, body: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store", ...headers });
  res.end(body);
}

function sendJson(res: ServerResponse, value: unknown): void {
  send(res, 200, JSON.stringify(value), { "Content-Type": "application/json" });
}

async function serveFile(res: ServerResponse, relPath: string, cache: string): Promise<boolean> {
  const filePath = normalize(join(PUBLIC_DIR, relPath));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) return false;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) return false;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream",
      "Content-Length": String(info.size),
      "Cache-Control": cache,
    });
    createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

function requestHostname(req: IncomingMessage): string {
  const host = req.headers.host ?? "localhost";
  // Strip the port; keep IPv6 brackets.
  const m = /^(\[[^\]]+\]|[^:]+)/.exec(host);
  return m?.[1] ?? "localhost";
}

async function handleIce(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = TURN_HOST || requestHostname(req);
  const stun = STUN_URLS.length > 0 ? STUN_URLS : [`stun:${host}:${TURN_PORT}`];
  const turn = TURN_SECRET
    ? { secret: TURN_SECRET, ttlSeconds: TURN_TTL, urls: [`turn:${host}:${TURN_PORT}?transport=udp`, `turn:${host}:${TURN_PORT}?transport=tcp`] }
    : null;
  // A unique username per client: coturn's user-quota counts allocations per username.
  const servers = await iceServers({ stunUrls: stun, turn, nowSec: Math.floor(Date.now() / 1000), label: `sr-${randomId(6)}` });
  sendJson(res, { iceServers: servers, ttlSeconds: turn ? TURN_TTL : null });
}

async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `${(("encrypted" in req.socket && req.socket.encrypted) || req.headers["x-forwarded-proto"] === "https") ? "https" : "http"}://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;
  const host = await isHost(req.headers.cookie ?? null, hostSecret);
  const existing = (id: string) => isRoomId(id) && invites.exists(id, rooms.peek(id).members > 0);
  if (req.method === "POST" && ["/api/host-session", "/api/rooms"].includes(path)) {
    if (!sameOrigin(req.headers.origin ?? null, url)) return send(res, 403, "Forbidden origin");
    if (path === "/api/rooms") {
      if (!host) return send(res, 403, "Host session required");
      const id = newRoomId(); invites.create(id); return sendJson(res, { id });
    }
    if (!attempts.allow(req.socket.remoteAddress ?? "unknown")) return send(res, 429, "Too many attempts. Try again in a minute.");
    req.setEncoding("utf8");
    let body = "";
    for await (const chunk of req) { body += String(chunk); if (body.length > 4096) return send(res, 413, "Too large"); }
    let candidate: unknown;
    try { candidate = JSON.parse(body); } catch { return send(res, 400, "Invalid JSON"); }
    if (typeof candidate !== "object" || candidate === null || !("passphrase" in candidate) || typeof candidate.passphrase !== "string") return send(res, 400, "Passphrase required");
    if (hostSecret && !await passphraseMatches(candidate.passphrase, hostSecret)) return send(res, 403, "That passphrase isn't right.");
    return send(res, 204, "", { "Set-Cookie": hostCookie(await hostToken(hostSecret || "open", Date.now()), url) });
  }
  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, "Method not allowed");

  if (path === "/healthz") return sendJson(res, { ok: true, rooms: rooms.roomCount, sockets: sockets.size });
  if (path === "/api/ice") {
    if (!host && !existing(url.searchParams.get("room") ?? "")) return send(res, 403, "Invite or host session required");
    return handleIce(req, res);
  }

  const peek = /^\/api\/rooms\/([^/]+)$/.exec(path);
  if (peek) {
    const id = peek[1];
    return isRoomId(id) && existing(id) ? sendJson(res, rooms.peek(id)) : send(res, 404, "Unknown room");
  }

  if (path === "/") {
    if (!host) { await serveFile(res, "index.html", "no-cache"); return; }
    const id = newRoomId(); invites.create(id);
    // Opening the app makes a fresh room. The 128-bit ID in the link is the invite.
    const query = url.search; // keep debug flags such as ?relay=1
    return send(res, 302, "", { Location: `/r/${id}${query}` });
  }

  if (path.startsWith("/r/")) {
    if (await serveFile(res, "index.html", "no-cache")) return;
    return send(res, 503, "Web app not built");
  }

  if (path.startsWith("/assets/") && (await serveFile(res, path, "public, max-age=31536000, immutable"))) return;
  if (/^\/[\w.-]+\.(svg|png|ico|webmanifest)$/.test(path) && (await serveFile(res, path, "public, max-age=3600"))) return;
  send(res, 404, "Not found");
}

const server = createServer((req, res) => {
  route(req, res).catch((err: unknown) => {
    console.error("request failed", err);
    if (!res.headersSent) send(res, 500, "Internal error");
    else res.destroy();
  });
});

// ---------------------------------------------------------------------------
// Signaling

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function apply(effects: Effect[]): void {
  for (const effect of effects) {
    const socket = sockets.get(effect.to);
    if (!socket) continue;
    if (effect.kind === "close") {
      sockets.delete(effect.to);
      socket.close(closeCode(effect.reason), effect.reason);
      apply(rooms.leave(effect.to));
    } else if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(effect.msg));
    }
  }
}

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const origin = req.headers.origin;
  let sameOrigin = origin === undefined;
  try {
    sameOrigin ||= new URL(origin ?? "").host === req.headers.host;
  } catch {
    sameOrigin = false;
  }
  const room = url.searchParams.get("room");
  if (!isRoomId(room) || !invites.exists(room, rooms.peek(room).members > 0)) {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n"); socket.destroy(); return;
  }
  if (url.pathname !== "/ws" || !sameOrigin) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, room));
});

function onConnection(ws: WebSocket, room: RoomId): void {
  const conn: ConnId = randomId(12);
  sockets.set(conn, ws);
  let alive = true;
  const session = new SignalingSession(rooms, conn, room);

  ws.on("pong", () => {
    alive = true;
  });
  const heartbeat = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
  }, 15_000);

  ws.on("message", (raw, isBinary) => {
    invites.touch(room);
    apply(session.receive(isBinary ? new ArrayBuffer(0) : raw.toString()));
  });

  ws.on("close", () => {
    clearInterval(heartbeat);
    invites.touch(room);
    // A replaced socket was already removed from `sockets` and from its room.
    if (sockets.get(conn) === ws) {
      sockets.delete(conn);
      apply(rooms.leave(conn));
    }
  });
  ws.on("error", () => ws.terminate());
}

server.listen(PORT, HOST, () => {
  console.log(`streamroom listening on http://${HOST}:${PORT} (static: ${PUBLIC_DIR}, turn: ${TURN_SECRET ? "on" : "off"})`);
});

function shutdown(): void {
  for (const ws of sockets.values()) ws.close(1001, "server restarting");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
