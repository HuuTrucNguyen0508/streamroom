import { expect, test } from "@playwright/test";
const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";

// A desktop app's Streamroom tab opens the start page, not the invite. A friend pastes the room
// code (or the whole link) there instead.
test("a friend joins from the start page with a pasted room code or link", async ({ browser, baseURL }) => {
  const host = await browser.newContext(), friend = await browser.newContext();
  try {
    await host.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase } });
    const { id } = await (await host.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL! } })).json();
    const page = await friend.newPage();
    await page.goto("/");
    const code = page.getByLabel("Join a friend's room");
    await expect(page.getByRole("button", { name: "Join room" })).toBeDisabled();

    await code.fill("not a room");
    await page.getByRole("button", { name: "Join room" }).click();
    await expect(page.getByRole("alert")).toContainText("isn't a room code");
    await expect(page).toHaveURL(`${baseURL}/`);
    await page.screenshot({ path: "test-results/join-by-code-error.png" });

    await code.fill(id);
    await page.getByRole("button", { name: "Join room" }).click();
    await expect(page).toHaveURL(`${baseURL}/r/${id}`);
    await expect(page.getByLabel("Your name")).toBeVisible();

    await page.goto("/");
    await page.getByLabel("Join a friend's room").fill(`Come in: ${baseURL}/r/${id}`);
    await page.getByLabel("Join a friend's room").press("Enter");
    await expect(page).toHaveURL(`${baseURL}/r/${id}`);

    await page.goto("/");
    await page.screenshot({ path: "test-results/join-by-code.png" });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: "test-results/join-by-code-mobile.png", fullPage: true });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  } finally { await host.close(); await friend.close(); }
});
