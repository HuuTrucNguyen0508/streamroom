// The peer-to-peer file wire format and the receiver's state machine. Pure: no RTCPeerConnection,
// so it runs under unit tests. transfers.ts binds it to data channels.
//
// A receiver asks for a file on the link's "ctl" channel with a fresh attempt id and the byte
// offset it already holds. The sender opens a channel labelled "xfer:<attempt>", streams binary
// chunks from that offset, then one string {"t":"end","sha256":<hex of the whole file>}.

import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { isFileId, randomId, type FileId, type FileMeta, type MemberId } from "../../shared/protocol.ts";

export const CHUNK_BYTES = 16 * 1024;
/** In-progress plus finished-but-unsaved downloads a receiver holds at once. */
export const MAX_RETAINED_BYTES = 2 * 1024 ** 3;
const MAX_CTL_CHARS = 1024;
/** Received chunks are folded into a Blob this often, so the JS heap holds at most one batch. */
const BATCH_BYTES = 16 * 1024 * 1024;
const READ_BYTES = 4 * 1024 * 1024;

export type TransferId = string & { readonly __brand: "TransferId" };
const TRANSFER_ID_RE = /^[A-Za-z0-9_-]{12}$/;
const DIGEST_RE = /^[0-9a-f]{64}$/;

export function newTransferId(): TransferId {
  return randomId(9) as TransferId;
}

export const XFER_PREFIX = "xfer:";

export type SendFailure = "gone" | "bad_offset";

export type Ctl =
  | { t: "get"; transfer: TransferId; file: FileId; offset: number }
  | { t: "cancel"; transfer: TransferId }
  | { t: "fail"; transfer: TransferId; reason: SendFailure }
  | { t: "ack"; transfer: TransferId };

function parseJson(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string" || raw.length > MAX_CTL_CHARS) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export function parseCtl(raw: unknown): Ctl | null {
  const v = parseJson(raw);
  if (!v || typeof v.transfer !== "string" || !TRANSFER_ID_RE.test(v.transfer)) return null;
  const transfer = v.transfer as TransferId;
  switch (v.t) {
    case "get":
      if (!isFileId(v.file) || typeof v.offset !== "number" || !Number.isSafeInteger(v.offset) || v.offset < 0) return null;
      return { t: "get", transfer, file: v.file, offset: v.offset };
    case "cancel":
      return { t: "cancel", transfer };
    case "ack":
      return { t: "ack", transfer };
    case "fail":
      return v.reason === "gone" || v.reason === "bad_offset" ? { t: "fail", transfer, reason: v.reason } : null;
    default:
      return null;
  }
}

/** The digest from a transfer channel's closing string, or null when it isn't one. */
export function parseEnd(raw: unknown): string | null {
  const v = parseJson(raw);
  return v?.t === "end" && typeof v.sha256 === "string" && DIGEST_RE.test(v.sha256) ? v.sha256 : null;
}

export async function hashFile(file: Blob): Promise<string> {
  const hasher = sha256.create();
  for (let offset = 0; offset < file.size; offset += READ_BYTES) {
    hasher.update(new Uint8Array(await file.slice(offset, offset + READ_BYTES).arrayBuffer()));
  }
  return bytesToHex(hasher.digest());
}

export type FailReason = SendFailure | "size" | "mismatch" | "memory";

export type IncomingPhase =
  /** Asked the sender under `attempt`; its channel hasn't arrived. */
  | { kind: "requesting"; attempt: TransferId }
  | { kind: "receiving"; attempt: TransferId }
  /** No live attempt; resumes from `received` when the sender is reachable again. */
  | { kind: "paused" }
  | { kind: "done"; blob: Blob }
  | { kind: "failed"; reason: FailReason };

/**
 * One file being downloaded from one sender, across any number of attempts. `received` counts
 * exactly the bytes that are both kept and fed to the hasher, so a new attempt resumes there and
 * the running hash stays correct. Calls naming an attempt other than the current one are ignored.
 */
export class Incoming {
  phase: IncomingPhase = { kind: "paused" };
  received = 0;
  private hasher = sha256.create();
  private parts: Blob[] = [];
  private batch: Uint8Array[] = [];
  private batchBytes = 0;

  constructor(
    readonly from: MemberId,
    readonly meta: FileMeta,
  ) {}

  get attempt(): TransferId | null {
    return this.phase.kind === "requesting" || this.phase.kind === "receiving" ? this.phase.attempt : null;
  }

  /** Start an attempt from a pause. Returns the offset to ask for, or null if not paused. */
  request(attempt: TransferId): number | null {
    if (this.phase.kind !== "paused") return null;
    this.phase = { kind: "requesting", attempt };
    return this.received;
  }

  /** The sender's channel for `attempt` arrived. False means it isn't wanted and should be closed. */
  accept(attempt: TransferId): boolean {
    if (this.phase.kind !== "requesting" || this.phase.attempt !== attempt) return false;
    this.phase = { kind: "receiving", attempt };
    return true;
  }

  chunk(attempt: TransferId, data: Uint8Array): void {
    if (this.phase.kind !== "receiving" || this.phase.attempt !== attempt) return;
    if (this.received + data.byteLength > this.meta.size) return this.fail("size");
    this.hasher.update(data);
    this.batch.push(data);
    this.batchBytes += data.byteLength;
    this.received += data.byteLength;
    if (this.batchBytes >= BATCH_BYTES) this.flush();
  }

  /** The sender says it's finished. True when the file is complete and its hash matches. */
  end(attempt: TransferId, digest: string): boolean {
    if (this.phase.kind !== "receiving" || this.phase.attempt !== attempt) return false;
    if (this.received !== this.meta.size) {
      this.fail("size");
      return false;
    }
    if (bytesToHex(this.hasher.digest()) !== digest) {
      this.fail("mismatch");
      return false;
    }
    try {
      this.flush();
      const blob = new Blob(this.parts, { type: "application/octet-stream" });
      this.parts = [];
      this.phase = { kind: "done", blob };
      return true;
    } catch {
      this.fail("memory");
      return false;
    }
  }

  /** The attempt's channel or link went away before the end. */
  interrupt(attempt: TransferId): void {
    if (this.attempt === attempt) this.phase = { kind: "paused" };
  }

  fail(reason: FailReason): void {
    if (this.phase.kind === "done" || this.phase.kind === "failed") return;
    this.phase = { kind: "failed", reason };
    this.drop();
  }

  /** Bytes this download holds or will hold. */
  get retained(): number {
    return this.phase.kind === "failed" ? 0 : this.meta.size;
  }

  dispose(): void {
    this.phase = { kind: "failed", reason: "gone" };
    this.drop();
  }

  private flush(): void {
    if (this.batch.length === 0) return;
    this.parts.push(new Blob(this.batch as BlobPart[]));
    this.batch = [];
    this.batchBytes = 0;
  }

  private drop(): void {
    this.parts = [];
    this.batch = [];
    this.batchBytes = 0;
    this.hasher = sha256.create();
  }
}
