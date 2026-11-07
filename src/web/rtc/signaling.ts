// WebSocket client with automatic reconnect. The owner re-sends `join` on every open.

import { PING_INTERVAL_MS, SILENT_DROP_MS, type ClientMessage, type ServerMessage } from "../../shared/protocol.ts";

export interface SignalingEvents {
  open(): void;
  message(msg: ServerMessage): void;
  /** Socket dropped; a reconnect is scheduled unless closed on purpose. */
  drop(): void;
}

export class Signaling {
  private ws: WebSocket | null = null;
  private attempt = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private lastHeard = 0;

  constructor(
    private readonly url: string,
    private readonly events: SignalingEvents,
  ) {}

  connect(): void {
    this.stopped = false;
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.attempt = 0;
      this.lastHeard = Date.now();
      this.pingTimer = setInterval(() => {
        // No pong for two pings: the socket is dead but the browser hasn't noticed. Reconnect now so
        // the resume token reclaims this seat instead of leaving a ghost behind.
        if (Date.now() - this.lastHeard > SILENT_DROP_MS) return this.dropped(ws);
        this.send({ t: "ping" });
      }, PING_INTERVAL_MS);
      this.events.open();
    };
    ws.onmessage = (ev) => {
      this.lastHeard = Date.now();
      if (typeof ev.data !== "string") return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      this.events.message(msg);
    };
    ws.onclose = () => this.dropped(ws);
  }

  private dropped(ws: WebSocket): void {
    if (this.ws !== ws) return;
    this.ws = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    ws.onclose = ws.onmessage = null;
    if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close();
    if (this.stopped) return;
    this.events.drop();
    const delay = Math.min(8000, 400 * 2 ** this.attempt++) * (0.75 + Math.random() * 0.5);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  get open(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  send(msg: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close(1000, "bye");
    this.ws = null;
  }
}
