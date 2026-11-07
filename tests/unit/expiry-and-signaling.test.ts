import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_IDLE_MS, MAX_RIDE_MS, MAX_RIDERS } from '../../src/lib/constants';
import { evaluateRoomExpiry, formatDurationClock } from '../../src/lib/expiry';
import { LocalSignalingClient, SignalingError } from '../../src/lib/signaling';

describe('15-minute idle & 2-hour max auto-expiry rules', () => {
  it('keeps occupied room alive past 15 minutes up until 2 hours', () => {
    const t0 = 1_700_000_000_000;

    // 45 minutes into ride with 2 riders connected -> still active!
    const at45m = evaluateRoomExpiry(
      {
        status: 'active',
        createdAt: t0,
        lastActivityAt: t0,
        activeMemberCount: 2,
      },
      t0 + 45 * 60 * 1000,
    );
    expect(at45m.expired).toBe(false);
    expect(at45m.remainingRideMs).toBe(75 * 60 * 1000);

    // 2 hours + 1 second -> expires even with riders connected!
    const past2h = evaluateRoomExpiry(
      {
        status: 'active',
        createdAt: t0,
        lastActivityAt: t0 + 119 * 60 * 1000,
        activeMemberCount: 4,
      },
      t0 + MAX_RIDE_MS + 1_000,
    );
    expect(past2h.expired).toBe(true);
    expect(past2h.reason).toBe('max_duration');
  });

  it('expires empty room after 15 minutes with zero riders connected, but allows rejoin before 15m', () => {
    const t0 = 1_700_000_000_000;
    const lastLeftAt = t0 + 10 * 60 * 1000;

    // 14 minutes after last rider lost signal -> still valid for tunnel recovery!
    const at14mIdle = evaluateRoomExpiry(
      {
        status: 'active',
        createdAt: t0,
        lastActivityAt: lastLeftAt,
        activeMemberCount: 0,
      },
      lastLeftAt + 14 * 60 * 1000,
    );
    expect(at14mIdle.expired).toBe(false);
    expect(at14mIdle.remainingIdleMs).toBe(60 * 1000);

    // 15 minutes + 1 second with 0 riders -> expired!
    const at15mPlus = evaluateRoomExpiry(
      {
        status: 'active',
        createdAt: t0,
        lastActivityAt: lastLeftAt,
        activeMemberCount: 0,
      },
      lastLeftAt + MAX_IDLE_MS + 1_000,
    );
    expect(at15mPlus.expired).toBe(true);
    expect(at15mPlus.reason).toBe('idle_empty');
  });

  it('formats cockpit duration clocks cleanly', () => {
    expect(formatDurationClock(119 * 60 * 1000 + 5000)).toBe('01:59:05');
    expect(formatDurationClock(14 * 60 * 1000 + 9000)).toBe('14:09');
  });
});

function createMemoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => Array.from(map.keys())[index] ?? null,
    removeItem: (key: string) => {
      map.delete(key);
    },
    setItem: (key: string, value: string) => {
      map.set(key, String(value));
    },
  };
}

describe('LocalSignalingClient — 6-rider slot enforcement, auto-rejoin & host-only end', () => {
  let now = 1_700_000_000_000;
  let sharedStorage = createMemoryStorage();

  beforeEach(() => {
    sharedStorage = createMemoryStorage();
    now = 1_700_000_000_000;
  });

  it('allows up to 6 riders (creator + 5 joiners) and rejects the 7th rider', async () => {
    const clients = Array.from({ length: 7 }, (_, idx) => {
      return new LocalSignalingClient({
        uid: `uid-${idx}`,
        clock: () => now,
        storage: sharedStorage,
      });
    });

    const hostSession = await clients[0].createRoom('Lead Akash');
    const code = hostSession.meta.code;
    expect(hostSession.meta.isHost).toBe(true);
    expect(hostSession.meta.mySlot).toBe(0);

    const joinerSessions = [];
    for (let i = 1; i < MAX_RIDERS; i++) {
      const s = await clients[i].joinRoom(code, `Rider ${i + 1}`);
      expect(s.meta.mySlot).toBe(i);
      expect(s.meta.isHost).toBe(false);
      joinerSessions.push(s);
    }

    // 7th rider must be rejected with ROOM_FULL
    await expect(clients[6].joinRoom(code, 'Extra Rider 7')).rejects.toMatchObject({
      code: 'ROOM_FULL',
    });

    // Simulate Rider 3 losing connection (tunnel / page reload) -> slot 2 stays reserved for uid-2
    await joinerSessions[1].disconnectTemporarily();
    const rejoined = await clients[2].joinRoom(code, 'Rider 3');
    expect(rejoined.meta.mySlot).toBe(2);

    // Non-host cannot end ride
    await expect(rejoined.endRoom()).rejects.toBeInstanceOf(SignalingError);

    // Host ends ride -> room is ended
    let endedNotified = false;
    rejoined.onEnded((reason) => {
      if (reason === 'host_ended') endedNotified = true;
    });
    await hostSession.endRoom();
    await new Promise((r) => setTimeout(r, 30));
    expect(endedNotified).toBe(true);

    const checkAfterEnd = await clients[0].inspectRoom(code);
    expect(checkAfterEnd.active).toBe(false);

    for (const s of joinerSessions) await s.leaveRoom();
    await rejoined.leaveRoom();
  });

  it('expires room in LocalSignalingClient when idle > 15m or age > 2h', async () => {
    const hostClient = new LocalSignalingClient({
      uid: 'host-1',
      clock: () => now,
      storage: sharedStorage,
    });

    const s = await hostClient.createRoom('Akash');
    const code = s.meta.code;

    // Host loses signal cleanly
    await s.disconnectTemporarily();

    // Advance 10 minutes -> still active!
    now += 10 * 60 * 1000;
    expect((await hostClient.inspectRoom(code)).active).toBe(true);

    // Advance another 6 minutes (16m total with 0 members) -> expired!
    now += 6 * 60 * 1000;
    const status = await hostClient.inspectRoom(code);
    expect(status.active).toBe(false);
    expect(status.reason).toBe('idle_empty');
  });
});
