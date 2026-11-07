import { useMemo, useState } from "preact/hooks";
import { isRoomId, type RoomId } from "../../shared/protocol.ts";
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
      <Notice title="This room is full." body="Streamroom keeps rooms to three people so everyone gets full quality. Ask someone inside to make space, or start a room of your own.">
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
      <Notice title="You left the room." body="Your invite stays valid for 24 hours after everyone leaves.">
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

function HostGate() {
  const [passphrase, setPassphrase] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const enter = async () => {
    setBusy(true); setError("");
    try {
      const login = await fetch("/api/host-session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ passphrase }) });
      if (!login.ok) { setError(await login.text()); return; }
      const room = await fetch("/api/rooms", { method: "POST" });
      if (!room.ok) throw new Error("Room creation failed");
      const body: unknown = await room.json();
      if (typeof body !== "object" || body === null || !("id" in body) || !isRoomId(body.id)) throw new Error("Invalid room");
      location.assign(`/r/${body.id}${location.search}`);
    } catch { setError("Couldn't start a room. Try again."); }
    finally { setBusy(false); }
  };
  return <main class="lobby" data-screen="host">
    <section class="lobby-intro"><p class="wordmark">Streamroom</p><h1 class="lobby-title">Settle in.</h1>
      <div class="seat-row" aria-hidden="true"><span class="seat-dot" /><span class="seat-dot" /><span class="seat-dot" /></div>
      <p class="lobby-lede">Enter the host passphrase to start a room. Joining friends? Open their invite link instead.</p></section>
    <form class="lobby-panel" onSubmit={(e) => { e.preventDefault(); void enter(); }}>
      <label class="field"><span class="field-label">Host passphrase</span><input class="input" type="password" autocomplete="current-password" required value={passphrase} onInput={(e) => setPassphrase(e.currentTarget.value)} /></label>
      {error && <p class="field-error" role="alert">{error}</p>}
      <p class="field-hint">This browser remembers you for 90 days.</p>
      <button class="btn btn-primary btn-lg" disabled={busy || !passphrase}>{busy ? "Opening room…" : "Start a room"}</button>
    </form>
  </main>;
}
