import { ALERT_RATE_LIMIT_MS } from './constants';

export interface RoadAlertPreset {
  key: 'fuel' | 'police' | 'hazard' | 'pullover' | 'slow' | 'break';
  label: string;
  shortLabel: string;
  spokenPhrase: string;
  accent: string;
}

export const ROAD_ALERTS: readonly RoadAlertPreset[] = [
  {
    key: 'hazard',
    label: 'Hazard / Pothole',
    shortLabel: 'HAZARD',
    spokenPhrase: 'Hazard on road ahead',
    accent: '#FF6B00',
  },
  {
    key: 'police',
    label: 'Police / Check',
    shortLabel: 'POLICE',
    spokenPhrase: 'Police check ahead',
    accent: '#00E5FF',
  },
  {
    key: 'slow',
    label: 'Slow Down',
    shortLabel: 'SLOW',
    spokenPhrase: 'Slow down pack',
    accent: '#FFD600',
  },
  {
    key: 'pullover',
    label: 'Pull Over',
    shortLabel: 'PULL OVER',
    spokenPhrase: 'Pull over safely',
    accent: '#FF3D57',
  },
  {
    key: 'fuel',
    label: 'Fuel Stop',
    shortLabel: 'FUEL',
    spokenPhrase: 'Need a fuel stop',
    accent: '#00E676',
  },
  {
    key: 'break',
    label: 'Chai / Break',
    shortLabel: 'BREAK',
    spokenPhrase: 'Stop for a quick break',
    accent: '#9D6BFF',
  },
] as const;

export function getAlertPreset(key: string): RoadAlertPreset | undefined {
  return ROAD_ALERTS.find((a) => a.key === key);
}

export interface IncomingRoadAlert {
  id: string;
  alertKey: RoadAlertPreset['key'];
  fromUid: string;
  fromName: string;
  ts: number;
}

/**
 * Enforces per-rider alert rate limiting (1 alert per 3 seconds) and
 * deduplicates broadcast alert IDs across mesh paths.
 */
export class RoadAlertGuard {
  private readonly seenIds = new Set<string>();
  private readonly lastBySender = new Map<string, number>();
  private readonly rateLimitMs: number;

  constructor(rateLimitMs: number = ALERT_RATE_LIMIT_MS) {
    this.rateLimitMs = rateLimitMs;
  }

  canSend(myUid: string, nowMs: number): { allowed: boolean; cooldownRemainingMs: number } {
    const prev = this.lastBySender.get(myUid);
    if (prev !== undefined && nowMs - prev < this.rateLimitMs) {
      return {
        allowed: false,
        cooldownRemainingMs: this.rateLimitMs - (nowMs - prev),
      };
    }
    return { allowed: true, cooldownRemainingMs: 0 };
  }

  recordSent(id: string, myUid: string, nowMs: number): void {
    this.seenIds.add(id);
    this.lastBySender.set(myUid, nowMs);
  }

  acceptIncoming(alert: { id: string; fromUid: string }, nowMs: number): boolean {
    if (!alert.id || this.seenIds.has(alert.id)) {
      return false;
    }
    const prev = this.lastBySender.get(alert.fromUid);
    if (prev !== undefined && nowMs - prev < this.rateLimitMs - 250) {
      return false;
    }
    this.seenIds.add(alert.id);
    this.lastBySender.set(alert.fromUid, nowMs);

    // Keep bounded memory
    if (this.seenIds.size > 200) {
      const first = this.seenIds.values().next().value;
      if (first) this.seenIds.delete(first);
    }
    return true;
  }
}

