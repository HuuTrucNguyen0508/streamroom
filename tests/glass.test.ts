import { describe, expect, it } from "vitest";
import type { MemberId } from "../src/shared/protocol.ts";
import { Draw, colorFor, encodeDraw } from "../src/web/rtc/draw.ts";
import { GLASS_PORT, Glass, glassCommand } from "../src/web/rtc/glass.ts";

const me = "sharermem1" as MemberId;
const bob = "bobmember01" as MemberId;
const other = "othersharer" as MemberId;

class Socket {
  readyState: 0 | 1 | 2 | 3 = 0;
  bufferedAmount = 0;
  sent: Record<string, unknown>[] = [];
  closed = false;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: CloseEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  close() {
    this.closed = true;
  }
  /** Streamroom Glass accepts the connection and says hello. */
  accept(v = 1) {
    this.readyState = 1;
    this.onopen?.({} as Event);
    this.receive({ t: "hello", app: "streamroom-glass", v });
  }
  receive(msg: object) {
    this.onmessage?.({ data: JSON.stringify(msg) } as MessageEvent);
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code } as CloseEvent);
  }
}

class Channel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  send() {}
  close() {}
  receive(data: string) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

function screen(id: string, settings: Record<string, unknown> = { displaySurface: "monitor", width: 2560, height: 1072 }) {
  return { id, getVideoTracks: () => [{ getSettings: () => settings }] } as unknown as MediaStream;
}

function setup(enabled = true) {
  const sockets: Socket[] = [];
  const timers: { fn: () => void; ms: number }[] = [];
  const stored = new Map<string, string>(enabled ? [["streamroom:glass", "1"]] : []);
  const draw = new Draw(() => me, () => 0);
  const toBob = new Channel();
  draw.channel(bob, toBob);
  const glass = new Glass({
    draw,
    names: () => new Map([[me, "Me"], [bob, "Bob"]]),
    connect: (url) => {
      const s = new Socket(url);
      sockets.push(s);
      return s;
    },
    storage: { getItem: (k) => stored.get(k) ?? null, setItem: (k, v) => void stored.set(k, v) },
    setTimeout: (fn, ms) => timers.push({ fn, ms }),
    clearTimeout: () => {},
  });
  const last = () => sockets.at(-1)!;
  const types = (s = last()) => s.sent.map((m) => m.t);
  return { glass, draw, toBob, sockets, timers, stored, last, types };
}

describe("Glass", () => {
  it("stays away from this computer until it's turned on", () => {
    const { glass, sockets, stored } = setup(false);
    glass.update(screen("s1"), me);
    expect(sockets).toHaveLength(0);
    expect(glass.state).toEqual({ k: "off" });
    glass.setEnabled(true);
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe(`ws://127.0.0.1:${GLASS_PORT}/`);
    expect(stored.get("streamroom:glass")).toBe("1");
  });

  it("only connects while sharing, and tells the app about the share once it says hello", () => {
    const { glass, sockets, last } = setup();
    glass.update(null, me);
    expect(sockets).toHaveLength(0);
    expect(glass.state).toEqual({ k: "idle" });
    glass.update(screen("s1"), me);
    expect(glass.state).toEqual({ k: "connecting" });
    last().accept();
    expect(last().sent).toEqual([{ t: "share", gen: 1, me, w: 2560, h: 1072 }]);
    last().receive({ t: "status", gen: 1, output: "DP-2" });
    expect(glass.state).toEqual({ k: "drawing", output: "DP-2" });
    glass.update(null, me);
    expect(last().closed).toBe(true);
    expect(glass.state).toEqual({ k: "idle" });
  });

  it("forwards marks on our share as they arrive, with names and colors, and nothing else", () => {
    const { glass, draw, toBob, last } = setup();
    glass.update(screen("s1"), me);
    last().accept();
    last().sent.length = 0;
    toBob.receive(encodeDraw({ t: "down", s: me, x: 0.25, y: 0.5 }));
    // Sent inside the data channel's own event: no timer or animation frame in between.
    expect(last().sent).toEqual([{ t: "mark", gen: 1, a: bob, name: "Bob", color: colorFor(bob), m: { t: "down", x: 0.25, y: 0.5 } }]);
    toBob.receive(encodeDraw({ t: "up", s: me }));
    toBob.receive(encodeDraw({ t: "move", s: other, x: 0.1, y: 0.1 }));
    draw.send({ t: "line", s: me, x: 0.3, y: 0.3 });
    expect(last().sent.slice(1)).toEqual([
      { t: "mark", gen: 1, a: bob, name: "Bob", color: colorFor(bob), m: { t: "up" } },
      { t: "mark", gen: 1, a: me, name: "Me", color: colorFor(me), m: { t: "line", x: 0.3, y: 0.3 } },
    ]);
  });

  it("says when a member's marks go and when the call closes", () => {
    const { glass, draw, last, types } = setup();
    glass.update(screen("s1"), me);
    last().accept();
    draw.linkClosed(bob);
    expect(last().sent.at(-1)).toEqual({ t: "forget", a: bob });
    draw.close();
    expect(types().at(-1)).toBe("stop");
  });

  it("starts a new share when the stream or our member id changes", () => {
    const { glass, last } = setup();
    glass.update(screen("s1"), me);
    last().accept();
    glass.update(screen("s2"), me);
    const rejoined = "rejoinedme1" as MemberId;
    glass.update(screen("s2"), rejoined);
    // The same share seen again changes nothing.
    glass.update(screen("s2"), rejoined);
    expect(last().sent).toEqual([
      { t: "share", gen: 1, me, w: 2560, h: 1072 },
      { t: "stop", gen: 1 },
      { t: "share", gen: 2, me, w: 2560, h: 1072 },
      { t: "stop", gen: 2 },
      { t: "share", gen: 3, me: rejoined, w: 2560, h: 1072 },
    ]);
    // A status for an old share is ignored.
    last().receive({ t: "status", gen: 2, output: "DP-2" });
    expect(glass.state).toEqual({ k: "connecting" });
  });

  it("never sends a window, tab or unknown share", () => {
    const { glass, sockets } = setup();
    glass.update(screen("w1", { displaySurface: "window", width: 800, height: 600 }), me);
    expect(glass.state).toEqual({ k: "not-monitor", surface: "window" });
    glass.update(screen("f1", { width: 2560, height: 1440 }), me);
    expect(glass.state).toEqual({ k: "not-monitor", surface: "" });
    expect(sockets).toHaveLength(0);
  });

  it("retries with backoff when the app isn't running, and resends the share on reconnect", () => {
    const { glass, sockets, timers, last } = setup();
    glass.update(screen("s1"), me);
    last().drop();
    expect(glass.state).toEqual({ k: "missing" });
    expect(timers.map((t) => t.ms)).toEqual([1000]);
    timers[0]!.fn();
    last().drop();
    expect(timers.map((t) => t.ms)).toEqual([1000, 2000]);
    // Coming back to the tab tries at once.
    glass.retry();
    expect(sockets).toHaveLength(3);
    last().accept();
    expect(last().sent).toEqual([{ t: "share", gen: 1, me, w: 2560, h: 1072 }]);
  });

  it("gives up when another tab takes over or the app is the wrong version", () => {
    const { glass, sockets, timers, last } = setup();
    glass.update(screen("s1"), me);
    last().accept();
    last().drop(4001);
    expect(glass.state).toEqual({ k: "replaced" });
    expect(timers).toHaveLength(0);
    glass.retry();
    expect(sockets).toHaveLength(1);
    // Turning it off and on takes it back.
    glass.setEnabled(false);
    glass.setEnabled(true);
    last().accept(2);
    expect(glass.state).toEqual({ k: "outdated" });
    expect(last().closed).toBe(true);
    expect(timers).toHaveLength(0);
  });

  it("explains a share the app can't place", () => {
    const { glass, last } = setup();
    glass.update(screen("s1", { displaySurface: "monitor", width: 1920, height: 1080 }), me);
    last().accept();
    last().receive({ t: "status", gen: 1, output: null, why: "no-match", outputs: ["DP-2 3440x1440", 7] });
    expect(glass.state).toEqual({ k: "unplaced", why: "no-match", share: "1920×1080", outputs: ["DP-2 3440x1440"] });
  });

  it("drops pointer moves behind a backlog and starts over behind a bigger one", () => {
    const { glass, toBob, last, types } = setup();
    glass.update(screen("s1"), me);
    const socket = last();
    socket.accept();
    socket.bufferedAmount = 300 * 1024;
    toBob.receive(encodeDraw({ t: "move", s: me, x: 0.1, y: 0.1 }));
    toBob.receive(encodeDraw({ t: "down", s: me, x: 0.1, y: 0.1 }));
    expect(types(socket)).toEqual(["share", "mark"]);
    expect(socket.sent.at(-1)!.m).toEqual({ t: "down", x: 0.1, y: 0.1 });
    socket.bufferedAmount = 2 * 1024 * 1024;
    toBob.receive(encodeDraw({ t: "up", s: me }));
    expect(socket.closed).toBe(true);
    expect(glass.state).toEqual({ k: "missing" });
  });

  it("builds the command to start the app", () => {
    expect(glassCommand("https://streamroom.example")).toBe("streamroom-glass --origin https://streamroom.example");
    expect(glassCommand("http://localhost:5173", "DP-1")).toBe("streamroom-glass --origin http://localhost:5173 --output DP-1");
  });
});
