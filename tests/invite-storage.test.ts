import { afterEach, expect, it, vi } from "vitest";
import { Room } from "../src/cloudflare/worker.ts";
import { ROOM_IDLE_MS } from "../src/shared/host.ts";
import { newRoomId } from "../src/shared/protocol.ts";

function fixture() {
  const records = new Map<string, unknown>();
  let alarm = 0;
  // Only storage methods used by these HTTP/alarm paths. No socket APIs are mocked.
  const ctx = { storage: {
    async get(key: string) { return records.get(key); },
    async put(key: string, value: unknown) { records.set(key, value); },
    async setAlarm(value: number) { alarm = value; },
    async deleteAll() { records.clear(); },
  } } as unknown as ConstructorParameters<typeof Room>[0];
  return { ctx, records, alarm: () => alarm };
}
afterEach(() => vi.useRealTimers());
it("DO invite exists before any host joins and survives a new object instance after an hour", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture(), id = newRoomId();
  const room = new Room(f.ctx);
  expect((await room.fetch(new Request(`http://localhost/api/rooms/${id}`))).status).toBe(404);
  expect((await room.fetch(new Request(`http://localhost/create/${id}`, { method: "POST" }))).ok).toBe(true);
  expect(f.alarm()).toBe(1000 + ROOM_IDLE_MS);
  vi.setSystemTime(3601000);
  const restarted = new Room(f.ctx);
  expect(await (await restarted.fetch(new Request(`http://localhost/api/rooms/${id}`))).json()).toEqual({ members: 0, max: 3, locked: false });
});
it("DO rejects expired invite before alarm delivery, and alarm deletes storage", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture(), id = newRoomId(), room = new Room(f.ctx);
  await room.fetch(new Request(`http://localhost/create/${id}`, { method: "POST" }));
  vi.setSystemTime(1000 + ROOM_IDLE_MS);
  expect((await room.fetch(new Request(`http://localhost/api/rooms/${id}`))).status).toBe(404);
  expect((await room.fetch(new Request(`http://localhost/ws?room=${id}`))).status).toBe(404);
  await room.alarm();
  expect(f.records.size).toBe(0);
});
it("an early DO alarm retains an unexpired invite and reschedules", async () => {
  vi.useFakeTimers(); vi.setSystemTime(1000);
  const f = fixture(), id = newRoomId(), room = new Room(f.ctx);
  await room.fetch(new Request(`http://localhost/create/${id}`, { method: "POST" }));
  vi.setSystemTime(2000); await room.alarm();
  expect([...f.records.keys()].sort()).toEqual(["expires", "seats"]); expect(f.alarm()).toBe(1000 + ROOM_IDLE_MS);
});
it("DO keeps the seat count chosen at creation across object restarts", async () => {
  const f = fixture(), id = newRoomId();
  await new Room(f.ctx).fetch(new Request(`http://localhost/create/${id}?seats=7`, { method: "POST" }));
  const restarted = new Room(f.ctx);
  expect(await (await restarted.fetch(new Request(`http://localhost/api/rooms/${id}`))).json()).toEqual({ members: 0, max: 7, locked: false });
  const bad = newRoomId();
  await new Room(f.ctx).fetch(new Request(`http://localhost/create/${bad}?seats=40`, { method: "POST" }));
  expect(f.records.get("seats")).toBe(3);
});
