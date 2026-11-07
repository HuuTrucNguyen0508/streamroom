import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PING_INTERVAL_MS, SILENT_DROP_MS } from "../src/shared/protocol.ts";
import { Signaling } from "../src/web/rtc/signaling.ts";

// Just enough of the browser WebSocket for Signaling: a socket that opens, then never answers.
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static all: FakeSocket[] = [];
  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) { FakeSocket.all.push(this); }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = FakeSocket.CLOSED; } // A dead network: no close event ever arrives.
  open() { this.readyState = FakeSocket.OPEN; this.onopen?.(); }
  receive(msg: unknown) { this.onmessage?.({ data: JSON.stringify(msg) }); }
}

describe("client signaling", () => {
  beforeEach(() => { vi.useFakeTimers(); FakeSocket.all = []; vi.stubGlobal("WebSocket", FakeSocket); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("reconnects when the server goes silent, even though the browser never reports a close", () => {
    const events = { open: vi.fn(), message: vi.fn(), drop: vi.fn() };
    const sig = new Signaling("wss://example/ws", events);
    sig.connect();
    FakeSocket.all[0]!.open();
    expect(events.open).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SILENT_DROP_MS + PING_INTERVAL_MS);
    expect(events.drop).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000); // Reconnect backoff.
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.all[1]!.open();
    expect(events.open).toHaveBeenCalledTimes(2); // The owner re-sends join with its resume token.
    sig.close();
  });

  it("keeps a connection whose server answers pings", () => {
    const events = { open: vi.fn(), message: vi.fn(), drop: vi.fn() };
    const sig = new Signaling("wss://example/ws", events);
    sig.connect();
    const socket = FakeSocket.all[0]!;
    socket.open();
    for (let i = 0; i < 10; i++) {
      vi.advanceTimersByTime(PING_INTERVAL_MS);
      socket.receive({ t: "pong" });
    }
    expect(events.drop).not.toHaveBeenCalled();
    expect(socket.sent.filter((s) => s.includes('"ping"')).length).toBeGreaterThanOrEqual(9);
    sig.close();
  });
});
