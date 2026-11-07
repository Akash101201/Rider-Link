import { tuneOpusSdp } from './sdp';
import type { RoomMember, SignalPayload, SignalingRoomSession } from './signaling';

export type PeerConnStatus = 'connecting' | 'connected' | 'reconnecting';

export type MeshDataMessage =
  | {
      type: 'alert';
      id: string;
      alertKey: string;
      fromUid: string;
      fromName: string;
      ts: number;
    }
  | {
      type: 'loc';
      fromUid: string;
      lat: number;
      lng: number;
      speedKmh: number;
      heading: number | null;
      accuracy: number;
      ts: number;
    }
  | {
      type: 'behind';
      id: string;
      fromUid: string;
      fromName: string;
      distanceKm: number;
      recovered: boolean;
      ts: number;
    };

interface PeerEntry {
  uid: string;
  pc: RTCPeerConnection;
  dc: RTCDataChannel;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  isSettingRemoteAnswerPending: boolean;
  pendingCandidates: RTCIceCandidateInit[];
  status: PeerConnStatus;
  disconnectTimer: number | null;
  sender: RTCRtpSender | null;
}

const FALLBACK_ICE_SERVERS: RTCIceServer[] = [
  {
    urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'],
  },
];

export async function fetchIceServers(skipRemote = false): Promise<RTCIceServer[]> {
  if (skipRemote) return FALLBACK_ICE_SERVERS;
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 2_500);
    const res = await fetch('/api/turn', { signal: controller.signal });
    window.clearTimeout(timer);
    if (!res.ok) return FALLBACK_ICE_SERVERS;
    const json = (await res.json()) as { iceServers?: RTCIceServer[] };
    if (Array.isArray(json.iceServers) && json.iceServers.length > 0) {
      return json.iceServers;
    }
    return FALLBACK_ICE_SERVERS;
  } catch {
    return FALLBACK_ICE_SERVERS;
  }
}

export interface PeerMeshCallbacks {
  onPeerStatus: (statuses: Record<string, PeerConnStatus>) => void;
  onRemoteStream: (peerUid: string, stream: MediaStream) => void;
  onPeerRemoved: (peerUid: string) => void;
  onDataMessage: (msg: MeshDataMessage) => void;
}

export class PeerMesh {
  private readonly myUid: string;
  private readonly signaling: SignalingRoomSession;
  private readonly iceServers: RTCIceServer[];
  private readonly callbacks: PeerMeshCallbacks;
  private outboundStream: MediaStream;
  private readonly peers = new Map<string, PeerEntry>();
  private readonly unsubSignal: () => void;
  private readonly unsubMembers: () => void;
  private destroyed = false;

  constructor(opts: {
    signaling: SignalingRoomSession;
    outboundStream: MediaStream;
    iceServers: RTCIceServer[];
    callbacks: PeerMeshCallbacks;
  }) {
    this.signaling = opts.signaling;
    this.myUid = opts.signaling.meta.myUid;
    this.outboundStream = opts.outboundStream;
    this.iceServers = opts.iceServers;
    this.callbacks = opts.callbacks;

    this.unsubSignal = this.signaling.onSignal((fromUid, payload) => {
      this.handleSignal(fromUid, payload).catch(() => undefined);
    });

    this.unsubMembers = this.signaling.onMembers((members) => {
      this.reconcileMembers(members);
    });
  }

  private emitStatuses(): void {
    const map: Record<string, PeerConnStatus> = {};
    for (const [uid, entry] of this.peers.entries()) {
      map[uid] = entry.status;
    }
    this.callbacks.onPeerStatus(map);
  }

  private reconcileMembers(members: RoomMember[]): void {
    if (this.destroyed) return;
    const activeUids = new Set(members.map((m) => m.uid));

    // Tear down peers who left or disconnected
    for (const existingUid of Array.from(this.peers.keys())) {
      if (!activeUids.has(existingUid)) {
        this.closePeer(existingUid);
      }
    }

    // Ensure peer connections for every other active rider
    for (const member of members) {
      if (member.uid === this.myUid) continue;
      if (!this.peers.has(member.uid)) {
        const entry = this.ensurePeer(member.uid);
        // Deterministic initiator avoids simultaneous offer glare
        if (this.myUid > member.uid) {
          this.sendOffer(entry, false).catch(() => undefined);
        }
      }
    }

    this.emitStatuses();
  }

  private ensurePeer(peerUid: string): PeerEntry {
    const existing = this.peers.get(peerUid);
    if (existing) return existing;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const polite = this.myUid < peerUid;

    const audioTrack = this.outboundStream.getAudioTracks()[0] ?? null;
    const sender = audioTrack ? pc.addTrack(audioTrack, this.outboundStream) : null;

    const dc = pc.createDataChannel('riderlink-data', {
      negotiated: true,
      id: 0,
      ordered: true,
    });

    const entry: PeerEntry = {
      uid: peerUid,
      pc,
      dc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      isSettingRemoteAnswerPending: false,
      pendingCandidates: [],
      status: 'connecting',
      disconnectTimer: null,
      sender,
    };

    dc.onmessage = (ev) => {
      if (this.destroyed || typeof ev.data !== 'string') return;
      try {
        const parsed = JSON.parse(ev.data) as MeshDataMessage;
        if (parsed && typeof parsed.type === 'string') {
          this.callbacks.onDataMessage(parsed);
        }
      } catch {
        // Ignore malformed payloads
      }
    };

    pc.onicecandidate = (ev) => {
      if (this.destroyed || !ev.candidate) return;
      this.signaling
        .sendSignal(peerUid, {
          t: 'ice',
          candidate: ev.candidate.toJSON(),
        })
        .catch(() => undefined);
    };

    pc.ontrack = (ev) => {
      if (this.destroyed) return;
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      this.callbacks.onRemoteStream(peerUid, stream);
    };

    const updateConnState = () => {
      if (this.destroyed || !this.peers.has(peerUid)) return;
      const state = pc.connectionState;
      const iceState = pc.iceConnectionState;

      if (state === 'connected' || iceState === 'connected' || iceState === 'completed') {
        if (entry.disconnectTimer !== null) {
          window.clearTimeout(entry.disconnectTimer);
          entry.disconnectTimer = null;
        }
        if (entry.status !== 'connected') {
          entry.status = 'connected';
          this.emitStatuses();
        }
      } else if (iceState === 'disconnected' || state === 'disconnected') {
        if (entry.status !== 'reconnecting') {
          entry.status = 'reconnecting';
          this.emitStatuses();
        }
        if (entry.disconnectTimer === null) {
          entry.disconnectTimer = window.setTimeout(() => {
            entry.disconnectTimer = null;
            if (!this.destroyed && this.peers.has(peerUid) && this.myUid > peerUid) {
              this.sendOffer(entry, true).catch(() => undefined);
            }
          }, 4_000);
        }
      } else if (state === 'failed' || iceState === 'failed') {
        entry.status = 'reconnecting';
        this.emitStatuses();
        if (this.myUid > peerUid) {
          this.sendOffer(entry, true).catch(() => undefined);
        }
      }
    };

    pc.onconnectionstatechange = updateConnState;
    pc.oniceconnectionstatechange = updateConnState;

    // Handshake retry watchdog if initial offer arrived while peer was still booting
    if (this.myUid > peerUid) {
      entry.disconnectTimer = window.setTimeout(() => {
        entry.disconnectTimer = null;
        if (!this.destroyed && this.peers.has(peerUid) && entry.status === 'connecting') {
          this.sendOffer(entry, true).catch(() => undefined);
        }
      }, 2_200);
    }

    this.peers.set(peerUid, entry);
    return entry;
  }

  private async sendOffer(entry: PeerEntry, iceRestart: boolean): Promise<void> {
    if (this.destroyed) return;
    try {
      entry.makingOffer = true;
      const offer = await entry.pc.createOffer({ iceRestart });
      if (entry.pc.signalingState !== 'stable') return;
      const tunedSdp = offer.sdp ? tuneOpusSdp(offer.sdp) : offer.sdp;
      await entry.pc.setLocalDescription({ type: 'offer', sdp: tunedSdp });
      if (entry.pc.localDescription?.sdp) {
        await this.signaling.sendSignal(entry.uid, {
          t: 'offer',
          sdp: entry.pc.localDescription.sdp,
        });
      }
    } finally {
      entry.makingOffer = false;
    }
  }

  private async handleSignal(fromUid: string, payload: SignalPayload): Promise<void> {
    if (this.destroyed || fromUid === this.myUid) return;
    const entry = this.ensurePeer(fromUid);
    const { pc } = entry;

    try {
      if (payload.t === 'offer' || payload.t === 'answer') {
        const readyForOffer =
          !entry.makingOffer &&
          (pc.signalingState === 'stable' || entry.isSettingRemoteAnswerPending);
        const offerCollision = payload.t === 'offer' && !readyForOffer;

        entry.ignoreOffer = !entry.polite && offerCollision;
        if (entry.ignoreOffer) return;

        entry.isSettingRemoteAnswerPending = payload.t === 'answer';
        await pc.setRemoteDescription({ type: payload.t, sdp: payload.sdp });
        entry.isSettingRemoteAnswerPending = false;

        // Flush any ICE candidates that arrived prior to remoteDescription
        while (entry.pendingCandidates.length > 0) {
          const cand = entry.pendingCandidates.shift();
          if (cand) {
            await pc.addIceCandidate(cand).catch(() => undefined);
          }
        }

        if (payload.t === 'offer') {
          const answer = await pc.createAnswer();
          const tunedSdp = answer.sdp ? tuneOpusSdp(answer.sdp) : answer.sdp;
          await pc.setLocalDescription({ type: 'answer', sdp: tunedSdp });
          if (pc.localDescription?.sdp) {
            await this.signaling.sendSignal(fromUid, {
              t: 'answer',
              sdp: pc.localDescription.sdp,
            });
          }
        }
      } else if (payload.t === 'ice' && payload.candidate) {
        if (!entry.ignoreOffer) {
          if (pc.remoteDescription && pc.remoteDescription.type) {
            await pc.addIceCandidate(payload.candidate).catch(() => undefined);
          } else {
            entry.pendingCandidates.push(payload.candidate);
          }
        }
      }
    } catch {
      // Recoverable WebRTC state transition error during rapid reconnect
    }
  }

  async replaceAudioTrack(newTrack: MediaStreamTrack | null): Promise<void> {
    for (const entry of this.peers.values()) {
      if (entry.sender) {
        await entry.sender.replaceTrack(newTrack).catch(() => undefined);
      }
    }
  }

  broadcastData(msg: MeshDataMessage): number {
    const encoded = JSON.stringify(msg);
    let sentCount = 0;
    for (const entry of this.peers.values()) {
      if (entry.dc.readyState === 'open') {
        try {
          entry.dc.send(encoded);
          sentCount++;
        } catch {
          // Channel closing
        }
      }
    }
    return sentCount;
  }

  async getAudioTransferStats(): Promise<{
    connectedPeers: number;
    openChannels: number;
    bytesSent: number;
    bytesReceived: number;
  }> {
    let connectedPeers = 0;
    let openChannels = 0;
    let bytesSent = 0;
    let bytesReceived = 0;

    for (const entry of this.peers.values()) {
      if (entry.status === 'connected') connectedPeers++;
      if (entry.dc.readyState === 'open') openChannels++;
      try {
        const stats = await entry.pc.getStats();
        stats.forEach((report: Record<string, unknown>) => {
          if (report.type === 'outbound-rtp' && report.kind === 'audio') {
            bytesSent += Number(report.bytesSent ?? 0);
          } else if (report.type === 'inbound-rtp' && report.kind === 'audio') {
            bytesReceived += Number(report.bytesReceived ?? 0);
          }
        });
      } catch {
        // Ignore
      }
    }

    return { connectedPeers, openChannels, bytesSent, bytesReceived };
  }

  private closePeer(peerUid: string): void {
    const entry = this.peers.get(peerUid);
    if (!entry) return;
    if (entry.disconnectTimer !== null) {
      window.clearTimeout(entry.disconnectTimer);
    }
    try {
      entry.dc.close();
    } catch {
      // Ignore
    }
    try {
      entry.pc.close();
    } catch {
      // Ignore
    }
    this.peers.delete(peerUid);
    this.callbacks.onPeerRemoved(peerUid);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.unsubSignal();
    this.unsubMembers();
    for (const uid of Array.from(this.peers.keys())) {
      this.closePeer(uid);
    }
  }
}

