// Pure, transport-agnostic room logic. No Bun APIs: this module is meant to move into a
// Cloudflare Durable Object unchanged. Every operation returns the messages to deliver
// ("effects"); the caller owns the sockets.

import {
  DEFAULT_SEATS,
  randomId,
  type JoinError,
  type MemberId,
  type MemberInfo,
  type MemberState,
  type RoomId,
  type RoomInfo,
  type RoomPeek,
  type ServerMessage,
  type SignalData,
} from "../shared/protocol.ts";

/** Opaque handle the transport uses for one socket. */
export type ConnId = string;

export type Effect =
  | { kind: "send"; to: ConnId; msg: ServerMessage }
  | { kind: "close"; to: ConnId; reason: string };

interface Member {
  id: MemberId;
  conn: ConnId;
  name: string;
  state: MemberState;
  resume: string;
}

interface Room {
  id: RoomId;
  /** Join order is host succession order. */
  members: Member[];
  hostId: MemberId | null;
  locked: boolean;
}

interface Departed {
  roomId: RoomId;
  expiresAt: number;
}

export interface RoomsOptions {
  /** Seats when a room has no recorded size. */
  maxMembers?: number;
  /** The seat count chosen when the room was created, if known. */
  capacityOf?: (roomId: RoomId) => number | undefined;
  /** How long a dropped member may come back through a locked door with its resume token. */
  resumeGraceMs?: number;
  now?: () => number;
  makeId?: (bytes: number) => string;
}

export type JoinOutcome = { ok: true; memberId: MemberId; effects: Effect[] } | { ok: false; error: JoinError; effects: Effect[] };

export class Rooms {
  private readonly rooms = new Map<RoomId, Room>();
  private readonly byConn = new Map<ConnId, { room: Room; member: Member }>();
  private readonly departed = new Map<string, Departed>();
  private readonly maxMembers: number;
  private readonly capacityOf: (roomId: RoomId) => number | undefined;
  private readonly resumeGraceMs: number;
  private readonly now: () => number;
  private readonly makeId: (bytes: number) => string;

  constructor(opts: RoomsOptions = {}) {
    this.maxMembers = opts.maxMembers ?? DEFAULT_SEATS;
    this.capacityOf = opts.capacityOf ?? (() => undefined);
    this.resumeGraceMs = opts.resumeGraceMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
    this.makeId = opts.makeId ?? randomId;
  }

  get roomCount(): number {
    return this.rooms.size;
  }

  peek(roomId: RoomId): RoomPeek {
    const room = this.rooms.get(roomId);
    return { members: room?.members.length ?? 0, max: this.seats(roomId), locked: room?.locked ?? false };
  }

  private seats(roomId: RoomId): number {
    return this.capacityOf(roomId) ?? this.maxMembers;
  }

  info(roomId: RoomId): RoomInfo | null {
    const room = this.rooms.get(roomId);
    return room ? snapshot(room) : null;
  }

  memberOf(conn: ConnId): MemberId | null {
    return this.byConn.get(conn)?.member.id ?? null;
  }

  /**
   * Join a room, creating it if needed (rooms are created lazily: a valid 128-bit ID is the invite).
   * A resume token from an earlier session lets a reconnecting client replace its stale presence
   * and pass a lock it was already inside of.
   */
  join(conn: ConnId, roomId: RoomId, name: string, state: MemberState, resume: string | null): JoinOutcome {
    this.pruneDeparted();
    const effects: Effect[] = [];
    if (this.byConn.has(conn)) effects.push(...this.leave(conn));

    let room = this.rooms.get(roomId);
    let inheritHost = false;
    let mayPassLock = false;

    if (resume !== null && room) {
      const stale = room.members.find((m) => m.resume === resume);
      if (stale) {
        // Half-open socket from the same client: drop the old presence first.
        inheritHost = room.hostId === stale.id;
        mayPassLock = true;
        effects.push({ kind: "close", to: stale.conn, reason: "replaced" });
        effects.push(...this.leave(stale.conn));
        room = this.rooms.get(roomId);
      }
    }
    if (resume !== null && !mayPassLock) {
      const gone = this.departed.get(resume);
      if (gone && gone.roomId === roomId) {
        mayPassLock = true;
        this.departed.delete(resume);
      }
    }

    if (room) {
      if (room.members.length >= this.seats(roomId)) return { ok: false, error: "full", effects };
      if (room.locked && !mayPassLock) return { ok: false, error: "locked", effects };
    } else {
      room = { id: roomId, members: [], hostId: null, locked: false };
      this.rooms.set(roomId, room);
    }

    const member: Member = { id: this.makeId(9) as MemberId, conn, name, state, resume: this.makeId(18) };
    for (const other of room.members) {
      effects.push({ kind: "send", to: other.conn, msg: { t: "member-joined", member: publicInfo(member) } });
    }
    room.members.push(member);
    this.byConn.set(conn, { room, member });

    if (room.hostId === null || inheritHost) {
      const hostChanged = room.hostId !== member.id;
      room.hostId = member.id;
      if (hostChanged && room.members.length > 1) effects.push(...this.broadcastRoom(room, member.id));
    }

    effects.push({ kind: "send", to: conn, msg: { t: "joined", you: member.id, resume: member.resume, room: snapshot(room) } });
    return { ok: true, memberId: member.id, effects };
  }

  /** Socket closed or member left. Passes host to the longest-present member; deletes empty rooms. */
  leave(conn: ConnId): Effect[] {
    const entry = this.byConn.get(conn);
    if (!entry) return [];
    const { room, member } = entry;
    this.byConn.delete(conn);
    room.members = room.members.filter((m) => m !== member);
    const wasHost = room.hostId === member.id;
    this.departed.set(member.resume, { roomId: room.id, expiresAt: this.now() + this.resumeGraceMs });

    if (room.members.length === 0) {
      this.rooms.delete(room.id);
      return [];
    }
    const effects: Effect[] = room.members.map((m) => ({ kind: "send", to: m.conn, msg: { t: "member-left", id: member.id } }));
    if (wasHost) {
      room.hostId = room.members[0]!.id;
      effects.push(...this.broadcastRoom(room));
    }
    return effects;
  }

  setLocked(conn: ConnId, locked: boolean): Effect[] {
    const entry = this.byConn.get(conn);
    if (!entry) return [notJoined(conn)];
    const { room, member } = entry;
    if (room.hostId !== member.id) {
      return [{ kind: "send", to: conn, msg: { t: "error", code: "not_host", message: "Only the host can lock the room." } }];
    }
    if (room.locked === locked) return [];
    room.locked = locked;
    return this.broadcastRoom(room);
  }

  updateState(conn: ConnId, state: MemberState): Effect[] {
    const entry = this.byConn.get(conn);
    if (!entry) return [notJoined(conn)];
    entry.member.state = state;
    return entry.room.members
      .filter((m) => m !== entry.member)
      .map((m) => ({ kind: "send", to: m.conn, msg: { t: "member-state", id: entry.member.id, state } }));
  }

  /** Relay WebRTC signaling only between members of the same room. */
  signal(conn: ConnId, to: MemberId, data: SignalData): Effect[] {
    const entry = this.byConn.get(conn);
    if (!entry) return [notJoined(conn)];
    const target = entry.room.members.find((m) => m.id === to);
    if (!target || target === entry.member) return [];
    return [{ kind: "send", to: target.conn, msg: { t: "signal", from: entry.member.id, data } }];
  }

  private broadcastRoom(room: Room, except?: MemberId): Effect[] {
    return room.members
      .filter((m) => m.id !== except)
      .map((m) => ({ kind: "send", to: m.conn, msg: { t: "room", hostId: room.hostId, locked: room.locked } }));
  }

  private pruneDeparted(): void {
    const now = this.now();
    for (const [token, d] of this.departed) if (d.expiresAt <= now) this.departed.delete(token);
  }
}

function publicInfo(m: Member): MemberInfo {
  return { id: m.id, name: m.name, state: m.state };
}

function snapshot(room: Room): RoomInfo {
  return { hostId: room.hostId, locked: room.locked, members: room.members.map(publicInfo) };
}

function notJoined(conn: ConnId): Effect {
  return { kind: "send", to: conn, msg: { t: "error", code: "not_joined", message: "Join a room first." } };
}
