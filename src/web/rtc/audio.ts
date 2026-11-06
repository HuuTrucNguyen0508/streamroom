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
    let el = this.players.get(key);
    if (!el) {
      el = new Audio();
      el.autoplay = true;
      this.players.set(key, el);
    }
    if (el.srcObject !== stream) el.srcObject = stream;
    el.volume = volume;
    void el.play().catch(() => undefined);
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
