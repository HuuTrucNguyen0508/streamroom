import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Call, retainDownloadCards } from "../src/web/rtc/call.ts";
import type { ChatEntry, ClientMessage, FileId, FileMeta, MemberId, RoomId } from "../src/shared/protocol.ts";
import type { SignalingEvents } from "../src/web/rtc/signaling.ts";
const signal = vi.hoisted(() => ({ events: null as SignalingEvents | null, sent: [] as ClientMessage[] }));
vi.mock("../src/web/rtc/signaling.ts", () => ({ Signaling: class {
  open = true;
  constructor(_: string, events: SignalingEvents) { signal.events = events; }
  send(msg: ClientMessage) { signal.sent.push(msg); }
} }));
vi.mock("../src/web/rtc/audio.ts", () => ({ AudioEngine: class {} }));
const member = "sender0001" as MemberId;
const meta: FileMeta = { id: "AAAAAAAAAAAAAAAA" as FileId, name:"f.bin",size:64,mime:"" };
beforeEach(() => { vi.stubGlobal("location", {protocol:"http:",host:"localhost"}); signal.sent = []; });
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const call = new Call("AAAAAAAAAAAAAAAAAAAAAA" as RoomId, {relayOnly:false});
  signal.events!.message({t:"joined",you:member,resume:"token",chat:[],room:{hostId:member,locked:false,members:[]}});
  return call;
}
it("confirms text only on echo and leaves rejected text available to the composer", async () => {
  const call = setup();
  const rejected = call.sendChat("keep this draft");
  signal.events!.message({t:"error",code:"slow_down",message:"slow"});
  expect(await rejected).toBe(false);
  const accepted = call.sendChat("hello");
  signal.events!.message({t:"chat",entry:{seq:1,from:member,name:"Sender",at:1,body:{kind:"text",text:"hello"}}});
  expect(await accepted).toBe(true);
});
it("removes a rate-limited offer and reports every file refused after a partial batch", () => {
  const call = setup();
  call.shareFiles([new File(["hello"],"hello.txt")]);
  signal.events!.message({t:"error",code:"slow_down",message:"slow"});
  expect(call.view.transfers.offered.size).toBe(0);
  call.shareFiles(Array.from({length:12}, (_,i) => new File(["hello"],`f${i}.txt`)));
  expect(call.view.notice).toContain("f8.txt was not shared");
  expect(call.view.notice).toContain("f11.txt was not shared");
});
it("reports messages with no visible content", async () => {
  const call = setup();
  expect(await call.sendChat("\u200b")).toBe(false);
  expect(call.view.notice).toContain("visible text");
  expect(signal.sent).toHaveLength(0);
});
it("keeps retained download cards across history replacement and the 500-entry cap", () => {
  const card: ChatEntry = {seq:1,from:member,name:"Sender",at:1,body:{kind:"file",file:meta}};
  const view = {incoming:new Map([[`${member}/${meta.id}`, {phase:"done" as const,blob:new Blob()}]]),outgoing:new Map(),offered:new Set<FileId>()};
  expect(retainDownloadCards([card], [], view)).toEqual([card]);
  const history = [card, ...Array.from({length:500}, (_,i):ChatEntry => ({...card,seq:i+2,body:{kind:"text",text:"hello"}}))];
  expect(retainDownloadCards(history, history, view)).toHaveLength(501);
  expect(retainDownloadCards(history, history, view)[0]).toEqual(card);
  view.incoming.clear();
  expect(retainDownloadCards(history, history, view)).toHaveLength(500);
});
