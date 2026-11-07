import { useCallback, useEffect, useState } from 'react';
import { Power } from 'lucide-react';
import { formatPlateCode, isValidRoomCode, normalizeCode } from './lib/code';
import { createLocalAudioRig, playCommsTone, type LocalAudioRig } from './lib/audio';
import {
  clearActiveSession,
  isIosDevice,
  loadActiveSession,
  loadRiderPreferences,
  saveActiveSession,
  saveRiderPreferences,
  type RiderPreferences,
  type SavedRideSession,
} from './lib/session';
import {
  getSignalingClient,
  SignalingError,
  type SignalingRoomSession,
} from './lib/signaling';
import type { CompletedRideRecord } from './lib/rideLog';
import { Home } from './components/Home';
import { RideSummary } from './components/RideSummary';
import { Room } from './components/Room';

function parseDeepLinkCode(): string {
  const match = /^\/r\/([A-Za-z0-9]+)/.exec(window.location.pathname);
  if (match) return normalizeCode(match[1]);
  const q = new URLSearchParams(window.location.search).get('code');
  return q ? normalizeCode(q) : '';
}

export function App() {
  const signaling = getSignalingClient();
  const [prefs, setPrefs] = useState<RiderPreferences>(() => loadRiderPreferences());
  const [deepLinkCode] = useState<string>(() => parseDeepLinkCode());
  const [busy, setBusy] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const [activeSession, setActiveSession] = useState<SignalingRoomSession | null>(null);
  const [audioRig, setAudioRig] = useState<LocalAudioRig | null>(null);
  const [rejoinedSilently, setRejoinedSilently] = useState(false);

  // iOS requires a single tap gesture to unlock audio on auto-rejoin
  const [iosRejoinPrompt, setIosRejoinPrompt] = useState<SavedRideSession | null>(null);

  const [summaryState, setSummaryState] = useState<{
    ride: CompletedRideRecord;
    reasonLabel: string;
  } | null>(null);

  useEffect(() => {
    document.documentElement.dataset.theme = prefs.daylightTheme ? 'daylight' : 'night';
  }, [prefs.daylightTheme]);

  const handleUpdatePrefs = useCallback((patch: Partial<RiderPreferences>) => {
    setPrefs(saveRiderPreferences(patch));
  }, []);

  const connectIntoSession = useCallback(
    async (
      mode: 'create' | 'join',
      riderName: string,
      code?: string,
      silentRejoin = false,
    ) => {
      setBusy(true);
      setErrorMessage(null);

      let rig: LocalAudioRig | null = null;
      try {
        rig = await createLocalAudioRig(prefs.windFilter);

        const roomSession =
          mode === 'create'
            ? await signaling.createRoom(riderName)
            : await signaling.joinRoom(code ?? '', riderName);

        saveActiveSession({
          code: roomSession.meta.code,
          riderName,
          isHost: roomSession.meta.isHost,
          joinedAt: Date.now(),
          backend: signaling.backend,
        });

        window.history.replaceState(
          null,
          '',
          `/r/${roomSession.meta.code}${window.location.search}`,
        );

        playCommsTone('join');
        setRejoinedSilently(silentRejoin);
        setAudioRig(rig);
        setActiveSession(roomSession);
      } catch (err) {
        rig?.destroy();
        if (err instanceof SignalingError) {
          setErrorMessage(err.message);
        } else if (err instanceof DOMException && err.name === 'NotAllowedError') {
          setErrorMessage(
            'Microphone permission is required so your Bluetooth helmet headset can transmit voice.',
          );
        } else {
          setErrorMessage(
            err instanceof Error ? err.message : 'Unable to connect to pack intercom.',
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [prefs.windFilter, signaling],
  );

  // Phase 2 Auto-Rejoin on launch / reload if a ride is still active & within 15m idle / 2h cap
  useEffect(() => {
    let cancelled = false;
    const saved = loadActiveSession(signaling.backend);
    if (!saved || !isValidRoomCode(saved.code)) return;

    signaling
      .inspectRoom(saved.code)
      .then((status) => {
        if (cancelled) return;
        if (!status.active) {
          clearActiveSession(signaling.backend);
          if (status.exists) {
            setErrorMessage(
              status.reason === 'idle_empty'
                ? `Pack ${saved.code} expired after 15 minutes with no riders connected.`
                : status.reason === 'max_duration'
                  ? `Pack ${saved.code} reached its 2-hour maximum ride limit.`
                  : `Ride ${saved.code} has ended.`,
            );
          }
          window.history.replaceState(null, '', `/${window.location.search}`);
          return;
        }

        if (isIosDevice()) {
          setIosRejoinPrompt(saved);
        } else {
          connectIntoSession('join', saved.riderName, saved.code, true).catch(() => undefined);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, [signaling, connectIntoSession]);

  const teardownMedia = useCallback(() => {
    audioRig?.destroy();
    setAudioRig(null);
    setActiveSession(null);
    clearActiveSession(signaling.backend);
    window.history.replaceState(null, '', `/${window.location.search}`);
  }, [audioRig, signaling.backend]);

  // iOS One-Tap Rejoin Gate
  if (iosRejoinPrompt && !activeSession) {
    return (
      <main className="cockpit-shell rejoin-gate" data-testid="ios-rejoin-gate">
        <div className="eyebrow-tag">ACTIVE PACK DETECTED</div>
        <h1 className="summary-title">Rejoin Your Pack</h1>
        <div className="plate-badge plate-badge--large">
          {formatPlateCode(iosRejoinPrompt.code)}
        </div>
        <button
          type="button"
          className="ignition-btn"
          onClick={() => {
            const target = iosRejoinPrompt;
            setIosRejoinPrompt(null);
            connectIntoSession('join', target.riderName, target.code, true);
          }}
        >
          <span className="ignition-btn__icon">
            <Power size={24} />
          </span>
          <span className="ignition-btn__text">
            <strong>TAP TO REJOIN PACK</strong>
            <small>Reconnects your helmet mic &amp; slot as {iosRejoinPrompt.riderName}</small>
          </span>
        </button>
        <button
          type="button"
          className="btn-secondary"
          onClick={() => {
            clearActiveSession(signaling.backend);
            setIosRejoinPrompt(null);
          }}
        >
          Cancel &amp; Stay in Paddock
        </button>
      </main>
    );
  }

  if (activeSession && audioRig) {
    return (
      <Room
        session={activeSession}
        audioRig={audioRig}
        prefs={prefs}
        rejoinedSilently={rejoinedSilently}
        onUpdatePrefs={handleUpdatePrefs}
        onRideEnded={(ride, reasonLabel) => {
          teardownMedia();
          setSummaryState({ ride, reasonLabel });
        }}
        onVoluntaryLeave={(ride) => {
          teardownMedia();
          setSummaryState({ ride, reasonLabel: 'YOU LEFT THE PACK' });
        }}
      />
    );
  }

  if (summaryState) {
    return (
      <RideSummary
        ride={summaryState.ride}
        endReasonLabel={summaryState.reasonLabel}
        onDone={() => setSummaryState(null)}
      />
    );
  }

  return (
    <Home
      initialJoinCode={deepLinkCode}
      prefs={prefs}
      backend={signaling.backend}
      busy={busy}
      errorMessage={errorMessage}
      onUpdatePrefs={handleUpdatePrefs}
      onStartRide={(riderName) => connectIntoSession('create', riderName)}
      onJoinRide={(code, riderName) => connectIntoSession('join', riderName, code)}
      onOpenPastRide={(ride) =>
        setSummaryState({ ride, reasonLabel: 'PAST RIDE LOG' })
      }
    />
  );
}

