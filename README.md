# RiderLink — Free, Private Group Intercom for Bikers (PWA)

**RiderLink** turns any smartphone and Bluetooth helmet headset into a hands-free, encrypted group intercom and pack radar for up to **6 riders (including the creator)** — built entirely on free tiers.

## Features

- **6-Character Helmet Pack Codes (`K7M · Q3X`):** Creator starts a ride and invites up to 5 fellow riders via code, WhatsApp/Web Share link, or Fuel-Stop QR scan.
- **100% Private P2P Encrypted Audio:** Voice, quick road alerts, and live GPS coordinates flow phone-to-phone over WebRTC (`DTLS-SRTP` + `SCTP` DataChannels). Nothing is recorded or stored on a server.
- **Moto Wind & Exhaust Filter:** Built-in 185 Hz high-pass Web Audio filter + compressor cuts helmet wind roar and exhaust drone, with tuned Opus FEC/DTX (`~32 kbps` mono) for patchy highway 4G.
- **Auto-Expiry Rules (Serverless):** Rooms close immediately when the creator holds **End Ride**, or expire automatically after **15 minutes with zero riders connected** or **2 hours from creation**.
- **Quick Road Alerts (Human Voice):** One-tap glove buttons (`HAZARD`, `POLICE`, `SLOW`, `PULL OVER`, `FUEL`, `BREAK`) play a helmet chime and speak naturally in every rider's headset.
- **Auto-Rejoin:** Reconnects into your reserved slot automatically if the app reloads or signal drops through a tunnel.
- **Pack Radar & Local Ride Telemetry:** Live group map with directional rider markers (`LEAD` / `SWEEP`), falling-behind alerts, OLED **Stealth HUD** mode (double-tap anywhere to mute), and on-device Ride Summary + GPX export.

---

## Quick Local Run (Zero Config Needed)

Without `.env` keys, RiderLink runs automatically in **Local Multi-Tab Demo Mode** (`BroadcastChannel` + `localStorage`), so you can open up to 6 browser tabs on your machine and test full WebRTC voice, alerts, radar, and GPX telemetry immediately:

```bash
npm install
npm run dev
```

### Run Automated Verification
```bash
npm test          # Vitest unit test suite
npm run build     # TypeScript + production PWA bundle
npm run test:e2e  # Playwright 6-rider mobile E2E suite
```

---

## Free-Tier Production Setup (Vercel + Firebase + Cloudflare TURN)

### 1. Firebase Realtime Database (Spark Free Plan)
1. Go to [console.firebase.google.com](https://console.firebase.google.com) and create a project.
2. Enable **Authentication → Sign-in method → Anonymous**.
3. Enable **Realtime Database** (start in locked mode), then paste the contents of [`database.rules.json`](./database.rules.json) into the **Rules** tab and click **Publish** (or run `npx firebase deploy --only database`).
4. Go to **Project Settings → General → Your apps → Web app** and copy your `VITE_FIREBASE_*` keys.

### 2. Cloudflare Realtime TURN (Optional, Strongly Recommended — 1 TB/month Free)
Mobile carriers (Jio, Airtel, Vi, etc.) frequently use symmetric NATs that block direct P2P UDP without a TURN relay.
1. Open the [Cloudflare Dashboard](https://dash.cloudflare.com) → **Calls / Realtime → TURN Keys**.
2. Create a TURN Key to obtain `CF_TURN_KEY_ID` and `CF_TURN_API_TOKEN` (used only by [`api/turn.ts`](./api/turn.ts) on Vercel — never exposed to browsers).

### 3. Deploy Free on Vercel
1. Import this GitHub repository into [vercel.com](https://vercel.com).
2. Add the environment variables from [`.env.example`](./.env.example) (`VITE_FIREBASE_*`, `CF_TURN_KEY_ID`, `CF_TURN_API_TOKEN`).
3. Click **Deploy** — open the URL on Android Chrome or iOS Safari and tap **Add to Home Screen**.

