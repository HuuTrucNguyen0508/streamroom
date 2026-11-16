// Remote audio playback (one <audio> element per remote stream, so the browser's echo canceller
// sees it) and level meters for speaking indicators.

export interface Meter {
  /** 0..1, roughly perceptual (-60 dBFS .. 0 dBFS). */
  level(): number;
  dispose(): void;
}

export class AudioEngine {
  readonly ctx = new AudioContext({ latencyHint: "interactive" });
  private readonly players = new Map<string, HTMLAudioElement>();
  /** Output device for every player; "" is the system default. */
  private sinkId = "";
  /** Players already playing; the rest are routed when they start (see play). */
  private readonly routable = new WeakSet<HTMLAudioElement>();

  resume(): void {
    if (this.ctx.state === "suspended") void this.ctx.resume().catch(() => undefined);
  }

  meter(stream: MediaStream): Meter {
    const source = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let smoothed = 0;
    return {
      level() {
        analyser.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const v of buf) sum += v * v;
        const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
        const target = Math.min(1, Math.max(0, (db + 60) / 60));
        // Fast attack, slow release reads as "speaking" without flicker.
        smoothed = target > smoothed ? target : smoothed * 0.88 + target * 0.12;
        return smoothed;
      },
      dispose() {
        source.disconnect();
        analyser.disconnect();
      },
    };
  }

  /** Start (or keep) playing a remote stream. */
  play(key: string, stream: MediaStream, volume: number): void {
    const existing = this.players.get(key);
    if (existing) {
      existing.volume = volume;
      return;
    }
    const el = new Audio();
    el.autoplay = true;
    el.srcObject = stream;
    el.volume = volume;
    this.players.set(key, el);
    // Route the player only once it plays. A sink set on an element before its stream loads is
    // reported as applied while the call plays on the system default (FxSound), and setting the
    // same id again does nothing, so a friend who rejoined was heard through the default output.
    void el.play().catch(() => undefined).then(async () => {
      this.routable.add(el);
      if (this.players.get(key) === el && this.sinkId) await applySink(el, this.sinkId);
    }).catch(() => undefined); // Gone device: system default.
  }

  /** Play the call on this output device ("" = system default). Rejects if the device can't be used. */
  async setSink(sinkId: string): Promise<void> {
    const previous = this.sinkId;
    this.sinkId = sinkId; // A player that starts meanwhile goes here too.
    const players = [...this.players.values()].filter((el) => this.routable.has(el));
    try {
      await Promise.all(players.map((el) => applySink(el, sinkId)));
    } catch (err) {
      this.sinkId = previous;
      throw err;
    }
  }

  setVolume(keyPrefix: string, volume: number): void {
    for (const [key, el] of this.players) if (key.startsWith(keyPrefix)) el.volume = volume;
  }

  stop(keyPrefix: string): void {
    for (const [key, el] of this.players) {
      if (!key.startsWith(keyPrefix)) continue;
      el.pause();
      el.srcObject = null;
      this.players.delete(key);
    }
  }

  close(): void {
    this.stop("");
    void this.ctx.close().catch(() => undefined);
  }
}

async function applySink(el: HTMLAudioElement, sinkId: string): Promise<void> {
  const media = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (typeof media.setSinkId === "function") await media.setSinkId(sinkId);
}
