import { haversineKm, type GeoPoint } from './geo';

export interface CompletedRideRecord {
  id: string;
  code: string;
  startedAt: number;
  endedAt: number;
  durationSec: number;
  movingTimeSec: number;
  distanceKm: number;
  avgSpeedKmh: number;
  topSpeedKmh: number;
  riders: string[];
  points: Array<{ lat: number; lng: number; speedKmh: number; ts: number }>;
}

const DB_NAME = 'riderlink_rides_db';
const STORE_NAME = 'rides';
const FALLBACK_LS_KEY = 'riderlink:past_rides:v1';

/**
 * Records a rider's own GPS breadcrumbs during an active ride (sampled at >= 8s or >= 25m)
 * and computes final ride telemetry on completion. Never uploaded anywhere.
 */
export class ActiveRideRecorder {
  readonly code: string;
  readonly startedAt: number;
  private readonly points: Array<{ lat: number; lng: number; speedKmh: number; ts: number }> = [];
  private readonly riderNames = new Set<string>();

  constructor(code: string, startedAt: number = Date.now()) {
    this.code = code;
    this.startedAt = startedAt;
  }

  noteRiders(names: readonly string[]): void {
    for (const n of names) {
      if (n.trim()) this.riderNames.add(n.trim());
    }
  }

  recordFix(fix: GeoPoint): void {
    const prev = this.points[this.points.length - 1];
    if (prev) {
      const dt = fix.ts - prev.ts;
      if (dt <= 0) return;
      const distKm = haversineKm(prev, fix);
      if (dt < 8_000 && distKm < 0.025) {
        return;
      }
    }
    this.points.push({
      lat: Number(fix.lat.toFixed(6)),
      lng: Number(fix.lng.toFixed(6)),
      speedKmh: fix.speedKmh,
      ts: fix.ts,
    });
  }

  finalize(endedAt: number = Date.now()): CompletedRideRecord {
    return computeRideSummary({
      id: `${this.code}-${this.startedAt}`,
      code: this.code,
      startedAt: this.startedAt,
      endedAt: Math.max(endedAt, this.startedAt + 1_000),
      riders: Array.from(this.riderNames),
      points: this.points,
    });
  }
}

export function computeRideSummary(input: {
  id: string;
  code: string;
  startedAt: number;
  endedAt: number;
  riders: string[];
  points: Array<{ lat: number; lng: number; speedKmh: number; ts: number }>;
}): CompletedRideRecord {
  const durationSec = Math.max(1, Math.round((input.endedAt - input.startedAt) / 1000));
  let totalKm = 0;
  let movingMs = 0;
  let topSpeedKmh = 0;

  for (let i = 0; i < input.points.length; i++) {
    const pt = input.points[i];
    if (pt.speedKmh > topSpeedKmh) {
      topSpeedKmh = pt.speedKmh;
    }
    if (i > 0) {
      const prev = input.points[i - 1];
      const segKm = haversineKm(prev, pt);
      const dtMs = pt.ts - prev.ts;
      if (dtMs <= 0) continue;
      // Guard against GPS teleport spikes (> 250 km/h)
      const segSpeedKmh = segKm / (dtMs / 3_600_000);
      if (segSpeedKmh <= 250) {
        totalKm += segKm;
        if (segSpeedKmh >= 4 || pt.speedKmh >= 4) {
          movingMs += dtMs;
        }
        if (Math.round(segSpeedKmh) > topSpeedKmh && pt.speedKmh === 0) {
          topSpeedKmh = Math.round(segSpeedKmh);
        }
      }
    }
  }

  const movingTimeSec = Math.round(movingMs / 1000);
  const distanceKm = Math.round(totalKm * 100) / 100;
  const effectiveHours = (movingTimeSec > 10 ? movingTimeSec : durationSec) / 3600;
  const avgSpeedKmh =
    distanceKm > 0 && effectiveHours > 0 ? Math.round(distanceKm / effectiveHours) : 0;

  return {
    id: input.id,
    code: input.code,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    durationSec,
    movingTimeSec,
    distanceKm,
    avgSpeedKmh,
    topSpeedKmh: Math.round(topSpeedKmh),
    riders: input.riders,
    points: input.points,
  };
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Exports a completed ride into a standard GPX 1.1 XML document compatible with Strava, Relive & OsmAnd.
 */
export function exportRideToGpx(ride: CompletedRideRecord): string {
  const isoStart = new Date(ride.startedAt).toISOString();
  const trkpts = ride.points
    .map(
      (pt) =>
        `      <trkpt lat="${pt.lat}" lon="${pt.lng}"><time>${new Date(pt.ts).toISOString()}</time></trkpt>`,
    )
    .join('\n');

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="RiderLink Pack Intercom" xmlns="http://www.topografix.com/GPX/1/1">',
    '  <metadata>',
    `    <name>${escapeXml(`RiderLink Pack ${ride.code}`)}</name>`,
    `    <time>${isoStart}</time>`,
    '  </metadata>',
    '  <trk>',
    `    <name>${escapeXml(`Pack ${ride.code} (${ride.distanceKm} km)`)}</name>`,
    '    <trkseg>',
    trkpts,
    '    </trkseg>',
    '  </trk>',
    '</gpx>',
  ].join('\n');
}

/* ============================================================================
 * Local Device Storage (IndexedDB with localStorage fallback)
 * ============================================================================ */

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IDB error'));
  });
}

export async function saveCompletedRide(ride: CompletedRideRecord): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(ride);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    try {
      const prev = loadFallbackRides();
      const filtered = prev.filter((r) => r.id !== ride.id);
      filtered.unshift(ride);
      window.localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(filtered.slice(0, 20)));
    } catch {
      // Ignore
    }
  }
}

export async function listCompletedRides(): Promise<CompletedRideRecord[]> {
  try {
    const db = await openDb();
    const all = await new Promise<CompletedRideRecord[]>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as CompletedRideRecord[]) ?? []);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return all.sort((a, b) => b.endedAt - a.endedAt);
  } catch {
    return loadFallbackRides();
  }
}

export async function deleteCompletedRide(id: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    try {
      const next = loadFallbackRides().filter((r) => r.id !== id);
      window.localStorage.setItem(FALLBACK_LS_KEY, JSON.stringify(next));
    } catch {
      // Ignore
    }
  }
}

function loadFallbackRides(): CompletedRideRecord[] {
  try {
    const raw = window.localStorage.getItem(FALLBACK_LS_KEY);
    if (!raw) return [];
    return (JSON.parse(raw) as CompletedRideRecord[]).sort((a, b) => b.endedAt - a.endedAt);
  } catch {
    return [];
  }
}

