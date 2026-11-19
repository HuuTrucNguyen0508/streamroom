// End-to-end: a viewer points and draws on a shared screen, and the sharer sees it (and back).
// Reads the pixels of each page's draw canvas, so it checks what people actually see.

import { expect, test, type Page } from "@playwright/test";

const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";

async function join(page: Page, url: string, name: string): Promise<void> {
  await page.goto(url);
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Join room", exact: true }).click();
  await expect(page.locator('[data-screen="call"][data-phase="in-call"]')).toBeVisible();
}

/** How many pixels on the page's draw canvas have anything painted on them. */
function painted(page: Page): Promise<number> {
  return page.getByTestId("draw-layer").evaluate((el) => {
    const c = el as HTMLCanvasElement;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < data.length; i += 4) if (data[i]! > 0) n++;
    return n;
  });
}

/** Pick up the pen and hover until `watcher` sees our pointer, so the pen's handlers are live. */
async function penUp(page: Page, watcher: Page): Promise<void> {
  await page.getByTestId("draw-toggle").click();
  await expect(page.getByTestId("draw-toggle")).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByTestId("draw-layer")).toHaveCSS("pointer-events", "auto");
  const box = (await page.getByTestId("draw-layer").boundingBox())!;
  let dx = 0;
  await expect
    .poll(
      async () => {
        dx = (dx + 7) % 40;
        await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2);
        return painted(watcher);
      },
      { message: "the other side sees our pointer" },
    )
    .toBeGreaterThan(50);
}

/** Drag across the middle of the stage with the mouse. */
async function scribble(page: Page): Promise<void> {
  const box = (await page.getByTestId("draw-layer").boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx - 150, cy);
  await page.mouse.down();
  for (let i = 0; i <= 30; i++) await page.mouse.move(cx - 150 + i * 10, cy + Math.sin(i / 3) * 60);
  await page.mouse.up();
}

test("a viewer draws on a shared screen and the sharer sees it fade", async ({ browser, baseURL }) => {
  const adaCtx = await browser.newContext();
  const benCtx = await browser.newContext();
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
    await expect(ben.getByTestId("draw-toggle")).toBeVisible();
    await expect.poll(() => ben.locator(".stage-frame video").evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

    // Before the pen is up, the canvas lets clicks through.
    await expect(ben.getByTestId("draw-layer")).toHaveCSS("pointer-events", "none");
    // Ben picks up the pen and hovers: Ada sees his named pointer.
    await penUp(ben, ada);

    await scribble(ben);
    await expect.poll(() => painted(ada), { message: "Ada sees Ben's stroke" }).toBeGreaterThan(2000);
    await expect.poll(() => painted(ben), { message: "Ben sees his own stroke" }).toBeGreaterThan(2000);
    await ada.screenshot({ path: "test-results/draw-sharer.png" });
    await ben.screenshot({ path: "test-results/draw-viewer.png" });

    // Ben moves off the picture: his pointer leaves; the stroke fades within hold + fade time.
    await ben.mouse.move(5, 5);
    await expect.poll(() => painted(ada), { message: "Ben's stroke fades on Ada", timeout: 8000 }).toBe(0);

    // The sharer draws on their own preview and the viewer sees it.
    await penUp(ada, ben);
    await scribble(ada);
    await expect.poll(() => painted(ben), { message: "Ben sees Ada's stroke" }).toBeGreaterThan(2000);

    // The eraser clears Ada's strokes for everyone at once, well before they would fade.
    await ada.getByTestId("draw-clear").click();
    await ada.mouse.move(5, 5);
    await expect.poll(() => painted(ben), { message: "Ada's clear reaches Ben", timeout: 1500 }).toBe(0);

    // Esc puts the pen down.
    await ada.keyboard.press("Escape");
    await expect(ada.getByTestId("draw-toggle")).toHaveAttribute("aria-pressed", "false");
  } finally {
    await adaCtx.close();
    await benCtx.close();
  }
});
