import { useEffect, useRef, useState } from "preact/hooks";
import { PRESET_IDS, type MemberId, type PresetId } from "../../shared/protocol.ts";
import type { Call, CallView } from "../rtc/call.ts";
import { canPickSpeaker, listMics, listSpeakers, replayerName } from "../rtc/media.ts";
import { PRESETS } from "../rtc/presets.ts";
import { ChatPanel } from "./ChatPanel.tsx";
import { initials, useLevel } from "./hooks.ts";
import {
  ChatIcon,
  ChevronIcon,
  ExpandIcon,
  GaugeIcon,
  LeaveIcon,
  LinkIcon,
  LockIcon,
  MicIcon,
  MicOffIcon,
  ScreenIcon,
  StopScreenIcon,
  UnlockIcon,
} from "./icons.tsx";
import { StatsPanel } from "./StatsPanel.tsx";

interface Share {
  id: MemberId | "self";
  name: string;
  stream: MediaStream | null;
  preset: PresetId;
}

function sharesOf(view: CallView): Share[] {
  const remote = view.members.flatMap((m) => (m.state.share ? [{ id: m.id, name: m.name, stream: m.screen, preset: m.state.share.preset }] : []));
  const own = view.localScreen && view.self.share ? [{ id: "self" as const, name: "You", stream: view.localScreen, preset: view.self.share.preset }] : [];
  return [...remote, ...own];
}

export function CallScreen({ call, view }: { call: Call; view: CallView }) {
  const [stageId, setStageId] = useState<Share["id"] | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [menu, setMenu] = useState<"share" | "mic" | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const focusChatInput = useRef(true);
  const callRef = useRef<HTMLDivElement>(null);
  const chatToggle = useRef<HTMLButtonElement>(null);
  const closeChat = () => { setChatOpen(false); requestAnimationFrame(() => chatToggle.current?.focus()); };
  const [chatOpen, setChatOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const sendInFlight = useRef(false);
  const sendChat = async () => {
    if (sendInFlight.current) return;
    const text = draft;
    sendInFlight.current = true;
    setSending(true);
    setDraft("");
    let sent = false;
    try {
      sent = await call.sendChat(text);
    } catch (err) {
      console.warn(err);
    }
    sendInFlight.current = false;
    setSending(false);
    if (!sent) setDraft((typed) => (typed ? `${text}\n${typed}` : text));
  };
  const [dropping, setDropping] = useState(false);
  const shares = sharesOf(view);
  const stage = shares.find((s) => s.id === stageId) ?? shares[0] ?? null;
  const seatsTaken = view.members.length + 1;
  const seatsTotal = useRoomSeats(call.roomId);

  // Newest remote share takes the stage when it appears.
  const shareKey = shares.map((s) => s.id).join(",");
  const prevKey = useRef(shareKey);
  useEffect(() => {
    const before = new Set(prevKey.current.split(","));
    const added = shares.find((s) => !before.has(s.id) && s.id !== "self");
    if (added) setStageId(added.id);
    prevKey.current = shareKey;
  }, [shareKey]);

  useEffect(() => call.setChatOpen(chatOpen), [call, chatOpen]);
  useEffect(() => {
    const media = matchMedia("(max-width: 900px)");
    const update = () => {
      for (const child of callRef.current?.children ?? []) {
        if (child instanceof HTMLElement && !child.classList.contains("chat")) child.inert = chatOpen && media.matches;
      }
    };
    update();
    media.addEventListener("change", update);
    const observer = new MutationObserver(update);
    if (callRef.current) observer.observe(callRef.current, { childList: true });
    return () => { media.removeEventListener("change", update); observer.disconnect(); };
  }, [chatOpen]);

  const menuOpen = useRef(false);
  menuOpen.current = menu !== null;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && menuOpen.current && !e.isComposing && e.keyCode !== 229 && !e.defaultPrevented) {
        e.preventDefault();
        setMenu(null);
        return;
      }
      const t = e.target;
      const typing = t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable);
      if (typing || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "m" && view.self.hasMic) call.setMuted(!view.self.muted);
      if (e.key === "Escape") setMenu(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [call, view.self.hasMic, view.self.muted]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2200);
    return () => clearTimeout(t);
  }, [toast]);

  const run = (p: Promise<void>, failure: string) =>
    p.catch((err: unknown) => {
      if (err instanceof DOMException && err.name === "NotAllowedError") return; // picker cancelled
      console.warn(err);
      setError(failure);
    });

  const copyInvite = async () => {
    const url = `${location.origin}/r/${view.roomId}`;
    try {
      await navigator.clipboard.writeText(url);
      setToast("Invite link copied");
    } catch {
      window.prompt("Copy this invite link", url);
    }
  };

  return (
    <div
      ref={callRef}
      class={`call${stage ? " has-stage" : ""}${showStats ? " has-stats" : ""}${chatOpen ? " has-chat" : ""}`}
      data-screen="call"
      data-phase={view.phase}
      onDragOver={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        setDropping(true);
      }}
      onDragLeave={(e) => {
        if (e.relatedTarget === null || !e.currentTarget.contains(e.relatedTarget as Node)) setDropping(false);
      }}
      onDrop={(e) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        setDropping(false);
        const files = [...e.dataTransfer.files];
        if (files.length === 0) return;
        call.shareFiles(files);
        focusChatInput.current = false;
        setChatOpen(true);
      }}
    >
      <header class="rail">
        <div class="rail-left">
          <span class="wordmark">Streamroom</span>
          <span class="rail-seats" data-testid="seat-count">
            {seatsTaken} of {seatsTotal} seats
          </span>
          {view.locked && (
            <span class="badge" data-testid="locked-badge">
              <LockIcon width={14} height={14} /> Locked
            </span>
          )}
          {view.relayOnly && <span class="badge badge-debug">Relay only</span>}
        </div>
        <div class="rail-right">
          {toast && (
            <span class="toast" role="status">
              {toast}
            </span>
          )}
          <button class="btn btn-ghost" onClick={() => void copyInvite()}>
            <LinkIcon /> <span class="label">Copy invite link</span>
          </button>
          {view.isHost && (
            <button class="btn btn-ghost" aria-pressed={view.locked} data-testid="lock" onClick={() => call.setLocked(!view.locked)}>
              {view.locked ? <UnlockIcon /> : <LockIcon />} <span class="label">{view.locked ? "Unlock room" : "Lock room"}</span>
            </button>
          )}
          <button class="btn btn-ghost" aria-pressed={showStats} data-testid="stats-toggle" onClick={() => setShowStats(!showStats)}>
            <GaugeIcon /> <span class="label">Stats</span>
          </button>
        </div>
      </header>

      {view.phase !== "in-call" && (
        <div class="banner" role="status">
          {view.phase === "reconnecting" ? "Connection lost. Reconnecting to the room." : "Connecting to the room."}
        </div>
      )}
      {(error || view.notice) && (
        <div class="banner banner-error" role="alert">
          {error || view.notice}
          <button class="btn btn-ghost btn-sm" onClick={() => { setError(null); call.clearNotice(); }}>
            Dismiss
          </button>
        </div>
      )}

      <main class="floor">
        {stage ? (
          <Stage share={stage} shares={shares} onPick={setStageId} />
        ) : (
          <div class="empty-stage">
            <p class="empty-title">{view.members.length === 0 ? "You're the first one here." : "Nobody is sharing."}</p>
            <p class="empty-body">
              {view.members.length === 0
                ? "Copy the invite link and send it to your friends. The invite stays open for 1 hour after everyone leaves."
                : "Share a screen and it lands here for everyone."}
            </p>
          </div>
        )}

        <ul class="seats" aria-label="People in the room">
          <Seat
            name={view.name}
            you
            host={view.isHost}
            muted={view.self.muted || !view.self.hasMic}
            sharing={view.self.share !== null}
            level={() => call.levelOf("self")}
          />
          {view.members.map((m) => (
            <Seat
              key={m.id}
              name={m.name}
              host={m.id === view.hostId}
              muted={m.state.muted || !m.state.hasMic}
              sharing={m.state.share !== null}
              connection={m.connection}
              level={() => call.levelOf(m.id)}
              volume={m.volume}
              onVolume={(v) => call.setVolume(m.id, v)}
            />
          ))}
        </ul>
      </main>

      {view.localScreen && <ShareAudio call={call} view={view} onError={(message) => setError(message)} />}
      <footer class="dock">
        <div class="dock-group">
          {view.self.hasMic ? (
            <button
              class={`btn btn-dock${view.self.muted ? " is-off" : ""}`}
              aria-pressed={view.self.muted}
              data-testid="mute"
              onClick={() => call.setMuted(!view.self.muted)}
              title="Mute or unmute (M)"
            >
              {view.self.muted ? <MicOffIcon /> : <MicIcon />}
              <span class="label">{view.self.muted ? "Unmute" : "Mute"}</span>
            </button>
          ) : (
            <button class="btn btn-dock is-off" onClick={() => void run(call.enableMic(), "Couldn't open a microphone. Check the browser's permission for this site.")}>
              <MicOffIcon />
              <span class="label">Turn on mic</span>
            </button>
          )}
          {view.self.hasMic && (
            <MicMenu
              open={menu === "mic"}
              onToggle={() => setMenu(menu === "mic" ? null : "mic")}
              current={view.micDeviceId}
              onPick={(id) => {
                setMenu(null);
                void run(call.switchMic(id), "Couldn't switch to that microphone.");
              }}
            />
          )}
        </div>

        <div class="dock-group">
          {view.self.share ? (
            <button class="btn btn-dock is-live" data-testid="stop-share" onClick={() => call.stopShare()}>
              <StopScreenIcon />
              <span class="label">Stop sharing</span>
            </button>
          ) : (
            <div class="menu-anchor">
              <button class="btn btn-dock" aria-expanded={menu === "share"} data-testid="share" onClick={() => setMenu(menu === "share" ? null : "share")}>
                <ScreenIcon />
                <span class="label">Share screen</span>
              </button>
              {menu === "share" && (
                <div class="menu" role="menu" aria-label="Share quality">
                  {PRESET_IDS.map((id) => (
                    <button
                      key={id}
                      role="menuitem"
                      class="menu-item"
                      data-testid={`preset-${id}`}
                      onClick={() => {
                        setMenu(null);
                        void run(call.startShare(id), "Screen sharing didn't start. Your browser may not support it here.");
                      }}
                    >
                      <span class="menu-item-title">{PRESETS[id].label}</span>
                      <span class="menu-item-hint">
                        {PRESETS[id].hint}, {PRESETS[id].maxBitrate / 1_000_000} Mbps per viewer
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        <div class="dock-group">
          <button
            ref={chatToggle}
            class="btn btn-dock chat-toggle"
            aria-pressed={chatOpen}
            aria-label={view.unread > 0 ? `Chat, ${view.unread} unread` : "Chat"}
            data-testid="chat-toggle"
            onClick={() => { focusChatInput.current = true; if (chatOpen) closeChat(); else setChatOpen(true); }}
          >
            <ChatIcon />
            <span class="label">Chat</span>
            {view.unread > 0 && !chatOpen && (
              <span class="chat-badge" aria-hidden="true" data-testid="chat-badge">
                {view.unread > 9 ? "9+" : view.unread}
              </span>
            )}
          </button>
          <button class="btn btn-dock btn-leave" data-testid="leave" onClick={() => call.leave()}>
            <LeaveIcon />
            <span class="label">Leave</span>
          </button>
        </div>
      </footer>

      {chatOpen && <ChatPanel call={call} view={view} onClose={closeChat} focusInput={focusChatInput.current} menuOpen={menu !== null} draft={draft} setDraft={setDraft} sending={sending} send={sendChat} />}
      {dropping && (
        <div class="drop-veil" aria-hidden="true">
          <p>Drop to share with the room</p>
        </div>
      )}
      {showStats && <StatsPanel call={call} onClose={() => setShowStats(false)} />}
    </div>
  );
}

function Stage({ share, shares, onPick }: { share: Share; shares: Share[]; onPick: (id: Share["id"]) => void }) {
  const frameRef = useRef<HTMLDivElement>(null);
  return (
    <section class="stage" aria-label={`${share.name === "You" ? "Your" : `${share.name}'s`} screen`}>
      <div class="stage-frame" ref={frameRef} data-testid="stage">
        {share.stream ? <Video stream={share.stream} /> : <p class="stage-wait">Connecting to {share.name}'s screen.</p>}
        <div class="stage-caption">
          <span>{share.id === "self" ? "You are sharing" : `${share.name} is sharing`}</span>
          <span class="stage-preset">{PRESETS[share.preset].label}</span>
          <button class="btn btn-ghost btn-sm" onClick={() => void frameRef.current?.requestFullscreen?.()} aria-label="Fullscreen">
            <ExpandIcon width={16} height={16} />
          </button>
        </div>
      </div>
      {shares.length > 1 && (
        <div class="switcher" role="tablist" aria-label="Screens being shared">
          {shares.map((s) => (
            <button key={s.id} role="tab" aria-selected={s.id === share.id} class="switcher-tab" onClick={() => onPick(s.id)}>
              {s.id === "self" ? "Your screen" : `${s.name}'s screen`}
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

function Video({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    void el.play().catch(() => undefined);
  }, [stream]);
  return <video ref={ref} class="stage-video" autoplay playsInline muted />;
}

interface SeatProps {
  name: string;
  you?: boolean;
  host: boolean;
  muted: boolean;
  sharing: boolean;
  connection?: RTCPeerConnectionState | "new";
  level: () => number;
  volume?: number;
  onVolume?: (v: number) => void;
}

function Seat({ name, you, host, muted, sharing, connection, level, volume, onVolume }: SeatProps) {
  const ref = useLevel<HTMLLIElement>(level);
  const pending = connection !== undefined && connection !== "connected";
  return (
    <li class={`seat${muted ? " is-muted" : ""}${pending ? " is-pending" : ""}`} ref={ref} data-testid="seat">
      <div class="seat-face" aria-hidden="true">
        {initials(name)}
        {muted && (
          <span class="seat-muted">
            <MicOffIcon width={14} height={14} />
          </span>
        )}
      </div>
      <div class="seat-info">
        <div class="seat-name">
          {name}
          {you && <span class="seat-you"> (you)</span>}
        </div>
        <div class="seat-meta">
          {[host && "Host", sharing && "Sharing", muted && "Muted", pending && (connection === "failed" ? "Reconnecting" : "Connecting")]
            .filter(Boolean)
            .join(", ") || "\u00a0"}
        </div>
        {onVolume && volume !== undefined && (
          <label class="seat-volume">
            <span class="sr-only">Volume for {name}</span>
            <input type="range" min={0} max={100} step={1} value={Math.round(volume * 100)} onInput={(e) => onVolume(Number(e.currentTarget.value) / 100)} />
          </label>
        )}
      </div>
    </li>
  );
}

function MicMenu({ open, onToggle, current, onPick }: { open: boolean; onToggle: () => void; current: string | null; onPick: (id: string) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (open) void listMics().then(setDevices);
  }, [open]);
  return (
    <div class="menu-anchor">
      <button class="btn btn-dock btn-icon" aria-expanded={open} aria-label="Choose microphone" onClick={onToggle}>
        <ChevronIcon />
      </button>
      {open && (
        <div class="menu" role="menu" aria-label="Microphone">
          {devices.length === 0 && <p class="menu-empty">No other microphones found.</p>}
          {devices.map((d, i) => (
            <button key={d.deviceId} role="menuitemradio" aria-checked={d.deviceId === current} class="menu-item" onClick={() => onPick(d.deviceId)}>
              <span class="menu-item-title">{d.label || `Microphone ${i + 1}`}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ShareAudio({ call, view, onError }: { call: Call; view: CallView; onError: (message: string) => void }) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<{ defaultLabel: string; devices: MediaDeviceInfo[] }>({ defaultLabel: "", devices: [] });
  const [busy, setBusy] = useState(false);
  const pickSpeaker = canPickSpeaker();
  useEffect(() => {
    const refresh = () => {
      void listMics().then(setDevices).catch(() => undefined);
      if (pickSpeaker) void listSpeakers().then(setSpeakers).catch(() => undefined);
    };
    refresh(); navigator.mediaDevices.addEventListener("devicechange", refresh);
    return () => navigator.mediaDevices.removeEventListener("devicechange", refresh);
  }, [pickSpeaker]);
  const platform = navigator.userAgent;
  const tip = /Windows/.test(platform) ? 'On Windows, share "Entire screen" and tick "Also share system audio".'
    : /Linux/.test(platform) ? 'On Linux, choose a game monitor or virtual input in Audio source.'
    : /Mac/.test(platform) ? 'On macOS with Chrome 141 or later, tick system audio.' : 'Choose an audio input in Audio source.';
  // System audio captures everything except this browser's own sound. A call played through an
  // enhancer like FxSound comes back out of FxSound's program instead, so it gets captured too.
  const sharingSystemAudio = view.audioSource === "browser" && !view.noDisplayAudio;
  const playingOn = view.speakerId ? speakers.devices.find((d) => d.deviceId === view.speakerId)?.label ?? "" : speakers.defaultLabel;
  const replayer = sharingSystemAudio ? replayerName(playingOn) : null;
  // Without restrictOwnAudio the capture records the default output, call included. Playing the
  // call on another device keeps it out.
  const callCaptured = sharingSystemAudio && view.callInDisplayAudio && !replayer && playingOn === speakers.defaultLabel;
  return <section class="share-audio" aria-label="Screen share audio">
    {view.noDisplayAudio && view.audioSource === "browser" && <p class="share-audio-warning" role="status" data-testid="no-sound">Your screen has no audio. {tip} You can also share a browser tab and tick "Also share tab audio".</p>}
    {replayer && <p class="share-audio-warning" role="status" data-testid="replayer-echo">The call plays through {replayer}, so your friends hear themselves in your shared sound. In "Call plays on", pick your headset or speakers.</p>}
    {callCaptured && <p class="share-audio-warning" role="status" data-testid="call-captured">Your browser can't leave the call out of your shared sound, so your friends hear themselves.{pickSpeaker ? ' In "Call plays on", pick headphones or speakers that aren\'t your system default, or share a browser tab instead.' : " Share a browser tab instead, or use Chrome or Edge on Windows or macOS."}</p>}
    <div class="share-audio-fields">
      {pickSpeaker && sharingSystemAudio && (
        <label class="share-audio-field"><span class="field-label">Call plays on</span>
          <select class="input" aria-label="Call plays on" data-testid="speaker" value={view.speakerId} disabled={busy} onChange={(e) => {
            setBusy(true); void call.setSpeaker(e.currentTarget.value).catch(() => onError("Couldn't play the call on that device. Choose another one.")).finally(() => setBusy(false));
          }}>
            <option value="">{speakers.defaultLabel ? `System default: ${speakers.defaultLabel}` : "System default"}</option>
            {speakers.devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${i + 1}`}</option>)}
          </select>
        </label>
      )}
      <label class="share-audio-field"><span class="field-label">Audio source</span>
        <select class="input" aria-label="Audio source" value={view.audioSource} disabled={busy} onChange={(e) => {
          setBusy(true); void call.switchShareAudio(e.currentTarget.value).catch(() => onError("Couldn't open that audio source. Check its permission or choose another input.")).finally(() => setBusy(false));
        }}>
          <option value="browser">Browser audio{view.noDisplayAudio ? " (not captured)" : ""}</option>
          {devices.map((d, i) => <option key={d.deviceId} value={d.deviceId}>{d.label || `Audio input ${i + 1}`}</option>)}
          <option value="none">None</option>
        </select>
      </label>
    </div>
  </section>;
}

/** The room's seat count, chosen by the host at creation. */
function useRoomSeats(roomId: string): number {
  const [seats, setSeats] = useState(3);
  useEffect(() => {
    let alive = true;
    fetch(`/api/rooms/${roomId}`)
      .then((r) => (r.ok ? (r.json() as Promise<{ max?: unknown }>) : null))
      .then((p) => { if (alive && typeof p?.max === "number") setSeats(p.max); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [roomId]);
  return seats;
}
