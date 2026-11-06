import { describe, expect, it } from "vitest";
import { mungeOpus, sortVideoCodecs } from "../src/shared/sdp.ts";

const AUDIO = [
  "v=0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0",
  "a=rtpmap:111 opus/48000/2",
  "a=rtcp-fb:111 transport-cc",
  "a=fmtp:111 minptime=10;useinbandfec=1",
  "a=rtpmap:63 red/48000/2",
  "a=fmtp:63 111/111",
  "a=rtpmap:9 G722/8000",
  "",
].join("\r\n");

describe("mungeOpus", () => {
  it("adds stereo and bitrate params to the Opus fmtp line only", () => {
    const out = mungeOpus(AUDIO);
    expect(out).toContain("a=fmtp:111 minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1;maxaveragebitrate=128000\r\n");
    expect(out).toContain("a=fmtp:63 111/111\r\n");
    expect(out.split("\r\n")).toHaveLength(AUDIO.split("\r\n").length);
  });

  it("is idempotent", () => {
    expect(mungeOpus(mungeOpus(AUDIO))).toBe(mungeOpus(AUDIO));
  });

  it("overrides existing values instead of duplicating keys", () => {
    const sdp = AUDIO.replace("useinbandfec=1", "stereo=0;maxaveragebitrate=32000");
    const line = mungeOpus(sdp).split("\r\n").find((l) => l.startsWith("a=fmtp:111"));
    expect(line).toBe("a=fmtp:111 minptime=10;stereo=1;maxaveragebitrate=128000;sprop-stereo=1;useinbandfec=1");
  });

  it("adds an fmtp line when Opus has none", () => {
    const sdp = AUDIO.replace("a=fmtp:111 minptime=10;useinbandfec=1\r\n", "");
    const lines = mungeOpus(sdp).split("\r\n");
    const i = lines.indexOf("a=rtpmap:111 opus/48000/2");
    expect(lines[i + 1]).toBe("a=fmtp:111 stereo=1;sprop-stereo=1;maxaveragebitrate=128000;useinbandfec=1");
  });

  it("leaves SDP without Opus unchanged", () => {
    const video = "v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=rtpmap:96 VP8/90000\r\n";
    expect(mungeOpus(video)).toBe(video);
  });

  it("handles several Opus payload types and LF line endings", () => {
    const sdp = "m=audio 9 RTP 111 112\na=rtpmap:111 opus/48000/2\na=fmtp:111 minptime=10\na=rtpmap:112 opus/48000/2\n";
    const out = mungeOpus(sdp);
    expect(out).toContain("a=fmtp:111 minptime=10;stereo=1");
    expect(out).toContain("a=rtpmap:112 opus/48000/2\na=fmtp:112 stereo=1");
  });
});

describe("sortVideoCodecs", () => {
  it("orders AV1 > VP9 > H.264 > VP8 and keeps RTX/FEC last", () => {
    const codecs = ["video/VP8", "video/rtx", "video/H264", "video/VP9", "video/H264", "video/AV1", "video/red", "video/H265"].map((mimeType, i) => ({ mimeType, i }));
    expect(sortVideoCodecs(codecs).map((c) => `${c.mimeType}#${c.i}`)).toEqual([
      "video/AV1#5", "video/VP9#3", "video/H264#2", "video/H264#4", "video/VP8#0", "video/H265#7", "video/rtx#1", "video/red#6",
    ]);
  });
});
