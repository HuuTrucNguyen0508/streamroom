import { describe, expect, it } from "vitest";
import { Rooms, type Effect } from "../src/server/rooms.ts";
import { CHAT_HISTORY, CHAT_HISTORY_BYTES, MAX_CHAT_TEXT, type MemberState, type RoomId, type ServerMessage } from "../src/shared/protocol.ts";

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

describe("Rooms chat", () => {
  const text = (t: string) => ({ kind: "text" as const, text: t });
  const chatOf = (effects: Effect[], to: string) => sent(effects, to).flatMap((m) => (m.t === "chat" ? [m.entry] : []));

  it("stamps a message and sends it to everyone, the sender included", () => {
    const { rooms, now } = setup({ t: 5000 });
    const a = joinOk(rooms, "a");
    joinOk(rooms, "b");
    const effects = rooms.chat("a", text("hi"));
    const entry = { seq: 1, from: a.memberId, name: "A", at: 5000, body: text("hi") };
    expect(chatOf(effects, "a")).toEqual([entry]);
    expect(chatOf(effects, "b")).toEqual([entry]);
    now.t = 6000;
    expect(chatOf(rooms.chat("b", text("yo")), "a").map((e) => [e.seq, e.name, e.at])).toEqual([[2, "B", 6000]]);
  });

  it("gives a late joiner the history, oldest first", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    rooms.chat("a", text("one"));
    rooms.chat("a", text("two"));
    expect(joinOk(rooms, "b").joined.chat.map((e) => [e.seq, e.body])).toEqual([[1, text("one")], [2, text("two")]]);
  });

  it("forgets the history when the room empties, and restarts the sequence", () => {
    const { rooms } = setup();
    joinOk(rooms, "a");
    rooms.chat("a", text("gone soon"));
    rooms.leave("a");
    expect(joinOk(rooms, "b").joined.chat).toEqual([]);
    expect(chatOf(rooms.chat("b", text("fresh")), "b")[0]?.seq).toBe(1);
  });

  it("keeps the newest 100 entries", () => {
    const { rooms, now } = setup();
    joinOk(rooms, "a");
    for (let i = 1; i <= 130; i++) {
      now.t += 1000;
      rooms.chat("a", text(`m${i}`));
    }
    const history = joinOk(rooms, "b").joined.chat;
    expect(history).toHaveLength(CHAT_HISTORY);
    expect([history[0]?.seq, history.at(-1)?.seq]).toEqual([31, 130]);
  });

  it("keeps the serialized history within its byte budget", () => {
    const { rooms, now } = setup();
    joinOk(rooms, "a");
    // 2000 three-byte characters: about 6 KB per entry, so the byte budget binds before the count.
    for (let i = 0; i < 60; i++) {
      now.t += 1000;
      rooms.chat("a", text("€".repeat(MAX_CHAT_TEXT)));
    }
    const history = joinOk(rooms, "b").joined.chat;
    const bytes = history.reduce((n, e) => n + new TextEncoder().encode(JSON.stringify(e)).byteLength, 0);
    expect(history.length).toBe(43);
    expect(bytes).toBeLessThanOrEqual(CHAT_HISTORY_BYTES);
    expect(bytes + 6040).toBeGreaterThan(CHAT_HISTORY_BYTES);
    expect(history.at(-1)?.seq).toBe(60);
  });

  it("allows a burst of 10, then one message per second", () => {
    const { rooms, now } = setup({ t: 0 });
    joinOk(rooms, "a");
    for (let i = 0; i < 10; i++) expect(chatOf(rooms.chat("a", text(`${i}`)), "a")).toHaveLength(1);
    const slow = rooms.chat("a", text("too fast"));
    expect(slow).toEqual([{ kind: "send", to: "a", msg: { t: "error", code: "slow_down", message: "You're sending messages too fast." } }]);
    now.t = 999;
    expect(sent(rooms.chat("a", text("still too fast")), "a")[0]).toMatchObject({ code: "slow_down" });
    now.t = 1000;
    expect(chatOf(rooms.chat("a", text("ok")), "a")).toHaveLength(1);
    expect(sent(rooms.chat("a", text("no")), "a")[0]).toMatchObject({ code: "slow_down" });
    now.t = 60_000;
    for (let i = 0; i < 10; i++) expect(chatOf(rooms.chat("a", text(`${i}`)), "a")).toHaveLength(1);
    expect(sent(rooms.chat("a", text("eleventh")), "a")[0]).toMatchObject({ code: "slow_down" });
    expect(joinOk(rooms, "b").joined.chat.map((e) => e.seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
  });

  it("refuses chat from a connection that has not joined", () => {
    const { rooms } = setup();
    expect(rooms.chat("ghost", text("hi"))).toEqual([{ kind: "send", to: "ghost", msg: { t: "error", code: "not_joined", message: "Join a room first." } }]);
  });
});

it("carries chat rate limits through replacement and disconnected resume", () => {
  const { rooms } = setup();
  const a = joinOk(rooms, "a");
  joinOk(rooms, "b");
  for (let i=0; i<10; i++) rooms.chat("a", {kind:"text",text:"hello"});
  const c = joinOk(rooms, "c", ROOM, a.joined.resume);
  expect(sent(rooms.chat("c", {kind:"text",text:"blocked"}), "c")).toMatchObject([{t:"error",code:"slow_down"}]);
  rooms.leave("c");
  joinOk(rooms, "d", ROOM, c.joined.resume);
  expect(sent(rooms.chat("d", {kind:"text",text:"still blocked"}), "d")).toMatchObject([{t:"error",code:"slow_down"}]);
});
