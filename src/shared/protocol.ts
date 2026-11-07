// Signaling protocol shared by the server and the browser.
// Everything that crosses the wire is parsed here; the rest of the code trusts these types.

/** Seats per room: the host picks a number when creating it. Mesh calls get heavy past ~10. */
export const DEFAULT_SEATS = 3;
export const MIN_SEATS = 2;
export const MAX_SEATS = 10;

/** A seat count from a query string or JSON body, or null when absent or out of range. */
export function parseSeats(v: unknown): number | null {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n >= MIN_SEATS && n <= MAX_SEATS ? n : null;
}
export const MAX_MESSAGE_BYTES = 64 * 1024;
export const MAX_NAME_LENGTH = 32;

/** Room IDs are 16 random bytes (128 bits) encoded as unpadded base64url: 22 chars. */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;

export type RoomId = string & { readonly __brand: "RoomId" };
export type MemberId = string & { readonly __brand: "MemberId" };

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === "string" && ROOM_ID_RE.test(value);
}

export function isMemberId(value: unknown): value is MemberId {
  return typeof value === "string" && MEMBER_ID_RE.test(value);
}

export function randomId(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  let bin = "";
  for (const b of buf) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newRoomId(): RoomId {
  return randomId(16) as RoomId;
}

export const PRESET_IDS = ["text", "motion", "max"] as const;
export type PresetId = (typeof PRESET_IDS)[number];

/** What a member tells the room about itself. Media flows peer-to-peer; this is just presence. */
export interface MemberState {
  muted: boolean;
  hasMic: boolean;
  /** MediaStream id of the member's screen share (matches the remote stream id), or null. */
  share: { streamId: string; preset: PresetId; hasAudio: boolean } | null;
}

export interface MemberInfo {
  id: MemberId;
  name: string;
  state: MemberState;
}

export interface RoomInfo {
  hostId: MemberId | null;
  locked: boolean;
  members: MemberInfo[];
}

/** Opaque WebRTC payload relayed between peers. */
export interface SignalData {
  description?: { type: "offer" | "answer" | "rollback" | "pranswer"; sdp?: string };
  candidate?: { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null; usernameFragment?: string | null } | null;
}

export type ClientMessage =
  | { t: "join"; room: RoomId; name: string; resume: string | null; state: MemberState }
  | { t: "signal"; to: MemberId; data: SignalData }
  | { t: "state"; state: MemberState }
  | { t: "lock"; locked: boolean }
  | { t: "ping" };

export type JoinError = "full" | "locked";
export type ErrorCode = JoinError | "bad_request" | "not_joined" | "not_host";

export type ServerMessage =
  | { t: "joined"; you: MemberId; resume: string; room: RoomInfo }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "member-joined"; member: MemberInfo }
  | { t: "member-left"; id: MemberId }
  | { t: "member-state"; id: MemberId; state: MemberState }
  | { t: "room"; hostId: MemberId | null; locked: boolean }
  | { t: "signal"; from: MemberId; data: SignalData }
  | { t: "pong" };

export interface RoomPeek {
  members: number;
  max: number;
  locked: boolean;
}

// ---------------------------------------------------------------------------
// Parsing (server side boundary). Returns null on anything malformed.

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  // Strip control and bidi-override characters, collapse whitespace.
  const name = raw
    .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length === 0) return null;
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join("");
}

function parseState(v: unknown): MemberState | null {
  if (!isObject(v)) return null;
  // Older clients also send `music`; extra fields are ignored.
  const { muted, hasMic, share } = v;
  if (typeof muted !== "boolean" || typeof hasMic !== "boolean") return null;
  let parsedShare: MemberState["share"] = null;
  if (share !== null && share !== undefined) {
    if (!isObject(share)) return null;
    const { streamId, preset, hasAudio } = share;
    if (typeof streamId !== "string" || streamId.length === 0 || streamId.length > 128) return null;
    if (!PRESET_IDS.includes(preset as PresetId)) return null;
    if (typeof hasAudio !== "boolean") return null;
    parsedShare = { streamId, preset: preset as PresetId, hasAudio };
  }
  return { muted, hasMic, share: parsedShare };
}

const DESCRIPTION_TYPES = new Set(["offer", "answer", "rollback", "pranswer"]);

function parseSignal(v: unknown): SignalData | null {
  if (!isObject(v)) return null;
  const out: SignalData = {};
  if (v.description !== undefined) {
    const d = v.description;
    if (!isObject(d) || typeof d.type !== "string" || !DESCRIPTION_TYPES.has(d.type)) return null;
    if (d.sdp !== undefined && typeof d.sdp !== "string") return null;
    out.description = { type: d.type as "offer", ...(typeof d.sdp === "string" ? { sdp: d.sdp } : {}) };
  }
  if (v.candidate !== undefined) {
    const c = v.candidate;
    if (c === null) out.candidate = null;
    else {
      if (!isObject(c) || typeof c.candidate !== "string") return null;
      out.candidate = {
        candidate: c.candidate,
        sdpMid: typeof c.sdpMid === "string" ? c.sdpMid : null,
        sdpMLineIndex: typeof c.sdpMLineIndex === "number" ? c.sdpMLineIndex : null,
        usernameFragment: typeof c.usernameFragment === "string" ? c.usernameFragment : null,
      };
    }
  }
  if (out.description === undefined && out.candidate === undefined) return null;
  return out;
}

export function parseClientMessage(raw: string): ClientMessage | null {
  if (raw.length > MAX_MESSAGE_BYTES) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObject(v)) return null;
  switch (v.t) {
    case "join": {
      const name = cleanName(v.name);
      const state = parseState(v.state);
      if (!isRoomId(v.room) || name === null || state === null) return null;
      const resume = typeof v.resume === "string" && TOKEN_RE.test(v.resume) ? v.resume : null;
      return { t: "join", room: v.room, name, resume, state };
    }
    case "signal": {
      const data = parseSignal(v.data);
      if (!isMemberId(v.to) || data === null) return null;
      return { t: "signal", to: v.to, data };
    }
    case "state": {
      const state = parseState(v.state);
      return state === null ? null : { t: "state", state };
    }
    case "lock":
      return typeof v.locked === "boolean" ? { t: "lock", locked: v.locked } : null;
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}
