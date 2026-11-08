import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { MAX_CHAT_TEXT, type ChatEntry, type FileMeta, type MemberId } from "../../shared/protocol.ts";
import type { Call, CallView } from "../rtc/call.ts";
import { downloadKey, type IncomingView, type SendView } from "../rtc/transfers.ts";
import { initials } from "./hooks.ts";
import { AttachIcon, CloseIcon, DownloadIcon, SendIcon } from "./icons.tsx";

/** Consecutive messages from one person within this window share a header. */
const GROUP_MS = 5 * 60_000;

interface Group {
  from: MemberId;
  name: string;
  at: number;
  entries: ChatEntry[];
}

function groupsOf(chat: ChatEntry[]): Group[] {
  const groups: Group[] = [];
  for (const entry of chat) {
    const last = groups.at(-1);
    const lastAt = last?.entries.at(-1)?.at ?? 0;
    if (last && last.from === entry.from && entry.at - lastAt < GROUP_MS) last.entries.push(entry);
    else groups.push({ from: entry.from, name: entry.name, at: entry.at, entries: [entry] });
  }
  return groups;
}

const clock = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });

/** Screen readers read the whole live region; a long paste would drown out the call. */
const ANNOUNCE_CHARS = 140;

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function clip(text: string, max: number): string {
  const chars = Array.from(graphemes.segment(text), (s) => s.segment);
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : text;
}

export function ChatPanel({ call, view, onClose, focusInput, menuOpen, draft, setDraft, sending, send }: {
  call: Call; view: CallView; onClose: () => void; focusInput: boolean; menuOpen: boolean;
  draft: string; setDraft: (text: string) => void; sending: boolean; send: () => void;
}) {
  const [mobile, setMobile] = useState(() => matchMedia("(max-width: 900px)").matches);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const pinned = useRef(true);
  const groups = groupsOf(view.chat);
  const last = view.chat.at(-1);
  const announcement = last && !view.ownIds.has(last.from) ? `${last.name}: ${last.body.kind === "text" ? clip(last.body.text, ANNOUNCE_CHARS) : "shared a file"}` : "";

  useEffect(() => {
    if (matchMedia("(pointer: coarse)").matches) closeRef.current?.focus();
    else if (focusInput) inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const viewport = window.visualViewport;
    const update = () => {
      const panel = panelRef.current;
      if (!panel) return;
      const narrow = matchMedia("(max-width: 900px)").matches;
      setMobile(narrow);
      if (narrow && viewport) {
        if (Math.abs(viewport.scale - 1) > 0.01) return;
        panel.style.height = `${viewport.height}px`;
        panel.style.top = `${viewport.offsetTop}px`;
      } else { panel.style.height = ""; panel.style.top = ""; }
    };
    update();
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    window.addEventListener("resize", update);
    return () => {
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, []);

  // Follow new messages unless the reader has scrolled up to read older ones.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (list && pinned.current) list.scrollTop = list.scrollHeight;
  }, [view.chat.at(-1)?.seq, view.chat.at(-1)?.from]);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const observer = new ResizeObserver(() => { if (pinned.current) list.scrollTop = list.scrollHeight; });
    for (const child of list.children) observer.observe(child);
    return () => observer.disconnect();
  }, [view.chat]);

  // Effects run after paint, so a listener closed over props would miss a menu that just closed.
  const latest = useRef({ onClose, menuOpen });
  latest.current = { onClose, menuOpen };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.isComposing || e.keyCode === 229 || e.defaultPrevented || latest.current.menuOpen) return;
      e.preventDefault();
      latest.current.onClose();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.style.height = "auto";
    input.style.height = `${input.scrollHeight}px`;
  }, [draft]);

  return (
    <div ref={panelRef} class="chat" role={mobile ? "dialog" : undefined} aria-modal={mobile ? "true" : undefined} aria-label="Chat" data-testid="chat-panel">
      <p class="sr-only" role="status" aria-live="polite">{announcement && <span key={last?.seq}>{announcement}</span>}</p>
      <header class="chat-head">
        <h2 class="chat-title">Chat</h2>
        <button ref={closeRef} class="btn btn-ghost btn-sm" aria-label="Close chat" onClick={onClose}>
          <CloseIcon width={18} height={18} />
        </button>
      </header>

      <div
        class="chat-log"
        data-testid="chat-log"
        ref={listRef}

        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
        }}
      >
        <p class="chat-lifetime">Messages stay while anyone is in the room. Files go straight from the sender's browser and are never uploaded.</p>
        {groups.length === 0 && <p class="chat-empty">Nothing here yet. Say hello, or drop a file anywhere on the call to share it.</p>}
        {groups.map((g) => {
          const own = view.ownIds.has(g.from);
          return (
            <section key={g.entries[0]!.seq} class={`chat-group${own ? " is-own" : ""}`}>
              <div class="chat-face" aria-hidden="true">
                {initials(g.name)}
              </div>
              <div class="chat-runs">
                <p class="chat-who">
                  <span class="chat-name">{own ? "You" : g.name}</span> <time class="chat-time" dateTime={new Date(g.at).toISOString()}>{clock.format(g.at)}</time>
                </p>
                {g.entries.map((e) =>
                  e.body.kind === "text" ? (
                    <p key={e.seq} class="chat-text" data-testid="chat-message">
                      {e.body.text}
                    </p>
                  ) : (
                    <FileCard key={e.seq} call={call} view={view} entry={e} file={e.body.file} own={own} />
                  ),
                )}
              </div>
            </section>
          );
        })}
      </div>

      <form
        class="chat-compose"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          ref={fileRef}
          type="file"
          multiple
          hidden
          data-testid="chat-file-input"
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (files.length > 0) call.shareFiles(files);
          }}
        />
        <button type="button" class="btn btn-ghost chat-attach" aria-label="Share files" title="Share files" onClick={() => fileRef.current?.click()}>
          <AttachIcon />
        </button>
        <label class="chat-field">
          <span class="sr-only">Message</span>
          <textarea
            ref={inputRef}
            class="chat-input"
            rows={1}
            maxLength={MAX_CHAT_TEXT}
            placeholder="Message the room"
            data-testid="chat-input"
            value={draft}
            onInput={(e) => setDraft(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
                e.preventDefault();
                send();
              }
            }}
          />
        </label>
        <button class="btn btn-primary chat-send" aria-label="Send" disabled={sending || draft.trim() === ""} data-testid="chat-send">
          <SendIcon />
        </button>
      </form>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File cards

type CardState =
  | { kind: "offer"; sends: SendView[] }
  | { kind: "withdrawn" }
  | { kind: "available" }
  | { kind: "unavailable" }
  | ({ kind: "incoming" } & IncomingView);

function cardState(view: CallView, entry: ChatEntry, file: FileMeta, own: boolean): CardState {
  if (own) {
    if (entry.from !== view.selfId || !view.transfers.offered.has(file.id)) return { kind: "withdrawn" };
    return { kind: "offer", sends: view.transfers.outgoing.get(file.id) ?? [] };
  }
  const incoming = view.transfers.incoming.get(downloadKey(entry.from, file.id));
  if (incoming) return { kind: "incoming", ...incoming };
  return view.members.some((m) => m.id === entry.from) ? { kind: "available" } : { kind: "unavailable" };
}

function FileCard({ call, view, entry, file, own }: { call: Call; view: CallView; entry: ChatEntry; file: FileMeta; own: boolean }) {
  const state = cardState(view, entry, file, own);
  const sender = entry.name;
  const dot = file.name.lastIndexOf(".");
  const extension = dot > 0 ? file.name.slice(dot) : "";
  const stem = extension ? file.name.slice(0, dot) : file.name;
  const progress = state.kind === "incoming" && "received" in state ? state.received / file.size : state.kind === "incoming" && state.phase === "done" ? 1 : 0;
  const stateName = state.kind === "incoming" ? state.phase : state.kind;
  const present = view.members.some((m) => m.id === entry.from);

  let status: preact.ComponentChildren;
  let actions: preact.ComponentChildren = null;
  switch (state.kind) {
    case "offer": {
      const names = new Map(view.members.map((m) => [m.id, m.name]));
      status =
        state.sends.length === 0 ? (
          "Shared from this tab. Keep it open until your friends have it."
        ) : (
          <span class="file-sends">
            {state.sends.map((s) => (
              <span key={s.to}>
                {names.get(s.to) ?? "Someone"}{" "}
                {s.phase === "sending" ? <span class="file-num">{percent(s.sent / file.size)}</span> : s.phase === "queued" ? "is waiting" : s.phase === "sent" ? "is checking it" : "has it"}
              </span>
            ))}
          </span>
        );
      actions = (
        <button class="btn btn-ghost btn-sm" onClick={() => call.unshareFile(file.id)}>
          Stop sharing
        </button>
      );
      break;
    }
    case "withdrawn":
      status = "No longer shared. Share it again if someone still needs it.";
      break;
    case "available":
      status = `From ${sender}`;
      actions = (
        <button class="btn btn-sm file-get" onClick={() => call.download(entry)}>
          <DownloadIcon width={16} height={16} /> Download
        </button>
      );
      break;
    case "unavailable":
      status = `${sender} left, so this file can't be downloaded.`;
      break;
    case "incoming":
      switch (state.phase) {
        case "requesting":
          status = `Asking ${sender}`;
          break;
        case "receiving":
          status = (
            <>
              <span class="file-num">{percent(progress)}</span>
              {state.bytesPerSec > 0 && <span class="file-num file-rate">{bytes(state.bytesPerSec)}/s</span>}
            </>
          );
          break;
        case "paused":
          status = `Paused at ${percent(progress)}. It picks up again when ${sender} reconnects.`;
          break;
        case "done":
          status = "Ready to save";
          break;
        case "failed":
          status = failure(state.reason, sender, present);
          break;
      }
      actions =
        state.phase === "done" ? (
          <>
            <button class="btn btn-sm btn-primary" onClick={() => save(state.blob, file.name)}>
              Save
            </button>
            <button class="btn btn-ghost btn-sm" aria-label={`Dismiss ${file.name}`} title="Remove from memory" onClick={() => call.discardDownload(entry.from, file.id)}>
              <CloseIcon width={16} height={16} />
            </button>
          </>
        ) : state.phase === "failed" ? (
          present && (
            <button class="btn btn-sm" onClick={() => call.download(entry)}>
              Try again
            </button>
          )
        ) : (
          <>
            {state.phase === "paused" && (
              <button class="btn btn-sm" onClick={() => call.resumeDownload(entry.from, file.id)}>
                Resume
              </button>
            )}
            <button class="btn btn-ghost btn-sm" onClick={() => call.discardDownload(entry.from, file.id)}>
              Cancel
            </button>
          </>
        );
      break;
  }

  return (
    <article
      class={`file is-${stateName}`}
      style={{ "--progress": progress.toFixed(4) }}
      data-testid="file-card"
      data-state={stateName}
      data-name={file.name}
      data-received={state.kind === "incoming" && "received" in state ? state.received : undefined}
    >
      <span class="sr-only" role="status">{state.kind === "incoming" && state.phase === "done" ? `${file.name} is ready to save` : state.kind === "incoming" && state.phase === "failed" ? `${file.name} failed` : ""}</span>
      <div class="file-main">
        <p class="file-name" title={file.name}>
          <span class="file-stem">{stem}</span><span class="file-extension">{extension}</span>
        </p>
        <p class="file-meta">
          <span class="file-num">{bytes(file.size)}</span>
          <span class="file-status" role={state.kind === "incoming" && state.phase === "failed" ? "alert" : undefined}>
            {status}
          </span>
        </p>
      </div>
      {actions && <div class="file-actions">{actions}</div>}
    </article>
  );
}

function failure(reason: string, sender: string, present: boolean): string {
  switch (reason) {
    case "gone":
      return present ? `${sender} stopped sharing this file.` : `${sender} left before the file finished.`;
    case "mismatch":
      return "The file arrived damaged and was thrown away.";
    case "memory":
      return "This browser ran out of memory for the file.";
    default:
      return "The transfer broke off.";
  }
}

/** Always a download with a generic type: a blob URL opened in a tab would run on this site's origin. */
function save(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function percent(fraction: number): string {
  return `${Math.floor(Math.min(1, Math.max(0, fraction)) * 100)}%`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${Math.round(n)} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}
