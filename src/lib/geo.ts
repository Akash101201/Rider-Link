export interface GeoPoint {
  lat: number;
  lng: number;
  speedKmh: number;
  heading: number | null;
  accuracy: number;
  ts: number;
}

const EARTH_RADIUS_KM = 6371;

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Computes great-circle Haversine distance between two coordinates in kilometers.
 */
export function haversineKm(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);
  const h =
    sinLat * sinLat +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * sinLng * sinLng;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Computes compass bearing in degrees (0..360) from point A to point B.
 */
export function computeBearingDeg(
  a: { lat: number; lng: number },
  b: { lat: number; lng: number },
): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x =
    Math.cos(lat1) * Math.sin(lat2) -
    Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export interface GpsTrackerOptions {
  onFix: (fix: GeoPoint) => void;
  onBroadcastDue: (fix: GeoPoint) => void;
  minBroadcastIntervalMs?: number;
  minBroadcastDistanceM?: number;
  maxAccuracyM?: number;
}

/**
 * Watches the phone's GPS while in an active ride, computes smoothed km/h speed
 * (deriving speed from displacement when `coords.speed` is null), and throttles
 * P2P broadcasts to every 5s or 40m moved.
 */
export function startGpsTracker(opts: GpsTrackerOptions): () => void {
  const minInterval = opts.minBroadcastIntervalMs ?? 5_000;
  const minDistanceKm = (opts.minBroadcastDistanceM ?? 40) / 1000;
  const maxAccuracy = opts.maxAccuracyM ?? 80;

  let prevFix: GeoPoint | null = null;
  let lastBroadcastFix: GeoPoint | null = null;
  let watchId: number | null = null;

  const ingestFix = (raw: {
    lat: number;
    lng: number;
    speedMps: number | null;
    heading: number | null;
    accuracy: number;
    ts: number;
  }) => {
    if (raw.accuracy > maxAccuracy && prevFix !== null) {
      return;
    }

    let speedKmh = raw.speedMps !== null && raw.speedMps >= 0 ? raw.speedMps * 3.6 : -1;
    let heading = raw.heading;

    if (prevFix) {
      const distKm = haversineKm(prevFix, raw);
      const dtHours = (raw.ts - prevFix.ts) / 3_600_000;
      if (speedKmh < 0 && dtHours > 0.0001) {
        const derived = distKm / dtHours;
        speedKmh = derived < 260 ? derived : 0;
      }
      if ((heading === null || Number.isNaN(heading)) && distKm > 0.008) {
        heading = computeBearingDeg(prevFix, raw);
      }
    }

    if (speedKmh < 1.5) speedKmh = 0;

    const point: GeoPoint = {
      lat: raw.lat,
      lng: raw.lng,
      speedKmh: Math.round(speedKmh),
      heading: heading !== null && !Number.isNaN(heading) ? Math.round(heading) : null,
      accuracy: Math.round(raw.accuracy),
      ts: raw.ts,
    };

    prevFix = point;
    opts.onFix(point);

    const shouldBroadcast =
      !lastBroadcastFix ||
      point.ts - lastBroadcastFix.ts >= minInterval ||
      haversineKm(lastBroadcastFix, point) >= minDistanceKm;

    if (shouldBroadcast) {
      lastBroadcastFix = point;
      opts.onBroadcastDue(point);
    }
  };

  if (typeof navigator !== 'undefined' && 'geolocation' in navigator) {
    try {
      watchId = navigator.geolocation.watchPosition(
        (pos) => {
          ingestFix({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            speedMps: pos.coords.speed,
            heading: pos.coords.heading,
            accuracy: pos.coords.accuracy ?? 15,
            ts: pos.timestamp || Date.now(),
          });
        },
        () => {
          // Rider denied GPS or indoors — voice intercom continues unaffected
        },
        {
          enableHighAccuracy: true,
          maximumAge: 3_000,
          timeout: 12_000,
        },
      );
    } catch {
      watchId = null;
    }
  }

  // Expose deterministic test hook for Playwright E2E telemetry & route tests
  const win = window as unknown as {
    __RIDERLINK_PUSH_GPS__?: (fix: {
      lat: number;
      lng: number;
      speedKmh?: number;
      heading?: number;
      ts?: number;
    }) => void;
  };

  win.__RIDERLINK_PUSH_GPS__ = (sim) => {
    ingestFix({
      lat: sim.lat,
      lng: sim.lng,
      speedMps: sim.speedKmh !== undefined ? sim.speedKmh / 3.6 : null,
      heading: sim.heading ?? null,
      accuracy: 8,
      ts: sim.ts ?? Date.now(),
    });
  };

  return () => {
    if (watchId !== null && typeof navigator !== 'undefined' && 'geolocation' in navigator) {
      navigator.geolocation.clearWatch(watchId);
    }
    delete win.__RIDERLINK_PUSH_GPS__;
  };
}

