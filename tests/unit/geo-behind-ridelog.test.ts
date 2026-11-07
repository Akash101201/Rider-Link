import { describe, expect, it } from 'vitest';
import { BehindMonitor, findLostContactUids } from '../../src/lib/behind';
import { haversineKm } from '../../src/lib/geo';
import { ActiveRideRecorder, exportRideToGpx } from '../../src/lib/rideLog';

describe('Geo, Falling-Behind Monitor & Local Ride Log', () => {
  it('computes accurate Haversine distances in km', () => {
    // Mumbai CSMT to Pune (~118-120 km straight-line)
    const mumbai = { lat: 18.9398, lng: 72.8355 };
    const pune = { lat: 18.5204, lng: 73.8567 };
    const d = haversineKm(mumbai, pune);
    expect(d).toBeGreaterThan(115);
    expect(d).toBeLessThan(125);
  });

  it('triggers fell_behind after dwell, respects cooldown, and emits caught_up', () => {
    const monitor = new BehindMonitor({
      thresholdKm: 2,
      dwellMs: 10_000,
      repeatCooldownMs: 60_000,
    });

    const leadPos = { lat: 19.0, lng: 73.0, ts: 1_000 };
    // ~3.3 km south of lead
    const behindPos = { lat: 18.97, lng: 73.0 };

    // Initial separation starts timer, does not alert before dwellMs
    expect(monitor.evaluate(behindPos, [leadPos], 2_000).kind).toBe('none');

    // After 10s dwell -> fell_behind!
    const alert = monitor.evaluate(behindPos, [{ ...leadPos, ts: 12_000 }], 12_500);
    expect(alert.kind).toBe('fell_behind');

    // Suppressed during cooldown
    expect(monitor.evaluate(behindPos, [{ ...leadPos, ts: 20_000 }], 20_000).kind).toBe('none');

    // Catches up to ~0.5 km -> emits caught_up!
    const closePos = { lat: 18.996, lng: 73.0 };
    const rec = monitor.evaluate(closePos, [{ ...leadPos, ts: 30_000 }], 30_000);
    expect(rec.kind).toBe('caught_up');
  });

  it('identifies riders who lost both audio and GPS contact > 2 minutes', () => {
    const lost = findLostContactUids(
      [
        { uid: 'r1', connected: true, lastSeenMs: 0 },
        { uid: 'r2', connected: false, lastSeenMs: 50_000 },
        { uid: 'r3', connected: false, lastSeenMs: 10_000 },
      ],
      150_000,
      120_000,
    );
    expect(lost).toEqual(['r3']);
  });

  it('records ride breadcrumbs, calculates telemetry stats, and exports valid GPX 1.1', () => {
    const t0 = 1_700_000_000_000;
    const rec = new ActiveRideRecorder('K7MQ3X', t0);
    rec.noteRiders(['Akash', 'Rahul']);

    // Simulate 3 points moving ~1.11 km north each (0.01 deg lat = ~1.112 km)
    rec.recordFix({ lat: 19.0, lng: 72.85, speedKmh: 55, heading: 0, accuracy: 8, ts: t0 });
    rec.recordFix({
      lat: 19.01,
      lng: 72.85,
      speedKmh: 68,
      heading: 0,
      accuracy: 8,
      ts: t0 + 60_000,
    });
    rec.recordFix({
      lat: 19.02,
      lng: 72.85,
      speedKmh: 72,
      heading: 0,
      accuracy: 8,
      ts: t0 + 120_000,
    });

    const summary = rec.finalize(t0 + 120_000);
    expect(summary.distanceKm).toBeGreaterThan(2.1);
    expect(summary.distanceKm).toBeLessThan(2.35);
    expect(summary.topSpeedKmh).toBe(72);
    expect(summary.riders).toEqual(['Akash', 'Rahul']);

    const gpx = exportRideToGpx(summary);
    expect(gpx).toContain('<gpx version="1.1"');
    expect(gpx).toContain('<trkpt lat="19.01" lon="72.85">');
  });
});

