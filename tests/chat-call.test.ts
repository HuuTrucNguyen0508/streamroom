import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Call, retainFileCards } from "../src/web/rtc/call.ts";
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
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
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
  expect(retainFileCards([card], [], view)).toEqual([card]);
  const history = [card, ...Array.from({length:500}, (_,i):ChatEntry => ({...card,seq:i+2,body:{kind:"text",text:"hello"}}))];
  expect(retainFileCards(history, history, view)).toHaveLength(501);
  expect(retainFileCards(history, history, view)[0]).toEqual(card);
  view.incoming.clear();
  expect(retainFileCards(history, history, view)).toHaveLength(500);
});

it("keeps your own shared file's card past the 500-entry cap until you stop sharing", () => {
  const card: ChatEntry = {seq:1,from:"me0000001" as MemberId,name:"Me",at:1,body:{kind:"file",file:meta}};
  const view = {incoming:new Map(),outgoing:new Map(),offered:new Set<FileId>([meta.id])};
  const history = [card, ...Array.from({length:500}, (_,i):ChatEntry => ({...card,seq:i+2,body:{kind:"text",text:"hello"}}))];
  expect(retainFileCards(history, history, view)[0]).toEqual(card);
  view.offered.clear();
  expect(retainFileCards(history, history, view)).toHaveLength(500);
});

it.each(["bad_request", "not_joined"] as const)("settles %s before accepting the next echo", async (code) => {
  const call = setup();
  const refused = call.sendChat("first");
  signal.events!.message({t:"error",code,message:"refused"});
  const result = vi.fn();
  void refused.then(result);
  await Promise.resolve();
  expect(result).toHaveBeenCalledWith(false);
  const next = call.sendChat("next");
  signal.events!.message({t:"chat",entry:{seq:1,from:member,name:"Sender",at:1,body:{kind:"text",text:"first"}}});
  const nextResult = vi.fn();
  void next.then(nextResult);
  await Promise.resolve();
  expect(nextResult).not.toHaveBeenCalled();
  signal.events!.message({t:"chat",entry:{seq:2,from:member,name:"Sender",at:1,body:{kind:"text",text:"next"}}});
  expect(await next).toBe(true);
});
it("bounds a missing echo without inviting an automatic resend", async () => {
  vi.useFakeTimers();
  const call = setup();
  const sent = call.sendChat("uncertain");
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await sent).toBe(true);
  expect(call.view.notice).toContain("history");
});
it.each([true, false])("reconciles a dropped send against rejoin history, accepted=%s", async (accepted) => {
  const call = setup();
  const sent = call.sendChat("during drop");
  signal.events!.drop();
  signal.events!.message({t:"joined",you:"sender0002" as MemberId,resume:"token",chat:accepted ? [{seq:1,from:member,name:"Sender",at:1,body:{kind:"text",text:"during drop"}}] : [],room:{hostId:member,locked:false,members:[]}});
  expect(await sent).toBe(accepted);
});
