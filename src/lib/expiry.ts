import { MAX_IDLE_MS, MAX_RIDE_MS } from './constants';

export interface RoomLifecycleSnapshot {
  status: 'active' | 'ended';
  createdAt: number;
  lastActivityAt: number;
  activeMemberCount: number;
}

export type ExpiryReason = 'none' | 'ended' | 'max_duration' | 'idle_empty';

export interface RoomExpiryEvaluation {
  expired: boolean;
  reason: ExpiryReason;
  remainingRideMs: number;
  remainingIdleMs: number | null;
}

/**
 * Evaluates whether a room has ended or auto-expired under RiderLink's two rules:
 * 1. Hard cap: 2 hours since creation (`createdAt`).
 * 2. Idle cap: 15 minutes with zero connected riders (`activeMemberCount === 0` since `lastActivityAt`).
 */
export function evaluateRoomExpiry(
  room: RoomLifecycleSnapshot,
  nowMs: number,
): RoomExpiryEvaluation {
  if (room.status === 'ended') {
    return {
      expired: true,
      reason: 'ended',
      remainingRideMs: 0,
      remainingIdleMs: 0,
    };
  }

  const ageMs = Math.max(0, nowMs - room.createdAt);
  if (ageMs > MAX_RIDE_MS) {
    return {
      expired: true,
      reason: 'max_duration',
      remainingRideMs: 0,
      remainingIdleMs: null,
    };
  }

  const remainingRideMs = Math.max(0, MAX_RIDE_MS - ageMs);

  if (room.activeMemberCount === 0) {
    const idleMs = Math.max(0, nowMs - room.lastActivityAt);
    if (idleMs > MAX_IDLE_MS) {
      return {
        expired: true,
        reason: 'idle_empty',
        remainingRideMs,
        remainingIdleMs: 0,
      };
    }
    return {
      expired: false,
      reason: 'none',
      remainingRideMs,
      remainingIdleMs: Math.max(0, MAX_IDLE_MS - idleMs),
    };
  }

  return {
    expired: false,
    reason: 'none',
    remainingRideMs,
    remainingIdleMs: null,
  };
}

/**
 * Formats milliseconds into a compact TFT cockpit timer string (e.g. "01:42:19" or "14:05").
 */
export function formatDurationClock(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;
  const mm = String(mins).padStart(2, '0');
  const ss = String(secs).padStart(2, '0');
  if (hours > 0) {
    return `${String(hours).padStart(2, '0')}:${mm}:${ss}`;
  }
  return `${mm}:${ss}`;
}
