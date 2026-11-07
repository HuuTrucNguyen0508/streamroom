// End-to-end: real browsers, real WebRTC, real TURN. Media comes from Chromium's fake devices.
// Assertions read RTCPeerConnection.getStats() inside each page through window.__streamroom.

import { expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import WebSocket from "ws";
import type { PeerStats, StreamStats } from "../src/web/rtc/stats.ts";

const SCREENSHOTS = process.env.SCREENSHOTS === "1";

interface Friend {
  context: BrowserContext;
  page: Page;
  name: string;
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[${name}] pageerror: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "warning" || m.type() === "error") console.log(`[${name}] ${m.type()}: ${m.text()}`);
  });
  return { context, page, name };
}

async function join(f: Friend, url: string): Promise<void> {
  await f.page.goto(url);
  await f.page.getByLabel("Your name").fill(f.name);
  const button = f.page.getByRole("button", { name: "Join room", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(f.page.locator('[data-screen="call"][data-phase="in-call"]')).toBeVisible();
}

function stats(f: Friend): Promise<PeerStats[]> {
  return f.page.evaluate(() => (window as unknown as { __streamroom: { stats(): Promise<PeerStats[]> } }).__streamroom.stats());
}

function find(all: PeerStats[], peerName: string, pick: (s: StreamStats) => boolean): StreamStats | undefined {
  return all.find((p) => p.name === peerName)?.streams.find(pick);
}

/** Wait until `read` returns a number that has grown between two samples. */
async function expectGrowing(label: string, read: () => Promise<number | undefined>): Promise<number> {
  let last: number | undefined;
  let grown = 0;
  await expect
    .poll(
      async () => {
        const now = await read();
        if (now !== undefined && last !== undefined && now > last) grown = now - last;
        last = now ?? last;
        return grown;
      },
      { message: label, intervals: [1000], timeout: 30_000 },
    )
    .toBeGreaterThan(0);
  return last ?? 0;
}

const inVoice = (s: StreamStats) => s.direction === "in" && s.label === "voice";
const inScreen = (s: StreamStats) => s.direction === "in" && s.kind === "video";
const outScreen = (s: StreamStats) => s.direction === "out" && s.kind === "video";

function describeVideo(s: StreamStats | undefined): string {
  if (!s) return "none";
  return `${s.codec} ${s.width}x${s.height} @ ${s.fps ?? "?"} fps, ${s.bitrateKbps?.toFixed(0) ?? "?"} kbps, decoded ${s.framesDecoded}`;
}

test.describe.configure({ mode: "serial" });

test("three friends: voice, simultaneous screen shares, presets, full room, lock, host hand-off", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const cy = await open(browser, "Cy");
  const dee = await open(browser, "Dee");

  // A host opening "/?seats=3" creates a 3-seat room and lands on its link.
  if (process.env.E2E_HOST_PASSPHRASE) await ada.context.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase: process.env.E2E_HOST_PASSPHRASE } });
  await ada.page.goto("/?seats=3");
  await expect(ada.page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/);
  const roomUrl = ada.page.url();
  console.log(`room: ${roomUrl}`);

  if (SCREENSHOTS) {
    await ada.page.getByLabel("Your name").fill("Ada");
    await expect(ada.page.locator(".meter")).toBeVisible();
    await ada.page.waitForTimeout(1200); // let the level meter catch a beep
    await ada.page.screenshot({ path: "docs/screenshots/join.png" });
  }

  await join(ada, roomUrl);
  await join(ben, roomUrl);
  await join(cy, roomUrl);
  for (const f of [ada, ben, cy]) await expect(f.page.getByTestId("seat-count")).toHaveText("3 of 3 seats");

  // 1. Everyone hears everyone: inbound voice bytes grow from both other peers.
  for (const f of [ada, ben, cy]) {
    for (const other of [ada, ben, cy].filter((o) => o !== f)) {
      await expectGrowing(`${f.name} receives ${other.name}'s voice`, async () => find(await stats(f), other.name, inVoice)?.bytes);
    }
  }
  const voice = find(await stats(ben), "Ada", (s) => s.direction === "in" && s.label === "voice");
  const outVoice = find(await stats(ada), "Ben", (s) => s.direction === "out" && s.label === "voice");
  console.log(`voice Ada->Ben: ${voice?.codec}, ${outVoice?.codecDetail}, send cap ${outVoice?.maxBitrateKbps} kbps`);
  expect(voice?.codec).toBe("opus");
  expect(outVoice?.codecDetail).toContain("stereo=1");
  expect(outVoice?.codecDetail).toContain("maxaveragebitrate=128000");

  // 2. Ada and Ben start sharing at the same moment (forces an offer collision on their link).
  await ada.page.getByTestId("share").click();
  await ben.page.getByTestId("share").click();
  await Promise.all([ada.page.getByTestId("preset-text").click(), ben.page.getByTestId("preset-motion").click()]);

  for (const [viewer, sharer] of [
    [ben, ada],
    [cy, ada],
    [ada, ben],
    [cy, ben],
  ] as const) {
    await expectGrowing(`${viewer.name} decodes ${sharer.name}'s screen`, async () => find(await stats(viewer), sharer.name, inScreen)?.framesDecoded ?? undefined);
    const v = find(await stats(viewer), sharer.name, inScreen);
    console.log(`${sharer.name} -> ${viewer.name} screen: ${describeVideo(v)}`);
    expect(["AV1", "VP9"]).toContain(v?.codec);
    expect(v?.width).toBeGreaterThan(0);
  }
  await expect(cy.page.getByRole("tab")).toHaveCount(2);
  await expect(cy.page.getByTestId("stage")).toBeVisible();

  // 3. The outbound screen encodings carry each preset's bitrate cap, per viewer.
  for (const viewer of ["Ben", "Cy"]) {
    expect(find(await stats(ada), viewer, outScreen)?.maxBitrateKbps).toBe(8000);
  }
  for (const viewer of ["Ada", "Cy"]) {
    expect(find(await stats(ben), viewer, outScreen)?.maxBitrateKbps).toBe(12000);
  }
  // Give bandwidth estimation a few seconds to ramp, then record what the encoder reached.
  await cy.page.waitForTimeout(6000);
  const adaOut = await stats(ada);
  for (const p of adaOut) {
    const s = p.streams.find(outScreen);
    console.log(
      `Ada -> ${p.name} send: ${s?.codec} ${s?.width}x${s?.height} @ ${s?.fps} fps, ${s?.bitrateKbps?.toFixed(0)} kbps of ${s?.maxBitrateKbps} cap, limited by ${s?.qualityLimitation}; route ${p.localCandidate}/${p.remoteCandidate} ${p.protocol}, rtt ${p.rttMs} ms`,
    );
  }

  if (SCREENSHOTS) {
    await cy.page.getByRole("tab", { name: "Ada's screen" }).click();
    await cy.page.getByTestId("stats-toggle").click();
    await expect(cy.page.getByTestId("stats").locator("tbody tr").first()).toBeVisible();
    await cy.page.waitForTimeout(2500);
    await cy.page.screenshot({ path: "docs/screenshots/call.png" });
    await cy.page.getByTestId("stats-toggle").click();
    await cy.page.setViewportSize({ width: 390, height: 844 });
    await cy.page.waitForTimeout(500);
    await cy.page.screenshot({ path: "docs/screenshots/call-mobile.png" });
    await cy.page.setViewportSize({ width: 1440, height: 900 });
  }

  // 4. A fourth person sees "room is full".
  await dee.page.goto(roomUrl);
  await expect(dee.page.getByRole("heading", { name: "This room is full." })).toBeVisible();

  // 5. Host locks; after Ben leaves, a newcomer still can't get in (UI and server both refuse).
  await ada.page.getByTestId("lock").click();
  await expect(cy.page.getByTestId("locked-badge")).toBeVisible();
  await ben.page.getByTestId("leave").click();
  await expect(ben.page.getByRole("heading", { name: "You left the room." })).toBeVisible();
  await expect(ada.page.getByTestId("seat-count")).toHaveText("2 of 3 seats");
  // Ben's share left with him: Cy is back to one stage, no switcher.
  await expect(cy.page.getByRole("tab")).toHaveCount(0);

  await dee.page.goto(roomUrl);
  await expect(dee.page.getByText("The host locked this room.")).toBeVisible();
  await expect(dee.page.getByRole("button", { name: "Join room", exact: true })).toBeDisabled();
  const roomId = roomUrl.split("/r/")[1]!;
  const serverAnswer = await rawJoin(baseURL!, roomId);
  expect(serverAnswer).toMatchObject({ t: "error", code: "locked" });

  await ada.page.getByTestId("lock").click();
  await expect(cy.page.getByTestId("locked-badge")).toHaveCount(0);
  await dee.page.reload();
  await join(dee, roomUrl);
  await expect(ada.page.getByTestId("seat-count")).toHaveText("3 of 3 seats");

  // 6. Ada stops sharing: the stage disappears for everyone.
  await expectGrowing("Dee decodes Ada's screen", async () => find(await stats(dee), "Ada", inScreen)?.framesDecoded ?? undefined);
  await ada.page.getByTestId("stop-share").click();
  await expect(cy.page.getByTestId("stage")).toHaveCount(0);
  await expect(dee.page.getByTestId("stage")).toHaveCount(0);
  await expect(cy.page.getByText("Nobody is sharing.")).toBeVisible();

  // 7. The host leaves: the next member in join order (Cy) becomes host and gets the lock control.
  await ada.page.getByTestId("leave").click();
  await expect(cy.page.getByTestId("lock")).toBeVisible();
  await expect(dee.page.getByTestId("lock")).toHaveCount(0);

  for (const f of [ada, ben, cy, dee]) await f.context.close();
});

test("relay only (?relay=1): media flows through coturn", async ({ browser, request, baseURL }) => {
  if (process.env.E2E_HOST_PASSPHRASE) await request.post("/api/host-session", { headers: { Origin: baseURL! }, data: { passphrase: process.env.E2E_HOST_PASSPHRASE } });
  const ice = await (await request.get("/api/ice")).json();
  test.skip(!ice.iceServers.some((s: { urls: string[] }) => s.urls.some((url) => /^turns?:/.test(url))), "Relay test requires TURN credentials; STUN-only development cannot relay.");
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  if (process.env.E2E_HOST_PASSPHRASE) await ada.context.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase: process.env.E2E_HOST_PASSPHRASE } });
  await ada.page.goto("/?seats=3&relay=1");
  await expect(ada.page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}\?relay=1$/);
  const roomUrl = ada.page.url();
  await join(ada, roomUrl);
  await join(ben, roomUrl);
  await expect(ada.page.getByText("Relay only")).toBeVisible();

  await expectGrowing("Ben receives Ada's voice via TURN", async () => find(await stats(ben), "Ada", inVoice)?.bytes);
  await ada.page.getByTestId("share").click();
  await ada.page.getByTestId("preset-motion").click();
  await expectGrowing("Ben decodes Ada's screen via TURN", async () => find(await stats(ben), "Ada", inScreen)?.framesDecoded ?? undefined);

  for (const f of [ada, ben]) {
    const [peer] = await stats(f);
    console.log(
      `${f.name} route: local ${peer?.localCandidate}, remote ${peer?.remoteCandidate}, ${peer?.protocol}, rtt ${peer?.rttMs} ms; screen ${describeVideo(peer?.streams.find((s) => s.kind === "video"))}`,
    );
    expect(peer?.localCandidate).toBe("relay");
    expect(peer?.remoteCandidate).toBe("relay");
  }
  for (const f of [ada, ben]) await f.context.close();
});

/** Join over a raw WebSocket to prove the server (not just the UI) enforces the lock. */
function rawJoin(baseURL: string, room: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${baseURL.replace(/^http/, "ws")}/ws?room=${room}`);
    const timer = setTimeout(() => reject(new Error("no answer")), 5000);
    ws.on("open", () =>
      ws.send(JSON.stringify({ t: "join", room, name: "Intruder", resume: null, state: { muted: false, hasMic: false, share: null } })),
    );
    ws.on("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
      ws.close();
    });
    ws.on("error", reject);
  });
}
