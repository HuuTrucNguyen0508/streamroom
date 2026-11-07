import { MAX_MESSAGE_BYTES, parseClientMessage, type RoomId } from "../shared/protocol.ts";
import { Rooms, type ConnId, type Effect } from "./rooms.ts";

/** Shared per-connection validation and dispatch for Bun and Durable Objects. */
export class SignalingSession {
  private windowStart = 0;
  private count = 0;

  private readonly rooms: Rooms;
  private readonly conn: ConnId;
  private readonly room: RoomId | undefined;

  constructor(rooms: Rooms, conn: ConnId, room?: RoomId) {
    this.rooms = rooms;
    this.conn = conn;
    this.room = room;
  }

  receive(raw: string | ArrayBuffer, now = Date.now()): Effect[] {
    if (now - this.windowStart > 1000) {
      this.windowStart = now;
      this.count = 0;
    }
    if (++this.count > 200) return [{ kind: "close", to: this.conn, reason: "rate limit" }];
    if ((typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength) > MAX_MESSAGE_BYTES) {
      return [{ kind: "close", to: this.conn, reason: "message too large" }];
    }
    const msg = typeof raw === "string" ? parseClientMessage(raw) : null;
    if (!msg || (msg.t === "join" && this.room !== undefined && msg.room !== this.room)) {
      return [{ kind: "send", to: this.conn, msg: { t: "error", code: "bad_request", message: "Malformed message." } }];
    }
    switch (msg.t) {
      case "join": {
        const result = this.rooms.join(this.conn, msg.room, msg.name, msg.state, msg.resume);
        if (result.ok) return result.effects;
        return [...result.effects, { kind: "send", to: this.conn, msg: {
          t: "error", code: result.error,
          message: result.error === "full" ? "This room already has 3 people." : "The host locked this room.",
        } }];
      }
      case "signal": return this.rooms.signal(this.conn, msg.to, msg.data);
      case "state": return this.rooms.updateState(this.conn, msg.state);
      case "lock": return this.rooms.setLocked(this.conn, msg.locked);
      case "ping": return [{ kind: "send", to: this.conn, msg: { t: "pong" } }];
    }
  }
}

export function closeCode(reason: string): number {
  return reason === "rate limit" ? 1008 : reason === "message too large" ? 1009 : 4000;
}
