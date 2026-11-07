import { useEffect, useState, type FormEvent } from 'react';
import {
  Bluetooth,
  Download,
  History,
  Moon,
  Power,
  Radio,
  ShieldCheck,
  Sun,
  Trash2,
} from 'lucide-react';
import { CODE_LENGTH, MAX_RIDERS } from '../lib/constants';
import { formatPlateCode, isValidRoomCode, normalizeCode } from '../lib/code';
import {
  deleteCompletedRide,
  listCompletedRides,
  type CompletedRideRecord,
} from '../lib/rideLog';
import type { RiderPreferences } from '../lib/session';
import { HelmetAvatar } from './HelmetAvatar';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

interface HomeProps {
  initialJoinCode?: string;
  prefs: RiderPreferences;
  backend: 'firebase' | 'local';
  busy: boolean;
  errorMessage: string | null;
  onUpdatePrefs: (patch: Partial<RiderPreferences>) => void;
  onStartRide: (riderName: string) => void;
  onJoinRide: (code: string, riderName: string) => void;
  onOpenPastRide: (ride: CompletedRideRecord) => void;
}

export function Home({
  initialJoinCode = '',
  prefs,
  backend,
  busy,
  errorMessage,
  onUpdatePrefs,
  onStartRide,
  onJoinRide,
  onOpenPastRide,
}: HomeProps) {
  const [name, setName] = useState(prefs.riderName);
  const [joinCode, setJoinCode] = useState(() => normalizeCode(initialJoinCode));
  const [pastRides, setPastRides] = useState<CompletedRideRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    if (initialJoinCode) {
      setJoinCode(normalizeCode(initialJoinCode));
    }
  }, [initialJoinCode]);

  useEffect(() => {
    listCompletedRides()
      .then(setPastRides)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setInstallPrompt(e as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const cleanName = name.trim() || 'Rider';
  const normalizedJoin = normalizeCode(joinCode);
  const joinReady = isValidRoomCode(normalizedJoin);

  const handleStart = () => {
    onUpdatePrefs({ riderName: cleanName });
    onStartRide(cleanName);
  };

  const handleJoinSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!joinReady || busy) return;
    onUpdatePrefs({ riderName: cleanName });
    onJoinRide(normalizedJoin, cleanName);
  };

  const handleDeleteRide = async (id: string) => {
    await deleteCompletedRide(id);
    setPastRides((prev) => prev.filter((r) => r.id !== id));
  };

  return (
    <main className="cockpit-shell home-screen" data-testid="home-screen">
      {/* Top TFT Status Strip */}
      <header className="tft-status-bar">
        <div className="brand-lockup">
          <HelmetAvatar color="#FF6B00" size={38} />
          <div>
            <div className="brand-title">RIDERLINK</div>
            <div className="brand-sub">PACK INTERCOM · {MAX_RIDERS} MAX</div>
          </div>
        </div>

        <div className="tft-status-bar__right">
          <span
            className="mode-pill"
            title={
              backend === 'firebase'
                ? 'Connected to Firebase Cloud Signaling'
                : 'Local Multi-Tab Demo Signaling (add .env keys for multi-phone cloud)'
            }
          >
            <Radio size={12} />
            {backend === 'firebase' ? 'CLOUD' : 'LOCAL'}
          </span>

          <button
            type="button"
            className="icon-pill-btn"
            onClick={() => onUpdatePrefs({ daylightTheme: !prefs.daylightTheme })}
            aria-label="Toggle daylight or night theme"
            title="Toggle Daylight / Night TFT theme"
          >
            {prefs.daylightTheme ? <Moon size={17} /> : <Sun size={17} />}
          </button>
        </div>
      </header>

      {/* Telemetry Capability Ribbon */}
      <div className="capability-ribbon">
        <span>
          <Bluetooth size={13} /> Helmet BT Ready
        </span>
        <span>
          <ShieldCheck size={13} /> Encrypted P2P Voice
        </span>
      </div>

      {errorMessage && (
        <div className="cockpit-alert-banner cockpit-alert-banner--error" role="alert" data-testid="home-error">
          {errorMessage}
        </div>
      )}

      {/* Callsign Input Card */}
      <section className="cockpit-card">
        <label htmlFor="rider-callsign" className="field-label">
          RIDER CALLSIGN / BIKE
        </label>
        <input
          id="rider-callsign"
          data-testid="callsign-input"
          type="text"
          maxLength={22}
          placeholder="e.g. AKASH · GT650"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="cockpit-input"
          autoComplete="nickname"
        />
      </section>

      {/* Primary Ignition CTA — Start Pack Ride */}
      <section className="ignition-card">
        <div className="ignition-card__meta">
          <span className="eyebrow-tag">LEAD RIDER</span>
          <span className="expiry-note">Auto-expires: 15m idle · 2h max</span>
        </div>
        <button
          type="button"
          data-testid="start-ride-btn"
          disabled={busy}
          className="ignition-btn"
          onClick={handleStart}
        >
          <span className="ignition-btn__icon">
            <Power size={24} />
          </span>
          <span className="ignition-btn__text">
            <strong>{busy ? 'IGNITING COMMS…' : 'START PACK RIDE'}</strong>
            <small>Generates a 6-digit helmet code for up to 6 riders</small>
          </span>
        </button>
      </section>

      {/* Join Existing Pack via 6-Character License-Plate Input */}
      <form className="cockpit-card join-card" onSubmit={handleJoinSubmit}>
        <div className="join-card__header">
          <label htmlFor="pack-code-input" className="field-label">
            JOIN PACK BY 6-DIGIT CODE
          </label>
          {normalizedJoin.length > 0 && (
            <span className="plate-preview">{formatPlateCode(normalizedJoin)}</span>
          )}
        </div>

        <div className="plate-input-wrap">
          <input
            id="pack-code-input"
            data-testid="join-code-input"
            type="text"
            inputMode="text"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            maxLength={9}
            placeholder="K7M Q3X"
            value={joinCode}
            onChange={(e) => setJoinCode(normalizeCode(e.target.value))}
            className="plate-code-input"
          />
          <div className="plate-slots-indicator" aria-hidden="true">
            {Array.from({ length: CODE_LENGTH }).map((_, idx) => (
              <span
                key={idx}
                className={`plate-slot-dot ${idx < normalizedJoin.length ? 'is-filled' : ''}`}
              />
            ))}
          </div>
        </div>

        <button
          type="submit"
          data-testid="join-ride-btn"
          disabled={!joinReady || busy}
          className="btn-secondary btn-join-pack"
        >
          JOIN PACK INTERCOM
        </button>
      </form>

      {/* Footer Utilities: Install PWA & Past Ride Telemetry */}
      <footer className="home-footer">
        {installPrompt && (
          <button
            type="button"
            className="footer-chip-btn"
            onClick={async () => {
              await installPrompt.prompt();
              setInstallPrompt(null);
            }}
          >
            <Download size={15} />
            <span>Install App</span>
          </button>
        )}

        {pastRides.length > 0 && (
          <button
            type="button"
            className="footer-chip-btn"
            data-testid="past-rides-btn"
            onClick={() => setShowHistory((s) => !s)}
          >
            <History size={15} />
            <span>Past Rides ({pastRides.length})</span>
          </button>
        )}
      </footer>

      {showHistory && pastRides.length > 0 && (
        <section className="cockpit-card history-drawer" data-testid="past-rides-list">
          <div className="field-label">LOCAL RIDE LOGS (STORED ON THIS PHONE)</div>
          <div className="history-items">
            {pastRides.map((r) => (
              <div key={r.id} className="history-item">
                <button
                  type="button"
                  className="history-item__main"
                  onClick={() => onOpenPastRide(r)}
                >
                  <strong>{formatPlateCode(r.code)}</strong>
                  <span>
                    {r.distanceKm.toFixed(1)} km · {new Date(r.startedAt).toLocaleDateString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="icon-pill-btn"
                  onClick={() => handleDeleteRide(r.id)}
                  aria-label={`Delete ride ${r.code}`}
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))}
          </div>
        </section>
      )}
    </main>
  );
}

