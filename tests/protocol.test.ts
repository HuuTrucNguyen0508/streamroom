import { describe, expect, it } from "vitest";
import { MAX_MESSAGE_BYTES, cleanName, isRoomId, newRoomId, parseClientMessage } from "../src/shared/protocol.ts";

const state = { muted: false, hasMic: true, share: null };
const room = "AAAAAAAAAAAAAAAAAAAAAA";

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
