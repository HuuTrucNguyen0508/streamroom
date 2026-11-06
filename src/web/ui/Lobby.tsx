import { useEffect, useRef, useState } from "preact/hooks";
import type { RoomId, RoomPeek } from "../../shared/protocol.ts";
import { getMic, listMics } from "../rtc/media.ts";
import { Notice } from "./App.tsx";
import { MicIcon } from "./icons.tsx";

export interface JoinChoice {
  name: string;
  mic: MediaStream | null;
  deviceId: string | null;
}

type MicStatus = { kind: "asking" } | { kind: "ready"; stream: MediaStream } | { kind: "blocked"; message: string };

const NAME_KEY = "streamroom:name";

function savedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

export function Lobby({ roomId, relayOnly, onJoin }: { roomId: RoomId; relayOnly: boolean; onJoin: (c: JoinChoice) => void }) {
  const [peek, setPeek] = useState<RoomPeek | null>(null);
  const [name, setName] = useState(savedName);
  const [mic, setMic] = useState<MicStatus>({ kind: "asking" });
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [deviceId, setDeviceId] = useState<string | null>(null);
  const handedOff = useRef(false);
  const meterRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch(`/api/rooms/${roomId}`)
        .then((r) => r.json() as Promise<RoomPeek>)
        .then((p) => alive && setPeek(p))
        .catch(() => undefined);
    void load();
    const t = setInterval(load, 4000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [roomId]);

  // Open the chosen mic for the preview meter; it is handed to the call on join.
  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    setMic({ kind: "asking" });
    getMic(deviceId, false)
      .then(async (s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        setMic({ kind: "ready", stream: s });
        setDevices(await listMics());
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const denied = err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError");
        setMic({
          kind: "blocked",
          message: denied
            ? "Microphone access is blocked. Allow it from the address bar, or join without a mic."
            : !window.isSecureContext
              ? "Browsers only allow microphones on HTTPS links. Open the room over HTTPS, or join without a mic."
              : "No microphone found. Plug one in, or join without a mic.",
        });
      });
    return () => {
      cancelled = true;
      if (stream && !handedOff.current) stream.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId]);

  // Level meter for the preview.
  useEffect(() => {
    if (mic.kind !== "ready") return;
    const ctx = new AudioContext();
    const src = ctx.createMediaStreamSource(mic.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    let level = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) || 1e-8);
      const target = Math.min(1, Math.max(0, (db + 60) / 60));
      level = target > level ? target : level * 0.9 + target * 0.1;
      meterRef.current?.style.setProperty("--level", level.toFixed(3));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      void ctx.close();
    };
  }, [mic]);

  const full = peek !== null && peek.members >= peek.max;
  if (full) {
    return (
      <Notice title="This room is full." body="Streamroom keeps rooms to three people so everyone gets full quality. Ask someone inside to make space, or start a room of your own.">
        <button class="btn" onClick={() => location.reload()}>Try again</button>
        <a class="btn btn-primary" href="/">Start a new room</a>
      </Notice>
    );
  }

  const trimmed = name.trim();
  const join = (withMic: boolean) => {
    if (!trimmed) return;
    try {
      localStorage.setItem(NAME_KEY, trimmed);
    } catch {
      // Not remembered; fine.
    }
    const stream = withMic && mic.kind === "ready" ? mic.stream : null;
    if (stream) handedOff.current = true;
    else if (mic.kind === "ready") mic.stream.getTracks().forEach((t) => t.stop());
    onJoin({ name: trimmed, mic: stream, deviceId: stream?.getAudioTracks()[0]?.getSettings().deviceId ?? deviceId });
  };

  const inside = peek?.members ?? 0;
  const lede =
    peek === null
      ? "Checking who's here."
      : peek.locked
        ? "The host locked this room. You can join once they unlock it."
        : inside === 0
          ? "Nobody's here yet. Join first, then send the link to one or two friends."
          : inside === 1
            ? "One person is inside, with room for two more."
            : "Two people are inside. Yours is the last seat.";

  return (
    <main class="lobby" data-screen="lobby">
      <section class="lobby-intro">
        <p class="wordmark">Streamroom</p>
        <h1 class="lobby-title">Pull up a seat.</h1>
        <div class="seat-row" aria-label={`${inside} of 3 seats taken`}>
          {[0, 1, 2].map((i) => (
            <span key={i} class={`seat-dot${i < inside ? " is-taken" : ""}`} />
          ))}
        </div>
        <p class="lobby-lede">{lede}</p>
        {relayOnly && <p class="lobby-debug">Relay-only mode: all media goes through the TURN server.</p>}
      </section>

      <form
        class="lobby-panel"
        onSubmit={(e) => {
          e.preventDefault();
          join(true);
        }}
      >
        <label class="field">
          <span class="field-label">Your name</span>
          <input
            class="input"
            name="name"
            autocomplete="nickname"
            maxLength={32}
            required
            placeholder="What friends call you"
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
          />
        </label>

        <label class="field">
          <span class="field-label">Microphone</span>
          <select
            class="input"
            name="mic"
            disabled={devices.length === 0}
            value={deviceId ?? (mic.kind === "ready" ? mic.stream.getAudioTracks()[0]?.getSettings().deviceId : "") ?? ""}
            onChange={(e) => setDeviceId(e.currentTarget.value)}
          >
            {devices.length === 0 && <option value="">{mic.kind === "asking" ? "Waiting for permission" : "No microphone"}</option>}
            {devices.map((d, i) => (
              <option key={d.deviceId} value={d.deviceId}>
                {d.label || `Microphone ${i + 1}`}
              </option>
            ))}
          </select>
        </label>

        {mic.kind === "blocked" ? (
          <p class="field-error" role="alert">{mic.message}</p>
        ) : (
          <div class="meter" ref={meterRef} role="presentation">
            <MicIcon />
            <div class="meter-track">
              {Array.from({ length: 16 }, (_, i) => (
                <span key={i} style={{ "--i": i / 16 }} />
              ))}
            </div>
          </div>
        )}
        <p class="field-hint">{mic.kind === "ready" ? "Say something: the bar should move." : " "}</p>

        <div class="lobby-actions">
          <button class="btn btn-primary btn-lg" type="submit" disabled={!trimmed || mic.kind !== "ready" || peek?.locked === true}>
            Join room
          </button>
          <button class="btn btn-quiet" type="button" disabled={!trimmed || peek?.locked === true} onClick={() => join(false)}>
            Join without mic
          </button>
        </div>
      </form>
    </main>
  );
}
