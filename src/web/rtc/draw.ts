// Draw: live pointers and fading pen strokes over a shared screen.
// Every member sends its own pointer and strokes to every peer on a "draw" data channel, so
// everyone watching a share sees everyone else's marks. Coordinates are fractions (0–1) of the
// shared picture, so screens and windows of any size line up.

import { isMemberId, type MemberId } from "../../shared/protocol.ts";

export const DRAW_LABEL = "draw";

/** `s` is the member whose share the mark is on. */
export type DrawMessage =
  | { t: "move"; s: MemberId; x: number; y: number }
  | { t: "down"; s: MemberId; x: number; y: number }
  | { t: "line"; s: MemberId; x: number; y: number }
  | { t: "up"; s: MemberId }
  | { t: "leave"; s: MemberId }
  | { t: "clear"; s: MemberId };

/** A finished stroke stays fully visible this long, then fades out over STROKE_FADE_MS. */
export const STROKE_HOLD_MS = 2500;
export const STROKE_FADE_MS = 800;
/** A pointer that hasn't moved for this long disappears. */
export const POINTER_IDLE_MS = 5000;
/** An open stroke with no new point for this long counts as finished (its "up" was lost). */
export const STROKE_STALL_MS = 10_000;
export const MAX_STROKE_POINTS = 4000;
export const MAX_STROKES = 64;
/** Rooms hold at most 10 members; anything past this is junk from a misbehaving peer. */
const MAX_SHARES = 16;
const MAX_MESSAGE_CHARS = 200;
/** Pointer moves are dropped rather than queued behind this much unsent data. */
const MOVE_BUFFER_LIMIT = 64 * 1024;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const round = (v: number) => Math.round(clamp01(v) * 10_000) / 10_000;

export function parseDraw(data: unknown): DrawMessage | null {
  if (typeof data !== "string" || data.length > MAX_MESSAGE_CHARS) return null;
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const m = v as Record<string, unknown>;
  if (!isMemberId(m.s)) return null;
  const s = m.s;
  switch (m.t) {
    case "move":
    case "down":
    case "line": {
      if (typeof m.x !== "number" || typeof m.y !== "number" || !Number.isFinite(m.x) || !Number.isFinite(m.y)) return null;
      return { t: m.t, s, x: clamp01(m.x), y: clamp01(m.y) };
    }
    case "up":
    case "leave":
    case "clear":
      return { t: m.t, s };
    default:
      return null;
  }
}

export function encodeDraw(msg: DrawMessage): string {
  return JSON.stringify("x" in msg ? { ...msg, x: round(msg.x), y: round(msg.y) } : msg);
}

interface Stroke {
  /** Flat x, y pairs. */
  points: number[];
  lastAt: number;
  endedAt: number | null;
}

interface Marks {
  pointer: { x: number; y: number; at: number } | null;
  strokes: Stroke[];
}

export interface VisibleMarks {
  author: MemberId;
  pointer: { x: number; y: number } | null;
  strokes: { points: readonly number[]; alpha: number }[];
}

/** Who drew what on which share. Times come from the caller, so tests can drive the clock. */
export class DrawBoard {
  private readonly shares = new Map<MemberId, Map<MemberId, Marks>>();

  apply(author: MemberId, msg: DrawMessage, now: number): void {
    let byAuthor = this.shares.get(msg.s);
    if (!byAuthor) {
      if (this.shares.size >= MAX_SHARES) return;
      this.shares.set(msg.s, (byAuthor = new Map()));
    }
    let marks = byAuthor.get(author);
    if (!marks) byAuthor.set(author, (marks = { pointer: null, strokes: [] }));
    const open = marks.strokes.at(-1)?.endedAt === null ? marks.strokes.at(-1)! : null;
    switch (msg.t) {
      case "move":
        marks.pointer = { x: msg.x, y: msg.y, at: now };
        return;
      case "down":
        if (open) open.endedAt = now;
        marks.strokes.push({ points: [msg.x, msg.y], lastAt: now, endedAt: null });
        if (marks.strokes.length > MAX_STROKES) marks.strokes.shift();
        marks.pointer = { x: msg.x, y: msg.y, at: now };
        return;
      case "line":
        if (open && open.points.length < MAX_STROKE_POINTS * 2) {
          open.points.push(msg.x, msg.y);
          open.lastAt = now;
        } else if (!open) {
          // The "down" went missing (joined mid-stroke): start from here.
          marks.strokes.push({ points: [msg.x, msg.y], lastAt: now, endedAt: null });
          if (marks.strokes.length > MAX_STROKES) marks.strokes.shift();
        }
        marks.pointer = { x: msg.x, y: msg.y, at: now };
        return;
      case "up":
        if (open) open.endedAt = now;
        return;
      case "leave":
        if (open) open.endedAt = now;
        marks.pointer = null;
        return;
      case "clear":
        marks.strokes = [];
        return;
    }
  }

  /** `member` left or its link closed: its marks go everywhere, and so does its share's slot. */
  forget(member: MemberId): void {
    this.shares.delete(member);
    for (const [share, byAuthor] of this.shares) {
      byAuthor.delete(member);
      if (byAuthor.size === 0) this.shares.delete(share);
    }
  }

  clearAll(): void {
    this.shares.clear();
  }

  /** What to paint on `share` at `now`. Drops whatever has faded out. */
  visible(share: MemberId, now: number): VisibleMarks[] {
    const byAuthor = this.shares.get(share);
    if (!byAuthor) return [];
    const out: VisibleMarks[] = [];
    for (const [author, marks] of byAuthor) {
      if (marks.pointer && now - marks.pointer.at >= POINTER_IDLE_MS) marks.pointer = null;
      const strokes: VisibleMarks["strokes"] = [];
      marks.strokes = marks.strokes.filter((stroke) => {
        const alpha = strokeAlpha(stroke, now);
        if (alpha <= 0) return false;
        strokes.push({ points: stroke.points, alpha });
        return true;
      });
      if (!marks.pointer && marks.strokes.length === 0) {
        byAuthor.delete(author);
        continue;
      }
      out.push({ author, pointer: marks.pointer && { x: marks.pointer.x, y: marks.pointer.y }, strokes });
    }
    if (byAuthor.size === 0) this.shares.delete(share);
    return out;
  }
}

function strokeAlpha(stroke: Stroke, now: number): number {
  const ended = stroke.endedAt ?? (now - stroke.lastAt >= STROKE_STALL_MS ? stroke.lastAt : null);
  if (ended === null) return 1;
  const age = now - ended;
  if (age < STROKE_HOLD_MS) return 1;
  return Math.max(0, 1 - (age - STROKE_HOLD_MS) / STROKE_FADE_MS);
}

/** Where an object-fit: contain picture of videoW×videoH sits inside a boxW×boxH element. */
export function contentRect(boxW: number, boxH: number, videoW: number, videoH: number): { x: number; y: number; w: number; h: number } {
  if (videoW <= 0 || videoH <= 0 || boxW <= 0 || boxH <= 0) return { x: 0, y: 0, w: boxW, h: boxH };
  // Fit the limiting side exactly, so the picture's edges land on the box's edges.
  const wide = boxW * videoH <= boxH * videoW;
  const w = wide ? boxW : (videoW * boxH) / videoH;
  const h = wide ? (videoH * boxW) / videoW : boxH;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

const COLORS = ["#f4b860", "#ef6f5e", "#6fd3c4", "#8fb4ff", "#d58cf0", "#9be07a", "#ffd166", "#ff8fb1"] as const;

/** The same member gets the same color in every tab. */
export function colorFor(member: MemberId): string {
  let h = 5381;
  for (let i = 0; i < member.length; i++) h = ((h * 33) ^ member.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length]!;
}

type Channel = Pick<RTCDataChannel, "readyState" | "bufferedAmount" | "close" | "onmessage" | "onclose"> & { send(data: string): void };

/** The "draw" channels to every peer, plus the board they feed. */
export class Draw {
  readonly board = new DrawBoard();
  private readonly channels = new Map<MemberId, Channel>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly selfId: () => MemberId | null,
    private readonly now: () => number = () => performance.now(),
  ) {}

  channel(member: MemberId, dc: Channel): void {
    if (this.channels.has(member)) {
      dc.close();
      return;
    }
    this.channels.set(member, dc);
    dc.onmessage = (ev) => {
      if (this.channels.get(member) !== dc) return;
      const msg = parseDraw(ev.data);
      if (!msg) return;
      this.board.apply(member, msg, this.now());
      this.changed();
    };
    dc.onclose = () => {
      if (this.channels.get(member) === dc) this.linkClosed(member);
    };
  }

  linkClosed(member: MemberId): void {
    const dc = this.channels.get(member);
    if (dc) {
      dc.onmessage = null;
      dc.onclose = null;
    }
    this.channels.delete(member);
    this.board.forget(member);
    this.changed();
  }

  /** Mark something ourselves: shown here at once and sent to everyone. */
  send(msg: DrawMessage): void {
    const self = this.selfId();
    if (self === null) return;
    this.board.apply(self, msg, this.now());
    this.changed();
    const data = encodeDraw(msg);
    for (const dc of this.channels.values()) {
      if (dc.readyState !== "open") continue;
      if (msg.t === "move" && dc.bufferedAmount > MOVE_BUFFER_LIMIT) continue;
      try {
        dc.send(data);
      } catch {
        // Closing; onclose cleans up.
      }
    }
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  close(): void {
    for (const member of [...this.channels.keys()]) {
      const dc = this.channels.get(member)!;
      this.linkClosed(member);
      dc.close();
    }
    this.board.clearAll();
    this.changed();
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}
