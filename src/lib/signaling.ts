import { initializeApp, getApps, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously, type Auth } from 'firebase/auth';
import {
  getDatabase,
  ref,
  get,
  set,
  update,
  remove,
  push,
  onValue,
  onChildAdded,
  onDisconnect,
  runTransaction,
  serverTimestamp,
  type Database,
} from 'firebase/database';
import { MAX_RIDERS } from './constants';
import { generateRoomCode, isValidRoomCode, normalizeCode } from './code';
import { evaluateRoomExpiry } from './expiry';

export type RiderRole = 'lead' | 'sweep' | 'rider';

export interface RoomMember {
  uid: string;
  name: string;
  slot: number;
  joinedAt: number;
  muted: boolean;
  role: RiderRole;
}

export type SignalPayload =
  | { t: 'offer'; sdp: string }
  | { t: 'answer'; sdp: string }
  | { t: 'ice'; candidate: RTCIceCandidateInit | null };

export interface RoomStateMeta {
  code: string;
  hostUid: string;
  createdAt: number;
  lastActivityAt: number;
  status: 'active' | 'ended';
  myUid: string;
  mySlot: number;
  isHost: boolean;
  backend: 'firebase' | 'local';
}

export type RoomEndReason = 'host_ended' | 'max_duration' | 'idle_empty';

export interface SignalingRoomSession {
  meta: RoomStateMeta;
  getServerNow: () => number;
  updateMyState: (patch: Partial<Pick<RoomMember, 'muted' | 'role' | 'name'>>) => Promise<void>;
  sendSignal: (toUid: string, payload: SignalPayload) => Promise<void>;
  onMembers: (cb: (members: RoomMember[]) => void) => () => void;
  onSignal: (cb: (fromUid: string, payload: SignalPayload) => void) => () => void;
  onEnded: (cb: (reason: RoomEndReason) => void) => () => void;
  leaveRoom: () => Promise<void>;
  disconnectTemporarily: () => Promise<void>;
  endRoom: () => Promise<void>;
}

export interface RoomStatusCheck {
  exists: boolean;
  active: boolean;
  reason?: 'not_found' | 'ended' | 'max_duration' | 'idle_empty';
  createdAt?: number;
  isHost?: boolean;
}

export interface SignalingClient {
  readonly backend: 'firebase' | 'local';
  getUid: () => Promise<string>;
  inspectRoom: (code: string) => Promise<RoomStatusCheck>;
  createRoom: (riderName: string, preferredCode?: string) => Promise<SignalingRoomSession>;
  joinRoom: (rawCode: string, riderName: string) => Promise<SignalingRoomSession>;
}

export class SignalingError extends Error {
  readonly code:
    | 'INVALID_CODE'
    | 'ROOM_NOT_FOUND'
    | 'ROOM_ENDED'
    | 'ROOM_EXPIRED_IDLE'
    | 'ROOM_EXPIRED_MAX'
    | 'ROOM_FULL'
    | 'NOT_HOST'
    | 'AUTH_FAILED';

  constructor(
    code: SignalingError['code'],
    message: string,
  ) {
    super(message);
    this.name = 'SignalingError';
    this.code = code;
  }
}

/* ============================================================================
 * 1. LOCAL / MULTI-TAB SIGNALING (BroadcastChannel + Storage — Demo & E2E)
 * ============================================================================ */

interface StoredLocalRoom {
  code: string;
  hostUid: string;
  createdAt: number;
  lastActivityAt: number;
  status: 'active' | 'ended';
  slots: Record<string, string>; // slotIndex -> uid
  members: Record<
    string,
    {
      uid: string;
      name: string;
      slot: number;
      joinedAt: number;
      muted: boolean;
      role: RiderRole;
      heartbeatAt: number;
    }
  >;
}

type LocalBusEvent =
  | { kind: 'room_updated'; code: string }
  | { kind: 'room_ended'; code: string; reason: RoomEndReason }
  | { kind: 'signal'; code: string; toUid: string; fromUid: string; payload: SignalPayload };

const LOCAL_ROOM_PREFIX = 'riderlink:room:';
const LOCAL_TAB_UID_KEY = 'riderlink:tab:uid';
const LOCAL_CHANNEL_NAME = 'riderlink-signaling-v1';
const MEMBER_STALE_MS = 12_000;

export interface LocalSignalingOptions {
  clock?: () => number;
  uid?: string;
  storage?: Storage;
}

export class LocalSignalingClient implements SignalingClient {
  readonly backend = 'local' as const;
  private readonly clock: () => number;
  private readonly fixedUid?: string;
  private readonly storage: Storage;

  constructor(opts: LocalSignalingOptions = {}) {
    this.clock =
      opts.clock ??
      (() => {
        const offset =
          typeof window !== 'undefined'
            ? ((window as unknown as { __RIDERLINK_TIME_OFFSET_MS__?: number })
                .__RIDERLINK_TIME_OFFSET_MS__ ?? 0)
            : 0;
        return Date.now() + offset;
      });
    this.fixedUid = opts.uid;
    this.storage = opts.storage ?? window.localStorage;
  }

  async getUid(): Promise<string> {
    if (this.fixedUid) return this.fixedUid;
    let uid = window.sessionStorage.getItem(LOCAL_TAB_UID_KEY);
    if (!uid) {
      uid = `rider-${crypto.randomUUID().slice(0, 8)}`;
      window.sessionStorage.setItem(LOCAL_TAB_UID_KEY, uid);
    }
    return uid;
  }

  private roomKey(code: string): string {
    return `${LOCAL_ROOM_PREFIX}${code}`;
  }

  private readRoom(code: string): StoredLocalRoom | null {
    const raw = this.storage.getItem(this.roomKey(code));
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as StoredLocalRoom;
      return this.pruneStaleMembers(parsed);
    } catch {
      return null;
    }
  }

  private pruneStaleMembers(room: StoredLocalRoom): StoredLocalRoom {
    const now = this.clock();
    let changed = false;
    for (const [uid, m] of Object.entries(room.members)) {
      if (now - m.heartbeatAt > MEMBER_STALE_MS) {
        delete room.members[uid];
        room.lastActivityAt = Math.max(room.lastActivityAt, m.heartbeatAt);
        changed = true;
      }
    }
    if (changed) {
      this.writeRoom(room);
    }
    return room;
  }

  private writeRoom(room: StoredLocalRoom): void {
    this.storage.setItem(this.roomKey(room.code), JSON.stringify(room));
  }

  private removeRoom(code: string): void {
    this.storage.removeItem(this.roomKey(code));
  }

  async inspectRoom(rawCode: string): Promise<RoomStatusCheck> {
    const code = normalizeCode(rawCode);
    if (!isValidRoomCode(code)) {
      return { exists: false, active: false, reason: 'not_found' };
    }
    const room = this.readRoom(code);
    if (!room) {
      return { exists: false, active: false, reason: 'not_found' };
    }
    const uid = await this.getUid();
    const activeCount = Object.keys(room.members).length;
    const expiry = evaluateRoomExpiry(
      {
        status: room.status,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
        activeMemberCount: activeCount,
      },
      this.clock(),
    );
    if (expiry.expired) {
      if (expiry.reason !== 'ended') {
        this.removeRoom(code);
      }
      return {
        exists: true,
        active: false,
        reason: expiry.reason === 'none' ? undefined : expiry.reason,
        createdAt: room.createdAt,
        isHost: room.hostUid === uid,
      };
    }
    return {
      exists: true,
      active: true,
      createdAt: room.createdAt,
      isHost: room.hostUid === uid,
    };
  }

  async createRoom(riderName: string, preferredCode?: string): Promise<SignalingRoomSession> {
    const myUid = await this.getUid();
    const now = this.clock();
    let code = preferredCode ? normalizeCode(preferredCode) : generateRoomCode();

    for (let attempt = 0; attempt < 8; attempt++) {
      const existing = this.readRoom(code);
      if (!existing) break;
      const expiry = evaluateRoomExpiry(
        {
          status: existing.status,
          createdAt: existing.createdAt,
          lastActivityAt: existing.lastActivityAt,
          activeMemberCount: Object.keys(existing.members).length,
        },
        now,
      );
      if (expiry.expired) {
        this.removeRoom(code);
        break;
      }
      code = generateRoomCode();
    }

    const room: StoredLocalRoom = {
      code,
      hostUid: myUid,
      createdAt: now,
      lastActivityAt: now,
      status: 'active',
      slots: { '0': myUid },
      members: {
        [myUid]: {
          uid: myUid,
          name: riderName.trim() || 'Rider 1',
          slot: 0,
          joinedAt: now,
          muted: false,
          role: 'lead',
          heartbeatAt: now,
        },
      },
    };
    this.writeRoom(room);

    return this.buildSession(room, myUid, 0);
  }

  async joinRoom(rawCode: string, riderName: string): Promise<SignalingRoomSession> {
    const code = normalizeCode(rawCode);
    if (!isValidRoomCode(code)) {
      throw new SignalingError('INVALID_CODE', 'Enter a valid 6-character pack code.');
    }

    const room = this.readRoom(code);
    if (!room) {
      throw new SignalingError('ROOM_NOT_FOUND', `Pack ${code} was not found.`);
    }

    const now = this.clock();
    const expiry = evaluateRoomExpiry(
      {
        status: room.status,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt,
        activeMemberCount: Object.keys(room.members).length,
      },
      now,
    );

    if (expiry.expired) {
      this.removeRoom(code);
      if (expiry.reason === 'ended') {
        throw new SignalingError('ROOM_ENDED', 'This ride has already ended.');
      }
      if (expiry.reason === 'idle_empty') {
        throw new SignalingError(
          'ROOM_EXPIRED_IDLE',
          'Pack expired after 15 minutes with no riders connected.',
        );
      }
      throw new SignalingError(
        'ROOM_EXPIRED_MAX',
        'Pack expired after reaching the 2-hour ride limit.',
      );
    }

    const myUid = await this.getUid();

    // Check if this rider already holds a slot (auto-rejoin or tunnel recovery!)
    let assignedSlot = -1;
    for (let i = 0; i < MAX_RIDERS; i++) {
      if (room.slots[String(i)] === myUid) {
        assignedSlot = i;
        break;
      }
    }

    if (assignedSlot === -1) {
      for (let i = 0; i < MAX_RIDERS; i++) {
        if (!room.slots[String(i)]) {
          assignedSlot = i;
          room.slots[String(i)] = myUid;
          break;
        }
      }
    }

    if (assignedSlot === -1) {
      throw new SignalingError(
        'ROOM_FULL',
        `Pack is full (${MAX_RIDERS}/${MAX_RIDERS} riders).`,
      );
    }

    const existingMember = room.members[myUid];
    const isHost = room.hostUid === myUid;
    room.lastActivityAt = now;
    room.members[myUid] = {
      uid: myUid,
      name: riderName.trim() || existingMember?.name || `Rider ${assignedSlot + 1}`,
      slot: assignedSlot,
      joinedAt: existingMember?.joinedAt ?? now,
      muted: existingMember?.muted ?? false,
      role: isHost ? 'lead' : (existingMember?.role ?? 'rider'),
      heartbeatAt: now,
    };
    this.writeRoom(room);

    return this.buildSession(room, myUid, assignedSlot);
  }

  private buildSession(
    initialRoom: StoredLocalRoom,
    myUid: string,
    mySlot: number,
  ): SignalingRoomSession {
    const code = initialRoom.code;
    const isHost = initialRoom.hostUid === myUid;
    const channel =
      typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(LOCAL_CHANNEL_NAME) : null;

    const memberListeners = new Set<(members: RoomMember[]) => void>();
    const signalListeners = new Set<(fromUid: string, payload: SignalPayload) => void>();
    const bufferedSignals: Array<{ fromUid: string; payload: SignalPayload }> = [];
    const endedListeners = new Set<(reason: RoomEndReason) => void>();
    let closed = false;
    let endedEmitted = false;

    const meta: RoomStateMeta = {
      code,
      hostUid: initialRoom.hostUid,
      createdAt: initialRoom.createdAt,
      lastActivityAt: initialRoom.lastActivityAt,
      status: initialRoom.status,
      myUid,
      mySlot,
      isHost,
      backend: 'local',
    };

    const sortedMembers = (r: StoredLocalRoom): RoomMember[] =>
      Object.values(r.members)
        .map(({ heartbeatAt: _hb, ...rest }) => rest)
        .sort((a, b) => a.slot - b.slot);

    const emitEndedOnce = (reason: RoomEndReason) => {
      if (endedEmitted) return;
      endedEmitted = true;
      meta.status = 'ended';
      for (const cb of endedListeners) cb(reason);
    };

    const syncFromStorage = () => {
      if (closed) return;
      const room = this.readRoom(code);
      if (!room) {
        emitEndedOnce('host_ended');
        return;
      }
      const expiry = evaluateRoomExpiry(
        {
          status: room.status,
          createdAt: room.createdAt,
          lastActivityAt: room.lastActivityAt,
          activeMemberCount: Object.keys(room.members).length,
        },
        this.clock(),
      );
      if (expiry.expired) {
        const reason: RoomEndReason =
          expiry.reason === 'max_duration'
            ? 'max_duration'
            : expiry.reason === 'idle_empty'
              ? 'idle_empty'
              : 'host_ended';
        emitEndedOnce(reason);
        return;
      }
      meta.lastActivityAt = room.lastActivityAt;
      const list = sortedMembers(room);
      for (const cb of memberListeners) cb(list);
    };

    const postBus = (ev: LocalBusEvent) => {
      channel?.postMessage(ev);
    };

    if (channel) {
      channel.onmessage = (ev: MessageEvent<LocalBusEvent>) => {
        if (closed || !ev.data || ev.data.code !== code) return;
        if (ev.data.kind === 'room_updated') {
          syncFromStorage();
        } else if (ev.data.kind === 'room_ended') {
          emitEndedOnce(ev.data.reason);
        } else if (ev.data.kind === 'signal' && ev.data.toUid === myUid) {
          if (signalListeners.size === 0) {
            bufferedSignals.push({ fromUid: ev.data.fromUid, payload: ev.data.payload });
          } else {
            for (const cb of signalListeners) cb(ev.data.fromUid, ev.data.payload);
          }
        }
      };
    }

    const onStorageEvent = (e: StorageEvent) => {
      if (e.key === this.roomKey(code)) {
        syncFromStorage();
      }
    };
    window.addEventListener('storage', onStorageEvent);

    // Heartbeat + 2h duration watchdog
    const heartbeatTimer = window.setInterval(() => {
      if (closed) return;
      const room = this.readRoom(code);
      if (!room) {
        emitEndedOnce('host_ended');
        return;
      }
      const now = this.clock();
      const expiry = evaluateRoomExpiry(
        {
          status: room.status,
          createdAt: room.createdAt,
          lastActivityAt: room.lastActivityAt,
          activeMemberCount: Object.keys(room.members).length,
        },
        now,
      );
      if (expiry.expired) {
        this.removeRoom(code);
        const reason: RoomEndReason =
          expiry.reason === 'max_duration'
            ? 'max_duration'
            : expiry.reason === 'idle_empty'
              ? 'idle_empty'
              : 'host_ended';
        postBus({ kind: 'room_ended', code, reason });
        emitEndedOnce(reason);
        return;
      }
      if (room.members[myUid]) {
        room.members[myUid].heartbeatAt = now;
        room.lastActivityAt = now;
        this.writeRoom(room);
      }
      syncFromStorage();
    }, 2_500);

    const handlePageHide = () => {
      if (closed) return;
      const room = this.readRoom(code);
      if (room && room.members[myUid]) {
        delete room.members[myUid];
        room.lastActivityAt = this.clock();
        this.writeRoom(room);
        postBus({ kind: 'room_updated', code });
      }
    };
    window.addEventListener('pagehide', handlePageHide);

    // Notify existing tabs immediately
    postBus({ kind: 'room_updated', code });

    const cleanupHandles = () => {
      if (closed) return;
      closed = true;
      window.clearInterval(heartbeatTimer);
      window.removeEventListener('storage', onStorageEvent);
      window.removeEventListener('pagehide', handlePageHide);
      channel?.close();
    };

    return {
      meta,
      getServerNow: () => this.clock(),
      updateMyState: async (patch) => {
        if (closed) return;
        const room = this.readRoom(code);
        if (!room || !room.members[myUid]) return;
        room.members[myUid] = {
          ...room.members[myUid],
          ...patch,
          heartbeatAt: this.clock(),
        };
        room.lastActivityAt = this.clock();
        this.writeRoom(room);
        postBus({ kind: 'room_updated', code });
        syncFromStorage();
      },
      sendSignal: async (toUid, payload) => {
        if (closed) return;
        postBus({ kind: 'signal', code, toUid, fromUid: myUid, payload });
      },
      onMembers: (cb) => {
        memberListeners.add(cb);
        const current = this.readRoom(code);
        if (current) cb(sortedMembers(current));
        return () => {
          memberListeners.delete(cb);
        };
      },
      onSignal: (cb) => {
        signalListeners.add(cb);
        while (bufferedSignals.length > 0) {
          const item = bufferedSignals.shift();
          if (item) cb(item.fromUid, item.payload);
        }
        return () => {
          signalListeners.delete(cb);
        };
      },
      onEnded: (cb) => {
        endedListeners.add(cb);
        return () => {
          endedListeners.delete(cb);
        };
      },
      disconnectTemporarily: async () => {
        const room = this.readRoom(code);
        if (room && room.members[myUid]) {
          delete room.members[myUid];
          room.lastActivityAt = this.clock();
          this.writeRoom(room);
          postBus({ kind: 'room_updated', code });
        }
        cleanupHandles();
      },
      leaveRoom: async () => {
        const room = this.readRoom(code);
        if (room) {
          delete room.members[myUid];
          for (const [slotKey, ownerUid] of Object.entries(room.slots)) {
            if (ownerUid === myUid) {
              delete room.slots[slotKey];
            }
          }
          room.lastActivityAt = this.clock();
          this.writeRoom(room);
          postBus({ kind: 'room_updated', code });
        }
        cleanupHandles();
      },
      endRoom: async () => {
        if (!isHost) {
          throw new SignalingError('NOT_HOST', 'Only the ride creator can end the ride.');
        }
        const room = this.readRoom(code);
        if (room) {
          room.status = 'ended';
          room.members = {};
          this.writeRoom(room);
        }
        postBus({ kind: 'room_ended', code, reason: 'host_ended' });
        this.removeRoom(code);
        emitEndedOnce('host_ended');
        cleanupHandles();
      },
    };
  }
}

/* ============================================================================
 * 2. FIREBASE REALTIME DATABASE SIGNALING (Production Multi-Phone Cloud)
 * ============================================================================ */

interface FirebaseRoomSnapshot {
  hostUid: string;
  createdAt: number;
  lastActivityAt: number;
  status: 'active' | 'ended';
  slots?: Record<string, string>;
  members?: Record<
    string,
    {
      name: string;
      joinedAt: number;
      muted: boolean;
      role?: RiderRole;
    }
  >;
}

export class FirebaseSignalingClient implements SignalingClient {
  readonly backend = 'firebase' as const;
  private readonly app: FirebaseApp;
  private readonly auth: Auth;
  private readonly db: Database;
  private serverOffsetMs = 0;

  constructor(config: {
    apiKey: string;
    authDomain?: string;
    databaseURL: string;
    projectId?: string;
    appId?: string;
  }) {
    const existing = getApps();
    this.app = existing.length > 0 ? existing[0] : initializeApp(config);
    this.auth = getAuth(this.app);
    this.db = getDatabase(this.app);

    onValue(ref(this.db, '.info/serverTimeOffset'), (snap) => {
      const val = snap.val();
      if (typeof val === 'number') {
        this.serverOffsetMs = val;
      }
    });
  }

  private nowServer(): number {
    return Date.now() + this.serverOffsetMs;
  }

  async getUid(): Promise<string> {
    if (this.auth.currentUser) {
      return this.auth.currentUser.uid;
    }
    try {
      const cred = await signInAnonymously(this.auth);
      return cred.user.uid;
    } catch (err) {
      throw new SignalingError(
        'AUTH_FAILED',
        err instanceof Error ? err.message : 'Firebase Anonymous Auth failed.',
      );
    }
  }

  async inspectRoom(rawCode: string): Promise<RoomStatusCheck> {
    const code = normalizeCode(rawCode);
    if (!isValidRoomCode(code)) {
      return { exists: false, active: false, reason: 'not_found' };
    }
    const myUid = await this.getUid();
    const snap = await get(ref(this.db, `rooms/${code}`));
    if (!snap.exists()) {
      return { exists: false, active: false, reason: 'not_found' };
    }
    const room = snap.val() as FirebaseRoomSnapshot;
    const activeCount = room.members ? Object.keys(room.members).length : 0;
    const expiry = evaluateRoomExpiry(
      {
        status: room.status,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt ?? room.createdAt,
        activeMemberCount: activeCount,
      },
      this.nowServer(),
    );

    if (expiry.expired) {
      await remove(ref(this.db, `rooms/${code}`)).catch(() => undefined);
      return {
        exists: true,
        active: false,
        reason: expiry.reason === 'none' ? undefined : expiry.reason,
        createdAt: room.createdAt,
        isHost: room.hostUid === myUid,
      };
    }

    return {
      exists: true,
      active: true,
      createdAt: room.createdAt,
      isHost: room.hostUid === myUid,
    };
  }

  async createRoom(riderName: string, preferredCode?: string): Promise<SignalingRoomSession> {
    const myUid = await this.getUid();
    let code = preferredCode ? normalizeCode(preferredCode) : generateRoomCode();

    for (let attempt = 0; attempt < 8; attempt++) {
      const roomRef = ref(this.db, `rooms/${code}`);
      const now = this.nowServer();
      const tx = await runTransaction(roomRef, (current: FirebaseRoomSnapshot | null) => {
        if (current) {
          const activeCount = current.members ? Object.keys(current.members).length : 0;
          const expiry = evaluateRoomExpiry(
            {
              status: current.status,
              createdAt: current.createdAt,
              lastActivityAt: current.lastActivityAt ?? current.createdAt,
              activeMemberCount: activeCount,
            },
            now,
          );
          if (!expiry.expired) {
            return; // Abort transaction, try a fresh code
          }
        }
        return {
          hostUid: myUid,
          createdAt: serverTimestamp(),
          lastActivityAt: serverTimestamp(),
          status: 'active',
          slots: { '0': myUid },
          members: {
            [myUid]: {
              name: riderName.trim() || 'Rider 1',
              joinedAt: serverTimestamp(),
              muted: false,
              role: 'lead',
            },
          },
        };
      });

      if (tx.committed && tx.snapshot.exists()) {
        const val = tx.snapshot.val() as FirebaseRoomSnapshot;
        return this.attachSession(code, val, myUid, 0, riderName.trim() || 'Rider 1');
      }
      code = generateRoomCode();
    }

    throw new SignalingError('ROOM_FULL', 'Could not allocate a unique room code. Try again.');
  }

  async joinRoom(rawCode: string, riderName: string): Promise<SignalingRoomSession> {
    const code = normalizeCode(rawCode);
    if (!isValidRoomCode(code)) {
      throw new SignalingError('INVALID_CODE', 'Enter a valid 6-character pack code.');
    }

    const myUid = await this.getUid();
    const roomRef = ref(this.db, `rooms/${code}`);
    const snap = await get(roomRef);
    if (!snap.exists()) {
      throw new SignalingError('ROOM_NOT_FOUND', `Pack ${code} was not found.`);
    }

    const room = snap.val() as FirebaseRoomSnapshot;
    const activeCount = room.members ? Object.keys(room.members).length : 0;
    const expiry = evaluateRoomExpiry(
      {
        status: room.status,
        createdAt: room.createdAt,
        lastActivityAt: room.lastActivityAt ?? room.createdAt,
        activeMemberCount: activeCount,
      },
      this.nowServer(),
    );

    if (expiry.expired) {
      await remove(roomRef).catch(() => undefined);
      if (expiry.reason === 'ended') {
        throw new SignalingError('ROOM_ENDED', 'This ride has already ended.');
      }
      if (expiry.reason === 'idle_empty') {
        throw new SignalingError(
          'ROOM_EXPIRED_IDLE',
          'Pack expired after 15 minutes with no riders connected.',
        );
      }
      throw new SignalingError(
        'ROOM_EXPIRED_MAX',
        'Pack expired after reaching the 2-hour ride limit.',
      );
    }

    // Check existing slot first (auto-rejoin), else atomically claim first free slot 0..5
    let claimedSlot = -1;
    const slots = room.slots ?? {};
    for (let i = 0; i < MAX_RIDERS; i++) {
      if (slots[String(i)] === myUid) {
        claimedSlot = i;
        break;
      }
    }

    if (claimedSlot === -1) {
      for (let i = 0; i < MAX_RIDERS; i++) {
        const slotRef = ref(this.db, `rooms/${code}/slots/${i}`);
        const tx = await runTransaction(slotRef, (cur: string | null) => {
          if (cur === null || cur === myUid) return myUid;
          return;
        });
        if (tx.committed && tx.snapshot.val() === myUid) {
          claimedSlot = i;
          break;
        }
      }
    }

    if (claimedSlot === -1) {
      throw new SignalingError(
        'ROOM_FULL',
        `Pack is full (${MAX_RIDERS}/${MAX_RIDERS} riders).`,
      );
    }

    const cleanName = riderName.trim() || `Rider ${claimedSlot + 1}`;
    const isHost = room.hostUid === myUid;
    await update(ref(this.db, `rooms/${code}`), {
      lastActivityAt: serverTimestamp(),
      [`members/${myUid}`]: {
        name: cleanName,
        joinedAt: room.members?.[myUid]?.joinedAt ?? serverTimestamp(),
        muted: room.members?.[myUid]?.muted ?? false,
        role: isHost ? 'lead' : (room.members?.[myUid]?.role ?? 'rider'),
      },
    });

    return this.attachSession(code, room, myUid, claimedSlot, cleanName);
  }

  private attachSession(
    code: string,
    initialRoom: FirebaseRoomSnapshot,
    myUid: string,
    mySlot: number,
    initialName: string,
  ): SignalingRoomSession {
    const isHost = initialRoom.hostUid === myUid;
    const meta: RoomStateMeta = {
      code,
      hostUid: initialRoom.hostUid,
      createdAt: initialRoom.createdAt || this.nowServer(),
      lastActivityAt: initialRoom.lastActivityAt || this.nowServer(),
      status: 'active',
      myUid,
      mySlot,
      isHost,
      backend: 'firebase',
    };

    let currentMemberPatch: { name: string; muted: boolean; role: RiderRole } = {
      name: initialName,
      muted: false,
      role: isHost ? 'lead' : 'rider',
    };

    const memberListeners = new Set<(members: RoomMember[]) => void>();
    const signalListeners = new Set<(fromUid: string, payload: SignalPayload) => void>();
    const bufferedSignals: Array<{ fromUid: string; payload: SignalPayload }> = [];
    const endedListeners = new Set<(reason: RoomEndReason) => void>();
    const unsubscribers: Array<() => void> = [];
    const peerSignalUnsubs = new Map<string, () => void>();

    let closed = false;
    let endedEmitted = false;

    const emitEndedOnce = (reason: RoomEndReason) => {
      if (endedEmitted) return;
      endedEmitted = true;
      meta.status = 'ended';
      for (const cb of endedListeners) cb(reason);
    };

    const memberRef = ref(this.db, `rooms/${code}/members/${myUid}`);
    const lastActivityRef = ref(this.db, `rooms/${code}/lastActivityAt`);

    // Re-register presence + server-side onDisconnect whenever Firebase reconnects (e.g. exiting tunnel)
    const connectedUnsub = onValue(ref(this.db, '.info/connected'), async (snap) => {
      if (closed || !snap.val()) return;
      await onDisconnect(memberRef).remove().catch(() => undefined);
      await onDisconnect(lastActivityRef).set(serverTimestamp()).catch(() => undefined);
      await update(ref(this.db, `rooms/${code}`), {
        lastActivityAt: serverTimestamp(),
        [`members/${myUid}`]: {
          name: currentMemberPatch.name,
          joinedAt: serverTimestamp(),
          muted: currentMemberPatch.muted,
          role: currentMemberPatch.role,
        },
      }).catch(() => undefined);
    });
    unsubscribers.push(connectedUnsub);

    // Watch room state, slots, and active members
    const roomUnsub = onValue(ref(this.db, `rooms/${code}`), (snap) => {
      if (closed) return;
      if (!snap.exists()) {
        emitEndedOnce('host_ended');
        return;
      }
      const r = snap.val() as FirebaseRoomSnapshot;
      const activeCount = r.members ? Object.keys(r.members).length : 0;
      const expiry = evaluateRoomExpiry(
        {
          status: r.status,
          createdAt: r.createdAt,
          lastActivityAt: r.lastActivityAt ?? r.createdAt,
          activeMemberCount: activeCount,
        },
        this.nowServer(),
      );

      if (expiry.expired) {
        const reason: RoomEndReason =
          expiry.reason === 'max_duration'
            ? 'max_duration'
            : expiry.reason === 'idle_empty'
              ? 'idle_empty'
              : 'host_ended';
        emitEndedOnce(reason);
        return;
      }

      const slotByUid = new Map<string, number>();
      if (r.slots) {
        for (const [idxStr, uid] of Object.entries(r.slots)) {
          slotByUid.set(uid, Number(idxStr));
        }
      }

      const members: RoomMember[] = Object.entries(r.members ?? {})
        .map(([uid, m]) => ({
          uid,
          name: m.name,
          slot: slotByUid.get(uid) ?? 0,
          joinedAt: typeof m.joinedAt === 'number' ? m.joinedAt : meta.createdAt,
          muted: Boolean(m.muted),
          role: m.role ?? (uid === r.hostUid ? 'lead' : 'rider'),
        }))
        .sort((a, b) => a.slot - b.slot);

      // Attach inbox listeners per peer
      for (const m of members) {
        if (m.uid === myUid || peerSignalUnsubs.has(m.uid)) continue;
        const peerInboxRef = ref(this.db, `rooms/${code}/signals/${myUid}/${m.uid}`);
        const unsub = onChildAdded(peerInboxRef, (sigSnap) => {
          if (closed || !sigSnap.exists()) return;
          const payload = sigSnap.val() as SignalPayload;
          remove(sigSnap.ref).catch(() => undefined);
          if (signalListeners.size === 0) {
            bufferedSignals.push({ fromUid: m.uid, payload });
          } else {
            for (const cb of signalListeners) cb(m.uid, payload);
          }
        });
        peerSignalUnsubs.set(m.uid, unsub);
      }

      for (const cb of memberListeners) cb(members);
    });
    unsubscribers.push(roomUnsub);

    // Watchdog for 2-hour max ride limit
    const expiryWatchdog = window.setInterval(() => {
      if (closed) return;
      if (this.nowServer() - meta.createdAt > 2 * 60 * 60 * 1000) {
        if (isHost) {
          remove(ref(this.db, `rooms/${code}`)).catch(() => undefined);
        }
        emitEndedOnce('max_duration');
      }
    }, 5_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      window.clearInterval(expiryWatchdog);
      for (const u of unsubscribers) u();
      for (const u of peerSignalUnsubs.values()) u();
      peerSignalUnsubs.clear();
    };

    return {
      meta,
      getServerNow: () => this.nowServer(),
      updateMyState: async (patch) => {
        if (closed) return;
        currentMemberPatch = { ...currentMemberPatch, ...patch };
        await update(memberRef, patch);
      },
      sendSignal: async (toUid, payload) => {
        if (closed) return;
        const outboxRef = ref(this.db, `rooms/${code}/signals/${toUid}/${myUid}`);
        await set(push(outboxRef), payload);
      },
      onMembers: (cb) => {
        memberListeners.add(cb);
        return () => {
          memberListeners.delete(cb);
        };
      },
      onSignal: (cb) => {
        signalListeners.add(cb);
        while (bufferedSignals.length > 0) {
          const item = bufferedSignals.shift();
          if (item) cb(item.fromUid, item.payload);
        }
        return () => {
          signalListeners.delete(cb);
        };
      },
      onEnded: (cb) => {
        endedListeners.add(cb);
        return () => {
          endedListeners.delete(cb);
        };
      },
      disconnectTemporarily: async () => {
        await onDisconnect(memberRef).cancel().catch(() => undefined);
        await update(ref(this.db, `rooms/${code}`), {
          lastActivityAt: serverTimestamp(),
          [`members/${myUid}`]: null,
        }).catch(() => undefined);
        cleanup();
      },
      leaveRoom: async () => {
        await onDisconnect(memberRef).cancel().catch(() => undefined);
        await update(ref(this.db, `rooms/${code}`), {
          lastActivityAt: serverTimestamp(),
          [`members/${myUid}`]: null,
          [`slots/${mySlot}`]: null,
        }).catch(() => undefined);
        cleanup();
      },
      endRoom: async () => {
        if (!isHost) {
          throw new SignalingError('NOT_HOST', 'Only the ride creator can end the ride.');
        }
        await update(ref(this.db, `rooms/${code}`), { status: 'ended' }).catch(() => undefined);
        await remove(ref(this.db, `rooms/${code}`)).catch(() => undefined);
        emitEndedOnce('host_ended');
        cleanup();
      },
    };
  }
}

/* ============================================================================
 * 3. FACTORY (Auto-selects Firebase when configured, else Local Multi-Tab Demo)
 * ============================================================================ */

let singletonClient: SignalingClient | null = null;

export function getSignalingClient(): SignalingClient {
  if (singletonClient) return singletonClient;

  const params = new URLSearchParams(window.location.search);
  const forceLocal = params.get('mode') === 'local';

  const apiKey = import.meta.env.VITE_FIREBASE_API_KEY as string | undefined;
  const databaseURL = import.meta.env.VITE_FIREBASE_DATABASE_URL as string | undefined;

  if (!forceLocal && apiKey && databaseURL) {
    singletonClient = new FirebaseSignalingClient({
      apiKey,
      authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN as string | undefined,
      databaseURL,
      projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID as string | undefined,
      appId: import.meta.env.VITE_FIREBASE_APP_ID as string | undefined,
    });
  } else {
    singletonClient = new LocalSignalingClient();
  }

  return singletonClient;
}

