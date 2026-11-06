// SDP helpers. Pure string functions so they can be unit tested without a browser.

export const OPUS_PARAMS: Readonly<Record<string, string>> = {
  stereo: "1",
  "sprop-stereo": "1",
  maxaveragebitrate: "128000",
  useinbandfec: "1",
};

/**
 * Merge parameters into the fmtp line of every Opus payload type, adding the line if it is
 * missing. Other codecs are left untouched. Line endings are preserved.
 */
export function mungeOpus(sdp: string, params: Readonly<Record<string, string>> = OPUS_PARAMS): string {
  const eol = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(eol);
  const opusPts = new Set<string>();
  for (const line of lines) {
    const m = /^a=rtpmap:(\d+) opus\/48000(?:\/\d+)?$/i.exec(line.trim());
    if (m) opusPts.add(m[1]!);
  }
  if (opusPts.size === 0) return sdp;

  const seenFmtp = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const f = /^a=fmtp:(\d+) (.*)$/.exec(line);
    if (f && opusPts.has(f[1]!)) {
      seenFmtp.add(f[1]!);
      out.push(`a=fmtp:${f[1]} ${mergeParams(f[2]!, params)}`);
      continue;
    }
    out.push(line);
    const r = /^a=rtpmap:(\d+) opus\//i.exec(line);
    if (r && opusPts.has(r[1]!)) {
      // Insert an fmtp line right after rtpmap if none exists for this payload anywhere.
      const pt = r[1]!;
      if (!lines.some((l) => l.startsWith(`a=fmtp:${pt} `))) out.push(`a=fmtp:${pt} ${mergeParams("", params)}`);
    }
  }
  return out.join(eol);
}

function mergeParams(existing: string, params: Readonly<Record<string, string>>): string {
  const entries: [string, string][] = [];
  for (const part of existing.split(";")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    const key = eq === -1 ? trimmed : trimmed.slice(0, eq);
    const value = eq === -1 ? "" : trimmed.slice(eq + 1);
    entries.push([key, value]);
  }
  for (const [key, value] of Object.entries(params)) {
    const i = entries.findIndex(([k]) => k.toLowerCase() === key.toLowerCase());
    if (i === -1) entries.push([key, value]);
    else entries[i] = [entries[i]![0], value];
  }
  return entries.map(([k, v]) => (v === "" ? k : `${k}=${v}`)).join(";");
}

/** Preference order for screen share video. Lower rank wins; unknown codecs keep their order after these. */
const VIDEO_RANK: Record<string, number> = { "video/av1": 0, "video/vp9": 1, "video/h264": 2, "video/vp8": 3 };
const FEC_LIKE = new Set(["video/rtx", "video/red", "video/ulpfec", "video/flexfec-03"]);

export interface CodecLike {
  mimeType: string;
}

/** Sort codecs AV1 > VP9 > H.264 > VP8, keeping retransmission/FEC entries at the end. Stable within a codec. */
export function sortVideoCodecs<T extends CodecLike>(codecs: readonly T[]): T[] {
  const rank = (c: T) => {
    const mt = c.mimeType.toLowerCase();
    if (FEC_LIKE.has(mt)) return 100;
    return VIDEO_RANK[mt] ?? 50;
  };
  return codecs
    .map((c, i) => ({ c, i }))
    .sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i)
    .map(({ c }) => c);
}
