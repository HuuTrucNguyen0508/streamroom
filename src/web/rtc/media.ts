// Capturing local media: microphone, screen, and extra audio sources for a share.

import { sortVideoCodecs } from "../../shared/sdp.ts";
import type { SharePreset } from "./presets.ts";

/** Voice gets the browser's echo/noise/gain processing; `raw` (a game or system-audio source) gets none, in stereo. */
export function micConstraints(deviceId: string | null, raw: boolean): MediaTrackConstraints {
  const processing = !raw;
  return {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    echoCancellation: processing,
    noiseSuppression: processing,
    autoGainControl: processing,
    channelCount: raw ? { ideal: 2 } : { ideal: 1 },
    sampleRate: { ideal: 48_000 },
  };
}

export async function getMic(deviceId: string | null): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: micConstraints(deviceId, false), video: false });
  } catch (err) {
    // The remembered device may be gone; fall back to the default one.
    if (deviceId && err instanceof DOMException && err.name === "OverconstrainedError") {
      return navigator.mediaDevices.getUserMedia({ audio: micConstraints(null, false), video: false });
    }
    throw err;
  }
}

export async function listMics(): Promise<MediaDeviceInfo[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((d) => d.kind === "audioinput" && d.deviceId !== "");
}

export async function getScreen(preset: SharePreset): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: {
      // Open the picker on "Entire screen": the only tab where Chrome offers system audio.
      ...({ displaySurface: "monitor" } as object),
      width: { max: preset.width },
      height: { max: preset.height },
      frameRate: { ideal: preset.frameRate, max: preset.frameRate },
    },
    // System/tab audio when the browser offers it. Turn off processing so music survives.
    // restrictOwnAudio: system-audio capture skips this page's own playback (the call), so friends
    // don't hear themselves echoed back. Chrome-based browsers on Windows/macOS; ignored elsewhere.
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: { ideal: 2 },
      ...({ restrictOwnAudio: true } as object),
    },
    // Chrome hints; unknown keys are ignored elsewhere.
    ...({ systemAudio: "include", selfBrowserSurface: "exclude", surfaceSwitching: "include" } as object),
  } as DisplayMediaStreamOptions);
  const video = stream.getVideoTracks()[0];
  if (video) video.contentHint = preset.contentHint;
  for (const audio of stream.getAudioTracks()) audio.contentHint = "music";
  return stream;
}

/** Codec list for screen share video in our preference order, limited to what this browser can send. */
export function preferredVideoCodecs(): RTCRtpCodec[] | null {
  const recv = typeof RTCRtpReceiver !== "undefined" ? RTCRtpReceiver.getCapabilities?.("video") : null;
  if (!recv) return null;
  const send = RTCRtpSender.getCapabilities?.("video");
  const sendable = new Set(send?.codecs.map((c) => c.mimeType.toLowerCase()) ?? []);
  const codecs = send ? recv.codecs.filter((c) => sendable.has(c.mimeType.toLowerCase())) : recv.codecs;
  return sortVideoCodecs(codecs.length > 0 ? codecs : recv.codecs);
}

export function setVideoCodecPreferences(transceiver: RTCRtpTransceiver): void {
  if (typeof transceiver.setCodecPreferences !== "function") return;
  const codecs = preferredVideoCodecs();
  if (!codecs) return;
  try {
    transceiver.setCodecPreferences(codecs);
  } catch (err) {
    console.warn("setCodecPreferences failed; using browser defaults", err);
  }
}
