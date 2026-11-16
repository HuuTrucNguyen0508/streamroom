import { expect, test, type Browser } from "@playwright/test";
const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";

// A friend shares "Entire screen" with system audio in a browser that ignores restrictOwnAudio
// (Linux, Firefox, older Chrome). The capture records the default output, call included, so the
// viewer hears their own voice. The sharer is warned and can move the call to another device.
async function shareWith(browser: Browser, baseURL: string, restrictOwnAudio: boolean) {
  const host = await browser.newContext(), guest = await browser.newContext();
  await host.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL }, data: { passphrase } });
  const { id } = await (await host.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL } })).json();
  const viewer = await host.newPage(), sharer = await guest.newPage();
  await sharer.addInitScript((applied: boolean) => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement("canvas"); canvas.width = 640; canvas.height = 360;
      const ctx = canvas.getContext("2d")!;
      setInterval(() => { ctx.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; ctx.fillRect(0, 0, 640, 360); }, 40);
      const audio = new AudioContext(), tone = audio.createOscillator(), out = audio.createMediaStreamDestination();
      tone.connect(out); tone.start();
      const video = canvas.captureStream(25).getVideoTracks()[0]!, sound = out.stream.getAudioTracks()[0]!;
      const videoSettings = video.getSettings.bind(video), soundSettings = sound.getSettings.bind(sound);
      video.getSettings = () => ({ ...videoSettings(), displaySurface: "monitor" }) as MediaTrackSettings;
      sound.getSettings = () => ({ ...soundSettings(), restrictOwnAudio: applied }) as MediaTrackSettings;
      return new MediaStream([video, sound]);
    };
    const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
    const fake = (deviceId: string, label: string) => ({ deviceId, label, kind: "audiooutput", groupId: deviceId, toJSON() { return this; } }) as MediaDeviceInfo;
    navigator.mediaDevices.enumerateDevices = async () => [
      ...(await real()).filter((d) => d.kind !== "audiooutput"),
      fake("default", "Default - Speakers (Realtek Audio)"),
      fake("realtek", "Speakers (Realtek Audio)"),
      fake("headset", "Headphones (USB Headset)"),
    ];
    HTMLMediaElement.prototype.setSinkId = async function () { /* Fake ids can't reach the real one. */ };
  }, restrictOwnAudio);
  for (const [page, name] of [[viewer, "Viewer"], [sharer, "Sharer"]] as const) {
    await page.goto(`/r/${id}`); await page.getByLabel("Your name").fill(name);
    await page.getByRole("button", { name: "Join room", exact: true }).click();
    await expect(page.locator('[data-phase="in-call"]')).toBeVisible();
  }
  await sharer.getByTestId("share").click(); await sharer.getByTestId("preset-motion").click();
  await expect(sharer.getByTestId("speaker")).toBeVisible();
  return { sharer, close: async () => { await host.close(); await guest.close(); } };
}

test("a sharer whose browser captures the call is warned until the call moves off the default output", async ({ browser, baseURL }) => {
  const { sharer, close } = await shareWith(browser, baseURL!, false);
  try {
    await expect(sharer.getByTestId("call-captured")).toContainText("friends hear themselves");
    await sharer.screenshot({ path: "test-results/call-captured-warning.png" });
    await sharer.getByTestId("speaker").selectOption("headset");
    await expect(sharer.getByTestId("call-captured")).toHaveCount(0);
    // Naming the default device itself still records the call.
    await sharer.getByTestId("speaker").selectOption("realtek");
    await expect(sharer.getByTestId("call-captured")).toBeVisible();
  } finally { await close(); }
});

test("a sharer whose browser leaves the call out sees no echo warning", async ({ browser, baseURL }) => {
  const { sharer, close } = await shareWith(browser, baseURL!, true);
  try {
    await expect(sharer.getByTestId("speaker")).toHaveValue("");
    await expect(sharer.getByTestId("call-captured")).toHaveCount(0);
  } finally { await close(); }
});
