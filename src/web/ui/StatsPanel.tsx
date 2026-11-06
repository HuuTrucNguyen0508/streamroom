import { useEffect, useState } from "preact/hooks";
import type { Call } from "../rtc/call.ts";
import type { PeerStats, StreamStats } from "../rtc/stats.ts";
import { CloseIcon } from "./icons.tsx";

const ROUTE: Record<string, string> = { host: "direct (LAN)", srflx: "direct (NAT)", prflx: "direct (NAT)", relay: "TURN relay" };

function fmt(n: number | null, digits = 0, unit = ""): string {
  return n === null ? "–" : `${n.toFixed(digits)}${unit}`;
}

function rate(kbps: number | null): string {
  if (kbps === null) return "–";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${kbps.toFixed(0)} kbps`;
}

export function StatsPanel({ call, onClose }: { call: Call; onClose: () => void }) {
  const [peers, setPeers] = useState<PeerStats[] | null>(null);
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const s = await call.stats().catch(() => null);
      if (alive && s) setPeers(s);
    };
    void tick();
    const t = setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [call]);

  return (
    <aside class="stats" aria-label="Connection stats" data-testid="stats">
      <div class="stats-head">
        <h2 class="stats-title">Connection stats</h2>
        <button class="btn btn-ghost btn-sm" onClick={onClose} aria-label="Close stats">
          <CloseIcon width={16} height={16} />
        </button>
      </div>
      {peers === null && <p class="stats-empty">Reading stats.</p>}
      {peers?.length === 0 && <p class="stats-empty">Stats appear once someone else joins.</p>}
      {peers?.map((p) => (
        <section class="stats-peer" key={p.peerId}>
          <h3 class="stats-peer-name">{p.name}</h3>
          <dl class="stats-route">
            <div>
              <dt>Route</dt>
              <dd data-testid="route">
                {p.localCandidate ? `${ROUTE[p.localCandidate] ?? p.localCandidate}` : p.connection}
                {p.localCandidate && <span class="stats-dim"> {p.localCandidate}/{p.remoteCandidate} {p.protocol}</span>}
              </dd>
            </div>
            <div>
              <dt>Round trip</dt>
              <dd>{fmt(p.rttMs, 0, " ms")}</dd>
            </div>
            <div>
              <dt>Upload estimate</dt>
              <dd>{rate(p.availableOutKbps)}</dd>
            </div>
          </dl>
          <table class="stats-table">
            <thead>
              <tr>
                <th scope="col">Stream</th>
                <th scope="col">Codec</th>
                <th scope="col">Video</th>
                <th scope="col">Bitrate</th>
                <th scope="col">Loss</th>
              </tr>
            </thead>
            <tbody>
              {p.streams.map((s, i) => (
                <StreamRow key={i} s={s} />
              ))}
            </tbody>
          </table>
        </section>
      ))}
    </aside>
  );
}

function StreamRow({ s }: { s: StreamStats }) {
  const video = s.kind === "video" ? `${s.width ?? "?"}×${s.height ?? "?"} @ ${fmt(s.fps)}` : "";
  return (
    <tr>
      <th scope="row">
        <span class={`dir dir-${s.direction}`}>{s.direction === "out" ? "Sending" : "Receiving"}</span> {s.label}
      </th>
      <td title={s.codecDetail ?? ""}>{s.codec ?? "–"}</td>
      <td>{video || <span class="stats-dim">audio</span>}</td>
      <td>
        {rate(s.bitrateKbps)}
        {s.maxBitrateKbps && <span class="stats-dim"> / {rate(s.maxBitrateKbps)}</span>}
        {s.qualityLimitation && s.qualityLimitation !== "none" && <span class="stats-warn"> {s.qualityLimitation}-limited</span>}
      </td>
      <td>{fmt(s.lossPercent, 1, "%")}</td>
    </tr>
  );
}
