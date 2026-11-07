import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { newRoomId } from "../src/shared/protocol.ts";

test.skip(process.env.E2E_CLOUDFLARE !== "1", "Cloudflare-specific transport checks; set E2E_CLOUDFLARE=1.");

test.beforeEach(async ({ request, baseURL }) => {
  if (process.env.E2E_HOST_PASSPHRASE) expect((await request.post("/api/host-session", { headers: { Origin: baseURL! }, data: { passphrase: process.env.E2E_HOST_PASSPHRASE } })).ok()).toBe(true);
});
async function create(request: import("@playwright/test").APIRequestContext, baseURL: string): Promise<string> {
  return (await (await request.post("/api/rooms", { headers: { Origin: baseURL } })).json()).id;
}

test("Worker routes and origin protection", async ({ request, baseURL }) => {
  // "/" is the start screen (seat picker); "/?seats=N" from a host creates the room and redirects.
  expect((await request.get("/", { maxRedirects: 0 })).status()).toBe(200);
  const response = await request.get("/?seats=3&relay=1", { maxRedirects: 0 });
  expect(response.status()).toBe(302);
  expect(response.headers().location).toMatch(/^\/r\/[\w-]{22}\?relay=1$/);
  const room = await create(request, baseURL!);
  expect(await (await request.get(`/api/rooms/${room}`)).json()).toEqual({ members: 0, max: 3, locked: false });
  expect((await request.get("/api/rooms/invalid")).status()).toBe(404);
  expect((await request.post("/api/ice")).status()).toBe(405);
  expect((await request.get(`/r/${room}`)).headers()["content-type"]).toContain("text/html");
  expect((await request.get("/healthz")).headers()["referrer-policy"]).toBe("no-referrer");
  const status = await new Promise<number>((resolve, reject) => {
    const socket = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${room}`, { origin: "https://attacker.example" });
    socket.on("unexpected-response", (_, response) => { response.resume(); resolve(response.statusCode ?? 0); });
    socket.on("open", () => { socket.close(); reject(new Error("cross-origin socket accepted")); });
    socket.on("error", reject);
  });
  expect(status).toBe(403);
});

test("Durable Object rejects wrong-room joins and oversized messages, then cleans up", async ({ baseURL, request }) => {
  const room = await create(request, baseURL!);
  const socket = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${room}`);
  await new Promise<void>((resolve, reject) => { socket.once("open", resolve); socket.once("error", reject); });
  const receive = () => new Promise<unknown>((resolve, reject) => {
    socket.once("message", (data) => { try { resolve(JSON.parse(String(data))); } catch (error) { reject(error); } });
  });
  try {
    const rejected = receive();
    socket.send(JSON.stringify({ t: "join", room: newRoomId(), name: "Friend", state: { muted: false, hasMic: true, share: null } }));
    expect(await rejected).toMatchObject({ t: "error", code: "bad_request" });
    const joined = receive();
    socket.send(JSON.stringify({ t: "join", room, name: "Friend", state: { muted: false, hasMic: true, share: null } }));
    expect(await joined).toMatchObject({ t: "joined" });
    expect((await (await request.get(`/api/rooms/${room}`)).json()).members).toBe(1);
    const closed = new Promise<number>((resolve) => socket.once("close", resolve));
    socket.send("é".repeat(32769));
    expect(await closed).toBe(1009);
    await expect.poll(async () => (await (await request.get(`/api/rooms/${room}`)).json()).members).toBe(0);
  } finally {
    socket.close();
  }
});

test("a connection that stops pinging loses its seat, so a VPN switch leaves no ghost", async ({ baseURL, request }) => {
  test.setTimeout(120_000);
  const room = await create(request, baseURL!);
  // The ghost: joins, then goes silent like a socket whose network vanished. It never pings.
  const ghost = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${room}`);
  await new Promise<void>((resolve, reject) => { ghost.once("open", resolve); ghost.once("error", reject); });
  const joined = new Promise<unknown>((resolve) => ghost.once("message", (data) => resolve(JSON.parse(String(data)))));
  ghost.send(JSON.stringify({ t: "join", room, name: "Ghost", resume: null, state: { muted: false, hasMic: true, share: null } }));
  expect(await joined).toMatchObject({ t: "joined" });
  // A live friend keeps pinging and must keep their seat.
  const friend = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${room}`);
  await new Promise<void>((resolve, reject) => { friend.once("open", resolve); friend.once("error", reject); });
  friend.send(JSON.stringify({ t: "join", room, name: "Friend", resume: null, state: { muted: false, hasMic: true, share: null } }));
  const pings = setInterval(() => friend.send(JSON.stringify({ t: "ping" })), 20_000);
  const left = new Promise<unknown>((resolve) => friend.on("message", (data) => {
    const msg = JSON.parse(String(data)) as { t: string };
    if (msg.t === "member-left") resolve(msg);
  }));
  try {
    await expect.poll(async () => (await (await request.get(`/api/rooms/${room}`)).json()).members).toBe(2);
    const started = Date.now();
    await left;
    const waited = Date.now() - started;
    console.log(`Silent connection evicted after ${Math.round(waited / 1000)} s`);
    expect(waited).toBeGreaterThan(40_000);
    expect(waited).toBeLessThan(75_000);
    expect((await (await request.get(`/api/rooms/${room}`)).json()).members).toBe(1);
  } finally {
    clearInterval(pings);
    ghost.close(); friend.close();
  }
});
