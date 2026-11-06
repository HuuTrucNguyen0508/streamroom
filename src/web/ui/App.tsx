import { useMemo, useState } from "preact/hooks";
import { isRoomId, newRoomId, type RoomId } from "../../shared/protocol.ts";
import { Call } from "../rtc/call.ts";
import { CallScreen } from "./CallScreen.tsx";
import { useCallView } from "./hooks.ts";
import { Lobby, type JoinChoice } from "./Lobby.tsx";

function roomFromLocation(): RoomId | null {
  if (location.pathname === "/") {
    // The server redirects "/" to a fresh room; this covers the Vite dev server.
    const id = newRoomId();
    history.replaceState(null, "", `/r/${id}${location.search}`);
    return id;
  }
  const m = /^\/r\/([^/]+)\/?$/.exec(location.pathname);
  return m && isRoomId(m[1]) ? m[1] : null;
}

export function App() {
  const roomId = useMemo(roomFromLocation, []);
  const relayOnly = useMemo(() => new URLSearchParams(location.search).get("relay") === "1", []);
  const [call, setCall] = useState<Call | null>(null);

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
      <Notice title="You left the room." body="The room stays open while anyone is still inside. Once the last person leaves, it's gone for good.">
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
