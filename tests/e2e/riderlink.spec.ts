import { expect, test } from '@playwright/test';
import path from 'node:path';

const ARTIFACT_DIR =
  '/Users/akash/.gemini/antigravity/brain/6bfac2f1-7cfc-4643-a37e-92db1b2d85d8';

test.describe('RiderLink Mobile Moto Cockpit E2E', () => {
  test('connects 6-rider WebRTC audio mesh, blocks 7th rider, delivers alerts, radar, auto-rejoin & summary', async ({
    browser,
  }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      permissions: ['microphone', 'geolocation'],
      geolocation: { latitude: 19.07, longitude: 72.8777 },
    });

    await context.addInitScript(() => {
      (
        window as unknown as { __RIDERLINK_BEHIND_DWELL_MS__?: number }
      ).__RIDERLINK_BEHIND_DWELL_MS__ = 300;
    });

    const p1 = await context.newPage();
    await p1.goto('/?mode=local');

    // Screenshot 1: Moto Cockpit Paddock Home Screen
    await expect(p1.getByTestId('home-screen')).toBeVisible();
    await p1.getByTestId('callsign-input').fill('AKASH · GT650');
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_01_paddock_home.png'),
    });

    // Creator starts pack ride
    await p1.getByTestId('start-ride-btn').click();
    await expect(p1.getByTestId('room-screen')).toBeVisible();

    const plateText = (await p1.getByTestId('room-code-badge').innerText()).split('\n')[0];
    const roomCode = plateText.replace(/[^A-Z0-9]/g, '');
    expect(roomCode).toHaveLength(6);

    // Join 5 more riders (total = 6 riders including creator)
    const riderNames = [
      'RAHUL · DUKE',
      'KABIR · HIMMY',
      'VIKRAM · R15',
      'ROHAN · INT650',
      'DEV · D400',
    ];
    const joinerPages = [];

    for (const rName of riderNames) {
      const page = await context.newPage();
      await page.goto(`/?mode=local`);
      await page.getByTestId('callsign-input').fill(rName);
      await page.getByTestId('join-code-input').fill(roomCode);
      await page.getByTestId('join-ride-btn').click();
      await expect(page.getByTestId('room-screen')).toBeVisible();
      joinerPages.push(page);
    }

    // Wait for all 6 helmet pods on Creator's cockpit to reach LIVE WebRTC state
    for (let slot = 0; slot < 6; slot++) {
      await expect(p1.getByTestId(`pod-rider-${slot}`)).toHaveAttribute(
        'data-conn-status',
        'live',
      );
    }

    // Verify genuine WebRTC RTP audio packets are flowing across the 6-rider mesh
    await expect
      .poll(
        async () => {
          return p1.evaluate(async () => {
            const m = (
              window as unknown as {
                __RIDERLINK_MESH__?: {
                  getStats: () => Promise<{
                    connectedPeers: number;
                    openChannels: number;
                    bytesSent: number;
                    bytesReceived: number;
                  }>;
                };
              }
            ).__RIDERLINK_MESH__;
            if (!m) return { connectedPeers: 0, openChannels: 0, bytesSent: 0, bytesReceived: 0 };
            return m.getStats();
          });
        },
        { timeout: 12_000 },
      )
      .toMatchObject({
        connectedPeers: 5,
        openChannels: 5,
      });

    const stats = await p1.evaluate(async () => {
      const m = (
        window as unknown as {
          __RIDERLINK_MESH__: {
            getStats: () => Promise<{ bytesSent: number; bytesReceived: number }>;
          };
        }
      ).__RIDERLINK_MESH__;
      return m.getStats();
    });
    expect(stats.bytesSent).toBeGreaterThan(0);
    expect(stats.bytesReceived).toBeGreaterThan(0);

    // Screenshot 2: 6-Rider Full Pack Moto Cockpit
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_02_full_pack_cockpit.png'),
    });

    // Screenshot 3: Fuel-Stop QR Boarding Sheet
    await p1.getByTestId('open-qr-btn').click();
    await expect(p1.getByText('Scan to Join Pack')).toBeVisible();
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_03_qr_boarding.png'),
    });
    await p1.getByLabel('Close QR modal').click();

    // 7th rider attempt -> must be rejected with Pack is full (6/6 riders)
    const p7 = await context.newPage();
    await p7.goto('/?mode=local');
    await p7.getByTestId('callsign-input').fill('EXTRA · RIDER7');
    await p7.getByTestId('join-code-input').fill(roomCode);
    await p7.getByTestId('join-ride-btn').click();
    await expect(p7.getByTestId('home-error')).toContainText('Pack is full (6/6 riders)');
    await p7.close();

    // Close riders 3..6 to keep remaining telemetry/rejoin assertions crisp & fast
    for (let i = 1; i < joinerPages.length; i++) {
      await joinerPages[i].close();
    }
    const p2 = joinerPages[0];

    // Phase 2: Quick Road Alert from Rider 2 -> arrives on Creator's cockpit over DataChannel
    await p2.getByTestId('alert-btn-hazard').click();
    await expect(p1.getByTestId('road-alert-toast')).toContainText('HAZARD');
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_04_road_alert_toast.png'),
    });

    // Stealth OLED HUD Mode + Double-Tap Mute
    await p1.getByTestId('stealth-hud-btn').click();
    await expect(p1.getByTestId('stealth-hud')).toBeVisible();
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_05_stealth_hud.png'),
    });
    // Double-tap anywhere on Stealth HUD to mute mic
    await p1.getByTestId('stealth-hud').click();
    await p1.getByTestId('stealth-hud').click();
    await expect(p1.getByTestId('stealth-hud')).toContainText('MIC MUTED');
    await p1.getByRole('button', { name: /WAKE UI/i }).click();
    await expect(p1.getByTestId('mute-toggle-btn')).toContainText('MIC MUTED');
    // Unmute back
    await p1.getByTestId('mute-toggle-btn').click();
    await expect(p1.getByTestId('mute-toggle-btn')).toContainText('MIC LIVE');

    // Phase 2: Auto-Rejoin on page reload -> Rider 2 reclaims exact slot 1 & reconnects WebRTC
    await p2.reload();
    await expect(p2.getByTestId('room-screen')).toBeVisible();
    await expect(p1.getByTestId('pod-rider-1')).toHaveAttribute('data-conn-status', 'live');

    // Phase 3: GPS Speedometer, Pack Radar Map & Falling-Behind Alert
    const baseTs = Date.now() + 1_000;
    // Push 3 breadcrumbs on Creator (~2.22 km route at 74 km/h)
    await p1.evaluate((t) => {
      const push = (
        window as unknown as {
          __RIDERLINK_PUSH_GPS__: (f: {
            lat: number;
            lng: number;
            speedKmh: number;
            heading: number;
            ts: number;
          }) => void;
        }
      ).__RIDERLINK_PUSH_GPS__;
      push({ lat: 19.07, lng: 72.8777, speedKmh: 62, heading: 12, ts: t });
      push({ lat: 19.08, lng: 72.8777, speedKmh: 68, heading: 10, ts: t + 60_000 });
      push({ lat: 19.09, lng: 72.8777, speedKmh: 74, heading: 8, ts: t + 120_000 });
    }, baseTs);

    await expect(p1.getByTestId('cockpit-speed')).toHaveText('74');

    // Push Rider 2 ~3.3 km south so Rider 2 is > 2 km behind Creator
    await p2.evaluate((t) => {
      const push = (
        window as unknown as {
          __RIDERLINK_PUSH_GPS__: (f: {
            lat: number;
            lng: number;
            speedKmh: number;
            heading: number;
            ts: number;
          }) => void;
        }
      ).__RIDERLINK_PUSH_GPS__;
      push({ lat: 19.06, lng: 72.8777, speedKmh: 42, heading: 10, ts: t + 121_000 });
    }, baseTs);

    // Creator receives "RAHUL · DUKE IS BEHIND" alert
    await expect(p1.getByTestId('road-alert-toast')).toContainText('IS BEHIND');

    // Switch Creator to Pack Radar tab & verify live GPS rider tracking
    await p1.getByTestId('tab-radar').click();
    await expect(p1.getByTestId('pack-radar-map')).toBeVisible();
    await expect(p1.getByTestId('radar-tracked-count')).toContainText('GPS LIVE: 2/');
    await p1.getByRole('button', { name: /FIT PACK/i }).click();
    await p1.waitForTimeout(900);
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_06_pack_radar_map.png'),
    });

    // Hold-to-End Safety Guard: quick tap must NOT end the ride
    await p1.getByTestId('end-ride-btn').click();
    await expect(p1.getByTestId('room-screen')).toBeVisible();

    // Hold End Ride for 1.5s -> automatically completes & transitions BOTH Creator and Rider 2 to Ride Summary
    const endBtn = p1.getByTestId('end-ride-btn');
    await endBtn.dispatchEvent('pointerdown', { button: 0 });

    await expect(p1.getByTestId('ride-summary')).toBeVisible();
    await expect(p2.getByTestId('ride-summary')).toBeVisible();

    const summaryDistText = await p1.getByTestId('summary-distance').innerText();
    const distNum = parseFloat(summaryDistText);
    expect(distNum).toBeGreaterThan(2.1);
    expect(distNum).toBeLessThan(2.35);
    await expect(p1.getByTestId('export-gpx-btn')).toBeVisible();

    // Screenshot 7: Post-Ride Digital Telemetry Summary
    await p1.screenshot({
      path: path.join(ARTIFACT_DIR, 'riderlink_07_ride_summary.png'),
    });

    await context.close();
  });
});
