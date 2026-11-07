import { describe, expect, it } from "vitest";
import { Rooms, type Effect } from "../src/server/rooms.ts";
import type { MemberState, RoomId, ServerMessage } from "../src/shared/protocol.ts";

const ROOM = "AAAAAAAAAAAAAAAAAAAAAA" as RoomId;
const OTHER = "BBBBBBBBBBBBBBBBBBBBBB" as RoomId;
const state: MemberState = { muted: false, hasMic: true, share: null };

function setup(now = { t: 0 }) {
  let n = 0;
  const rooms = new Rooms({ now: () => now.t, makeId: (bytes) => `id${String(++n).padStart(bytes, "0")}` });
  return { rooms, now };
}

function sent(effects: Effect[], to: string): ServerMessage[] {
  return effects.flatMap((e) => (e.kind === "send" && e.to === to ? [e.msg] : []));
}

function joinOk(rooms: Rooms, conn: string, room: RoomId = ROOM, resume: string | null = null) {
  const r = rooms.join(conn, room, conn.toUpperCase(), state, resume);
  if (!r.ok) throw new Error(`join failed: ${r.error}`);
  const joined = sent(r.effects, conn).find((m) => m.t === "joined");
  if (joined?.t !== "joined") throw new Error("no joined message");
  return { ...r, joined };
}

describe("Rooms", () => {
  it("creates a room on first join and makes that member host", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    expect(a.joined.room.hostId).toBe(a.memberId);
    expect(a.joined.room.members.map((m) => m.name)).toEqual(["A"]);
    expect(rooms.peek(ROOM)).toEqual({ members: 1, max: 3, locked: false });
  });

  it("tells existing members about a new joiner and gives the joiner the full roster", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    const b = joinOk(rooms, "b");
    expect(sent(b.effects, "a")).toEqual([{ t: "member-joined", member: { id: b.memberId, name: "B", state } }]);
    expect(b.joined.room.members.map((m) => m.id)).toEqual([a.memberId, b.memberId]);
    expect(b.joined.room.hostId).toBe(a.memberId);
  });

  it("caps a room at three members", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    joinOk(rooms, "b");
    joinOk(rooms, "c");
    const d = rooms.join("d", ROOM, "D", state, null);
    expect(d).toEqual({ ok: false, error: "full", effects: [] });
    expect(rooms.peek(ROOM).members).toBe(3);
  });

  it("uses each room's own seat count, defaulting to three", () => {
    const seats = new Map<RoomId, number>([[ROOM, 2], [OTHER, 10]]);
    const rooms = new Rooms({ capacityOf: (id) => seats.get(id) });
    joinOk(rooms, "a");
    joinOk(rooms, "b");
    expect(rooms.join("c", ROOM, "C", state, null)).toMatchObject({ ok: false, error: "full" });
    expect(rooms.peek(ROOM)).toEqual({ members: 2, max: 2, locked: false });
    for (let i = 0; i < 10; i++) joinOk(rooms, `o${i}`, OTHER);
    expect(rooms.join("o10", OTHER, "O", state, null)).toMatchObject({ ok: false, error: "full" });
    expect(rooms.peek("CCCCCCCCCCCCCCCCCCCCCC" as RoomId).max).toBe(3);
  });

  it("lets only the host lock, and a locked room rejects new joiners", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    joinOk(rooms, "b");
    expect(sent(rooms.setLocked("b", true), "b")[0]).toMatchObject({ t: "error", code: "not_host" });
    const fx = rooms.setLocked("a", true);
    expect(sent(fx, "a")).toEqual([{ t: "room", hostId: expect.any(String), locked: true }]);
    expect(sent(fx, "b")).toHaveLength(1);
    expect(rooms.join("c", ROOM, "C", state, null)).toMatchObject({ ok: false, error: "locked" });
    rooms.setLocked("a", false);
    expect(rooms.join("c", ROOM, "C", state, null).ok).toBe(true);
  });

  it("passes host to the longest-present member when the host leaves", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    const b = joinOk(rooms, "b");
    joinOk(rooms, "c");
    const fx = rooms.leave("a");
    expect(sent(fx, "b")).toEqual([
      { t: "member-left", id: a.memberId },
      { t: "room", hostId: b.memberId, locked: false },
    ]);
    expect(rooms.info(ROOM)?.hostId).toBe(b.memberId);
  });

  it("deletes the room when the last member leaves", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    joinOk(rooms, "b");
    rooms.leave("a");
    expect(rooms.roomCount).toBe(1);
    expect(rooms.leave("b")).toEqual([]);
    expect(rooms.roomCount).toBe(0);
    expect(rooms.info(ROOM)).toBeNull();
  });

  it("relays signals only to members of the same room", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    const b = joinOk(rooms, "b");
    const x = joinOk(rooms, "x", OTHER);
    const data = { candidate: null };
    expect(rooms.signal("a", b.memberId, data)).toEqual([{ kind: "send", to: "b", msg: { t: "signal", from: a.memberId, data } }]);
    expect(rooms.signal("x", a.memberId, data)).toEqual([]);
    expect(rooms.signal("a", x.memberId, data)).toEqual([]);
    expect(rooms.signal("a", a.memberId, data)).toEqual([]);
    expect(sent(rooms.signal("nobody", a.memberId, data), "nobody")[0]).toMatchObject({ t: "error", code: "not_joined" });
  });

  it("broadcasts member state to everyone else", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    joinOk(rooms, "b");
    const muted = { ...state, muted: true };
    expect(rooms.updateState("a", muted)).toEqual([{ kind: "send", to: "b", msg: { t: "member-state", id: a.memberId, state: muted } }]);
  });

  it("lets a reconnecting member replace its stale presence and keep host", () => {
    const { rooms } = setup();
    const a = joinOk(rooms, "a");
    joinOk(rooms, "b");
    joinOk(rooms, "c");
    rooms.setLocked("a", true);
    // Room is full and locked, but "a2" carries a's resume token: its old socket is half-open.
    const r = rooms.join("a2", ROOM, "A", state, a.joined.resume);
    expect(r.ok).toBe(true);
    expect(r.effects).toContainEqual({ kind: "close", to: "a", reason: "replaced" });
    expect(sent(r.effects, "b").map((m) => m.t)).toEqual(["member-left", "room", "member-joined", "room"]);
    const info = rooms.info(ROOM)!;
    expect(info.members).toHaveLength(3);
    expect(info.hostId).toBe(r.ok ? r.memberId : null);
  });

  it("lets a recently dropped member back through a lock, but not after the grace period", () => {
    const now = { t: 0 };
    const { rooms } = setup(now);
    joinOk(rooms, "a");
    const b = joinOk(rooms, "b");
    rooms.setLocked("a", true);
    rooms.leave("b");
    now.t = 10_000;
    expect(rooms.join("b2", ROOM, "B", state, b.joined.resume).ok).toBe(true);
    // The token was consumed; a fresh one is issued on each join.
    rooms.leave("b2");
    now.t = 100_000;
    expect(rooms.join("b3", ROOM, "B", state, b.joined.resume)).toMatchObject({ ok: false, error: "locked" });
  });

  it("does not let a resume token from another room pass a lock", () => {
    const { rooms } = setup();
    const x = joinOk(rooms, "x", OTHER);
    rooms.leave("x");
    joinOk(rooms, "a");
    rooms.setLocked("a", true);
    expect(rooms.join("x2", ROOM, "X", state, x.joined.resume)).toMatchObject({ ok: false, error: "locked" });
  });

  it("moves a connection that joins again out of its previous room", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    joinOk(rooms, "a", OTHER);
    expect(rooms.peek(ROOM).members).toBe(0);
    expect(rooms.peek(OTHER).members).toBe(1);
  });
});
