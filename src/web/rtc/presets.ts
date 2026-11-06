import type { PresetId } from "../../shared/protocol.ts";

export type DegradationPreference = "maintain-resolution" | "maintain-framerate" | "balanced";

export interface SharePreset {
  id: PresetId;
  label: string;
  hint: string;
  width: number;
  height: number;
  frameRate: number;
  contentHint: "detail" | "motion" | "text";
  degradation: DegradationPreference;
  /** Video send bitrate cap per viewer, bits per second. */
  maxBitrate: number;
}

export const PRESETS: Record<PresetId, SharePreset> = {
  text: {
    id: "text",
    label: "Text and code",
    hint: "Sharp text, up to 1440p at 30 fps",
    width: 2560,
    height: 1440,
    frameRate: 30,
    contentHint: "detail",
    degradation: "maintain-resolution",
    maxBitrate: 8_000_000,
  },
  motion: {
    id: "motion",
    label: "Motion and games",
    hint: "Smooth movement, up to 1440p at 60 fps",
    width: 2560,
    height: 1440,
    frameRate: 60,
    contentHint: "motion",
    degradation: "maintain-framerate",
    maxBitrate: 12_000_000,
  },
  max: {
    id: "max",
    label: "Max (4K)",
    hint: "Up to 2160p at 60 fps, needs fast upload",
    width: 3840,
    height: 2160,
    frameRate: 60,
    contentHint: "detail",
    degradation: "balanced",
    maxBitrate: 25_000_000,
  },
};

/** Mic and screen-audio send bitrate (Opus, stereo). */
export const AUDIO_MAX_BITRATE = 128_000;
