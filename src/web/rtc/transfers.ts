// Files offered in the chat move peer-to-peer over data channels on the call's links. Nothing is
// stored on a server. The sender keeps the File; each download attempt gets its own channel, so
// closing a channel cancels exactly one attempt and backpressure is per transfer.

import type { FileId, FileMeta, MemberId } from "../../shared/protocol.ts";
import {
  CHUNK_BYTES,
  Incoming,
  MAX_RETAINED_BYTES,
  XFER_PREFIX,
  hashFile,
  newTransferId,
  parseCtl,
  parseEnd,
  type Ctl,
  type FailReason,
  type TransferId,
} from "./files.ts";

const READ_BYTES = 1024 * 1024;
/** Per-channel send buffer. With MAX_ACTIVE_SENDS per link this also caps a link's total. */
const HIGH_WATER = 2 * 1024 * 1024;
const LOW_WATER = 512 * 1024;
const MAX_ACTIVE_SENDS = 2;
const PROGRESS_MS = 200;

export interface TransferLinks {
  /** A new channel on the current link to `member`, or null when there is no link. */
  open(member: MemberId, label: string): RTCDataChannel | null;
  maxMessageSize(member: MemberId): number;
  changed(): void;
}

interface Offer {
  meta: FileMeta;
  file: Blob;
  /** Hashed on the first request, then reused for every receiver. */
  digest: Promise<string> | null;
  hashing: AbortController | null;
}

export type SendPhase = "queued" | "sending" | "sent" | "delivered";

interface Send {
  id: TransferId;
  to: MemberId;
  file: FileId;
  offset: number;
  sent: number;
  phase: SendPhase;
  busy: boolean;
  abort: AbortController;
}

interface Attempt {
  incoming: Incoming;
  channel: RTCDataChannel | null;
}

export type IncomingView =
  | { phase: "requesting" | "receiving" | "paused"; received: number; bytesPerSec: number }
  | { phase: "done"; blob: Blob }
  | { phase: "failed"; reason: FailReason };

export interface SendView {
  to: MemberId;
  phase: SendPhase;
  sent: number;
}

export interface TransfersView {
  /** Keyed by downloadKey(sender, file). */
  incoming: ReadonlyMap<string, IncomingView>;
  outgoing: ReadonlyMap<FileId, SendView[]>;
  offered: ReadonlySet<FileId>;
}

export function downloadKey(from: MemberId, file: FileId): string {
  return `${from}/${file}`;
}

export class FileTransfers {
  private readonly ctl = new Map<MemberId, RTCDataChannel>();
  private readonly offers = new Map<FileId, Offer>();
  private readonly sends = new Map<TransferId, Send>();
  private readonly incoming = new Map<string, Incoming>();
  private readonly attempts = new Map<TransferId, Attempt>();
  private readonly rates = new Map<string, { at: number; received: number; bytesPerSec: number }>();
  private progressTimer: ReturnType<typeof setTimeout> | null = null;

  readonly activity = { reads: 0, sends: 0 };

  constructor(private readonly links: TransferLinks) {}

  // ---------------------------------------------------------------------------
  // Channels from PeerLink

  channel(member: MemberId, dc: RTCDataChannel): void {
    dc.binaryType = "arraybuffer";
    if (dc.label === "ctl") return this.bindCtl(member, dc);
    if (dc.label.startsWith(XFER_PREFIX)) {
      const id = dc.label.slice(XFER_PREFIX.length) as TransferId;
      const attempt = this.attempts.get(id);
      if (attempt && attempt.incoming.from === member && attempt.incoming.accept(id)) return this.bindReceive(id, attempt, dc);
    }
    dc.close();
  }

  private bindCtl(member: MemberId, dc: RTCDataChannel): void {
    if (this.ctl.has(member)) { dc.close(); return; }
    this.ctl.set(member, dc);
    const opened = () => {
      for (const incoming of this.incoming.values()) if (incoming.from === member) this.startAttempt(incoming);
      this.links.changed();
    };
    dc.onopen = opened;
    dc.onmessage = (ev) => {
      if (this.ctl.get(member) === dc) this.onCtl(member, parseCtl(ev.data));
    };
    dc.onclose = () => {
      if (this.ctl.get(member) === dc) this.ctl.delete(member);
    };
    if (dc.readyState === "open") opened();
  }

  /** The link to `member` closed: every attempt on it ends; downloads pause until a new link opens. */
  linkClosed(member: MemberId): void {
    const ctl = this.ctl.get(member);
    if (ctl) detach(ctl);
    this.ctl.delete(member);
    for (const [id, attempt] of this.attempts) if (attempt.incoming.from === member) this.endAttempt(id);
    for (const send of this.sends.values()) if (send.to === member && send.phase !== "delivered") this.dropSend(send);
    this.links.changed();
  }

  /** `member` left the room for good: their offers are gone. */
  memberGone(member: MemberId): void {
    for (const incoming of this.incoming.values()) if (incoming.from === member) incoming.fail("gone");
    this.links.changed();
  }

  /** After a rejoin: downloads from anyone no longer in the room can't finish. */
  keepSenders(members: ReadonlySet<MemberId>): void {
    for (const incoming of this.incoming.values()) if (!members.has(incoming.from)) incoming.fail("gone");
  }

  // ---------------------------------------------------------------------------
  // Receiving

  /** Returns why the download can't start, or null. */
  download(from: MemberId, meta: FileMeta): string | null {
    const key = downloadKey(from, meta.id);
    const existing = this.incoming.get(key);
    if (existing && existing.phase.kind !== "failed") return null;
    if (existing) this.discard(from, meta.id);
    let held = 0;
    for (const incoming of this.incoming.values()) held += incoming.retained;
    if (held + meta.size > MAX_RETAINED_BYTES) {
      return "Downloads in this tab are limited to 2 GiB at a time. Save or dismiss a finished file first.";
    }
    const incoming = new Incoming(from, meta);
    this.incoming.set(key, incoming);
    this.startAttempt(incoming);
    this.links.changed();
    return null;
  }

  /** Try a paused download again now, for example after the sender's tab woke up. */
  resume(from: MemberId, file: FileId): void {
    const incoming = this.incoming.get(downloadKey(from, file));
    if (incoming) this.startAttempt(incoming);
    this.links.changed();
  }

  /** Cancel a download in progress, or forget a finished or failed one. */
  discard(from: MemberId, file: FileId): void {
    const key = downloadKey(from, file);
    const incoming = this.incoming.get(key);
    if (!incoming) return;
    const attempt = incoming.attempt;
    if (attempt) {
      this.sendCtl(from, { t: "cancel", transfer: attempt });
      this.endAttempt(attempt);
    }
    incoming.dispose();
    this.incoming.delete(key);
    this.rates.delete(key);
    this.links.changed();
  }

  private startAttempt(incoming: Incoming): void {
    const ctl = this.ctl.get(incoming.from);
    if (!ctl || ctl.readyState !== "open" || incoming.phase.kind !== "paused") return;
    const id = newTransferId();
    const offset = incoming.request(id);
    if (offset === null) return;
    this.attempts.set(id, { incoming, channel: null });
    if (!this.sendCtl(incoming.from, { t: "get", transfer: id, file: incoming.meta.id, offset })) this.endAttempt(id);
  }

  private bindReceive(id: TransferId, attempt: Attempt, dc: RTCDataChannel): void {
    attempt.channel = dc;
    const { incoming } = attempt;
    dc.onmessage = (ev) => {
      if (this.attempts.get(id) !== attempt) return;
      if (typeof ev.data !== "string") {
        try {
          incoming.chunk(id, new Uint8Array(ev.data as ArrayBuffer));
        } catch {
          incoming.fail("memory");
        }
        if (incoming.phase.kind === "failed") {
          this.sendCtl(incoming.from, { t: "cancel", transfer: id });
          this.endAttempt(id);
          this.links.changed();
        } else this.progress();
        return;
      }
      const digest = parseEnd(ev.data);
      if (digest === null) return;
      this.sendCtl(incoming.from, { t: incoming.end(id, digest) ? "ack" : "cancel", transfer: id });
      this.endAttempt(id);
      this.links.changed();
    };
    const lost = () => {
      if (this.attempts.get(id) !== attempt) return;
      this.endAttempt(id);
      this.links.changed();
    };
    dc.onclose = lost;
    dc.onerror = lost;
  }

  /** Detach and close an attempt's channel first, so nothing from it lands afterwards. */
  private endAttempt(id: TransferId): void {
    const attempt = this.attempts.get(id);
    if (!attempt) return;
    this.attempts.delete(id);
    if (attempt.channel) {
      detach(attempt.channel);
      attempt.channel.close();
    }
    attempt.incoming.interrupt(id);
  }

  // ---------------------------------------------------------------------------
  // Sending

  offer(meta: FileMeta, file: Blob): void {
    this.offers.set(meta.id, { meta, file, digest: null, hashing: null });
    this.links.changed();
  }

  /** Stop offering a file: active and future requests fail as gone. */
  unshare(file: FileId): void {
    this.offers.get(file)?.hashing?.abort();
    this.offers.delete(file);
    for (const send of this.sends.values()) {
      if (send.file !== file) continue;
      if (send.phase === "queued" || send.phase === "sending") this.sendCtl(send.to, { t: "fail", transfer: send.id, reason: "gone" });
      this.dropSend(send);
    }
    this.links.changed();
  }

  /** Forget every offer, for a rejoin under a new member id: old file cards can't be requested any more. */
  unshareAll(): void {
    for (const id of [...this.offers.keys()]) this.unshare(id);
    this.sends.clear();
  }

  private onCtl(member: MemberId, msg: Ctl | null): void {
    if (!msg) return;
    switch (msg.t) {
      case "get": {
        const offer = this.offers.get(msg.file);
        if (!offer) return void this.sendCtl(member, { t: "fail", transfer: msg.transfer, reason: "gone" });
        if (msg.offset > offer.meta.size) return void this.sendCtl(member, { t: "fail", transfer: msg.transfer, reason: "bad_offset" });
        if (this.sends.has(msg.transfer)) return;
        // A new attempt for the same file replaces any older one to this member.
        for (const send of this.sends.values()) if (send.to === member && send.file === msg.file) this.dropSend(send);
        this.sends.set(msg.transfer, {
          id: msg.transfer, to: member, file: msg.file, offset: msg.offset, sent: msg.offset, phase: "queued", busy: false, abort: new AbortController(),
        });
        this.pumpQueue(member);
        this.links.changed();
        return;
      }
      case "cancel": {
        const send = this.sends.get(msg.transfer);
        if (send?.to === member && send.phase !== "delivered") this.dropSend(send);
        this.links.changed();
        return;
      }
      case "ack": {
        const send = this.sends.get(msg.transfer);
        if (send?.to === member && send.phase === "sent") send.phase = "delivered";
        this.links.changed();
        return;
      }
      case "fail": {
        const attempt = this.attempts.get(msg.transfer);
        if (attempt?.incoming.from !== member) return;
        attempt.incoming.fail(msg.reason);
        this.endAttempt(msg.transfer);
        this.links.changed();
        return;
      }
    }
  }

  private pumpQueue(member: MemberId): void {
    let active = 0;
    for (const send of this.sends.values()) if (send.to === member && send.busy) active++;
    for (const send of this.sends.values()) {
      if (active >= MAX_ACTIVE_SENDS) return;
      if (send.to !== member || send.phase !== "queued") continue;
      active++;
      send.phase = "sending";
      send.busy = true;
      void this.pump(send)
        .catch(() => {
          if (this.sends.get(send.id) === send && send.phase === "sending") this.dropSend(send);
        })
        .finally(() => {
          send.busy = false;
          this.pumpQueue(member);
          this.links.changed();
        });
    }
  }

  private async pump(send: Send): Promise<void> {
    const offer = this.offers.get(send.file);
    const dc = offer ? this.links.open(send.to, `${XFER_PREFIX}${send.id}`) : null;
    if (!offer || !dc) throw new Error("no offer or link");
    const signal = send.abort.signal;
    signal.addEventListener("abort", () => { detach(dc); dc.close(); }, { once: true });
    dc.binaryType = "arraybuffer";
    dc.bufferedAmountLowThreshold = LOW_WATER;
    // The receiver closes the channel after the end marker, or to cancel.
    dc.onclose = () => send.abort.abort();
    await opened(dc, signal);
    if (!offer.digest) {
      offer.hashing = new AbortController();
      const hashing = offer.hashing;
      offer.digest = hashFile(offer.file, hashing.signal, () => this.activity.reads++).then((digest) => {
        if (offer.hashing === hashing) offer.hashing = null;
        return digest;
      });
      void offer.digest.catch(() => {});
    }
    const max = this.links.maxMessageSize(send.to);
    const chunk = max > 0 ? Math.min(CHUNK_BYTES, max) : CHUNK_BYTES;
    const size = offer.meta.size;
    let offset = send.offset;
    while (offset < size) {
      signal.throwIfAborted();
      this.activity.reads++;
      const block = new Uint8Array(await offer.file.slice(offset, Math.min(size, offset + READ_BYTES)).arrayBuffer());
      for (let i = 0; i < block.byteLength; i += chunk) {
        if (dc.bufferedAmount > HIGH_WATER) await drained(dc, signal);
        signal.throwIfAborted();
        dc.send(block.subarray(i, i + chunk));
        this.activity.sends++;
      }
      offset += block.byteLength;
      send.sent = offset;
      this.progress();
    }
    const digest = await offer.digest;
    signal.throwIfAborted();
    dc.send(JSON.stringify({ t: "end", sha256: digest }));
    send.phase = "sent";
    dc.bufferedAmountLowThreshold = 0;
    if (dc.bufferedAmount > 0) await drained(dc, signal);
  }

  private dropSend(send: Send): void {
    this.sends.delete(send.id);
    send.abort.abort();
    const offer = this.offers.get(send.file);
    if (offer?.hashing && ![...this.sends.values()].some((s) => s.file === send.file && (s.phase === "queued" || s.phase === "sending"))) {
      offer.hashing?.abort();
      offer.hashing = null;
      offer.digest = null;
    }
    this.pumpQueue(send.to);
  }

  // ---------------------------------------------------------------------------

  private sendCtl(member: MemberId, msg: Ctl): boolean {
    const ctl = this.ctl.get(member);
    if (ctl?.readyState !== "open") return false;
    try {
      ctl.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  /** Progress changes thousands of times a second; the UI hears about it a few times a second. */
  private progress(): void {
    this.progressTimer ??= setTimeout(() => {
      this.progressTimer = null;
      this.links.changed();
    }, PROGRESS_MS);
  }

  close(): void {
    for (const id of [...this.attempts.keys()]) this.endAttempt(id);
    for (const send of this.sends.values()) send.abort.abort();
    for (const incoming of this.incoming.values()) incoming.dispose();
    for (const ctl of this.ctl.values()) detach(ctl);
    this.sends.clear();
    for (const offer of this.offers.values()) offer.hashing?.abort();
    this.offers.clear();
    this.incoming.clear();
    this.ctl.clear();
    if (this.progressTimer) clearTimeout(this.progressTimer);
  }

  view(now = performance.now()): TransfersView {
    const incoming = new Map<string, IncomingView>();
    for (const [key, item] of this.incoming) {
      const { phase } = item;
      if (phase.kind === "done") incoming.set(key, { phase: "done", blob: phase.blob });
      else if (phase.kind === "failed") incoming.set(key, { phase: "failed", reason: phase.reason });
      else incoming.set(key, { phase: phase.kind, received: item.received, bytesPerSec: this.rate(key, item.received, now) });
    }
    const outgoing = new Map<FileId, SendView[]>();
    for (const send of this.sends.values()) {
      const list = outgoing.get(send.file) ?? [];
      list.push({ to: send.to, phase: send.phase, sent: send.sent });
      outgoing.set(send.file, list);
    }
    return { incoming, outgoing, offered: new Set(this.offers.keys()) };
  }

  private rate(key: string, received: number, now: number): number {
    const sample = this.rates.get(key);
    if (!sample || received < sample.received) {
      this.rates.set(key, { at: now, received, bytesPerSec: 0 });
      return 0;
    }
    if (now - sample.at >= 1000) {
      const bytesPerSec = ((received - sample.received) * 1000) / (now - sample.at);
      this.rates.set(key, { at: now, received, bytesPerSec });
      return bytesPerSec;
    }
    return sample.bytesPerSec;
  }
}

function detach(dc: RTCDataChannel): void {
  dc.onopen = dc.onmessage = dc.onclose = dc.onerror = dc.onbufferedamountlow = null;
}

function opened(dc: RTCDataChannel, signal: AbortSignal): Promise<void> {
  if (dc.readyState === "open") return Promise.resolve();
  return waitFor(dc, "open", signal);
}

function drained(dc: RTCDataChannel, signal: AbortSignal): Promise<void> {
  return waitFor(dc, "bufferedamountlow", signal);
}

/** Resolves on `event`; rejects if the channel closes or errors or the send is cancelled first. */
function waitFor(dc: RTCDataChannel, event: "open" | "bufferedamountlow", signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const done = (ok: boolean) => () => {
      dc.removeEventListener(event, onOk);
      dc.removeEventListener("close", onFail);
      dc.removeEventListener("error", onFail);
      signal.removeEventListener("abort", onFail);
      if (ok) resolve();
      else reject(new Error(`channel ${dc.readyState}`));
    };
    const onOk = done(true);
    const onFail = done(false);
    dc.addEventListener(event, onOk);
    dc.addEventListener("close", onFail);
    dc.addEventListener("error", onFail);
    signal.addEventListener("abort", onFail);
  });
}
