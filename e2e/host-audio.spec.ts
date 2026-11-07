import { expect, test } from "@playwright/test";
import WebSocket from "ws";
import { newRoomId } from "../src/shared/protocol.ts";
import type { PeerStats } from "../src/web/rtc/stats.ts";
const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";

test("host gate, guest-first invite, ICE access and unknown room rejection", async ({ browser, baseURL }) => {
  const host = await browser.newContext(), guest = await browser.newContext();
  const page = await host.newPage();
  try {
    await page.goto("/");
    await expect(page.getByLabel("Host passphrase")).toBeVisible();
    await page.screenshot({ path: "docs/screenshots/passphrase.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "docs/screenshots/passphrase-mobile.png" });
    expect((await guest.request.get(`${baseURL}/api/ice`)).status()).toBe(403);
    expect((await guest.request.post(`${baseURL}/api/host-session`, { headers: { Origin: "https://attacker.example" }, data: { passphrase } })).status()).toBe(403);
    expect((await guest.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL! } })).status()).toBe(403);
    await page.getByLabel("Host passphrase").fill("wrong");
    await page.getByRole("button", { name: "Start a room" }).click();
    await expect(page.getByRole("alert")).toContainText("isn't right");
    await page.getByLabel("Host passphrase").fill(passphrase);
    await page.getByRole("button", { name: "Start a room" }).click();
    await expect(page).toHaveURL(/\/r\/[\w-]{22}$/);
    const invite = page.url(), id = invite.split("/r/")[1]!;
    expect((await guest.cookies()).find((c) => c.name === "sr_host")).toBeUndefined();
    const g = await guest.newPage();
    await g.goto(invite);
    await g.getByLabel("Your name").fill("Guest first");
    await g.getByRole("button", { name: "Join without mic" }).click();
    await expect(g.locator('[data-phase="in-call"]')).toBeVisible();
    await expect(g.getByTestId("seat-count")).toHaveText("1 of 3 seats");
    expect((await guest.request.get(`${baseURL}/api/ice?room=${id}`)).status()).toBe(200);
    expect((await host.request.get(`${baseURL}/api/ice`)).status()).toBe(200);
    await page.getByLabel("Your name").fill("Host");
    await page.getByRole("button", { name: "Join without mic" }).click();
    await expect(g.getByTestId("seat-count")).toHaveText("2 of 3 seats");
    const unknown = newRoomId();
    expect((await guest.request.get(`${baseURL}/api/ice?room=${unknown}`)).status()).toBe(403);
    expect((await guest.request.get(`${baseURL}/api/rooms/${unknown}`)).status()).toBe(404);
    await g.goto(`/r/${unknown}`);
    await expect(g.getByRole("heading")).toHaveText("This room doesn't exist or has expired.");
    const status = await new Promise<number>((resolve, reject) => {
      const ws = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${unknown}`);
      ws.on("unexpected-response", (_, r) => { r.resume(); resolve(r.statusCode ?? 0); });
      ws.on("open", () => { ws.close(); reject(new Error("unknown room accepted")); });
      ws.on("error", reject);
    });
    expect(status).toBe(404);
    console.log("Auth: wrong=403, right=204; guest-first join=ok; ICE anonymous=403 valid-invite=200 host=200; unknown peek/WS=404");
  } finally { await host.close(); await guest.close(); }
});

test("video-only share warns; selected input sends screen audio and switches mid-share", async ({ browser, baseURL }) => {
  const host = await browser.newContext(), guest = await browser.newContext();
  try {
    await host.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase } });
    const { id } = await (await host.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL! } })).json();
    const a = await host.newPage(), b = await guest.newPage();
    await a.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext("2d")!;
        setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 40);
        return canvas.captureStream(25);
      };
    });
    for (const [page, name] of [[a, "Sharer"], [b, "Viewer"]] as const) {
      await page.goto(`/r/${id}`); await page.getByLabel("Your name").fill(name);
      await expect(page.getByRole("button", { name: "Join room", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Join room", exact: true }).click();
      await expect(page.locator('[data-phase="in-call"]')).toBeVisible();
    }
    await a.getByTestId("share").click(); await a.getByTestId("preset-motion").click();
    await expect(a.getByTestId("no-sound")).toBeVisible();
    await a.screenshot({ path: "docs/screenshots/no-sound-warning.png" });
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: "docs/screenshots/no-sound-mobile.png" });
    await a.setViewportSize({ width: 1440, height: 900 });
    const picker = a.getByLabel("Audio source", { exact: true });
    const device = await picker.locator('option').evaluateAll((options) => options.map((o) => ({ value: o.getAttribute("value"), label: o.textContent })).find((o) => o.value !== "browser" && o.value !== "none"));
    expect(device?.value).toBeTruthy();
    await picker.selectOption(device!.value!);
    await expect(a.getByTestId("no-sound")).toHaveCount(0);
    const bytes = () => b.evaluate(async () => {
      const stats: PeerStats[] = await (window as unknown as { __streamroom: { stats(): Promise<PeerStats[]> } }).__streamroom.stats();
      return stats.flatMap((p) => p.streams).find((s) => s.direction === "in" && s.label === "screen audio")?.bytes ?? 0;
    });
    await expect.poll(bytes).toBeGreaterThan(0);
    const before = await bytes();
    await expect.poll(bytes).toBeGreaterThan(before);
    console.log(`Screen audio: input=${device?.label}; receiver bytes ${before} -> ${await bytes()}`);
    await b.getByTestId("stats-toggle").click();
    await expect(b.getByTestId("stats")).toContainText("screen audio");
    await a.screenshot({ path: "docs/screenshots/audio-source-picker.png" });
    await a.setViewportSize({ width: 390, height: 844 });
    await a.screenshot({ path: "docs/screenshots/audio-source-mobile.png" });
    await picker.selectOption("none");
    await picker.selectOption(device!.value!);
    const resumed = await bytes(); await expect.poll(bytes).toBeGreaterThan(resumed);
    await a.evaluate(() => {
      const w = window as unknown as { __streamroom: { view: { localScreen: MediaStream } }; __shareTracks: MediaStreamTrack[] };
      w.__shareTracks = w.__streamroom.view.localScreen.getTracks();
    });
    await a.getByTestId("stop-share").click();
    expect(await a.evaluate(() => (window as unknown as { __shareTracks: MediaStreamTrack[] }).__shareTracks.every((t) => t.readyState === "ended"))).toBe(true);
    await expect(picker).toHaveCount(0);
  } finally { await host.close(); await guest.close(); }
});

test("host picks the seat count and the room enforces it", async ({ browser, baseURL }) => {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const origin = { Origin: baseURL! };
  try {
    await ctx.request.post(`${baseURL}/api/host-session`, { headers: origin, data: { passphrase } });
    await page.goto("/");
    // A remembered host sees the picker, not the passphrase field.
    await expect(page.getByTestId("seats")).toHaveText("3");
    await expect(page.getByLabel("Host passphrase")).toHaveCount(0);
    const fewer = page.getByRole("button", { name: "Fewer seats" }), more = page.getByRole("button", { name: "More seats" });
    await fewer.click();
    await expect(page.getByTestId("seats")).toHaveText("2");
    await expect(fewer).toBeDisabled();
    for (let i = 0; i < 8; i++) await more.click();
    await expect(page.getByTestId("seats")).toHaveText("10");
    await expect(more).toBeDisabled();
    await expect(page.locator(".seat-dot")).toHaveCount(10);
    await page.screenshot({ path: "docs/screenshots/seats.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "docs/screenshots/seats-mobile.png" });
    await page.setViewportSize({ width: 1440, height: 900 });
    for (let i = 0; i < 4; i++) await fewer.click();
    await page.getByRole("button", { name: "Start a room" }).click();
    await expect(page).toHaveURL(/\/r\/[\w-]{22}$/);
    const id = page.url().split("/r/")[1]!;
    expect(await (await ctx.request.get(`${baseURL}/api/rooms/${id}`)).json()).toMatchObject({ members: 0, max: 6 });
    await page.getByLabel("Your name").fill("Host");
    await page.getByRole("button", { name: "Join without mic" }).click();
    await expect(page.getByTestId("seat-count")).toHaveText("1 of 6 seats");
    // The choice is remembered for the next room.
    const next = await ctx.newPage();
    await next.goto("/");
    await expect(next.getByTestId("seats")).toHaveText("6");

    // The API rejects out-of-range sizes, and a 2-seat room turns a third person away.
    expect((await ctx.request.post(`${baseURL}/api/rooms`, { headers: origin, data: { seats: 11 } })).status()).toBe(400);
    expect((await ctx.request.post(`${baseURL}/api/rooms`, { headers: origin, data: { seats: 1 } })).status()).toBe(400);
    const small = (await (await ctx.request.post(`${baseURL}/api/rooms`, { headers: origin, data: { seats: 2 } })).json()) as { id: string };
    const sockets = [await seat(baseURL!, small.id), await seat(baseURL!, small.id)];
    expect(sockets.map((s) => s.reply.t)).toEqual(["joined", "joined"]);
    const third = await seat(baseURL!, small.id);
    expect(third.reply).toMatchObject({ t: "error", code: "full" });
    for (const s of [...sockets, third]) s.ws.close();
  } finally { await ctx.close(); }
});

function seat(baseURL: string, room: string): Promise<{ ws: WebSocket; reply: { t: string; code?: string } }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseURL.replace(/^http/, "ws")}/ws?room=${room}`);
    const timer = setTimeout(() => reject(new Error("no answer")), 5000);
    ws.on("open", () => ws.send(JSON.stringify({ t: "join", room, name: "Seat", resume: null, state: { muted: false, hasMic: false, share: null } })));
    ws.once("message", (data) => { clearTimeout(timer); resolve({ ws, reply: JSON.parse(String(data)) }); });
    ws.on("error", reject);
  });
}
