// Turns getStats() reports into the numbers people care about: codec, resolution, fps, bitrate,
// RTT, loss, and how the connection is routed (host / srflx / relay).

export type MediaLabel = "voice" | "screen" | "screen audio";

export interface StreamStats {
  direction: "out" | "in";
  kind: "audio" | "video";
  label: MediaLabel;
  codec: string | null;
  /** Channels and clock from the codec entry, e.g. "opus/48000/2". */
  codecDetail: string | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  bitrateKbps: number | null;
  maxBitrateKbps: number | null;
  packetsLost: number;
  lossPercent: number | null;
  framesDecoded: number | null;
  framesEncoded: number | null;
  bytes: number;
  qualityLimitation: string | null;
}

export interface PeerStats {
  peerId: string;
  name: string;
  connection: RTCPeerConnectionState;
  localCandidate: string | null;
  remoteCandidate: string | null;
  protocol: string | null;
  rttMs: number | null;
  availableOutKbps: number | null;
  iceRestarts: number;
  streams: StreamStats[];
}

interface Sample {
  bytes: number;
  timestamp: number;
}

type Report = Record<string, unknown> & { id: string; type: string; timestamp: number };

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export class StatsSampler {
  private prev = new Map<string, Sample>();

  async sample(
    pc: RTCPeerConnection,
    meta: { peerId: string; name: string; iceRestarts: number },
    labelFor: (direction: "in" | "out", kind: "audio" | "video", mid: string | null, trackId: string | null) => MediaLabel,
    maxBitrateFor: (mid: string | null) => number | null,
  ): Promise<PeerStats> {
    const report = await pc.getStats();
    const byId = new Map<string, Report>();
    report.forEach((r: Report) => byId.set(r.id, r));

    let pair: Report | undefined;
    for (const r of byId.values()) {
      if (r.type === "transport" && typeof r.selectedCandidatePairId === "string") pair = byId.get(r.selectedCandidatePairId);
    }
    if (!pair) {
      for (const r of byId.values()) if (r.type === "candidate-pair" && r.nominated === true && r.state === "succeeded") pair = r;
    }
    const local = pair ? byId.get(String(pair.localCandidateId)) : undefined;
    const remote = pair ? byId.get(String(pair.remoteCandidateId)) : undefined;

    const streams: StreamStats[] = [];
    const seen = new Set<string>();
    for (const r of byId.values()) {
      if (r.type !== "outbound-rtp" && r.type !== "inbound-rtp") continue;
      const kind = r.kind === "video" ? "video" : "audio";
      const direction = r.type === "outbound-rtp" ? "out" : "in";
      const bytes = num(direction === "out" ? r.bytesSent : r.bytesReceived) ?? 0;
      const key = `${meta.peerId}:${r.id}`;
      seen.add(key);
      const before = this.prev.get(key);
      this.prev.set(key, { bytes, timestamp: r.timestamp });
      const dt = before ? (r.timestamp - before.timestamp) / 1000 : 0;
      const bitrateKbps = before && dt > 0 ? Math.max(0, ((bytes - before.bytes) * 8) / dt / 1000) : null;

      const codec = typeof r.codecId === "string" ? byId.get(r.codecId) : undefined;
      const mime = str(codec?.mimeType);
      const packetsLost = num(r.packetsLost) ?? 0;
      const received = num(r.packetsReceived);
      let lossPercent: number | null = null;
      let rttLoss = packetsLost;
      if (direction === "out") {
        const remoteIn = typeof r.remoteId === "string" ? byId.get(r.remoteId) : undefined;
        rttLoss = num(remoteIn?.packetsLost) ?? 0;
        const sent = num(r.packetsSent);
        if (sent) lossPercent = (100 * rttLoss) / (sent + rttLoss);
      } else if (received !== null) {
        lossPercent = received + packetsLost > 0 ? (100 * packetsLost) / (received + packetsLost) : 0;
      }
      const mid = str(r.mid);
      streams.push({
        direction,
        kind,
        label: labelFor(direction, kind, mid, str(r.trackIdentifier)),
        codec: mime ? mime.replace(/^(audio|video)\//, "") : null,
        codecDetail: codec ? `${mime ?? "?"}/${num(codec.clockRate) ?? "?"}${num(codec.channels) ? `/${codec.channels}` : ""}${str(codec.sdpFmtpLine) ? ` ${codec.sdpFmtpLine}` : ""}` : null,
        width: num(r.frameWidth),
        height: num(r.frameHeight),
        fps: num(r.framesPerSecond),
        bitrateKbps,
        maxBitrateKbps: direction === "out" ? (maxBitrateFor(mid) ?? 0) / 1000 || null : null,
        packetsLost: rttLoss,
        lossPercent,
        framesDecoded: num(r.framesDecoded),
        framesEncoded: num(r.framesEncoded),
        bytes,
        qualityLimitation: str(r.qualityLimitationReason),
      });
    }
    for (const key of this.prev.keys()) if (key.startsWith(`${meta.peerId}:`) && !seen.has(key)) this.prev.delete(key);

    const order = { voice: 0, screen: 1, "screen audio": 2 } as const;
    streams.sort((a, b) => (a.direction === b.direction ? order[a.label] - order[b.label] : a.direction === "out" ? -1 : 1));

    const rtt = num(pair?.currentRoundTripTime);
    const available = num(pair?.availableOutgoingBitrate);
    return {
      peerId: meta.peerId,
      name: meta.name,
      connection: pc.connectionState,
      localCandidate: str(local?.candidateType),
      remoteCandidate: str(remote?.candidateType),
      protocol: str(local?.protocol),
      rttMs: rtt === null ? null : rtt * 1000,
      availableOutKbps: available === null ? null : available / 1000,
      iceRestarts: meta.iceRestarts,
      streams,
    };
  }
}
