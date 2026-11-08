// One RTCPeerConnection to one remote member, using MDN's "perfect negotiation" pattern.
// Every local track gets its own sendonly transceiver, so adding or removing a screen share is
// just add/stop + renegotiate, and simultaneous changes on both ends resolve via politeness.

import type { MemberId, SignalData } from "../../shared/protocol.ts";
import { mungeOpus } from "../../shared/sdp.ts";
import { setVideoCodecPreferences } from "./media.ts";
import type { DegradationPreference } from "./presets.ts";

export interface SendOptions {
  maxBitrate: number;
  maxFramerate?: number;
  degradation?: DegradationPreference;
}

export interface PeerEvents {
  signal(data: SignalData): void;
  track(track: MediaStreamTrack, streams: readonly MediaStream[]): void;
  /** A data channel this side created at startup ("ctl") or the remote side opened. */
  channel(channel: RTCDataChannel): void;
  change(): void;
}

interface Outgoing {
  transceiver: RTCRtpTransceiver;
  options: SendOptions;
}

const DISCONNECT_RESTART_MS = 4000;

export class PeerLink {
  readonly pc: RTCPeerConnection;
  private makingOffer = false;
  private ignoreOffer = false;
  private settingRemoteAnswer = false;
  private readonly outgoing = new Set<Outgoing>();
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  iceRestarts = 0;

  constructor(
    readonly remoteId: MemberId,
    readonly polite: boolean,
    config: RTCConfiguration,
    private readonly events: PeerEvents,
  ) {
    const pc = new RTCPeerConnection(config);
    this.pc = pc;

    pc.onnegotiationneeded = async () => {
      try {
        this.makingOffer = true;
        await pc.setLocalDescription();
        this.sendDescription();
      } catch (err) {
        console.warn(`[${remoteId}] offer failed`, err);
      } finally {
        this.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (candidate) this.events.signal({ candidate: candidate.toJSON() as SignalData["candidate"] });
    };
    pc.onicecandidateerror = (e) => {
      // 701 (unreachable) is routine for interfaces with no route; anything else is worth seeing.
      if (e.errorCode !== 701) console.warn(`[${remoteId}] ICE candidate error ${e.errorCode} ${e.errorText} (${e.url})`);
    };
    pc.ontrack = ({ track, streams, transceiver }) => {
      // Ask for our codec order on the receiving side too, before the answer is created.
      if (track.kind === "video") setVideoCodecPreferences(transceiver);
      this.events.track(track, streams);
    };
    pc.onsignalingstatechange = () => {
      if (pc.signalingState === "stable") void this.applySendParameters();
    };
    pc.onconnectionstatechange = () => {
      const state = pc.connectionState;
      if (state === "failed") this.restartIce();
      if (state === "disconnected") {
        this.disconnectTimer ??= setTimeout(() => {
          this.disconnectTimer = null;
          if (pc.connectionState === "disconnected") this.restartIce();
        }, DISCONNECT_RESTART_MS);
      } else if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }
      this.events.change();
    };
    pc.ondatachannel = ({ channel }) => this.events.channel(channel);
    // Only the impolite side creates the control channel, so it makes the first offer even when
    // neither side has media, and the polite side keeps waiting for that offer.
    if (!polite) this.events.channel(pc.createDataChannel("ctl", { ordered: true }));
  }

  /** A new reliable channel on the existing connection. No renegotiation once the first one exists. */
  openChannel(label: string): RTCDataChannel | null {
    if (this.closed) return null;
    try {
      return this.pc.createDataChannel(label, { ordered: true });
    } catch {
      return null;
    }
  }

  /** Largest message the remote end accepts, or 0 when unknown. */
  get maxMessageSize(): number {
    return this.pc.sctp?.maxMessageSize ?? 0;
  }

  private firstRemoteDone: () => void = () => undefined;
  private readonly firstRemote = new Promise<void>((resolve) => (this.firstRemoteDone = resolve));

  /**
   * Resolves once the first remote description is applied, or after `ms`.
   * The polite side waits on this before adding its own tracks: Chromium can leave a brand-new
   * connection unable to gather ICE candidates when its very first offer is rolled back by a
   * colliding remote offer, so we avoid that collision instead of resolving it.
   */
  firstRemoteDescription(ms: number): Promise<void> {
    return Promise.race([this.firstRemote, new Promise<void>((resolve) => setTimeout(resolve, ms))]);
  }

  get state(): RTCPeerConnectionState {
    return this.pc.connectionState;
  }

  restartIce(): void {
    if (this.closed) return;
    this.iceRestarts++;
    this.pc.restartIce();
  }

  private inbox: Promise<void> = Promise.resolve();

  /** Handle signaling messages strictly in arrival order. */
  receive(data: SignalData): void {
    this.inbox = this.inbox
      .then(() => (this.closed ? undefined : this.handleSignal(data)))
      .catch((err: unknown) => console.warn(`[${this.remoteId}] signaling error`, err));
  }

  private async handleSignal(data: SignalData): Promise<void> {
    const pc = this.pc;
    if (data.description) {
      const description = data.description;
      const readyForOffer = !this.makingOffer && (pc.signalingState === "stable" || this.settingRemoteAnswer);
      const collision = description.type === "offer" && !readyForOffer;
      this.ignoreOffer = !this.polite && collision;
      if (this.ignoreOffer) return;
      this.settingRemoteAnswer = description.type === "answer";
      // The receiver's fmtp tells the sender how to encode: ask for stereo, 128 kbps Opus with FEC.
      const sdp = description.sdp === undefined ? undefined : mungeOpus(description.sdp);
      await pc.setRemoteDescription({ type: description.type, ...(sdp === undefined ? {} : { sdp }) });
      this.settingRemoteAnswer = false;
      if (description.type === "offer") {
        await pc.setLocalDescription();
        this.sendDescription();
      }
      this.firstRemoteDone();
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (err) {
        if (!this.ignoreOffer) console.warn(`[${this.remoteId}] addIceCandidate failed`, err);
      }
    }
  }

  /** Start sending a track. Triggers renegotiation. */
  addTrack(track: MediaStreamTrack, stream: MediaStream, options: SendOptions): RTCRtpTransceiver {
    const encoding: RTCRtpEncodingParameters = { maxBitrate: options.maxBitrate, priority: "high", networkPriority: "high" };
    if (options.maxFramerate !== undefined) encoding.maxFramerate = options.maxFramerate;
    const transceiver = this.pc.addTransceiver(track, { direction: "sendonly", streams: [stream], sendEncodings: [encoding] });
    if (track.kind === "video") setVideoCodecPreferences(transceiver);
    const entry = { transceiver, options };
    this.outgoing.add(entry);
    void this.applySendParameters();
    return transceiver;
  }

  /** Stop sending a track for good. Triggers renegotiation; the m-line is recycled later. */
  removeTrack(transceiver: RTCRtpTransceiver): void {
    for (const entry of this.outgoing) if (entry.transceiver === transceiver) this.outgoing.delete(entry);
    if (this.closed || transceiver.currentDirection === "stopped") return;
    try {
      transceiver.stop();
    } catch {
      // Already stopped by a remote rejection.
    }
  }

  /** Make sure bitrate, framerate and degradation preference stick (some browsers reset them on negotiation). */
  private async applySendParameters(): Promise<void> {
    for (const { transceiver, options } of this.outgoing) {
      const sender = transceiver.sender;
      if (!sender.track || transceiver.currentDirection === "stopped") continue;
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: DegradationPreference };
      if (!params.encodings || params.encodings.length === 0) continue;
      let changed = false;
      for (const enc of params.encodings) {
        if (enc.maxBitrate !== options.maxBitrate) {
          enc.maxBitrate = options.maxBitrate;
          changed = true;
        }
        if (options.maxFramerate !== undefined && enc.maxFramerate !== options.maxFramerate) {
          enc.maxFramerate = options.maxFramerate;
          changed = true;
        }
      }
      if (options.degradation && params.degradationPreference !== options.degradation) {
        params.degradationPreference = options.degradation;
        changed = true;
      }
      if (!changed) continue;
      try {
        await sender.setParameters(params);
      } catch {
        // Older browsers reject degradationPreference; keep the bitrate cap at least.
        try {
          delete params.degradationPreference;
          await sender.setParameters(params);
        } catch (err) {
          console.warn(`[${this.remoteId}] setParameters failed`, err);
        }
      }
    }
  }

  private sendDescription(): void {
    const d = this.pc.localDescription;
    if (d) this.events.signal({ description: { type: d.type, sdp: d.sdp } });
  }

  close(): void {
    this.closed = true;
    if (this.disconnectTimer) clearTimeout(this.disconnectTimer);
    this.pc.onnegotiationneeded = null;
    this.pc.onicecandidate = null;
    this.pc.ontrack = null;
    this.pc.onicecandidateerror = null;
    this.pc.onconnectionstatechange = null;
    this.pc.onsignalingstatechange = null;
    this.pc.ondatachannel = null;
    this.pc.close();
  }
}
