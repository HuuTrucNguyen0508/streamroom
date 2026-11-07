import { describe, expect, it } from "vitest";
import { Rooms } from "../src/server/rooms.ts";
import { SignalingSession } from "../src/server/signaling.ts";
import { isRoomId, MAX_MESSAGE_BYTES, newRoomId } from "../src/shared/protocol.ts";

const room = newRoomId();
const state = { muted: false, hasMic: true, music: false, share: null };
const join = (id = room, resume: string | null = null) => JSON.stringify({ t: "join", room: id, name: "Friend", state, resume });

function setup() {
  const rooms = new Rooms();
  const a = new SignalingSession(rooms, "a", room);
  const b = new SignalingSession(rooms, "b", room);
  return { rooms, a, b };
}

describe("shared Durable Object / Node message handling", () => {
  it("rejects a join for another room before changing membership", () => {
    const { rooms, a } = setup();
    expect(a.receive(join(newRoomId()))).toMatchObject([{ kind: "send", msg: { code: "bad_request" } }]);
    expect(rooms.roomCount).toBe(0);
  });

  it("rejects binary, malformed and oversized UTF-8 messages", () => {
    const { a } = setup();
    for (const raw of [new ArrayBuffer(1), "{", "null"]) expect(a.receive(raw)).toMatchObject([{ msg: { code: "bad_request" } }]);
    expect(a.receive("é".repeat(MAX_MESSAGE_BYTES / 2 + 1))).toEqual([{ kind: "close", to: "a", reason: "message too large" }]);
  });

  it("enforces a per-connection rate window and accepts ping after it resets", () => {
    const { a } = setup();
    for (let i = 0; i < 200; i++) expect(a.receive('{"t":"ping"}', 2000)).toMatchObject([{ msg: { t: "pong" } }]);
    expect(a.receive('{"t":"ping"}', 2000)).toMatchObject([{ kind: "close", reason: "rate limit" }]);
    expect(a.receive('{"t":"ping"}', 3001)).toMatchObject([{ msg: { t: "pong" } }]);
  });

  it("preserves capacity, lock, resume replacement and host succession", () => {
    const { rooms, a, b } = setup();
    const first = a.receive(join()).find((e) => e.kind === "send" && e.msg.t === "joined");
    if (first?.kind !== "send" || first.msg.t !== "joined") throw new Error("no joined");
    b.receive(join());
    const c = new SignalingSession(rooms, "c", room);
    const d = new SignalingSession(rooms, "d", room);
    c.receive(join());
    expect(d.receive(join())).toMatchObject([{ msg: { code: "full" } }]);
    a.receive('{"t":"lock","locked":true}');
    rooms.leave("c");
    expect(d.receive(join())).toMatchObject([{ msg: { code: "locked" } }]);
    expect(d.receive(join(room, first.msg.resume))).toContainEqual({ kind: "close", to: "a", reason: "replaced" });
    expect(rooms.info(room)?.hostId).toBe(rooms.memberOf("d"));
    rooms.leave("d");
    expect(rooms.info(room)?.hostId).toBe(rooms.memberOf("b"));
    rooms.leave("b");
    expect(rooms.peek(room)).toEqual({ members: 0, max: 3, locked: false });
  });

  it("relays only to peers inside the same room", () => {
    const { rooms, a, b } = setup();
    a.receive(join()); b.receive(join());
    const other = newRoomId();
    expect(isRoomId(other)).toBe(true);
    new SignalingSession(rooms, "outsider", other).receive(join(other));
    const peer = rooms.memberOf("b");
    const outsider = rooms.memberOf("outsider");
    expect(a.receive(JSON.stringify({ t: "signal", to: peer, data: { candidate: null } }))).toMatchObject([{ kind: "send", to: "b", msg: { t: "signal" } }]);
    expect(a.receive(JSON.stringify({ t: "signal", to: outsider, data: { candidate: null } }))).toEqual([]);
  });
});
