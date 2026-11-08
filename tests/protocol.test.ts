import { describe, expect, it } from "vitest";
import {
  MAX_CHAT_TEXT,
  MAX_FILE_BYTES,
  MAX_FILE_NAME,
  MAX_MESSAGE_BYTES,
  cleanFileName,
  cleanName,
  isRoomId,
  newRoomId,
  parseClientMessage,
  parseFileMeta,
  parseSeats,
} from "../src/shared/protocol.ts";

const state = { muted: false, hasMic: true, share: null };
const room = "AAAAAAAAAAAAAAAAAAAAAA";

describe("seat counts", () => {
  it("accepts whole numbers from 2 to 10, from JSON or a query string", () => {
    expect([parseSeats(2), parseSeats(10), parseSeats("5")]).toEqual([2, 10, 5]);
    for (const bad of [1, 11, 3.5, "", "abc", null, undefined, "3e0x"]) expect(parseSeats(bad)).toBeNull();
  });
});

describe("room ids", () => {
  it("are 128-bit base64url strings", () => {
    const id = newRoomId();
    expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(isRoomId(id)).toBe(true);
    expect(new Set(Array.from({ length: 1000 }, newRoomId)).size).toBe(1000);
    expect(isRoomId("short")).toBe(false);
    expect(isRoomId(`${room}/`)).toBe(false);
  });
});

describe("parseClientMessage", () => {
  it("accepts a valid join and cleans the name", () => {
    const msg = parseClientMessage(JSON.stringify({ t: "join", room, name: "  Ada‮  Lovelace\n", resume: null, state }));
    expect(msg).toEqual({ t: "join", room, name: "Ada Lovelace", resume: null, state });
  });

  it("rejects malformed input", () => {
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ t: "nope" }),
      JSON.stringify({ t: "join", room: "x", name: "a", state }),
      JSON.stringify({ t: "join", room, name: "   ", state }),
      JSON.stringify({ t: "join", room, name: "a", state: { ...state, muted: "no" } }),
      JSON.stringify({ t: "state", state: { ...state, share: { streamId: "s", preset: "ultra", hasAudio: false } } }),
      JSON.stringify({ t: "signal", to: "abcdefghij", data: {} }),
      JSON.stringify({ t: "signal", to: "abcdefghij", data: { description: { type: "evil", sdp: "" } } }),
      JSON.stringify({ t: "lock", locked: "yes" }),
    ];
    for (const raw of bad) expect(parseClientMessage(raw), raw).toBeNull();
  });

  it("rejects oversized messages", () => {
    const big = JSON.stringify({ t: "signal", to: "abcdefghij", data: { description: { type: "offer", sdp: "x".repeat(MAX_MESSAGE_BYTES) } } });
    expect(parseClientMessage(big)).toBeNull();
  });

  it("drops unknown fields from signals", () => {
    const msg = parseClientMessage(JSON.stringify({ t: "signal", to: "abcdefghij", data: { description: { type: "offer", sdp: "v=0", x: 1 }, extra: true } }));
    expect(msg).toEqual({ t: "signal", to: "abcdefghij", data: { description: { type: "offer", sdp: "v=0" } } });
  });

  it("limits names to 32 characters", () => {
    expect(cleanName("x".repeat(50))).toHaveLength(32);
  });
});

describe("chat messages", () => {
  const file = { id: "AAAAAAAAAAAAAAAA", name: "notes.txt", size: 12, mime: "text/plain" };
  const chat = (body: unknown) => parseClientMessage(JSON.stringify({ t: "chat", body }));

  it("keeps newlines and strips other control and bidi characters from text", () => {
    expect(chat({ kind: "text", text: "  hi\r\nthere\u0007‮!\t " })).toEqual({ t: "chat", body: { kind: "text", text: "hi\nthere!" } });
  });

  it("refuses empty and overlong text instead of truncating it", () => {
    expect(chat({ kind: "text", text: " \u0000 " })).toBeNull();
    expect(chat({ kind: "text", text: "x".repeat(MAX_CHAT_TEXT) })).toEqual({ t: "chat", body: { kind: "text", text: "x".repeat(MAX_CHAT_TEXT) } });
    expect(chat({ kind: "text", text: "x".repeat(MAX_CHAT_TEXT + 1) })).toBeNull();
  });

  it("accepts file metadata and makes the name safe to save under", () => {
    expect(chat({ kind: "file", file: { ...file, name: "../a/b\\c‮.exe", extra: 1 } })).toEqual({
      t: "chat",
      body: { kind: "file", file: { ...file, name: ".._a_b_c.exe" } },
    });
    expect(chat({ kind: "file", file: { ...file, mime: "" } })).toEqual({ t: "chat", body: { kind: "file", file: { ...file, mime: "" } } });
    expect(parseFileMeta({ ...file, size: MAX_FILE_BYTES })?.size).toBe(MAX_FILE_BYTES);
    expect(cleanFileName("é".repeat(300))).toHaveLength(MAX_FILE_NAME);
  });

  it("rejects malformed file metadata", () => {
    const bad = [
      { ...file, id: "short" },
      { ...file, name: "" },
      { ...file, name: ".." },
      { ...file, name: 5 },
      { ...file, size: 0 },
      { ...file, size: 1.5 },
      { ...file, size: MAX_FILE_BYTES + 1 },
      { ...file, size: "12" },
      { ...file, mime: "text/html; charset=x" },
      { ...file, mime: "x".repeat(128) },
    ];
    for (const meta of bad) expect(chat({ kind: "file", file: meta }), JSON.stringify(meta)).toBeNull();
    expect(chat({ kind: "image", file })).toBeNull();
    expect(chat("hi")).toBeNull();
  });
});
