// End-to-end: the sharer turns on "Show marks on my desktop", and their tab forwards a viewer's
// pointer and strokes to Streamroom Glass on this computer. A small WebSocket server stands in for
// the app (glass/ has its own tests, and its real overlay can't run in CI), so this checks the browser side:
// what the tab sends, when, and what the person sees.

import { expect, test, type Page } from "@playwright/test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { WebSocketServer } = require("ws") as typeof import("ws");

const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";
const GLASS_PORT = 47291;

test.use({ actionTimeout: 15_000 });

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.locator('[data-screen="call"][data-phase="in-call"]')).toBeVisible();
}

/** A stand-in for Streamroom Glass that records what the tab sends and says it draws on "TEST-1". */
function fakeGlass(origin: string) {
  const frames: Record<string, unknown>[] = [];
  const origins: string[] = [];
  let closes = 0;
  const server = new WebSocketServer({ host: "127.0.0.1", port: GLASS_PORT });
  server.on("connection", (ws, req) => {
    origins.push(req.headers.origin ?? "");
    if (req.headers.origin !== origin) return ws.close(1008);
    ws.send(JSON.stringify({ t: "hello", app: "streamroom-glass", v: 1 }));
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data)) as Record<string, unknown>;
      frames.push(msg);
      if (msg.t === "share") ws.send(JSON.stringify({ t: "status", gen: msg.gen, output: "TEST-1" }));
    });
    ws.on("close", () => closes++);
  });
  const close = () =>
    new Promise((resolve) => {
      for (const client of server.clients) client.terminate();
      server.close(resolve);
    });
  return { frames, origins, closes: () => closes, close };
}

test("the sharer's tab sends marks on their screen to Streamroom Glass", async ({ browser, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const adaCtx = await browser.newContext();
  const benCtx = await browser.newContext();
  let glass: ReturnType<typeof fakeGlass> | null = null;
  try {
    await adaCtx.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase } });
    const { id } = await (await adaCtx.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL! } })).json();
    const ada = await adaCtx.newPage();
    const ben = await benCtx.newPage();
    for (const [p, n] of [[ada, "Ada"], [ben, "Ben"]] as const) p.on("pageerror", (e) => console.log(`[${n}] pageerror: ${e.message}`));
    await join(ada, `/r/${id}`, "Ada");
    await join(ben, `/r/${id}`, "Ben");

    await ada.getByTestId("share").click();
    await ada.locator('[data-testid^="preset-"]').first().click();
    const toggle = ada.getByTestId("glass-toggle");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    // Only the sharer gets the switch.
    await expect(ben.getByTestId("draw-toggle")).toBeVisible();
    await expect(ben.getByTestId("glass-toggle")).toHaveCount(0);

    // Turned on with no app running: say so, with the command to start it.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(toggle).toHaveAttribute("data-state", "attention");
    const note = ada.getByTestId("glass-note");
    await expect(note).toContainText("Streamroom couldn't reach Streamroom Glass");
    await expect(note.locator("code")).toHaveText(`streamroom-glass --origin ${origin}`);
    await ada.screenshot({ path: "test-results/glass-missing.png" });

    // The app starts; coming back to the tab connects at once.
    glass = fakeGlass(origin);
    await ada.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(toggle).toHaveAttribute("data-state", "drawing");
    await expect(note).toHaveCount(0);
    await ada.mouse.move(5, 5);
    // Lit like the pressed pen: tungsten, not the attention color.
    await expect(toggle).toHaveCSS("color", "rgb(244, 184, 96)");
    expect(glass.origins).toEqual([origin]);
    const share = glass.frames[0]!;
    expect(share).toMatchObject({ t: "share", gen: 1 });
    // The fake capture is a 16:9 monitor.
    expect((share.w as number) / (share.h as number)).toBeCloseTo(16 / 9, 2);
    await ada.screenshot({ path: "test-results/glass-drawing.png" });

    // Ben points and draws on Ada's screen: each mark reaches the app, credited to Ben.
    await ben.getByTestId("draw-toggle").click();
    const box = (await ben.getByTestId("draw-layer").boundingBox())!;
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await ben.mouse.move(cx - 100, cy);
    await ben.mouse.move(cx - 90, cy);
    await ben.mouse.down();
    for (let i = 0; i <= 20; i++) await ben.mouse.move(cx - 90 + i * 9, cy + (i % 2) * 20);
    await ben.mouse.up();
    await expect.poll(() => glass!.frames.filter((f) => f.t === "mark" && (f.m as { t: string }).t === "up").length).toBe(1);
    const marks = glass.frames.filter((f) => f.t === "mark");
    expect(new Set(marks.map((m) => m.name))).toEqual(new Set(["Ben"]));
    expect(new Set(marks.map((m) => m.gen))).toEqual(new Set([1]));
    expect(marks.map((m) => (m.m as { t: string }).t)).toEqual(expect.arrayContaining(["move", "down", "line", "up"]));
    for (const m of marks) {
      const { x, y } = m.m as { x?: number; y?: number };
      if (x !== undefined) expect(x > 0.3 && x < 0.7 && y! > 0.3 && y! < 0.7).toBe(true);
    }

    // Stopping the share tells the app, then lets it go.
    await ada.getByTestId("stop-share").click();
    await expect.poll(() => glass!.frames.at(-1)).toEqual({ t: "stop", gen: 1 });
    await expect.poll(() => glass!.closes()).toBe(1);
    // The switch remembers being on for the next share.
    await ada.reload();
    await join(ada, `/r/${id}`, "Ada");
    await ada.getByTestId("share").click();
    await ada.locator('[data-testid^="preset-"]').first().click();
    await expect(ada.getByTestId("glass-toggle")).toHaveAttribute("data-state", "drawing");
  } finally {
    await glass?.close();
    await adaCtx.close();
    await benCtx.close();
  }
});
