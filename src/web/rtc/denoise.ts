// The voice we send: the raw microphone, optionally through GTCRN, a small speech-enhancement
// model that keeps keyboard and mouse clicks out of the call. The browser's own noise suppression
// only handles steady noise. Against RNNoise on clicks over real speech, GTCRN removed 54 dB of
// clicks to RNNoise's 16, kept the voice closer to clean, and costs about 3% of one core and 32 ms.

import type { GtcrnWorkletNode } from "@sapphi-red/web-noise-suppressor";
import workletUrl from "@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url";
import wasmUrl from "@sapphi-red/web-noise-suppressor/gtcrn.wasm?url";

// Loaded on first use: the library subclasses AudioWorkletNode as it loads.
const library = () => import("@sapphi-red/web-noise-suppressor");

let wasm: Promise<ArrayBuffer> | null = null;
const modelBinary = (): Promise<ArrayBuffer> => {
  wasm ??= library().then(({ loadGtcrn }) => loadGtcrn({ url: wasmUrl })).catch((err: unknown) => {
    wasm = null; // Let a later attempt fetch it again.
    throw err;
  });
  return wasm;
};

/**
 * Owns the raw microphone stream. `stream` is what goes to friends; it exists from construction, so
 * callers can send it right away while the filter loads.
 */
export class Voice {
  readonly stream: MediaStream;
  private readonly graph: { ctx: AudioContext; source: MediaStreamAudioSourceNode; out: MediaStreamAudioDestinationNode } | null;
  private filter: GtcrnWorkletNode | null = null;
  private loading: Promise<GtcrnWorkletNode> | null = null;
  private wanted = false;
  private disposed = false;

  constructor(private readonly raw: MediaStream) {
    let graph: Voice["graph"] = null;
    try {
      // GTCRN runs at 16 or 48 kHz; 48 kHz keeps the voice full band.
      const ctx = new AudioContext({ sampleRate: 48_000, latencyHint: "interactive" });
      try {
        const source = ctx.createMediaStreamSource(raw);
        const out = ctx.createMediaStreamDestination();
        out.channelCount = 1;
        source.connect(out);
        graph = { ctx, source, out };
        if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);
      } catch (err) {
        // Firefox refuses a microphone whose rate differs from the context's.
        void ctx.close().catch(() => undefined);
        throw err;
      }
    } catch (err) {
      console.warn("Noise filter unavailable; sending the microphone as is.", err);
    }
    this.graph = graph;
    this.stream = graph ? new MediaStream([...graph.out.stream.getAudioTracks()]) : raw;
    for (const t of this.stream.getAudioTracks()) t.contentHint = "speech";
  }

  /** False when this browser can't run the filter; the toggle has no effect then. */
  get canFilter(): boolean {
    return this.graph !== null;
  }

  /** Resolves once the voice is routed as asked; rejects if the filter can't load (the voice stays unfiltered). */
  async setFiltered(on: boolean): Promise<void> {
    this.wanted = on;
    const graph = this.graph;
    if (!graph) return;
    if (on && !this.filter) {
      this.loading ??= (async () => {
        const [wasmBinary, { GtcrnWorkletNode }] = await Promise.all([modelBinary(), library(), graph.ctx.audioWorklet.addModule(workletUrl)]);
        return new GtcrnWorkletNode(graph.ctx, { maxChannels: 1, wasmBinary });
      })();
      try {
        const node = await this.loading;
        if (this.disposed) { node.destroy(); return; }
        this.filter = node;
      } finally {
        this.loading = null;
      }
    }
    // A newer call may have changed its mind while the filter loaded.
    this.route(this.wanted && this.filter !== null);
  }

  private route(filtered: boolean): void {
    const graph = this.graph;
    if (!graph || this.disposed) return;
    graph.source.disconnect();
    this.filter?.disconnect();
    if (filtered && this.filter) {
      graph.source.connect(this.filter);
      this.filter.connect(graph.out);
    } else {
      graph.source.connect(graph.out);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const t of this.stream.getTracks()) t.stop();
    for (const t of this.raw.getTracks()) t.stop();
    this.filter?.destroy();
    this.filter = null;
    if (this.graph) void this.graph.ctx.close().catch(() => undefined);
  }
}
