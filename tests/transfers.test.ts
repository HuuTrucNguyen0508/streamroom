import { afterEach, expect, it } from "vitest";
import type { FileId, FileMeta, MemberId } from "../src/shared/protocol.ts";
import { FileTransfers } from "../src/web/rtc/transfers.ts";

class Channel extends EventTarget {
  readyState = "open";
  binaryType = "arraybuffer";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror = null;
  onbufferedamountlow = null;
  sent: unknown[] = [];
  constructor(readonly label: string) { super(); }
  send(value: string | Uint8Array) {
    this.sent.push(value);
    this.bufferedAmount += typeof value === "string" ? value.length : value.byteLength;
  }
  close() { this.readyState = "closed"; this.onclose?.(); this.dispatchEvent(new Event("close")); }
  receive(value: unknown) { this.onmessage?.({ data: JSON.stringify(value) }); }
  drain() { this.bufferedAmount = 0; this.dispatchEvent(new Event("bufferedamountlow")); }
  rtc() { return this as unknown as RTCDataChannel; }
}
const member = "sender0001" as MemberId;
const meta: FileMeta = { id: "AAAAAAAAAAAAAAAA" as FileId, name: "f.bin", size: 64, mime: "" };
const live: FileTransfers[] = [];
afterEach(() => { for (const t of live.splice(0)) t.close(); });
function setup() {
  const opened: Channel[] = [];
  const t = new FileTransfers({open: (_, label) => { const dc = new Channel(label); opened.push(dc); return dc.rtc(); }, maxMessageSize: () => 16384, changed: () => {}});
  live.push(t);
  const ctl = new Channel("ctl");
  t.channel(member, ctl.rtc());
  return {t, ctl, opened};
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));
it("rejects duplicate ctl channels even while the legitimate channel is opening", () => {
  const {t, ctl} = setup();
  t.linkClosed(member);
  ctl.readyState = "connecting";
  t.channel(member, ctl.rtc());
  const duplicate = new Channel("ctl");
  t.channel(member, duplicate.rtc());
  expect(duplicate.readyState).toBe("closed");
  expect(ctl.readyState).toBe("connecting");
});
it("holds both send slots until buffered data drains", async () => {
  const {t, ctl, opened} = setup();
  for (let i=0; i<3; i++) {
    const file = {...meta, id: `AAAAAAAAAAAAAAA${i}` as FileId};
    t.offer(file, new Blob([new Uint8Array(64)]));
    ctl.receive({t:"get",file:file.id,transfer:`attempt0000${i}`,offset:0});
  }
  await tick();
  expect(opened).toHaveLength(2);
  expect(opened.every((dc) => dc.bufferedAmount > 0)).toBe(true);
  opened[0]!.drain();
  await tick();
  expect(opened).toHaveLength(3);
});
it("cancel stops further reads and sends and aborts shared hashing after its last request", async () => {
  const {t, ctl, opened} = setup();
  t.offer({...meta,size:32*1024*1024}, new Blob([new Uint8Array(32*1024*1024)]));
  ctl.receive({t:"get",file:meta.id,transfer:"attempt00001",offset:0});
  await tick();
  ctl.receive({t:"cancel",transfer:"attempt00001"});
  await tick();
  const before = {...t.activity};
  await tick();
  expect(t.activity).toEqual(before);
  expect(opened[0]!.readyState).toBe("closed");
  expect(t.view().outgoing.size).toBe(0);
});

