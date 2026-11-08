// End-to-end: chat over signaling and files peer-to-peer, in real headless browsers.

import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { expect, firefox, test, type Browser, type BrowserContext, type Locator, type Page } from "@playwright/test";
import WebSocket from "ws";

interface Friend {
  context: BrowserContext;
  page: Page;
  name: string;
}

async function open(browser: Browser, name: string): Promise<Friend> {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (err) => console.log(`[${name}] pageerror: ${err.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") console.log(`[${name}] ${m.type()}: ${m.text()}`);
  });
  return { context, page, name };
}

async function createRoom(f: Friend, baseURL: string, seats = 4): Promise<string> {
  if (process.env.E2E_HOST_PASSPHRASE) {
    await f.context.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL }, data: { passphrase: process.env.E2E_HOST_PASSPHRASE } });
  }
  await f.page.goto(`/?seats=${seats}`);
  await expect(f.page).toHaveURL(/\/r\/[A-Za-z0-9_-]{22}$/);
  return f.page.url();
}

async function join(f: Friend, url: string): Promise<void> {
  if (f.page.url() !== url) await f.page.goto(url);
  await f.page.getByLabel("Your name").fill(f.name);
  const button = f.page.getByRole("button", { name: "Join room", exact: true });
  await expect(button).toBeEnabled();
  await button.click();
  await expect(f.page.locator('[data-screen="call"][data-phase="in-call"]')).toBeVisible();
}

async function openChat(f: Friend): Promise<void> {
  if ((await f.page.getByTestId("chat-panel").count()) === 0) await f.page.getByTestId("chat-toggle").click();
  await expect(f.page.getByTestId("chat-panel")).toBeVisible();
}

async function say(f: Friend, text: string): Promise<void> {
  await openChat(f);
  const before = await f.page.getByTestId("chat-message").count();
  await f.page.getByTestId("chat-input").fill(text);
  await f.page.getByTestId("chat-input").press("Enter");
  await expect(f.page.getByTestId("chat-input")).toHaveValue("");
  await expect(f.page.getByTestId("chat-message")).toHaveCount(before + 1);
}

const messages = (f: Friend) => f.page.getByTestId("chat-message");
const card = (f: Friend, name: string): Locator => f.page.locator(`[data-testid="file-card"][data-name="${name}"]`);

async function share(f: Friend, path: string): Promise<void> {
  await openChat(f);
  await f.page.getByTestId("chat-file-input").setInputFiles(path);
}

async function randomFile(path: string, bytes: number): Promise<string> {
  const data = randomBytes(bytes);
  await writeFile(path, data);
  return createHash("sha256").update(data).digest("hex");
}

async function saveAndHash(f: Friend, name: string): Promise<string> {
  const downloaded = f.page.waitForEvent("download");
  await card(f, name).getByRole("button", { name: "Save" }).click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toBe(name);
  return createHash("sha256").update(await readFile((await download.path())!)).digest("hex");
}

/** Records every state and byte count a card shows, so a test can tell a resume from a restart. */
async function recordCard(f: Friend, name: string): Promise<() => Promise<{ state: string; received: number; at: number }[]>> {
  await f.page.evaluate((fileName) => {
    const log: { state: string; received: number; at: number }[] = [];
    (window as unknown as { __cardLog: typeof log }).__cardLog = log;
    const sample = () => {
      const el = document.querySelector(`[data-testid="file-card"][data-name="${fileName}"]`);
      if (!el) return;
      const entry = { state: el.getAttribute("data-state") ?? "", received: Number(el.getAttribute("data-received") ?? -1), at: Math.round(performance.now()) };
      const last = log.at(-1);
      if (!last || last.state !== entry.state || last.received !== entry.received) log.push(entry);
    };
    new MutationObserver(sample).observe(document.body, { subtree: true, attributes: true, childList: true });
  }, name);
  return () => f.page.evaluate(() => (window as unknown as { __cardLog: { state: string; received: number; at: number }[] }).__cardLog);
}

async function receivedOf(f: Friend, name: string): Promise<number> {
  return Number((await card(f, name).getAttribute("data-received")) ?? 0);
}

test.describe.configure({ mode: "serial" });

test("chat: both ways, unread badge, history for a late joiner, and typing m doesn't mute", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const cy = await open(browser, "Cy");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);

  await say(ada, "Movie at nine?");
  await expect(ben.page.getByTestId("chat-badge")).toHaveText("1");
  await openChat(ben);
  await expect(ben.page.getByTestId("chat-badge")).toHaveCount(0);
  await expect(messages(ben)).toHaveText(["Movie at nine?"]);

  const muteButton = ben.page.getByTestId("mute");
  const mutedBefore = await muteButton.getAttribute("aria-pressed");
  await ben.page.getByTestId("chat-input").pressSequentially("mmm, I'm in");
  await ben.page.getByTestId("chat-input").press("Shift+Enter");
  await ben.page.getByTestId("chat-input").pressSequentially("bring snacks");
  await ben.page.getByTestId("chat-input").press("Enter");
  if (mutedBefore !== null) await expect(muteButton).toHaveAttribute("aria-pressed", mutedBefore);
  await expect(messages(ada)).toHaveText(["Movie at nine?", "mmm, I'm in\nbring snacks"]);

  await join(cy, room);
  await expect(cy.page.getByTestId("chat-badge")).toHaveText("2");
  await openChat(cy);
  await expect(messages(cy)).toHaveText(["Movie at nine?", "mmm, I'm in\nbring snacks"]);
  await say(cy, "Same");
  for (const f of [ada, ben]) await expect(messages(f)).toHaveText(["Movie at nine?", "mmm, I'm in\nbring snacks", "Same"]);

  for (const f of [ada, ben, cy]) await f.context.close();
});

test("chat: a late joiner gets the largest history the room keeps", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const room = await createRoom(ada, baseURL!, 10);
  const roomId = room.split("/r/")[1]!;
  const longest = "€".repeat(1996);
  const sockets: WebSocket[] = [];
  // Eight members, ten messages each: their bursts fill the history past its byte budget.
  for (let i = 0; i < 8; i++) {
    const ws = new WebSocket(`${baseURL!.replace(/^http/, "ws")}/ws?room=${roomId}`);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => { ws.once("open", resolve); ws.once("error", reject); });
    const joined = new Promise<void>((resolve) => ws.on("message", (d) => { if (JSON.parse(String(d)).t === "joined") resolve(); }));
    ws.send(JSON.stringify({ t: "join", room: roomId, name: `Bot ${i}`, resume: null, state: { muted: true, hasMic: false, share: null } }));
    await joined;
    for (let n = 0; n < 10; n++) ws.send(JSON.stringify({ t: "chat", body: { kind: "text", text: `${i}.${n} ${longest}` } }));
  }
  const last = `7.9 ${longest}`;
  try {
    await join(ada, room);
    await openChat(ada);
    await expect(messages(ada).last()).toHaveText(last);
    const count = await messages(ada).count();
    console.log(`history after 80 messages of 2000 characters: ${count} entries`);
    expect(count).toBeGreaterThan(30);
    expect(count).toBeLessThan(80);
  } finally {
    for (const ws of sockets) ws.close();
    await ada.context.close();
  }
});

test("files: a 5 MiB file goes peer to peer and its SHA-256 matches", async ({ browser, baseURL }, testInfo) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);
  const path = testInfo.outputPath("holiday.bin");
  const digest = await randomFile(path, 5 * 1024 * 1024 + 123);

  await share(ada, path);
  await expect(card(ada, "holiday.bin")).toHaveAttribute("data-state", "offer");
  await openChat(ben);
  await expect(card(ben, "holiday.bin")).toHaveAttribute("data-state", "available");
  const log = await recordCard(ben, "holiday.bin");
  await card(ben, "holiday.bin").getByRole("button", { name: "Download" }).click();
  await expect(card(ben, "holiday.bin")).toHaveAttribute("data-state", "done");
  const states = await log();
  console.log(`5 MiB: requested to verified in ${states.at(-1)!.at - states.find((s) => s.state === "requesting")!.at} ms`);
  expect(await saveAndHash(ben, "holiday.bin")).toBe(digest);
  await expect(card(ada, "holiday.bin")).toContainText("Ben has it");

  for (const f of [ada, ben]) await f.context.close();
});

test("files: a receiver whose connection to the room drops mid-transfer resumes and still verifies", async ({ browser, baseURL }, testInfo) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);
  const path = testInfo.outputPath("film.bin");
  const size = 160 * 1024 * 1024;
  const digest = await randomFile(path, size);
  await share(ada, path);
  await openChat(ben);
  const log = await recordCard(ben, "film.bin");
  await card(ben, "film.bin").getByRole("button", { name: "Download" }).click();
  await expect.poll(() => receivedOf(ben, "film.bin"), { intervals: [50] }).toBeGreaterThan(size / 10);

  const idBefore = await ben.page.evaluate(() => (window as unknown as { __streamroom: { view: { selfId: string } } }).__streamroom.view.selfId);
  await ben.page.evaluate(() => (window as unknown as { __streamroom: { sig: { ws: WebSocket } } }).__streamroom.sig.ws.close());
  await expect(card(ben, "film.bin")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
  const idAfter = await ben.page.evaluate(() => (window as unknown as { __streamroom: { view: { selfId: string } } }).__streamroom.view.selfId);
  expect(idAfter).not.toBe(idBefore);

  const states = await log();
  const paused = states.findIndex((s) => s.state === "paused");
  expect(paused, JSON.stringify(states.map((s) => s.state))).toBeGreaterThan(0);
  const before = states[paused]!.received;
  const resumed = states.slice(paused).find((s) => s.state === "receiving");
  console.log(`paused at ${before} of ${size} bytes; next progress ${resumed?.received}`);
  expect(before).toBeGreaterThan(0);
  expect(before).toBeLessThan(size);
  expect(states.slice(paused).every((s) => s.state === "done" || s.received >= before)).toBe(true);
  expect(await saveAndHash(ben, "film.bin")).toBe(digest);

  for (const f of [ada, ben]) await f.context.close();
});

test("files: cancel stops a download, and a sender leaving fails one in progress", async ({ browser, baseURL }, testInfo) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);
  const path = testInfo.outputPath("archive.bin");
  const size = 160 * 1024 * 1024;
  await randomFile(path, size);
  await share(ada, path);
  await openChat(ben);

  await card(ben, "archive.bin").getByRole("button", { name: "Download" }).click();
  await expect.poll(() => receivedOf(ben, "archive.bin"), { intervals: [50] }).toBeGreaterThan(0);
  await expect(card(ada, "archive.bin")).toContainText("Ben");
  await card(ben, "archive.bin").getByRole("button", { name: "Cancel" }).click();
  await expect(card(ben, "archive.bin")).toHaveAttribute("data-state", "available");
  await expect(card(ada, "archive.bin")).toContainText("Shared from this tab");
  const activity = () => ada.page.evaluate(() => ({...(window as unknown as {__streamroom: {transfers: {activity: {reads: number; sends: number}}}}).__streamroom.transfers.activity}));
  await ada.page.waitForTimeout(100);
  const stopped = await activity();
  await ada.page.waitForTimeout(400);
  expect(await activity()).toEqual(stopped);


  await card(ben, "archive.bin").getByRole("button", { name: "Download" }).click();
  await expect.poll(() => receivedOf(ben, "archive.bin"), { intervals: [50] }).toBeGreaterThan(0);
  await ada.page.getByTestId("leave").click();
  await expect(card(ben, "archive.bin")).toHaveAttribute("data-state", "failed");
  await expect(card(ben, "archive.bin")).toContainText("Ada left before the file finished.");
  await expect(card(ben, "archive.bin").getByRole("button")).toHaveCount(0);

  for (const f of [ada, ben]) await f.context.close();
});

test("files: Chromium and Firefox send each other a file", async ({ browser, baseURL }, testInfo) => {
  test.skip(!existsSync(firefox.executablePath()), "Playwright Firefox isn't installed: pnpm exec playwright install firefox");
  const fox = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "media.navigator.streams.fake": true,
      "media.navigator.permission.disabled": true,
      "media.peerconnection.ice.obfuscate_host_addresses": false,
    },
  });
  try {
    const ada = await open(browser, "Ada");
    const ben = await open(fox, "Ben");
    const room = await createRoom(ada, baseURL!);
    await join(ada, room);
    await join(ben, room);
    const toFox = testInfo.outputPath("to-firefox.bin");
    const toChromium = testInfo.outputPath("to-chromium.bin");
    const [toFoxDigest, toChromiumDigest] = await Promise.all([randomFile(toFox, 3 * 1024 * 1024 + 7), randomFile(toChromium, 2 * 1024 * 1024 + 11)]);
    await share(ada, toFox);
    await share(ben, toChromium);
    await card(ben, "to-firefox.bin").getByRole("button", { name: "Download" }).click();
    await card(ada, "to-chromium.bin").getByRole("button", { name: "Download" }).click();
    await expect(card(ben, "to-firefox.bin")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    await expect(card(ada, "to-chromium.bin")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
    expect(await saveAndHash(ben, "to-firefox.bin")).toBe(toFoxDigest);
    expect(await saveAndHash(ada, "to-chromium.bin")).toBe(toChromiumDigest);
    await ada.context.close();
  } finally {
    await fox.close();
  }
});

test("chat: IME, focus return, mobile sheet, and scroll pinning at the history cap", async ({browser, baseURL}) => {
  const ada = await open(browser, "Ada");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await openChat(ada);
  const input = ada.page.getByTestId("chat-input");
  await input.fill("composing");
  await input.dispatchEvent("keydown", {key:"Enter",keyCode:229,bubbles:true});
  await expect(input).toHaveValue("composing");
  await expect(messages(ada)).toHaveCount(0);
  await input.press("Escape");
  await expect(ada.page.getByTestId("chat-panel")).toHaveCount(0);
  await expect(ada.page.getByTestId("chat-toggle")).toBeFocused();
  await openChat(ada);
  await say(ada, "one\n\n\n\n\n\ttwo");
  await expect(messages(ada)).toHaveText(["one\n\n\n\ttwo"]);
  await expect(ada.page.locator("time")).toHaveAttribute("datetime", /T/);
  await expect(ada.page.getByTestId("chat-log")).not.toHaveAttribute("aria-live");
  await ada.page.evaluate(() => {
    const call = (window as unknown as {__streamroom: {view:{selfId:string};onMessage(msg:unknown):void}}).__streamroom;
    for (let i=0; i<505; i++) call.onMessage({t:"chat",entry:{seq:1000+i,from:call.view.selfId,name:"Ada",at:Date.now(),body:{kind:"text",text:`Message ${i}`}}});
  });
  await expect(messages(ada)).toHaveCount(500);
  await expect.poll(() => ada.page.getByTestId("chat-log").evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await ada.page.evaluate(() => {
    const call = (window as unknown as {__streamroom: {view:{selfId:string};onMessage(msg:unknown):void}}).__streamroom;
    call.onMessage({t:"chat",entry:{seq:1505,from:call.view.selfId,name:"Ada",at:Date.now(),body:{kind:"text",text:"Last message"}}});
  });
  await expect(messages(ada).last()).toHaveText("Last message");
  await expect.poll(() => ada.page.getByTestId("chat-log").evaluate(el => el.scrollHeight-el.scrollTop-el.clientHeight)).toBeLessThan(2);
  await ada.page.setViewportSize({width:390,height:844});
  await expect.poll(() => ada.page.locator(".dock").evaluate(el => (el as HTMLElement).inert)).toBe(true);
  await input.press("Escape");
  await expect.poll(() => ada.page.locator(".dock").evaluate(el => (el as HTMLElement).inert)).toBe(false);
  await ada.context.close();
});

type Hook = { __streamroom: { sig: { ws: WebSocket }; onMessage(msg: unknown): void }; __held: string[]; __release(): void };

/** Holds this tab's outgoing chat frames until released, so a send stays in flight. */
async function holdChat(f: Friend): Promise<void> {
  await f.page.evaluate(() => {
    const w = window as unknown as Hook;
    const ws = w.__streamroom.sig.ws;
    const real = ws.send.bind(ws);
    w.__held = [];
    ws.send = (data: string) => { if (JSON.parse(data).t === "chat") w.__held.push(data); else real(data); };
    w.__release = () => { ws.send = real; for (const data of w.__held.splice(0)) real(data); };
  });
}

const liveRegion = (f: Friend) => f.page.locator('[data-testid="chat-panel"] > p[aria-live="polite"]');

test("chat: Escape closes an open menu first, waits out IME composition, and the draft survives closing", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await openChat(ada);
  const panel = ada.page.getByTestId("chat-panel");
  const input = ada.page.getByTestId("chat-input");
  await expect(panel).not.toHaveAttribute("role", "dialog");
  await expect.poll(() => ada.page.locator(".dock").evaluate((el) => (el as HTMLElement).inert)).toBe(false);
  await input.fill("half a thought");

  await ada.page.getByTestId("share").click();
  await expect(ada.page.getByRole("menu", { name: "Share quality" })).toBeVisible();
  await ada.page.keyboard.press("Escape");
  await expect(ada.page.getByRole("menu")).toHaveCount(0);
  await expect(panel).toBeVisible();

  await input.focus();
  await input.dispatchEvent("keydown", { key: "Escape", isComposing: true, bubbles: true });
  await input.dispatchEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true });
  await ada.page.evaluate(() => window.addEventListener("keydown", (e) => e.preventDefault(), { capture: true, once: true }));
  await input.press("Escape");
  await expect(panel).toBeVisible();

  await input.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(ada.page.getByTestId("chat-toggle")).toBeFocused();
  await openChat(ada);
  await expect(input).toHaveValue("half a thought");
  await ada.context.close();
});

test("chat: text typed during an in-flight send stays, and a rejected send comes back ahead of it once", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await openChat(ada);
  const input = ada.page.getByTestId("chat-input");

  await holdChat(ada);
  await input.fill("first");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.pressSequentially("next idea");
  await input.press("Escape");
  await openChat(ada);
  await expect(input).toHaveValue("next idea");
  await ada.page.evaluate(() => (window as unknown as Hook).__release());
  await expect(messages(ada)).toHaveText(["first"]);
  await expect(input).toHaveValue("next idea");

  await holdChat(ada);
  await input.fill("rejected one");
  await input.press("Enter");
  await expect(input).toHaveValue("");
  await input.pressSequentially("later");
  await input.press("Enter");
  await expect(input).toHaveValue("later");
  await ada.page.evaluate(() => (window as unknown as Hook).__streamroom.onMessage({ t: "error", code: "slow_down", message: "" }));
  await expect(input).toHaveValue("rejected one\nlater");
  expect(await ada.page.evaluate(() => (window as unknown as Hook).__held.length)).toBe(1);
  await ada.page.waitForTimeout(300);
  await expect(messages(ada)).toHaveText(["first"]);
  await ada.context.close();
});

test("chat: on a phone the sheet is a modal dialog, keeps late call children inert, and ignores pinch zoom", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const ada: Friend = { context, page: await context.newPage(), name: "Ada" };
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  expect(await ada.page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
  await ada.page.getByTestId("chat-toggle").click();
  const dialog = ada.page.getByRole("dialog", { name: "Chat" });
  await expect(dialog).toHaveAttribute("aria-modal", "true");
  await expect(ada.page.getByRole("button", { name: "Close chat" })).toBeFocused();

  const inert = (selector: string) => ada.page.locator(selector).evaluate((el) => (el as HTMLElement).inert);
  await expect.poll(() => inert(".dock")).toBe(true);
  await ada.page.evaluate(() => {
    const late = document.createElement("div");
    late.id = "late-child";
    document.querySelector('[data-screen="call"]')!.append(late);
  });
  await expect.poll(() => inert("#late-child")).toBe(true);
  expect(await inert('[data-testid="chat-panel"]')).toBe(false);

  const height = () => dialog.evaluate((el) => (el as HTMLElement).style.height);
  const before = await height();
  await ada.page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, "scale", { configurable: true, get: () => 2 });
    Object.defineProperty(vv, "height", { configurable: true, get: () => 300 });
    vv.dispatchEvent(new Event("resize"));
  });
  expect(await height()).toBe(before);
  await ada.page.evaluate(() => {
    const vv = window.visualViewport!;
    Object.defineProperty(vv, "scale", { configurable: true, get: () => 1 });
    vv.dispatchEvent(new Event("resize"));
  });
  expect(await height()).toBe("300px");

  await ada.page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => inert(".dock")).toBe(false);
  await expect.poll(() => inert("#late-child")).toBe(false);
  await context.close();
});

test("chat: screen readers hear other people's messages, capped, including repeats", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);
  await openChat(ben);
  await ben.page.evaluate(() => {
    const log: string[] = [];
    (window as unknown as { __heard: string[] }).__heard = log;
    const region = document.querySelector('[data-testid="chat-panel"] > p[aria-live="polite"]')!;
    new MutationObserver((records) => {
      for (const r of records) for (const n of r.addedNodes) if (n instanceof HTMLElement) log.push(n.textContent ?? "");
    }).observe(region, { childList: true, subtree: true, characterData: true });
  });

  await say(ada, "Popcorn is ready");
  await expect(liveRegion(ben)).toHaveText("Ada: Popcorn is ready");
  await say(ben, "On my way");
  await expect(messages(ben).last()).toHaveText("On my way");
  await expect(liveRegion(ben)).toHaveText("");

  const long = `${"a".repeat(139)}👨‍👩‍👧 and then a very long tail nobody needs read aloud`;
  await say(ada, long);
  await expect(liveRegion(ben)).toHaveText(`Ada: ${"a".repeat(139)}👨‍👩‍👧…`);

  await say(ada, "Same");
  await expect(messages(ben).last()).toHaveText("Same");
  await say(ada, "Same");
  await expect(messages(ben)).toHaveCount(5);
  await expect.poll(() => ben.page.evaluate(() => (window as unknown as { __heard: string[] }).__heard.filter((t) => t === "Ada: Same").length)).toBe(2);

  for (const f of [ada, ben]) await f.context.close();
});

test("chat: joined emoji, variation selectors and a Persian ZWNJ arrive byte-identical", async ({ browser, baseURL }) => {
  const ada = await open(browser, "Ada");
  const ben = await open(browser, "Ben");
  const room = await createRoom(ada, baseURL!);
  await join(ada, room);
  await join(ben, room);
  const text = "\u{1F468}‍\u{1F469}‍\u{1F467} ❤️ می‌خواهم";
  await say(ada, text);
  await openChat(ben);
  await expect(messages(ben)).toHaveCount(1);
  const received = await messages(ben).first().evaluate((el) => el.textContent ?? "");
  expect(Buffer.from(received, "utf8").toString("hex")).toBe(Buffer.from(text, "utf8").toString("hex"));
  for (const f of [ada, ben]) await f.context.close();
});

test("screenshots of the chat panel", async ({ browser, baseURL }, testInfo) => {
  test.skip(process.env.SCREENSHOTS !== "1", "Set SCREENSHOTS=1 to refresh docs/screenshots.");
  const [ada, ben, cy, dee] = await Promise.all([open(browser, "Ada"), open(browser, "Ben"), open(browser, "Cy"), open(browser, "Dee")]);
  const room = await createRoom(ada, baseURL!, 4);
  for (const f of [ada, ben, cy, dee]) await join(f, room);
  const file = async (name: string, bytes: number) => {
    const path = testInfo.outputPath(name);
    await randomFile(path, bytes);
    return path;
  };

  await share(dee, await file("poster-draft.png", 2_400_000));
  await say(dee, "Have to run, enjoy the film!");
  await dee.page.getByTestId("leave").click();
  await say(ada, "Sound check okay? I'll start in five.");
  await say(cy, "Loud and clear");
  await share(ada, await file("subtitles-en.srt", 84_000));
  await share(ada, await file("trailer-final.mp4", 160 * 1024 * 1024));
  await say(ada, "Subtitles and the trailer, in case your stream stutters.");
  await openChat(ben);
  await card(ben, "subtitles-en.srt").getByRole("button", { name: "Download" }).click();
  await expect(card(ben, "subtitles-en.srt")).toHaveAttribute("data-state", "done");
  await say(ben, "Got the subs, thanks.\nGrabbing popcorn, back in a sec");
  await share(ben, await file("snack-list.txt", 1_800));
  await card(ada, "snack-list.txt").getByRole("button", { name: "Download" }).click();
  await expect(card(ben, "snack-list.txt")).toContainText("Ada has it");

  await ada.page.getByTestId("share").click();
  await ada.page.getByTestId("preset-motion").click();
  await expect(ben.page.getByTestId("stage")).toBeVisible();
  await card(ben, "trailer-final.mp4").getByRole("button", { name: "Download" }).click();
  await expect.poll(() => receivedOf(ben, "trailer-final.mp4"), { intervals: [50] }).toBeGreaterThan(40 * 1024 * 1024);
  await ben.page.waitForTimeout(1100);
  await ben.page.screenshot({ path: "docs/screenshots/chat.png" });

  await ben.page.setViewportSize({ width: 390, height: 844 });
  await expect(card(ben, "trailer-final.mp4")).toHaveAttribute("data-state", "done", { timeout: 60_000 });
  await ben.page.getByTestId("chat-log").evaluate((el) => (el.scrollTop = el.scrollHeight));
  await ben.page.waitForTimeout(300);
  await ben.page.screenshot({ path: "docs/screenshots/chat-mobile.png" });

  for (const f of [ada, ben, cy, dee]) await f.context.close();
});
