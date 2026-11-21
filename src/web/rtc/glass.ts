// Desktop glass: sends the marks on our own screen share to Streamroom Glass, a small app on this
// computer (glass/ in this repo) that draws them on the real desktop. It only connects after the
// person turns it on, because Chrome and Edge ask permission before a page may reach this computer.
//
// Forwarding happens inside Draw's callback, so it keeps up while this tab is hidden: data channel and
// WebSocket events aren't throttled the way timers and animation frames are.

import type { MemberId } from "../../shared/protocol.ts";
import { colorFor, type Draw, type DrawEvent } from "./draw.ts";

export const GLASS_PORT = 47291;
export const GLASS_VERSION = 1;
/** The close code Streamroom Glass sends a tab whose place another tab took. */
const REPLACED = 4001;
const STORAGE_KEY = "streamroom:glass";
/** Pointer moves are dropped behind this much unsent data; past the hard limit the link restarts. */
const MOVE_BUFFER_LIMIT = 256 * 1024;
const HARD_BUFFER_LIMIT = 1024 * 1024;
const RETRY_MIN_MS = 1000;
const RETRY_MAX_MS = 10_000;

export type GlassState =
  | { k: "off" }
  /** On, but we aren't sharing. */
  | { k: "idle" }
  | { k: "connecting" }
  | { k: "missing" }
  | { k: "outdated" }
  | { k: "replaced" }
  /** Sharing a window or tab, or a browser that doesn't say which (`surface` is ""). */
  | { k: "not-monitor"; surface: string }
  | { k: "drawing"; output: string }
  | { k: "unplaced"; why: "ambiguous" | "no-match"; share: string; outputs: string[] };

type Socket = Pick<WebSocket, "readyState" | "bufferedAmount" | "send" | "close"> & {
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onclose: ((ev: CloseEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
};

interface Share {
  gen: number;
  me: MemberId;
  w: number;
  h: number;
}

export interface GlassDeps {
  draw: Draw;
  /** Display names, ours included. */
  names(): ReadonlyMap<MemberId, string>;
  connect?(url: string): Socket;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
  setTimeout?(fn: () => void, ms: number): unknown;
  clearTimeout?(id: unknown): void;
}

export class Glass {
  private enabled: boolean;
  private socket: Socket | null = null;
  private ready = false;
  private retryTimer: unknown = null;
  private retryMs = RETRY_MIN_MS;
  /** What we share and who we are, as last seen. */
  private key = "";
  private share: Share | null = null;
  private gen = 0;
  private surface = "";
  private sharing = false;
  private current: GlassState;
  /** Another tab took over, or the app is another version: stay away until the person turns this off and on. */
  private suppressed: "replaced" | "outdated" | null = null;
  private readonly listeners = new Set<(state: GlassState) => void>();

  constructor(private readonly deps: GlassDeps) {
    this.enabled = readEnabled(this.storage());
    this.current = this.enabled ? { k: "idle" } : { k: "off" };
    deps.draw.onEvent = (event) => this.forward(event);
  }

  get state(): GlassState {
    return this.current;
  }

  get on(): boolean {
    return this.enabled;
  }

  subscribe(fn: (state: GlassState) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    this.suppressed = null;
    try {
      this.storage()?.setItem(STORAGE_KEY, on ? "1" : "0");
    } catch {
      // Storage is optional.
    }
    this.disconnect();
    this.retryMs = RETRY_MIN_MS;
    this.reconcile();
  }

  /** Try now instead of waiting out the backoff, e.g. when the person comes back to this tab. */
  retry(): void {
    // Only while waiting out the backoff: not in the middle of a connection attempt.
    if (this.current.k !== "missing" || this.retryTimer === null) return;
    this.retryMs = RETRY_MIN_MS;
    this.disconnect();
    this.reconcile();
  }

  /** Call whenever our screen share or member id may have changed. */
  update(screen: MediaStream | null, selfId: MemberId | null): void {
    const track = screen?.getVideoTracks()[0];
    const settings = (track?.getSettings() ?? {}) as MediaTrackSettings & { displaySurface?: string };
    const surface = settings.displaySurface ?? "";
    const key = screen && selfId ? `${screen.id}|${selfId}|${surface}` : "";
    if (key === this.key) return;
    this.key = key;
    if (this.share) this.send({ t: "stop", gen: this.share.gen });
    this.share = null;
    this.sharing = key !== "";
    this.surface = surface;
    const w = Math.round(settings.width ?? 0);
    const h = Math.round(settings.height ?? 0);
    if (this.sharing && surface === "monitor" && w > 0 && h > 0) {
      this.share = { gen: ++this.gen, me: selfId!, w, h };
      this.send({ t: "share", ...this.share });
      // Until Streamroom Glass says where this share goes.
      if (this.ready) this.set({ k: "connecting" });
    }
    this.reconcile();
  }

  private forward(event: DrawEvent): void {
    const share = this.share;
    if (!share || !this.ready) return;
    switch (event.k) {
      case "mark":
        if (event.msg.s !== share.me) return;
        this.send(
          {
            t: "mark",
            gen: share.gen,
            a: event.author,
            name: this.deps.names().get(event.author) ?? "",
            color: colorFor(event.author),
            m: "x" in event.msg ? { t: event.msg.t, x: event.msg.x, y: event.msg.y } : { t: event.msg.t },
          },
          event.msg.t === "move",
        );
        return;
      case "forget":
        this.send({ t: "forget", a: event.member });
        return;
      case "clear":
        // Draw closes when we leave the call; the share stopping follows through update().
        this.send({ t: "stop", gen: share.gen });
        return;
    }
  }

  /** Connects or disconnects to match what's wanted, and works out the state to show. */
  private reconcile(): void {
    const wanted = this.enabled && this.share !== null;
    if (!wanted) {
      this.disconnect();
      if (!this.enabled) return this.set({ k: "off" });
      if (this.sharing) return this.set({ k: "not-monitor", surface: this.surface });
      return this.set({ k: "idle" });
    }
    if (this.suppressed) return this.set({ k: this.suppressed });
    if (!this.socket && this.retryTimer === null) this.open();
  }

  private open(): void {
    const connect = this.deps.connect ?? ((url: string) => new WebSocket(url) as Socket);
    let socket: Socket;
    try {
      socket = connect(`ws://127.0.0.1:${GLASS_PORT}/`);
    } catch {
      return this.lost(null);
    }
    this.socket = socket;
    this.ready = false;
    if (this.current.k !== "missing") this.set({ k: "connecting" });
    socket.onmessage = (ev) => {
      if (this.socket !== socket || typeof ev.data !== "string") return;
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(ev.data) as Record<string, unknown>;
      } catch {
        return;
      }
      if (msg.t === "hello") {
        if (msg.app !== "streamroom-glass" || msg.v !== GLASS_VERSION) {
          this.disconnect();
          this.suppressed = "outdated";
          return this.set({ k: "outdated" });
        }
        this.ready = true;
        this.retryMs = RETRY_MIN_MS;
        if (this.share) this.send({ t: "share", ...this.share });
        this.set({ k: "connecting" });
      } else if (msg.t === "status" && this.share && msg.gen === this.share.gen) {
        if (typeof msg.output === "string") this.set({ k: "drawing", output: msg.output });
        else
          this.set({
            k: "unplaced",
            why: msg.why === "ambiguous" ? "ambiguous" : "no-match",
            share: `${this.share.w}×${this.share.h}`,
            outputs: Array.isArray(msg.outputs) ? msg.outputs.filter((o): o is string => typeof o === "string") : [],
          });
      }
    };
    socket.onclose = (ev) => {
      if (this.socket === socket) this.lost(ev.code);
    };
    socket.onerror = () => {
      // onclose follows.
    };
  }

  private lost(code: number | null): void {
    this.socket = null;
    this.ready = false;
    if (code === REPLACED) {
      this.suppressed = "replaced";
      return this.set({ k: "replaced" });
    }
    if (!this.enabled || !this.share) return this.reconcile();
    this.set({ k: "missing" });
    const wait = this.retryMs;
    this.retryMs = Math.min(RETRY_MAX_MS, this.retryMs * 2);
    this.retryTimer = (this.deps.setTimeout ?? setTimeout)(() => {
      this.retryTimer = null;
      this.reconcile();
    }, wait);
  }

  private disconnect(): void {
    if (this.retryTimer !== null) (this.deps.clearTimeout ?? clearTimeout)(this.retryTimer as number);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    this.ready = false;
    if (socket) {
      socket.onmessage = socket.onclose = socket.onerror = socket.onopen = null;
      try {
        socket.close();
      } catch {
        // Already closing.
      }
    }
  }

  private send(msg: object, droppable = false): void {
    const socket = this.socket;
    if (!socket || !this.ready || socket.readyState !== 1) return;
    if (socket.bufferedAmount > HARD_BUFFER_LIMIT) {
      // The app has stopped reading. Start over; it clears what it drew when we go.
      this.disconnect();
      return this.lost(null);
    }
    if (droppable && socket.bufferedAmount > MOVE_BUFFER_LIMIT) return;
    socket.send(JSON.stringify(msg));
  }

  private set(state: GlassState): void {
    this.current = state;
    for (const fn of this.listeners) fn(state);
  }

  private storage(): Pick<Storage, "getItem" | "setItem"> | null {
    if (this.deps.storage !== undefined) return this.deps.storage;
    try {
      return localStorage;
    } catch {
      return null;
    }
  }
}

function readEnabled(storage: Pick<Storage, "getItem"> | null): boolean {
  try {
    return storage?.getItem(STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

/** The command that starts Streamroom Glass for this Streamroom. */
export function glassCommand(origin: string, output?: string): string {
  return `streamroom-glass --origin ${origin}${output ? ` --output ${output}` : ""}`;
}
