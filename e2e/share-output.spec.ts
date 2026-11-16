import { expect, test } from "@playwright/test";
const passphrase = process.env.E2E_HOST_PASSPHRASE ?? "streamroom-test-only";

// A Windows friend's default output is FxSound. FxSound replays the call from its own program, so
// a system-audio share captures it and the mic's echo canceller can't remove it: the viewer hears
// themselves. On join the call moves straight to the friend's headset; picking FxSound warns.
// The viewer sits on an ultrawide window, where a 16:9 share used to overflow the stage and be cropped.
test("ultrawide viewer sees the whole share; the call moves off FxSound to the headset on join", async ({ browser, baseURL }) => {
  const host = await browser.newContext({ viewport: { width: 3440, height: 1300 } }), guest = await browser.newContext();
  try {
    await host.request.post(`${baseURL}/api/host-session`, { headers: { Origin: baseURL! }, data: { passphrase } });
    const { id } = await (await host.request.post(`${baseURL}/api/rooms`, { headers: { Origin: baseURL! } })).json();
    const viewer = await host.newPage(), sharer = await guest.newPage();
    await sharer.addInitScript(() => {
      navigator.mediaDevices.getDisplayMedia = async () => {
        const canvas = document.createElement("canvas"); canvas.width = 2560; canvas.height = 1440;
        const ctx = canvas.getContext("2d")!;
        setInterval(() => {
          ctx.fillStyle = `hsl(${Date.now() % 360},70%,50%)`; ctx.fillRect(0, 0, 2560, 1440);
          ctx.fillStyle = "#fff"; ctx.fillRect(0, 1380, 2560, 60); // The taskbar the crop used to hide.
        }, 40);
        const audio = new AudioContext(), tone = audio.createOscillator(), out = audio.createMediaStreamDestination();
        tone.connect(out); tone.start();
        return new MediaStream([...canvas.captureStream(25).getVideoTracks(), ...out.stream.getAudioTracks()]);
      };
      const real = navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices);
      const fake = (deviceId: string, label: string) => ({ deviceId, label, kind: "audiooutput", groupId: deviceId, toJSON() { return this; } }) as MediaDeviceInfo;
      navigator.mediaDevices.enumerateDevices = async () => [
        ...(await real()).filter((d) => d.kind !== "audiooutput"),
        fake("default", "Default - FxSound Speakers (FxSound Audio Enhancer)"),
        fake("communications", "Communications - Headset Earphone (Arctis 7 Chat)"),
        fake("fxsound", "FxSound Speakers (FxSound Audio Enhancer)"),
        fake("arctis-chat", "Headset Earphone (Arctis 7 Chat)"),
      ];
      // Fake device ids can't reach the real setSinkId; record where each player was sent instead.
      // A sink set before the player plays its stream never reaches the speakers (the call stayed
      // on FxSound after a friend rejoined), so only a playing player's routing counts.
      const w = window as unknown as { __sinks: string[] };
      w.__sinks = [];
      HTMLMediaElement.prototype.setSinkId = async function (this: HTMLMediaElement, sinkId: string) {
        w.__sinks.push(this.srcObject && !this.paused ? sinkId : `ignored:${sinkId}`);
      };
    });
    for (const [page, name] of [[viewer, "Viewer"], [sharer, "Sharer"]] as const) {
      await page.goto(`/r/${id}`); await page.getByLabel("Your name").fill(name);
      await expect(page.getByRole("button", { name: "Join room", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Join room", exact: true }).click();
      await expect(page.locator('[data-phase="in-call"]')).toBeVisible();
    }
    // Joined: the call already plays on the headset, and the sharer is told why.
    await expect(sharer.getByRole("alert")).toContainText("FxSound");
    await expect(sharer.getByRole("alert")).toContainText("Headset Earphone (Arctis 7 Chat)");
    expect(await sharer.evaluate(() => (window as unknown as { __sinks: string[] }).__sinks)).toContain("arctis-chat");
    expect(await sharer.evaluate(() => localStorage.getItem("streamroom:speaker"))).toBeNull();
    await sharer.screenshot({ path: "test-results/fxsound-moved.png" });
    await sharer.getByRole("button", { name: "Choose microphone and speaker" }).click();
    const menu = sharer.getByTestId("audio-menu");
    await expect(menu.getByRole("menuitemradio", { name: /Arctis 7 Chat/ })).toHaveAttribute("aria-checked", "true");
    await expect(menu.getByRole("menuitemradio", { name: /^FxSound Speakers/ })).toContainText("friends hear their own voice");
    await sharer.screenshot({ path: "test-results/audio-menu.png" });
    await sharer.getByRole("button", { name: "Choose microphone and speaker" }).click();
    await sharer.getByRole("button", { name: "Dismiss" }).click();

    await sharer.getByTestId("share").click(); await sharer.getByTestId("preset-motion").click();

    // Ultrawide viewer: the whole 16:9 frame fits inside the stage (letterboxed, not cropped).
    const video = viewer.locator(".stage-video");
    await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBe(2560);
    const box = await viewer.evaluate(() => {
      const v = document.querySelector<HTMLVideoElement>(".stage-video")!, f = document.querySelector(".stage-frame")!;
      const vr = v.getBoundingClientRect(), fr = f.getBoundingClientRect();
      const scale = Math.min(vr.width / v.videoWidth, vr.height / v.videoHeight);
      const shownHeight = v.videoHeight * scale, top = vr.top + (vr.height - shownHeight) / 2;
      return { frameTop: fr.top, frameBottom: fr.bottom, shownTop: top, shownBottom: top + shownHeight };
    });
    expect(box.shownTop).toBeGreaterThanOrEqual(box.frameTop - 1);
    expect(box.shownBottom).toBeLessThanOrEqual(box.frameBottom + 1);
    await viewer.screenshot({ path: "test-results/ultrawide-viewer.png" });

    // Sharing: no echo warning, since the call is already off FxSound.
    const speaker = sharer.getByTestId("speaker");
    await expect(speaker).toHaveValue("arctis-chat");
    await expect(speaker.locator("option")).toHaveText(["System default: FxSound Speakers (FxSound Audio Enhancer)", "FxSound Speakers (FxSound Audio Enhancer)", "Headset Earphone (Arctis 7 Chat)"]);
    await expect(sharer.getByTestId("replayer-echo")).toHaveCount(0);
    // Picking FxSound by name is respected, with a warning.
    await speaker.selectOption("fxsound");
    await expect(sharer.getByTestId("replayer-echo")).toContainText("FxSound");
    expect(await sharer.evaluate(() => localStorage.getItem("streamroom:speaker"))).toBe("fxsound");
    await sharer.screenshot({ path: "test-results/fxsound-warning.png" });
    await speaker.selectOption("arctis-chat");
    await expect(sharer.getByTestId("replayer-echo")).toHaveCount(0);
    expect(await sharer.evaluate(() => localStorage.getItem("streamroom:speaker"))).toBe("arctis-chat");

    // The viewer leaves and rejoins: the sharer's new player for them goes to the headset too.
    const routed = () => sharer.evaluate(() => (window as unknown as { __sinks: string[] }).__sinks.filter((s) => s === "arctis-chat").length);
    const before = await routed();
    await viewer.getByRole("button", { name: "Leave", exact: true }).click();
    await viewer.getByRole("button", { name: "Rejoin" }).click();
    await viewer.getByLabel("Your name").fill("Viewer");
    await viewer.getByRole("button", { name: "Join room", exact: true }).click();
    await expect(viewer.locator('[data-phase="in-call"]')).toBeVisible();
    await expect.poll(routed).toBeGreaterThan(before);

    // The choice survives a reload: new players go straight to the headset.
    await sharer.reload();
    await sharer.getByLabel("Your name").fill("Sharer");
    await sharer.getByRole("button", { name: "Join room", exact: true }).click();
    await expect(sharer.locator('[data-phase="in-call"]')).toBeVisible();
    await expect.poll(() => sharer.evaluate(() => (window as unknown as { __sinks: string[] }).__sinks)).toContain("arctis-chat");
  } finally { await host.close(); await guest.close(); }
});
