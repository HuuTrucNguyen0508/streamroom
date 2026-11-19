import { describe, expect, it } from "vitest";
import type { MemberId } from "../src/shared/protocol.ts";
import {
  Draw,
  DrawBoard,
  MAX_STROKES,
  MAX_STROKE_POINTS,
  POINTER_IDLE_MS,
  STROKE_FADE_MS,
  STROKE_HOLD_MS,
  STROKE_STALL_MS,
  colorFor,
  contentRect,
  encodeDraw,
  parseDraw,
} from "../src/web/rtc/draw.ts";

const host = "hostmember1" as MemberId;
const alice = "alicemember" as MemberId;
const bob = "bobmember01" as MemberId;

describe("parseDraw", () => {
  it("round-trips every message", () => {
    for (const msg of [
      { t: "move", s: host, x: 0.25, y: 0.75 },
      { t: "down", s: host, x: 0, y: 1 },
      { t: "line", s: host, x: 0.5, y: 0.5 },
      { t: "up", s: host },
      { t: "leave", s: host },
      { t: "clear", s: host },
    ] as const) {
      expect(parseDraw(encodeDraw(msg))).toEqual(msg);
    }
  });

  it("clamps coordinates into the picture", () => {
    expect(parseDraw(JSON.stringify({ t: "move", s: host, x: -3, y: 9 }))).toEqual({ t: "move", s: host, x: 0, y: 1 });
  });

  it("rounds outgoing coordinates", () => {
    expect(encodeDraw({ t: "move", s: host, x: 0.123456789, y: 1.5 })).toBe(JSON.stringify({ t: "move", s: host, x: 0.1235, y: 1 }));
  });

  it("refuses junk", () => {
    expect(parseDraw("{")).toBeNull();
    expect(parseDraw(42)).toBeNull();
    expect(parseDraw(JSON.stringify(null))).toBeNull();
    expect(parseDraw(JSON.stringify({ t: "move", s: "not a member!", x: 0, y: 0 }))).toBeNull();
    expect(parseDraw(JSON.stringify({ t: "move", s: host, x: "1", y: 0 }))).toBeNull();
    expect(parseDraw(JSON.stringify({ t: "line", s: host, x: 0, y: null }))).toBeNull();
    expect(parseDraw(JSON.stringify({ t: "erase", s: host }))).toBeNull();
    expect(parseDraw(JSON.stringify({ t: "up", s: host, pad: "x".repeat(300) }))).toBeNull();
  });
});

describe("DrawBoard", () => {
  it("keeps a finished stroke, then fades it out", () => {
    const board = new DrawBoard();
    board.apply(alice, { t: "down", s: host, x: 0.1, y: 0.1 }, 0);
    board.apply(alice, { t: "line", s: host, x: 0.2, y: 0.2 }, 10);
    board.apply(alice, { t: "up", s: host }, 20);
    board.apply(alice, { t: "leave", s: host }, 20);

    expect(board.visible(host, 20 + STROKE_HOLD_MS - 1)).toEqual([
      { author: alice, pointer: null, strokes: [{ points: [0.1, 0.1, 0.2, 0.2], alpha: 1 }] },
    ]);
    const half = board.visible(host, 20 + STROKE_HOLD_MS + STROKE_FADE_MS / 2);
    expect(half[0]?.strokes[0]?.alpha).toBeCloseTo(0.5);
    expect(board.visible(host, 20 + STROKE_HOLD_MS + STROKE_FADE_MS)).toEqual([]);
  });

  it("keeps an open stroke until it stalls", () => {
    const board = new DrawBoard();
    board.apply(alice, { t: "down", s: host, x: 0.1, y: 0.1 }, 0);
    expect(board.visible(host, STROKE_STALL_MS - 1)[0]?.strokes[0]?.alpha).toBe(1);
    expect(board.visible(host, STROKE_STALL_MS + STROKE_HOLD_MS + STROKE_FADE_MS)).toEqual([]);
  });

  it("starts a stroke from a line whose down went missing", () => {
    const board = new DrawBoard();
    board.apply(alice, { t: "line", s: host, x: 0.3, y: 0.3 }, 0);
    board.apply(alice, { t: "line", s: host, x: 0.4, y: 0.4 }, 1);
    expect(board.visible(host, 2)[0]?.strokes).toEqual([{ points: [0.3, 0.3, 0.4, 0.4], alpha: 1 }]);
  });

  it("hides a pointer that stopped moving", () => {
    const board = new DrawBoard();
    board.apply(alice, { t: "move", s: host, x: 0.5, y: 0.5 }, 0);
    expect(board.visible(host, POINTER_IDLE_MS - 1)[0]?.pointer).toEqual({ x: 0.5, y: 0.5 });
    expect(board.visible(host, POINTER_IDLE_MS)).toEqual([]);
  });

  it("keeps marks apart by share and by author", () => {
    const board = new DrawBoard();
    board.apply(alice, { t: "down", s: host, x: 0.1, y: 0.1 }, 0);
    board.apply(bob, { t: "down", s: host, x: 0.9, y: 0.9 }, 0);
    board.apply(bob, { t: "down", s: alice, x: 0.5, y: 0.5 }, 0);
    board.apply(alice, { t: "clear", s: host }, 1);

    const onHost = board.visible(host, 2);
    expect(onHost.map((m) => [m.author, m.strokes.length])).toEqual([
      [alice, 0],
      [bob, 1],
    ]);
    expect(board.visible(alice, 2).map((m) => m.author)).toEqual([bob]);

    board.forget(bob);
    expect(board.visible(alice, 3)).toEqual([]);
    expect(board.visible(host, 3).map((m) => m.author)).toEqual([alice]);
  });

  it("caps strokes and points", () => {
    const board = new DrawBoard();
    for (let i = 0; i < MAX_STROKES + 5; i++) board.apply(alice, { t: "down", s: host, x: 0, y: 0 }, i);
    expect(board.visible(host, 100)[0]?.strokes).toHaveLength(MAX_STROKES);

    const long = new DrawBoard();
    long.apply(alice, { t: "down", s: host, x: 0, y: 0 }, 0);
    for (let i = 0; i < MAX_STROKE_POINTS + 10; i++) long.apply(alice, { t: "line", s: host, x: 0.5, y: 0.5 }, 1);
    expect(long.visible(host, 2)[0]?.strokes[0]?.points).toHaveLength(MAX_STROKE_POINTS * 2);
  });

  it("ignores shares past a sane number", () => {
    const board = new DrawBoard();
    const shares = Array.from({ length: 40 }, (_, i) => `share${String(i).padStart(6, "0")}` as MemberId);
    for (const s of shares) board.apply(alice, { t: "move", s, x: 0, y: 0 }, 0);
    expect(shares.filter((s) => board.visible(s, 1).length > 0)).toHaveLength(16);
  });
});

describe("contentRect", () => {
  it("letterboxes a wide picture in a tall box", () => {
    expect(contentRect(1000, 1000, 1920, 1080)).toEqual({ x: 0, y: 218.75, w: 1000, h: 562.5 });
  });

  it("pillarboxes a tall picture in a wide box", () => {
    expect(contentRect(2000, 1000, 1000, 1000)).toEqual({ x: 500, y: 0, w: 1000, h: 1000 });
  });

  it("falls back to the whole box before the video has a size", () => {
    expect(contentRect(800, 600, 0, 0)).toEqual({ x: 0, y: 0, w: 800, h: 600 });
  });
});

describe("colorFor", () => {
  it("is stable for a member", () => {
    expect(colorFor(alice)).toBe(colorFor(alice));
    expect(colorFor(alice)).toMatch(/^#[0-9a-f]{6}$/);
  });
});

class Channel {
  readyState: RTCDataChannelState = "open";
  bufferedAmount = 0;
  sent: string[] = [];
  closed = false;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onclose: ((ev: Event) => void) | null = null;
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
  }
  receive(data: unknown) {
    this.onmessage?.({ data } as MessageEvent);
  }
}

describe("Draw", () => {
  const setup = () => {
    let now = 0;
    const draw = new Draw(() => alice, () => now);
    const toHost = new Channel();
    const toBob = new Channel();
    draw.channel(host, toHost);
    draw.channel(bob, toBob);
    let changes = 0;
    draw.subscribe(() => changes++);
    return { draw, toHost, toBob, changes: () => changes, tick: (ms: number) => (now += ms) };
  };

  it("shows our own marks at once and sends them to everyone", () => {
    const { draw, toHost, toBob, changes } = setup();
    draw.send({ t: "down", s: host, x: 0.5, y: 0.5 });
    expect(changes()).toBe(1);
    expect(draw.board.visible(host, 0)).toEqual([{ author: alice, pointer: { x: 0.5, y: 0.5 }, strokes: [{ points: [0.5, 0.5], alpha: 1 }] }]);
    expect(toHost.sent).toEqual([encodeDraw({ t: "down", s: host, x: 0.5, y: 0.5 })]);
    expect(toBob.sent).toEqual(toHost.sent);
  });

  it("credits incoming marks to the channel's member, whatever the message says", () => {
    const { draw, toBob, changes } = setup();
    toBob.receive(encodeDraw({ t: "move", s: host, x: 0.1, y: 0.2 }));
    toBob.receive("garbage");
    expect(changes()).toBe(1);
    expect(draw.board.visible(host, 0)).toEqual([{ author: bob, pointer: { x: 0.1, y: 0.2 }, strokes: [] }]);
  });

  it("drops pointer moves, but not strokes, on a backed-up channel", () => {
    const { draw, toHost, toBob } = setup();
    toHost.bufferedAmount = 1 << 20;
    draw.send({ t: "move", s: host, x: 0.1, y: 0.1 });
    draw.send({ t: "up", s: host });
    expect(toHost.sent.map((d) => JSON.parse(d).t)).toEqual(["up"]);
    expect(toBob.sent.map((d) => JSON.parse(d).t)).toEqual(["move", "up"]);
  });

  it("skips channels that aren't open yet", () => {
    const { draw, toHost } = setup();
    toHost.readyState = "connecting";
    draw.send({ t: "move", s: host, x: 0.1, y: 0.1 });
    expect(toHost.sent).toEqual([]);
  });

  it("forgets a member's marks when its link closes", () => {
    const { draw, toBob } = setup();
    toBob.receive(encodeDraw({ t: "down", s: host, x: 0.1, y: 0.2 }));
    toBob.onclose?.(new Event("close"));
    expect(draw.board.visible(host, 0)).toEqual([]);
    toBob.receive(encodeDraw({ t: "down", s: host, x: 0.1, y: 0.2 }));
    expect(draw.board.visible(host, 0)).toEqual([]);
  });

  it("refuses a second channel from the same member", () => {
    const { draw } = setup();
    const extra = new Channel();
    draw.channel(bob, extra);
    expect(extra.closed).toBe(true);
  });

  it("sends nothing before joining", () => {
    const draw = new Draw(() => null, () => 0);
    const dc = new Channel();
    draw.channel(host, dc);
    draw.send({ t: "move", s: host, x: 0, y: 0 });
    expect(dc.sent).toEqual([]);
  });

  it("closes every channel on close", () => {
    const { draw, toHost, toBob } = setup();
    draw.send({ t: "down", s: host, x: 0, y: 0 });
    draw.close();
    expect(toHost.closed && toBob.closed).toBe(true);
    expect(draw.board.visible(host, 0)).toEqual([]);
  });
});
