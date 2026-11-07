import { haversineKm } from './geo';

export interface BehindMonitorConfig {
  thresholdKm: number;
  dwellMs?: number;
  repeatCooldownMs?: number;
}

export type BehindTransition =
  | { kind: 'none' }
  | { kind: 'fell_behind'; nearestKm: number }
  | { kind: 'caught_up'; nearestKm: number };

/**
 * Evaluates whether the local rider has fallen behind the nearest connected pack mate.
 * Each phone evaluates only itself and broadcasts transitions to avoid duplicate alerts.
 */
export class BehindMonitor {
  private thresholdKm: number;
  private readonly dwellMs: number;
  private readonly repeatCooldownMs: number;
  private separatedSince: number | null = null;
  private currentlyBehind = false;
  private lastAlertAt: number | null = null;

  constructor(cfg: BehindMonitorConfig) {
    this.thresholdKm = cfg.thresholdKm;
    this.dwellMs = cfg.dwellMs ?? 45_000;
    this.repeatCooldownMs = cfg.repeatCooldownMs ?? 5 * 60 * 1000;
  }

  setThresholdKm(km: number): void {
    this.thresholdKm = km;
  }

  evaluate(
    myPos: { lat: number; lng: number } | null,
    peerPositions: ReadonlyArray<{ lat: number; lng: number; ts: number }>,
    nowMs: number,
  ): BehindTransition {
    if (!myPos || peerPositions.length === 0) {
      this.separatedSince = null;
      return { kind: 'none' };
    }

    // Consider peer locations fresh within the last 90 seconds
    const freshPeers = peerPositions.filter((p) => nowMs - p.ts <= 90_000);
    if (freshPeers.length === 0) {
      return { kind: 'none' };
    }

    let nearestKm = Infinity;
    for (const peer of freshPeers) {
      const d = haversineKm(myPos, peer);
      if (d < nearestKm) nearestKm = d;
    }

    const roundedKm = Math.round(nearestKm * 10) / 10;

    if (nearestKm > this.thresholdKm) {
      if (this.separatedSince === null) {
        this.separatedSince = nowMs;
      }
      const separatedFor = nowMs - this.separatedSince;
      if (separatedFor >= this.dwellMs) {
        const cooldownOk =
          this.lastAlertAt === null || nowMs - this.lastAlertAt >= this.repeatCooldownMs;
        if (!this.currentlyBehind || cooldownOk) {
          this.currentlyBehind = true;
          this.lastAlertAt = nowMs;
          return { kind: 'fell_behind', nearestKm: roundedKm };
        }
      }
      return { kind: 'none' };
    }

    // Recovery hysteresis (85% of threshold) prevents flapping right on the boundary
    if (this.currentlyBehind && nearestKm <= this.thresholdKm * 0.85) {
      this.currentlyBehind = false;
      this.separatedSince = null;
      this.lastAlertAt = null;
      return { kind: 'caught_up', nearestKm: roundedKm };
    }

    if (!this.currentlyBehind) {
      this.separatedSince = null;
    }

    return { kind: 'none' };
  }
}

/**
 * Checks which pack mates have lost both audio connection and GPS updates for > 2 minutes.
 */
export function findLostContactUids(
  peers: ReadonlyArray<{
    uid: string;
    connected: boolean;
    lastSeenMs: number;
  }>,
  nowMs: number,
  lostThresholdMs: number = 120_000,
): string[] {
  const lost: string[] = [];
  for (const p of peers) {
    if (!p.connected && nowMs - p.lastSeenMs > lostThresholdMs) {
      lost.push(p.uid);
    }
  }
  return lost;
}

