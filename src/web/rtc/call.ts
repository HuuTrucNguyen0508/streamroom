// The call: signaling + one PeerLink per remote member + local media. No DOM rendering here;
// the UI subscribes to `view` snapshots and calls the action methods.

import type { MemberId, MemberInfo, MemberState, PresetId, RoomId, ServerMessage } from "../../shared/protocol.ts";
import { AudioEngine, type Meter } from "./audio.ts";
import { getMic, getScreen, micConstraints } from "./media.ts";
import { PeerLink } from "./peer.ts";
import { AUDIO_MAX_BITRATE, PRESETS } from "./presets.ts";
import { Signaling } from "./signaling.ts";
import { StatsSampler, type MediaLabel, type PeerStats } from "./stats.ts";

export type Phase = "idle" | "connecting" | "in-call" | "reconnecting" | "full" | "locked" | "left";

export interface RemoteView {
  id: MemberId;
  name: string;
  state: MemberState;
  connection: RTCPeerConnectionState | "new";
  volume: number;
  screen: MediaStream | null;
}

export interface CallView {
  phase: Phase;
  roomId: RoomId;
  selfId: MemberId | null;
  name: string;
  isHost: boolean;
  hostId: MemberId | null;
  locked: boolean;
  self: MemberState;
  micDeviceId: string | null;
  localScreen: MediaStream | null;
  audioSource: string;
  noDisplayAudio: boolean;
  members: RemoteView[];
  relayOnly: boolean;
  notice: string | null;
}

interface Remote {
  info: MemberInfo;
  link: PeerLink | null;
  streams: Map<string, MediaStream>;
  volume: number;
  meter: { streamId: string; meter: Meter } | null;
}

interface LinkSenders {
  mic: RTCRtpTransceiver | null;
  screen: RTCRtpTransceiver[];
  screenAudio: RTCRtpTransceiver | null;
}

/** How long the polite side waits for the other side's first offer before offering itself. */
const FIRST_OFFER_WAIT_MS = 1500;

export interface CallOptions {
  relayOnly: boolean;
}

export class Call {
  private readonly sig: Signaling;
  private readonly audio = new AudioEngine();
  private readonly sampler = new StatsSampler();
  private readonly remotes = new Map<MemberId, Remote>();
  private readonly senders = new Map<PeerLink, LinkSenders>();
  private readonly listeners = new Set<(v: CallView) => void>();
  private iceServers: RTCIceServer[] = [];
  private resume: string | null;
  private mic: MediaStream | null = null;
  private micMeter: Meter | null = null;
  private screen: MediaStream | null = null;
  private browserAudio: MediaStreamTrack | null = null;
  private audioSource = savedAudioSource();
  private noDisplayAudio = false;
  private audioRevision = 0;
  private state: MemberState = { muted: false, hasMic: false, music: false, share: null };
  private micDeviceId: string | null = null;
  private phase: Phase = "idle";
  private selfId: MemberId | null = null;
  private hostId: MemberId | null = null;
  private locked = false;
  private name = "";
  private notice: string | null = null;
  view: CallView;

  constructor(
    readonly roomId: RoomId,
    private readonly options: CallOptions,
  ) {
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    this.sig = new Signaling(`${scheme}//${location.host}/ws?room=${roomId}`, {
      open: () => void this.onOpen(),
      message: (msg) => this.onMessage(msg),
      drop: () => {
        if (this.phase === "in-call") this.setPhase("reconnecting");
      },
    });
    this.resume = readResume(roomId);
    this.view = this.buildView();
  }

  // ---------------------------------------------------------------------------
  // Subscription

  subscribe(fn: (v: CallView) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.view = this.buildView();
    for (const fn of this.listeners) fn(this.view);
  }

  private setPhase(phase: Phase): void {
    this.phase = phase;
    this.emit();
  }

  private buildView(): CallView {
    return {
      phase: this.phase,
      roomId: this.roomId,
      selfId: this.selfId,
      name: this.name,
      isHost: this.selfId !== null && this.selfId === this.hostId,
      hostId: this.hostId,
      locked: this.locked,
      self: this.state,
      micDeviceId: this.micDeviceId,
      localScreen: this.screen,
      audioSource: this.audioSource,
      noDisplayAudio: this.noDisplayAudio,
      relayOnly: this.options.relayOnly,
      notice: this.notice,
      members: [...this.remotes.values()].map((r) => ({
        id: r.info.id,
        name: r.info.name,
        state: r.info.state,
        connection: r.link?.state ?? "new",
        volume: r.volume,
        screen: r.info.state.share ? (r.streams.get(r.info.state.share.streamId) ?? null) : null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Lifecycle

  /** Must be called from a user gesture (the Join button) so audio playback is allowed. */
  join(name: string, mic: MediaStream | null, micDeviceId: string | null): void {
    this.name = name;
    this.audio.resume();
    this.setMic(mic);
    this.micDeviceId = micDeviceId;
    this.state = { ...this.state, hasMic: mic !== null };
    this.setPhase("connecting");
    this.sig.connect();
  }

  leave(): void {
    this.sig.close();
    for (const id of [...this.remotes.keys()]) this.dropRemote(id);
    this.stopShare();
    this.setMic(null);
    this.audio.close();
    this.setPhase("left");
  }

  private async onOpen(): Promise<void> {
    try {
      const res = await fetch(`/api/ice?room=${this.roomId}`, { cache: "no-store" });
      const body = (await res.json()) as { iceServers: RTCIceServer[] };
      this.iceServers = body.iceServers;
    } catch (err) {
      console.warn("could not load ICE servers; using host candidates only", err);
    }
    this.sig.send({ t: "join", room: this.roomId, name: this.name, resume: this.resume, state: this.state });
  }

  private onMessage(msg: ServerMessage): void {
    switch (msg.t) {
      case "joined": {
        this.selfId = msg.you;
        this.resume = msg.resume;
        writeResume(this.roomId, msg.resume);
        this.hostId = msg.room.hostId;
        this.locked = msg.room.locked;
        // Fresh session: rebuild every connection so both ends agree on state.
        for (const id of [...this.remotes.keys()]) this.dropRemote(id);
        for (const m of msg.room.members) if (m.id !== msg.you) this.addRemote(m);
        this.phase = "in-call";
        this.emit();
        return;
      }
      case "member-joined":
        this.dropRemote(msg.member.id);
        this.addRemote(msg.member);
        this.emit();
        return;
      case "member-left":
        this.dropRemote(msg.id);
        this.emit();
        return;
      case "member-state": {
        const r = this.remotes.get(msg.id);
        if (r) r.info = { ...r.info, state: msg.state };
        this.emit();
        return;
      }
      case "room":
        this.hostId = msg.hostId;
        this.locked = msg.locked;
        this.emit();
        return;
      case "signal":
        this.remotes.get(msg.from)?.link?.receive(msg.data);
        return;
      case "error":
        if (msg.code === "full" || msg.code === "locked") {
          this.sig.close();
          this.setPhase(msg.code);
        } else {
          console.warn("server error", msg.code, msg.message);
        }
        return;
      case "pong":
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Peers

  private addRemote(info: MemberInfo): void {
    const remote: Remote = { info, link: null, streams: new Map(), volume: 1, meter: null };
    this.remotes.set(info.id, remote);
    const selfId = this.selfId!;
    const link = new PeerLink(
      info.id,
      selfId > info.id,
      { iceServers: this.iceServers, iceTransportPolicy: this.options.relayOnly ? "relay" : "all", bundlePolicy: "max-bundle" },
      {
        signal: (data) => this.sig.send({ t: "signal", to: info.id, data }),
        track: (track, streams) => this.onRemoteTrack(remote, track, streams),
        change: () => this.emit(),
      },
    );
    remote.link = link;
    const senders: LinkSenders = { mic: null, screen: [], screenAudio: null };
    this.senders.set(link, senders);
    const attach = () => {
      if (this.senders.get(link) !== senders) return; // dropped meanwhile
      if (this.mic && !senders.mic) senders.mic = this.sendMic(link, this.mic);
      if (this.screen && this.state.share && senders.screen.length === 0) {
        senders.screen = this.sendScreen(link, this.screen, this.state.share.preset);
        senders.screenAudio = senders.screen.find((t) => t.sender.track?.kind === "audio") ?? null;
      }
    };
    // Only the impolite side offers first; see PeerLink.firstRemoteDescription.
    if (link.polite) void link.firstRemoteDescription(FIRST_OFFER_WAIT_MS).then(attach);
    else attach();
  }

  private dropRemote(id: MemberId): void {
    const remote = this.remotes.get(id);
    if (!remote) return;
    if (remote.link) {
      this.senders.delete(remote.link);
      remote.link.close();
    }
    remote.meter?.meter.dispose();
    this.audio.stop(`${id}/`);
    this.remotes.delete(id);
  }

  private onRemoteTrack(remote: Remote, track: MediaStreamTrack, streams: readonly MediaStream[]): void {
    const stream = streams[0] ?? new MediaStream([track]);
    remote.streams.set(stream.id, stream);
    if (track.kind === "audio") this.audio.play(`${remote.info.id}/${stream.id}`, stream, remote.volume);
    const cleanup = () => {
      if (stream.getTracks().some((t) => t.readyState === "live")) return this.emit();
      remote.streams.delete(stream.id);
      this.audio.stop(`${remote.info.id}/${stream.id}`);
      if (remote.meter?.streamId === stream.id) {
        remote.meter.meter.dispose();
        remote.meter = null;
      }
      this.emit();
    };
    track.addEventListener("ended", cleanup);
    stream.addEventListener("removetrack", cleanup);
    this.emit();
  }

  private sendMic(link: PeerLink, mic: MediaStream): RTCRtpTransceiver | null {
    const track = mic.getAudioTracks()[0];
    return track ? link.addTrack(track, mic, { maxBitrate: AUDIO_MAX_BITRATE }) : null;
  }

  private sendScreen(link: PeerLink, screen: MediaStream, presetId: PresetId): RTCRtpTransceiver[] {
    const preset = PRESETS[presetId];
    return screen.getTracks().map((track) =>
      track.kind === "video"
        ? link.addTrack(track, screen, { maxBitrate: preset.maxBitrate, maxFramerate: preset.frameRate, degradation: preset.degradation })
        : link.addTrack(track, screen, { maxBitrate: AUDIO_MAX_BITRATE }),
    );
  }

  // ---------------------------------------------------------------------------
  // Local media actions

  private setMic(stream: MediaStream | null): void {
    if (this.mic && this.mic !== stream) this.stopTracks(this.mic);
    this.micMeter?.dispose();
    this.micMeter = null;
    this.mic = stream;
    if (stream) {
      for (const t of stream.getAudioTracks()) t.enabled = !this.state.muted;
      if (stream.getAudioTracks().length > 0) this.micMeter = this.audio.meter(stream);
    }
  }

  private broadcastState(): void {
    this.sig.send({ t: "state", state: this.state });
    this.emit();
  }

  setMuted(muted: boolean): void {
    this.state = { ...this.state, muted };
    for (const t of this.mic?.getAudioTracks() ?? []) t.enabled = !muted;
    this.broadcastState();
  }

  /** Swap the microphone (device or processing mode) without renegotiating. */
  private async replaceMic(deviceId: string | null, music: boolean): Promise<void> {
    const next = await getMic(deviceId, music);
    const track = next.getAudioTracks()[0] ?? null;
    if (!this.mic) {
      // Joined without a mic: start sending one now (this renegotiates).
      this.setMic(next);
      for (const [link, s] of this.senders) s.mic = this.sendMic(link, next);
    } else {
      if (track) track.enabled = !this.state.muted;
      await Promise.all([...this.senders.values()].map((s) => s.mic?.sender.replaceTrack(track)));
      this.setMic(next);
    }
    this.micDeviceId = track?.getSettings().deviceId ?? deviceId;
    this.state = { ...this.state, hasMic: true, music };
    this.broadcastState();
  }

  switchMic(deviceId: string): Promise<void> {
    return this.replaceMic(deviceId, this.state.music);
  }

  enableMic(): Promise<void> {
    return this.replaceMic(this.micDeviceId, this.state.music);
  }

  setMusicMode(music: boolean): Promise<void> {
    return this.replaceMic(this.micDeviceId, music);
  }

  clearNotice(): void { this.notice = null; this.emit(); }

  async startShare(presetId: PresetId): Promise<void> {
    const stream = await getScreen(PRESETS[presetId]);
    if (this.screen) this.stopShare();
    this.screen = stream;
    stream.getVideoTracks()[0]?.addEventListener("ended", () => {
      // The browser's own "Stop sharing" button.
      if (this.screen === stream) this.stopShare();
    });
    this.browserAudio = stream.getAudioTracks()[0] ?? null;
    this.noDisplayAudio = !this.browserAudio;
    try { await this.switchShareAudio(this.audioSource); }
    catch { this.audioSource = "browser"; this.notice = "Couldn't open the saved audio source. Choose another source."; }
    if (this.screen !== stream) return;
    for (const [link, s] of this.senders) {
      s.screen = this.sendScreen(link, stream, presetId);
      s.screenAudio = s.screen.find((t) => t.sender.track?.kind === "audio") ?? null;
    }
    this.state = { ...this.state, share: { streamId: stream.id, preset: presetId, hasAudio: stream.getAudioTracks().length > 0 } };
    this.broadcastState();
  }

  async switchShareAudio(source: string): Promise<void> {
    const stream = this.screen;
    if (!stream) return;
    const revision = ++this.audioRevision;
    let track: MediaStreamTrack | null = null;
    if (source === "browser") track = this.browserAudio;
    else if (source !== "none") {
      const capture = await navigator.mediaDevices.getUserMedia({ audio: micConstraints(source, true), video: false });
      track = capture.getAudioTracks()[0] ?? null;
      if (track) track.contentHint = "music";
    }
    if (this.screen !== stream || revision !== this.audioRevision) { if (track !== this.browserAudio) track?.stop(); return; }
    const before = stream.getAudioTracks();
    try {
      for (const [link, s] of this.senders) {
        if (s.screenAudio) await s.screenAudio.sender.replaceTrack(track);
        else if (track && this.state.share) {
          s.screenAudio = link.addTrack(track, stream, { maxBitrate: AUDIO_MAX_BITRATE });
          s.screen.push(s.screenAudio);
        }
      }
    } catch (error) { if (track !== this.browserAudio) track?.stop(); throw error; }
    if (this.screen !== stream || revision !== this.audioRevision) { if (track !== this.browserAudio) track?.stop(); return; }
    for (const old of before) { stream.removeTrack(old); if (old !== this.browserAudio && old !== track) old.stop(); }
    if (track) stream.addTrack(track);
    this.audioSource = source;
    this.notice = null;
    try { localStorage.setItem("streamroom:share-audio", source); } catch { /* Storage is optional. */ }
    if (this.state.share) this.state = { ...this.state, share: { ...this.state.share, hasAudio: track !== null } };
    this.broadcastState();
  }

  stopShare(): void {
    this.audioRevision++;
    this.browserAudio?.stop();
    this.browserAudio = null;
    this.noDisplayAudio = false;
    for (const [link, s] of this.senders) {
      for (const t of s.screen) link.removeTrack(t);
      s.screen = [];
      s.screenAudio = null;
    }
    this.stopTracks(this.screen);
    this.screen = null;
    this.state = { ...this.state, share: null };
    this.broadcastState();
  }

  setLocked(locked: boolean): void {
    this.sig.send({ t: "lock", locked });
  }

  setVolume(id: MemberId, volume: number): void {
    const r = this.remotes.get(id);
    if (!r) return;
    r.volume = volume;
    this.audio.setVolume(`${id}/`, volume);
    this.emit();
  }

  /** Speaking level 0..1 for a member, or for yourself with "self". Cheap enough to call per frame. */
  levelOf(id: MemberId | "self"): number {
    if (id === "self") return this.state.muted ? 0 : (this.micMeter?.level() ?? 0);
    const r = this.remotes.get(id);
    if (!r || r.info.state.muted) return 0;
    const shareId = r.info.state.share?.streamId;
    if (!r.meter) {
      const voice = [...r.streams.values()].find((s) => s.id !== shareId && s.getAudioTracks().length > 0);
      if (!voice) return 0;
      r.meter = { streamId: voice.id, meter: this.audio.meter(voice) };
    }
    return r.meter.meter.level();
  }

  private stopTracks(stream: MediaStream | null): void {
    for (const t of stream?.getTracks() ?? []) t.stop();
  }

  // ---------------------------------------------------------------------------
  // Stats

  async stats(): Promise<PeerStats[]> {
    const out: PeerStats[] = [];
    for (const remote of this.remotes.values()) {
      const link = remote.link;
      if (!link) continue;
      const senders = this.senders.get(link);
      const byMid = (mid: string | null) => (mid === null ? undefined : link.pc.getTransceivers().find((t) => t.mid === mid));
      const labelFor = (direction: "in" | "out", kind: "audio" | "video", mid: string | null): MediaLabel => {
        if (kind === "video") return "screen";
        const t = byMid(mid);
        if (direction === "out") return t && senders?.mic === t ? "voice" : "screen audio";
        const share = remote.info.state.share;
        const screenStream = share ? remote.streams.get(share.streamId) : undefined;
        return t && screenStream?.getTrackById(t.receiver.track.id) ? "screen audio" : "voice";
      };
      const maxBitrateFor = (mid: string | null) => byMid(mid)?.sender.getParameters().encodings?.[0]?.maxBitrate ?? null;
      out.push(await this.sampler.sample(link.pc, { peerId: remote.info.id, name: remote.info.name, iceRestarts: link.iceRestarts }, labelFor, maxBitrateFor));
    }
    return out;
  }
}

function readResume(roomId: RoomId): string | null {
  try {
    return sessionStorage.getItem(`streamroom:resume:${roomId}`);
  } catch {
    return null;
  }
}

function writeResume(roomId: RoomId, token: string): void {
  try {
    sessionStorage.setItem(`streamroom:resume:${roomId}`, token);
  } catch {
    // Private mode: reconnects still work within this page.
  }
}

function savedAudioSource(): string {
  try { return localStorage.getItem("streamroom:share-audio") || "browser"; } catch { return "browser"; }
}
