import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { FileId, FileMeta, MemberId } from "../src/shared/protocol.ts";
import { Incoming, hashFile, parseCtl, parseEnd, type TransferId } from "../src/web/rtc/files.ts";

const SENDER = "sender0001" as MemberId;
const A1 = "attempt00001" as TransferId;
const A2 = "attempt00002" as TransferId;
const FILE = "FFFFFFFFFFFFFFFF" as FileId;

function fileOf(size: number): { bytes: Uint8Array; meta: FileMeta; digest: string } {
  const bytes = new Uint8Array(randomBytes(size));
  return { bytes, meta: { id: FILE, name: "f.bin", size, mime: "" }, digest: createHash("sha256").update(bytes).digest("hex") };
}

async function contents(incoming: Incoming): Promise<Uint8Array> {
  if (incoming.phase.kind !== "done") throw new Error(`not done: ${JSON.stringify(incoming.phase)}`);
  return new Uint8Array(await incoming.phase.blob.arrayBuffer());
}

function feed(incoming: Incoming, attempt: TransferId, bytes: Uint8Array, cuts: number[]): void {
  let at = 0;
  for (const cut of [...cuts, bytes.byteLength]) {
    incoming.chunk(attempt, bytes.subarray(at, cut));
    at = cut;
  }
}

describe("incoming transfer", () => {
  it("assembles chunks split at awkward boundaries and verifies the whole-file hash", async () => {
    const { bytes, meta, digest } = fileOf(200_003);
    const incoming = new Incoming(SENDER, meta);
    expect(incoming.request(A1)).toBe(0);
    expect(incoming.accept(A1)).toBe(true);
    feed(incoming, A1, bytes, [1, 63, 64, 65, 16_384, 16_447, 131_071, 200_002]);
    expect(incoming.received).toBe(200_003);
    expect(incoming.end(A1, digest)).toBe(true);
    expect(incoming.phase.kind).toBe("done");
    expect(Buffer.from(await contents(incoming)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("keeps every byte when chunks cross the in-memory batch fold", async () => {
    const { bytes, meta, digest } = fileOf(16 * 1024 * 1024 + 20_001);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.accept(A1);
    const cuts = Array.from({ length: Math.floor(bytes.byteLength / 16_383) }, (_, i) => (i + 1) * 16_383);
    feed(incoming, A1, bytes, cuts);
    expect(incoming.end(A1, digest)).toBe(true);
    expect(createHash("sha256").update(await contents(incoming)).digest("hex")).toBe(digest);
  });

  it("resumes on a new attempt from the bytes already received, continuing the same hash", async () => {
    const { bytes, meta, digest } = fileOf(100_000);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.accept(A1);
    feed(incoming, A1, bytes.subarray(0, 37_777), [5, 16_384]);
    incoming.interrupt(A1);
    expect(incoming.phase).toEqual({ kind: "paused" });
    expect(incoming.request(A2)).toBe(37_777);
    expect(incoming.accept(A2)).toBe(true);
    feed(incoming, A2, bytes.subarray(37_777), [3, 16_384, 40_000]);
    expect(incoming.end(A2, digest)).toBe(true);
    expect(Buffer.from(await contents(incoming)).equals(Buffer.from(bytes))).toBe(true);
  });

  it("ignores channels, chunks and ends from a stale attempt", async () => {
    const { bytes, meta, digest } = fileOf(1000);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.interrupt(A1);
    incoming.request(A2);
    expect(incoming.accept(A1)).toBe(false);
    expect(incoming.accept(A2)).toBe(true);
    incoming.chunk(A1, bytes.subarray(0, 500));
    expect(incoming.received).toBe(0);
    incoming.chunk(A2, bytes);
    expect(incoming.end(A1, digest)).toBe(false);
    incoming.interrupt(A1);
    expect(incoming.phase).toEqual({ kind: "receiving", attempt: A2 });
    expect(incoming.end(A2, digest)).toBe(true);
    expect((await contents(incoming)).byteLength).toBe(1000);
  });

  it("fails with size when the sender sends more than the file holds", () => {
    const { bytes, meta } = fileOf(1000);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.accept(A1);
    incoming.chunk(A1, bytes.subarray(0, 600));
    incoming.chunk(A1, new Uint8Array(401));
    expect(incoming.phase).toEqual({ kind: "failed", reason: "size" });
    expect(incoming.retained).toBe(0);
  });

  it("rejects an end that arrives before every byte", () => {
    const { bytes, meta, digest } = fileOf(1000);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.accept(A1);
    incoming.chunk(A1, bytes.subarray(0, 999));
    expect(incoming.end(A1, digest)).toBe(false);
    expect(incoming.phase).toEqual({ kind: "failed", reason: "size" });
  });

  it("fails with mismatch when the bytes don't hash to the sender's digest", () => {
    const { bytes, meta, digest } = fileOf(1000);
    const incoming = new Incoming(SENDER, meta);
    incoming.request(A1);
    incoming.accept(A1);
    const corrupt = bytes.slice();
    corrupt[500] = corrupt[500]! ^ 1;
    incoming.chunk(A1, corrupt);
    expect(incoming.end(A1, digest)).toBe(false);
    expect(incoming.phase).toEqual({ kind: "failed", reason: "mismatch" });
  });

  it("only starts an attempt from a pause", () => {
    const { meta } = fileOf(10);
    const incoming = new Incoming(SENDER, meta);
    expect(incoming.request(A1)).toBe(0);
    expect(incoming.request(A2)).toBeNull();
    incoming.fail("gone");
    expect(incoming.request(A2)).toBeNull();
    expect(incoming.phase).toEqual({ kind: "failed", reason: "gone" });
  });
});

describe("sender hashing", () => {
  it("matches node's SHA-256 across its read blocks", async () => {
    const { bytes, digest } = fileOf(4 * 1024 * 1024 + 12_345);
    expect(await hashFile(new Blob([bytes as BlobPart]))).toBe(digest);
    expect(await hashFile(new Blob([]))).toBe(createHash("sha256").digest("hex"));
  });
});

describe("control messages", () => {
  it("parses each known message and nothing else", () => {
    const transfer = "abcdefghijkl";
    expect(parseCtl(JSON.stringify({ t: "get", transfer, file: FILE, offset: 16384 }))).toEqual({ t: "get", transfer, file: FILE, offset: 16384 });
    expect(parseCtl(JSON.stringify({ t: "cancel", transfer }))).toEqual({ t: "cancel", transfer });
    expect(parseCtl(JSON.stringify({ t: "ack", transfer }))).toEqual({ t: "ack", transfer });
    expect(parseCtl(JSON.stringify({ t: "fail", transfer, reason: "gone" }))).toEqual({ t: "fail", transfer, reason: "gone" });
    const bad = [
      { t: "get", transfer, file: FILE, offset: -1 },
      { t: "get", transfer, file: FILE, offset: 1.5 },
      { t: "get", transfer, file: FILE, offset: "0" },
      { t: "get", transfer, file: "x", offset: 0 },
      { t: "get", transfer: "short", file: FILE, offset: 0 },
      { t: "fail", transfer, reason: "boom" },
      { t: "end", transfer },
      { t: "cancel", transfer, pad: "x".repeat(1024) },
    ];
    for (const v of bad) expect(parseCtl(JSON.stringify(v)), JSON.stringify(v).slice(0, 80)).toBeNull();
    expect(parseCtl("{")).toBeNull();
    expect(parseCtl(new ArrayBuffer(4))).toBeNull();
  });

  it("reads the end marker's digest", () => {
    const sha256 = "a".repeat(64);
    expect(parseEnd(JSON.stringify({ t: "end", sha256 }))).toBe(sha256);
    expect(parseEnd(JSON.stringify({ t: "end", sha256: "A".repeat(64) }))).toBeNull();
    expect(parseEnd(JSON.stringify({ t: "end", sha256: "a".repeat(63) }))).toBeNull();
  });
});

it("stops hashing before reading another block after abort", async () => {
  const abort = new AbortController();
  let reads = 0;
  const file = new Blob([new Uint8Array(9 * 1024 * 1024)]);
  await expect(hashFile(file, abort.signal, () => { reads++; abort.abort(); })).rejects.toThrow();
  expect(reads).toBe(1);
});

it("releases retained parts when a batch Blob allocation fails", () => {
  const { meta } = fileOf(16 * 1024 * 1024);
  const incoming = new Incoming(SENDER, meta);
  incoming.request(A1); incoming.accept(A1);
  vi.stubGlobal("Blob", class { constructor() { throw new Error("oom"); } });
  try {
    expect(() => incoming.chunk(A1, new Uint8Array(meta.size))).not.toThrow();
    expect(incoming.phase).toEqual({kind:"failed",reason:"memory"});
    expect(incoming.retained).toBe(0);
  } finally { vi.unstubAllGlobals(); }
});
