import { MAX_RIDE_MS } from './constants';

export interface SavedRideSession {
  code: string;
  riderName: string;
  isHost: boolean;
  joinedAt: number;
  backend: 'firebase' | 'local';
}

export interface RiderPreferences {
  riderName: string;
  windFilter: boolean;
  spokenAlerts: boolean;
  preferredVoice: string | null;
  behindThresholdKm: 1 | 2 | 5;
  daylightTheme: boolean;
}

const SESSION_KEY = 'riderlink:active_session:v1';
const PREFS_KEY = 'riderlink:prefs:v1';

const DEFAULT_PREFS: RiderPreferences = {
  riderName: '',
  windFilter: true,
  spokenAlerts: true,
  preferredVoice: null,
  behindThresholdKm: 2,
  daylightTheme: false,
};

function getSessionStore(backend: 'firebase' | 'local'): Storage {
  // In local multi-tab mode, sessionStorage keeps each tab independent while surviving tab reload!
  // In Firebase cloud mode, localStorage survives full PWA restarts on Android & iOS.
  return backend === 'local' ? window.sessionStorage : window.localStorage;
}

export function saveActiveSession(session: SavedRideSession): void {
  try {
    const store = getSessionStore(session.backend);
    store.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadActiveSession(
  backend: 'firebase' | 'local',
  nowMs: number = Date.now(),
): SavedRideSession | null {
  try {
    const store = getSessionStore(backend);
    const raw = store.getItem(SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as SavedRideSession;
    if (!parsed.code || typeof parsed.joinedAt !== 'number') {
      store.removeItem(SESSION_KEY);
      return null;
    }
    if (nowMs - parsed.joinedAt > MAX_RIDE_MS) {
      store.removeItem(SESSION_KEY);
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function clearActiveSession(backend: 'firebase' | 'local'): void {
  try {
    getSessionStore(backend).removeItem(SESSION_KEY);
  } catch {
    // Ignore
  }
}

export function loadRiderPreferences(): RiderPreferences {
  try {
    // Check tab-specific callsign first so multi-tab demos retain distinct rider names
    const tabName = window.sessionStorage.getItem('riderlink:tab:name');
    const raw = window.localStorage.getItem(PREFS_KEY);
    const base = raw ? ({ ...DEFAULT_PREFS, ...JSON.parse(raw) } as RiderPreferences) : DEFAULT_PREFS;
    return {
      ...base,
      riderName: tabName ?? base.riderName,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function saveRiderPreferences(patch: Partial<RiderPreferences>): RiderPreferences {
  const next = { ...loadRiderPreferences(), ...patch };
  try {
    if (patch.riderName !== undefined) {
      window.sessionStorage.setItem('riderlink:tab:name', patch.riderName);
    }
    window.localStorage.setItem(PREFS_KEY, JSON.stringify(next));
  } catch {
    // Ignore
  }
  return next;
}

export function isIosDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
  );
}

