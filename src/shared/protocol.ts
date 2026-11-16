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
/** Clients ping this often. */
export const PING_INTERVAL_MS = 20_000;
/**
 * A connection silent this long is dead (two missed pings): a VPN or network switch can drop it
 * without a close reaching either side. The server frees its seat; the client reconnects and resumes.
 */
export const SILENT_DROP_MS = 50_000;
export const MAX_NAME_LENGTH = 32;
/** Chat text limit in UTF-16 units, after cleaning. Longer messages are refused, not truncated. */
export const MAX_CHAT_TEXT = 2000;
/** The room keeps at most this many chat entries and this many serialized bytes, dropping the oldest. */
export const CHAT_HISTORY = 100;
export const CHAT_HISTORY_BYTES = 256 * 1024;
/** Receivers hold a whole file in memory until it is saved, so files are capped per file. */
export const MAX_FILE_BYTES = 1024 ** 3;
export const MAX_FILE_NAME = 255;

/** Room IDs are 16 random bytes (128 bits) encoded as unpadded base64url: 22 chars. */
const ROOM_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const TOKEN_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MEMBER_ID_RE = /^[A-Za-z0-9_-]{8,32}$/;
const FILE_ID_RE = /^[A-Za-z0-9_-]{16}$/;
const MIME_RE = /^[\w.+-]+\/[\w.+-]+$/;

export type RoomId = string & { readonly __brand: "RoomId" };
export type MemberId = string & { readonly __brand: "MemberId" };
export type FileId = string & { readonly __brand: "FileId" };

export function isRoomId(value: unknown): value is RoomId {
  return typeof value === "string" && ROOM_ID_RE.test(value);
}

/** The room in a pasted invite: a bare room code, or any link with /r/<code> in it. */
export function roomIdFromInvite(text: string): RoomId | null {
  const trimmed = text.trim();
  const code = /(?:^|\/)r\/([^/?#\s]+)/.exec(trimmed)?.[1] ?? trimmed;
  return isRoomId(code) ? code : null;
}

export function isMemberId(value: unknown): value is MemberId {
  return typeof value === "string" && MEMBER_ID_RE.test(value);
}

export function isFileId(value: unknown): value is FileId {
  return typeof value === "string" && FILE_ID_RE.test(value);
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

/** A file offered in the chat. The bytes travel peer-to-peer from the sender; the server only sees this. */
export interface FileMeta {
  id: FileId;
  name: string;
  size: number;
  mime: string;
}

export type ChatBody = { kind: "text"; text: string } | { kind: "file"; file: FileMeta };

export interface ChatEntry {
  /** Order within one room lifetime; restarts when the room empties. */
  seq: number;
  from: MemberId;
  /** The sender's name when they sent it, so entries outlive their sender. */
  name: string;
  at: number;
  body: ChatBody;
}

export type ClientMessage =
  | { t: "join"; room: RoomId; name: string; resume: string | null; state: MemberState }
  | { t: "signal"; to: MemberId; data: SignalData }
  | { t: "state"; state: MemberState }
  | { t: "lock"; locked: boolean }
  | { t: "chat"; body: ChatBody }
  | { t: "ping" };

export type JoinError = "full" | "locked";
export type ErrorCode = JoinError | "bad_request" | "not_joined" | "not_host" | "slow_down";

export type ServerMessage =
  | { t: "joined"; you: MemberId; resume: string; room: RoomInfo; chat: ChatEntry[] }
  | { t: "error"; code: ErrorCode; message: string }
  | { t: "member-joined"; member: MemberInfo }
  | { t: "member-left"; id: MemberId }
  | { t: "member-state"; id: MemberId; state: MemberState }
  | { t: "room"; hostId: MemberId | null; locked: boolean }
  | { t: "signal"; from: MemberId; data: SignalData }
  | { t: "chat"; entry: ChatEntry }
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
  const name = raw
    .replace(INVISIBLE_CHARS, "")
    .replace(/[\p{Cc}]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length === 0) return null;
  return Array.from(name).slice(0, MAX_NAME_LENGTH).join("");
}

const INVISIBLE_CHARS = /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180e\u200b\u200e\u200f\u2028-\u202e\u2060-\u206f\u2800\u3164\ufeff\uffa0]/gu;
const UNSAFE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;

/** Keeps newlines, strips other control and bidi-override characters, trims. Null when empty or too long. */
export function cleanChatText(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_CHAT_TEXT * 2) return null;
  const text = raw.replace(/\r\n?/g, "\n").replace(UNSAFE_CHARS, "").replace(INVISIBLE_CHARS, "").replace(/\n(?:[ \t]*\n){3,}/g, "\n\n\n").trim();
  return text.length === 0 || text.length > MAX_CHAT_TEXT ? null : text;
}

/** A name that is safe to show and to save under: no control, bidi or path characters. */
export function cleanFileName(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length > MAX_FILE_NAME * 4) return null;
  const name = raw.replace(UNSAFE_CHARS, "").replace(INVISIBLE_CHARS, "").replace(/[\t\n/\\]/g, "_").trim();
  if (name.length === 0 || name === "." || name === "..") return null;
  return Array.from(name).slice(0, MAX_FILE_NAME).join("");
}

/** Parses file metadata from a chat message. The client runs it again on receipt. */
export function parseFileMeta(v: unknown): FileMeta | null {
  if (!isObject(v)) return null;
  const name = cleanFileName(v.name);
  const { id, size, mime } = v;
  if (!isFileId(id) || name === null) return null;
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 1 || size > MAX_FILE_BYTES) return null;
  if (typeof mime !== "string" || mime.length > 127 || (mime !== "" && !MIME_RE.test(mime))) return null;
  return { id, name, size, mime };
}

export function parseChatBody(v: unknown): ChatBody | null {
  if (!isObject(v)) return null;
  if (v.kind === "text") {
    const text = cleanChatText(v.text);
    return text === null ? null : { kind: "text", text };
  }
  if (v.kind === "file") {
    const file = parseFileMeta(v.file);
    return file === null ? null : { kind: "file", file };
  }
  return null;
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
    case "chat": {
      const body = parseChatBody(v.body);
      return body === null ? null : { t: "chat", body };
    }
    case "ping":
      return { t: "ping" };
    default:
      return null;
  }
}
