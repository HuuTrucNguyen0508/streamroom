import { useEffect, useMemo, useState } from "preact/hooks";
import { DEFAULT_SEATS, MAX_SEATS, MIN_SEATS, isRoomId, parseSeats, roomIdFromInvite, type RoomId } from "../../shared/protocol.ts";
import { Call } from "../rtc/call.ts";
import { CallScreen } from "./CallScreen.tsx";
import { useCallView } from "./hooks.ts";
import { Lobby, type JoinChoice } from "./Lobby.tsx";

function roomFromLocation(): RoomId | null {
  const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
  return m && isRoomId(m[1]) ? m[1] : null;
}

export function App() {
  const roomId = useMemo(roomFromLocation, []);
  const relayOnly = useMemo(() => new URLSearchParams(location.search).get("relay") === "1", []);
  const [call, setCall] = useState<Call | null>(null);

  if (location.pathname === "/") return <HostGate />;

  if (!roomId) {
    return (
      <Notice title="This link doesn't lead to a room." body="Room links look like streamroom/r/ followed by 22 letters and numbers. Ask for the link again, or start your own room.">
        <a class="btn btn-primary" href="/">Start a new room</a>
      </Notice>
    );
  }

  if (!call) {
    const join = (choice: JoinChoice) => {
      const c = new Call(roomId, { relayOnly });
      (window as unknown as { __streamroom: Call }).__streamroom = c;
      c.join(choice.name, choice.mic, choice.deviceId);
      setCall(c);
    };
    return <Lobby roomId={roomId} relayOnly={relayOnly} onJoin={join} />;
  }
  return <InCall call={call} />;
}

function InCall({ call }: { call: Call }) {
  const view = useCallView(call);
  if (view.phase === "full") {
    return (
      <Notice title="This room is full." body="Every seat is taken. Ask someone inside to make space, or start a room of your own.">
        <button class="btn" onClick={() => location.reload()}>Try again</button>
        <a class="btn btn-primary" href="/">Start a new room</a>
      </Notice>
    );
  }
  if (view.phase === "locked") {
    return (
      <Notice title="The host locked this room." body="Nobody new can join until the host unlocks it. Ask them to unlock, then try again.">
        <button class="btn" onClick={() => location.reload()}>Try again</button>
        <a class="btn btn-primary" href="/">Start a new room</a>
      </Notice>
    );
  }
  if (view.phase === "left") {
    return (
      <Notice title="You left the room." body="Your invite stays valid for 1 hour after everyone leaves.">
        <button class="btn btn-primary" onClick={() => location.reload()}>Rejoin</button>
        <a class="btn" href="/">Start a new room</a>
      </Notice>
    );
  }
  return <CallScreen call={call} view={view} />;
}

export function Notice({ title, body, children }: { title: string; body: string; children?: preact.ComponentChildren }) {
  return (
    <main class="notice" data-screen="notice">
      <div class="notice-seats" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <h1 class="notice-title">{title}</h1>
      <p class="notice-body">{body}</p>
      <div class="notice-actions">{children}</div>
    </main>
  );
}

const SEATS_KEY = "streamroom.seats";

function savedSeats(): number {
  try {
    return parseSeats(localStorage.getItem(SEATS_KEY)) ?? DEFAULT_SEATS;
  } catch {
    return DEFAULT_SEATS;
  }
}

function HostGate() {
  const [passphrase, setPassphrase] = useState("");
  const [seats, setSeats] = useState(savedSeats);
  // null while checking: a remembered host skips the passphrase field.
  const [host, setHost] = useState<boolean | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/host-session")
      .then((r) => (r.ok ? (r.json() as Promise<{ host?: unknown }>) : { host: false }))
      .then((b) => setHost(b.host === true))
      .catch(() => setHost(false));
  }, []);

  const pick = (n: number) => {
    const next = Math.min(MAX_SEATS, Math.max(MIN_SEATS, n));
    setSeats(next);
    try {
      localStorage.setItem(SEATS_KEY, String(next));
    } catch {
      // Not remembered; fine.
    }
  };

  const enter = async () => {
    setBusy(true); setError("");
    try {
      if (!host) {
        const login = await fetch("/api/host-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
        if (!login.ok) { setError(await login.text()); return; }
      }
      const room = await fetch("/api/rooms", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ seats }) });
      if (room.status === 403) { setHost(false); setError("Enter the host passphrase again."); return; }
      if (!room.ok) throw new Error("Room creation failed");
      const body: unknown = await room.json();
      if (typeof body !== "object" || body === null || !("id" in body) || !isRoomId(body.id)) throw new Error("Invalid room");
      location.assign(`/r/${body.id}${location.search}`);
    } catch { setError("Couldn't start a room. Try again."); }
    finally { setBusy(false); }
  };

  const needsPassphrase = host === false;
  return <main class="lobby" data-screen="host">
    <section class="lobby-intro"><p class="wordmark">Streamroom</p><h1 class="lobby-title">Settle in.</h1>
      <div class="seat-row" aria-hidden="true">{Array.from({ length: seats }, (_, i) => <span key={i} class="seat-dot" />)}</div>
      <p class="lobby-lede">{needsPassphrase ? "Enter the host passphrase to start a room. Joining friends? Paste their room code below." : "Choose how many seats, then send the link to your friends."}</p></section>
    <div class="lobby-side">
    <form class="lobby-panel" onSubmit={(e) => { e.preventDefault(); void enter(); }}>
      {needsPassphrase && <label class="field"><span class="field-label">Host passphrase</span><input class="input" type="password" autocomplete="current-password" required value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} /></label>}
      <div class="field">
        <span class="field-label" id="seats-label">Seats</span>
        <div class="stepper" role="group" aria-labelledby="seats-label">
          <button type="button" class="btn stepper-btn" aria-label="Fewer seats" disabled={seats <= MIN_SEATS} onClick={() => pick(seats - 1)}>−</button>
          <output class="stepper-value" data-testid="seats" aria-live="polite">{seats}</output>
          <button type="button" class="btn stepper-btn" aria-label="More seats" disabled={seats >= MAX_SEATS} onClick={() => pick(seats + 1)}>+</button>
        </div>
      </div>
      {error && <p class="field-error" role="alert">{error}</p>}
      <p class="field-hint">
        {seats > 4 ? `Whoever shares their screen sends a copy to each viewer: ${seats - 1} copies here, so they need fast upload.` : "Up to 10 seats. "}
        {needsPassphrase && "This browser remembers you for 90 days."}
      </p>
      <button class="btn btn-primary btn-lg" disabled={busy || host === null || (needsPassphrase && !passphrase)}>{busy ? "Opening room…" : "Start a room"}</button>
    </form>
    <JoinByCode />
    </div>
  </main>;
}

/** Joining from somewhere that opens this page instead of the invite, like a desktop app's tab. */
function JoinByCode() {
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const join = () => {
    const room = roomIdFromInvite(text);
    if (!room) { setError("That isn't a room code. Paste the part after /r/ in the invite link, or the whole link."); return; }
    location.assign(`/r/${room}${location.search}`);
  };
  return <form class="lobby-panel lobby-join" onSubmit={(e) => { e.preventDefault(); join(); }}>
    <div class="field"><label class="field-label" for="join-room">Join a friend's room</label>
      <div class="join-row">
        <input class="input" id="join-room" name="room" autocomplete="off" spellcheck={false} placeholder="Room code or link" aria-describedby={error ? "join-error" : undefined} aria-invalid={error ? true : undefined}
          value={text} onInput={(e) => { setText(e.currentTarget.value); setError(""); }} />
        <button class="btn" disabled={text.trim() === ""}>Join room</button>
      </div>
    </div>
    {error && <p class="field-error" id="join-error" role="alert">{error}</p>}
  </form>;
}
