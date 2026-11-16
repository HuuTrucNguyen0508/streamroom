import { describe, expect, it } from "vitest";
import { speakerBehindReplayer } from "../src/web/rtc/media.ts";

const out = (deviceId: string, label: string, groupId = deviceId) => ({ deviceId, label, groupId, kind: "audiooutput" });

describe("speakerBehindReplayer", () => {
  it("leaves the call alone when the default output is a real device", () => {
    expect(speakerBehindReplayer([out("default", "Default - Speakers (Realtek Audio)"), out("realtek", "Speakers (Realtek Audio)")])).toBeNull();
  });

  it("moves the call from FxSound to the communications headset", () => {
    expect(speakerBehindReplayer([
      out("default", "Default - FxSound Speakers (FxSound Audio Enhancer)"),
      out("communications", "Communications - Headset Earphone (Arctis 7 Chat)"),
      out("fxsound", "FxSound Speakers (FxSound Audio Enhancer)"),
      out("realtek", "Speakers (Realtek Audio)"),
      out("arctis", "Headset Earphone (Arctis 7 Chat)"),
    ])).toEqual({ replayer: "FxSound", deviceId: "arctis", label: "Headset Earphone (Arctis 7 Chat)" });
  });

  it("reads localized alias prefixes", () => {
    expect(speakerBehindReplayer([
      out("default", "Par défaut - FxSound Speakers (FxSound Audio Enhancer)"),
      out("communications", "Communications - Casque (USB Audio)"),
      out("fxsound", "FxSound Speakers (FxSound Audio Enhancer)"),
      out("hdmi", "LG ULTRAGEAR (NVIDIA High Definition Audio)"),
      out("usb", "Casque (USB Audio)"),
    ])?.deviceId).toBe("usb");
  });

  it("uses the only real device when the communications device is FxSound too", () => {
    expect(speakerBehindReplayer([
      out("default", "Default - FxSound Speakers (FxSound Audio Enhancer)"),
      out("communications", "Communications - FxSound Speakers (FxSound Audio Enhancer)"),
      out("fxsound", "FxSound Speakers (FxSound Audio Enhancer)"),
      out("phones", "Headphones (Realtek Audio)"),
    ])?.deviceId).toBe("phones");
  });

  it("asks instead of guessing between several real devices", () => {
    expect(speakerBehindReplayer([
      out("default", "Default - FxSound Speakers (FxSound Audio Enhancer)"),
      out("communications", "Communications - FxSound Speakers (FxSound Audio Enhancer)"),
      out("fxsound", "FxSound Speakers (FxSound Audio Enhancer)"),
      out("phones", "Headphones (Realtek Audio)"),
      out("hdmi", "LG ULTRAGEAR (NVIDIA High Definition Audio)"),
    ])).toEqual({ replayer: "FxSound", deviceId: null, label: "" });
  });

  it("ignores inputs and unlabeled devices", () => {
    expect(speakerBehindReplayer([
      { ...out("default", "Default - FxSound Speakers (FxSound Audio Enhancer)"), kind: "audioinput" },
      out("x", ""),
    ])).toBeNull();
  });
});
