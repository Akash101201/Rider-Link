import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  EyeOff,
  LogOut,
  Map as MapIcon,
  Mic,
  MicOff,
  PowerOff,
  QrCode,
  Settings,
  Share2,
  Users,
} from 'lucide-react';
import { MAX_RIDE_MS, MAX_RIDERS } from '../lib/constants';
import { formatPlateCode } from '../lib/code';
import { formatDurationClock } from '../lib/expiry';
import {
  playCommsTone,
  RemoteAudioStage,
  triggerHaptic,
  type LocalAudioRig,
} from '../lib/audio';
import {
  fetchIceServers,
  PeerMesh,
  type MeshDataMessage,
  type PeerConnStatus,
} from '../lib/mesh';
import {
  getAlertPreset,
  RoadAlertGuard,
  type RoadAlertPreset,
} from '../lib/alerts';
import { BehindMonitor, findLostContactUids } from '../lib/behind';
import { haversineKm, startGpsTracker, type GeoPoint } from '../lib/geo';
import {
  ActiveRideRecorder,
  saveCompletedRide,
  type CompletedRideRecord,
} from '../lib/rideLog';
import type { RiderPreferences } from '../lib/session';
import type { RoomEndReason, RoomMember, SignalingRoomSession } from '../lib/signaling';
import { speakHumanCue } from '../lib/tts';
import { bindHelmetMediaSession, WakeLockController } from '../lib/wakeLock';
import { AlertBar } from './AlertBar';
import { HoldButton } from './HoldButton';
import { MapView } from './MapView';
import { QrModal } from './QrModal';
import { RiderPod } from './RiderPod';
import { SettingsDrawer } from './SettingsDrawer';
import { StealthHud } from './StealthHud';

interface RoomProps {
  session: SignalingRoomSession;
  audioRig: LocalAudioRig;
  prefs: RiderPreferences;
  rejoinedSilently?: boolean;
  onUpdatePrefs: (patch: Partial<RiderPreferences>) => void;
  onRideEnded: (summary: CompletedRideRecord, reasonLabel: string) => void;
  onVoluntaryLeave: (summary: CompletedRideRecord) => void;
}

interface CockpitBanner {
  id: string;
  title: string;
  subtitle: string;
  accent: string;
}

export function Room({
  session,
  audioRig,
  prefs,
  rejoinedSilently = false,
  onUpdatePrefs,
  onRideEnded,
  onVoluntaryLeave,
}: RoomProps) {
  const { meta } = session;
  const [members, setMembers] = useState<RoomMember[]>([]);
  const [peerStatuses, setPeerStatuses] = useState<Record<string, PeerConnStatus>>({});
  const [muted, setMuted] = useState(false);
  const [localSpeaking, setLocalSpeaking] = useState(false);
  const [remoteSpeaking, setRemoteSpeaking] = useState<Record<string, boolean>>({});
  const [activeTab, setActiveTab] = useState<'comms' | 'radar'>('comms');
  const [stealthMode, setStealthMode] = useState(false);
  const [showQr, setShowQr] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [banner, setBanner] = useState<CockpitBanner | null>(null);
  const [alertCooldown, setAlertCooldown] = useState(false);
  const [locations, setLocations] = useState<Record<string, GeoPoint>>({});
  const [speedKmh, setSpeedKmh] = useState(0);
  const [lostUids, setLostUids] = useState<Set<string>>(new Set());
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, MAX_RIDE_MS - (session.getServerNow() - meta.createdAt)),
  );

  const meshRef = useRef<PeerMesh | null>(null);
  const remoteStageRef = useRef<RemoteAudioStage | null>(null);
  const alertGuardRef = useRef(new RoadAlertGuard());
  const behindMonitorRef = useRef<BehindMonitor | null>(null);
  const recorderRef = useRef(new ActiveRideRecorder(meta.code, Date.now()));
  const lastPeerSeenRef = useRef<Map<string, number>>(new Map());
  const prevMemberNamesRef = useRef<Map<string, string>>(new Map());
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const finalizedRef = useRef(false);

  const showCockpitBanner = useCallback((b: CockpitBanner) => {
    setBanner(b);
    window.setTimeout(() => {
      setBanner((cur) => (cur?.id === b.id ? null : cur));
    }, 5_000);
  }, []);

  const announceInHelmet = useCallback((phrase: string) => {
    const p = prefsRef.current;
    if (!p.spokenAlerts) return;
    remoteStageRef.current?.setDucked(true);
    speakHumanCue(phrase, {
      preferredVoiceName: p.preferredVoice,
      enabled: p.spokenAlerts,
      onEnd: () => {
        remoteStageRef.current?.setDucked(false);
      },
    });
  }, []);

  // Sync wind filter preference to Web Audio rig
  useEffect(() => {
    audioRig.setWindFilter(prefs.windFilter);
  }, [audioRig, prefs.windFilter]);

  // Keep BehindMonitor threshold synced (allow fast dwell override in E2E tests)
  useEffect(() => {
    const customDwell = (window as unknown as { __RIDERLINK_BEHIND_DWELL_MS__?: number })
      .__RIDERLINK_BEHIND_DWELL_MS__;
    if (!behindMonitorRef.current) {
      behindMonitorRef.current = new BehindMonitor({
        thresholdKm: prefs.behindThresholdKm,
        dwellMs: customDwell ?? 45_000,
      });
    } else {
      behindMonitorRef.current.setThresholdKm(prefs.behindThresholdKm);
    }
  }, [prefs.behindThresholdKm]);

  // Toggle Mute handler (shared by button, Stealth HUD double-tap, and Bluetooth headset button)
  const toggleMute = useCallback(() => {
    remoteStageRef.current?.unlockPlayback();
    setMuted((prev) => {
      const next = !prev;
      audioRig.setMuted(next);
      session.updateMyState({ muted: next }).catch(() => undefined);
      playCommsTone(next ? 'mute' : 'unmute');
      triggerHaptic(next ? 35 : [25, 35, 25]);
      return next;
    });
  }, [audioRig, session]);

  // WakeLock + MediaSession headset integration
  useEffect(() => {
    const wake = new WakeLockController();
    wake.enable().catch(() => undefined);
    return () => {
      wake.disable().catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    return bindHelmetMediaSession(meta.code, members.length || 1, toggleMute);
  }, [meta.code, members.length, toggleMute]);

  // Local voice activity ring
  useEffect(() => {
    return audioRig.onSpeakingChange((speaking) => {
      setLocalSpeaking(speaking);
    });
  }, [audioRig]);

  // Recover microphone automatically if iOS Safari paused the track while backgrounded
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible') return;
      remoteStageRef.current?.unlockPlayback();
      if (!audioRig.isTrackLive()) {
        const freshTrack = await audioRig.restartMic();
        if (freshTrack && meshRef.current) {
          await meshRef.current.replaceAudioTrack(freshTrack);
          announceInHelmet('Microphone reconnected');
        }
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [audioRig, announceInHelmet]);

  // Subscribe to signaling roster & end events
  useEffect(() => {
    const unsubMembers = session.onMembers((list) => {
      setMembers(list);
      recorderRef.current.noteRiders(list.map((m) => m.name));

      const now = Date.now();
      const prevMap = prevMemberNamesRef.current;
      if (prevMap.size > 0) {
        for (const m of list) {
          if (m.uid !== meta.myUid && !prevMap.has(m.uid)) {
            playCommsTone('join');
            announceInHelmet(`${m.name} joined the pack`);
          }
          if (m.uid !== meta.myUid && !lastPeerSeenRef.current.has(m.uid)) {
            lastPeerSeenRef.current.set(m.uid, now);
          }
        }
        for (const [oldUid, oldName] of prevMap.entries()) {
          if (oldUid !== meta.myUid && !list.some((m) => m.uid === oldUid)) {
            playCommsTone('leave');
            announceInHelmet(`${oldName} disconnected`);
          }
        }
      } else {
        for (const m of list) {
          if (m.uid !== meta.myUid) lastPeerSeenRef.current.set(m.uid, now);
        }
      }

      const nextMap = new Map<string, string>();
      for (const m of list) nextMap.set(m.uid, m.name);
      prevMemberNamesRef.current = nextMap;
    });

    const unsubEnded = session.onEnded(async (reason: RoomEndReason) => {
      if (finalizedRef.current) return;
      finalizedRef.current = true;
      playCommsTone('end');
      const reasonLabel =
        reason === 'max_duration'
          ? '2-HOUR RIDE LIMIT REACHED'
          : reason === 'idle_empty'
            ? 'EXPIRED AFTER 15M IDLE'
            : 'RIDE ENDED BY LEAD';
      announceInHelmet(
        reason === 'max_duration' ? 'Two hour ride limit reached' : 'Ride ended',
      );
      const summary = recorderRef.current.finalize(Date.now());
      await saveCompletedRide(summary);
      onRideEnded(summary, reasonLabel);
    });

    if (rejoinedSilently) {
      announceInHelmet('Rejoined pack intercom');
    }

    return () => {
      unsubMembers();
      unsubEnded();
    };
  }, [session, meta.myUid, rejoinedSilently, announceInHelmet, onRideEnded]);

  // Boot WebRTC PeerMesh + RemoteAudioStage + DataChannel listeners
  useEffect(() => {
    let cancelled = false;
    const stage = new RemoteAudioStage();
    remoteStageRef.current = stage;

    const unsubRemoteSpeak = stage.onSpeakingChange(setRemoteSpeaking);

    const handleIncomingData = (msg: MeshDataMessage) => {
      const now = Date.now();
      if (msg.type === 'alert') {
        if (!alertGuardRef.current.acceptIncoming(msg, now)) return;
        const preset = getAlertPreset(msg.alertKey);
        if (!preset) return;
        playCommsTone('alert');
        triggerHaptic([50, 40, 50]);
        showCockpitBanner({
          id: msg.id,
          title: `${msg.fromName.toUpperCase()}: ${preset.label.toUpperCase()}`,
          subtitle: preset.spokenPhrase,
          accent: preset.accent,
        });
        announceInHelmet(`${msg.fromName}: ${preset.spokenPhrase}`);
      } else if (msg.type === 'loc') {
        lastPeerSeenRef.current.set(msg.fromUid, now);
        setLocations((prev) => ({
          ...prev,
          [msg.fromUid]: {
            lat: msg.lat,
            lng: msg.lng,
            speedKmh: msg.speedKmh,
            heading: msg.heading,
            accuracy: msg.accuracy,
            ts: msg.ts,
          },
        }));
      } else if (msg.type === 'behind') {
        playCommsTone('alert');
        if (msg.recovered) {
          showCockpitBanner({
            id: msg.id,
            title: `${msg.fromName.toUpperCase()} CAUGHT UP`,
            subtitle: `Back within ${msg.distanceKm.toFixed(1)} km of pack`,
            accent: '#00E676',
          });
          announceInHelmet(`${msg.fromName} has caught up`);
        } else {
          showCockpitBanner({
            id: msg.id,
            title: `${msg.fromName.toUpperCase()} IS BEHIND`,
            subtitle: `${msg.distanceKm.toFixed(1)} km behind nearest rider`,
            accent: '#FFD600',
          });
          announceInHelmet(`${msg.fromName} is ${msg.distanceKm.toFixed(1)} kilometers behind`);
        }
      }
    };

    fetchIceServers(meta.backend === 'local').then((iceServers) => {
      if (cancelled) return;
      const mesh = new PeerMesh({
        signaling: session,
        outboundStream: audioRig.outboundStream,
        iceServers,
        callbacks: {
          onPeerStatus: (statuses) => {
            setPeerStatuses(statuses);
            const now = Date.now();
            for (const [uid, st] of Object.entries(statuses)) {
              if (st === 'connected') {
                lastPeerSeenRef.current.set(uid, now);
              }
            }
          },
          onRemoteStream: (peerUid, stream) => {
            stage.attachPeerStream(peerUid, stream);
          },
          onPeerRemoved: (peerUid) => {
            stage.removePeerStream(peerUid);
          },
          onDataMessage: handleIncomingData,
        },
      });
      meshRef.current = mesh;

      (window as unknown as { __RIDERLINK_MESH__?: unknown }).__RIDERLINK_MESH__ = {
        getStats: () => mesh.getAudioTransferStats(),
      };
    });

    return () => {
      cancelled = true;
      unsubRemoteSpeak();
      meshRef.current?.destroy();
      meshRef.current = null;
      stage.destroy();
      remoteStageRef.current = null;
      delete (window as unknown as { __RIDERLINK_MESH__?: unknown }).__RIDERLINK_MESH__;
    };
  }, [session, audioRig, showCockpitBanner, announceInHelmet]);

  // Start GPS tracker for cockpit speedometer, P2P Pack Radar & local breadcrumb log
  useEffect(() => {
    const stopGps = startGpsTracker({
      onFix: (fix) => {
        setSpeedKmh(fix.speedKmh);
        recorderRef.current.recordFix(fix);
        setLocations((prev) => ({
          ...prev,
          [meta.myUid]: fix,
        }));
      },
      onBroadcastDue: (fix) => {
        meshRef.current?.broadcastData({
          type: 'loc',
          fromUid: meta.myUid,
          lat: fix.lat,
          lng: fix.lng,
          speedKmh: fix.speedKmh,
          heading: fix.heading,
          accuracy: fix.accuracy,
          ts: fix.ts,
        });
      },
    });
    return stopGps;
  }, [meta.myUid]);

  // Periodic tick: 2-hour countdown, Falling-Behind evaluation & Lost-Contact check
  useEffect(() => {
    const timer = window.setInterval(() => {
      const nowServer = session.getServerNow();
      setRemainingMs(Math.max(0, MAX_RIDE_MS - (nowServer - meta.createdAt)));

      const now = Date.now();
      const myPos = locations[meta.myUid] ?? null;
      const peerPosList = Object.entries(locations)
        .filter(([uid]) => uid !== meta.myUid)
        .map(([, pt]) => pt);

      const transition = !meta.isHost
        ? behindMonitorRef.current?.evaluate(myPos, peerPosList, now)
        : undefined;
      if (transition && transition.kind !== 'none') {
        const me = members.find((m) => m.uid === meta.myUid);
        const myName = me?.name ?? 'Rider';
        const id = `${meta.myUid}-behind-${now}`;
        const recovered = transition.kind === 'caught_up';
        meshRef.current?.broadcastData({
          type: 'behind',
          id,
          fromUid: meta.myUid,
          fromName: myName,
          distanceKm: transition.nearestKm,
          recovered,
          ts: now,
        });

        if (recovered) {
          announceInHelmet('You have caught up with the pack');
        } else {
          showCockpitBanner({
            id,
            title: 'FALLING BEHIND PACK',
            subtitle: `${transition.nearestKm.toFixed(1)} km from nearest rider`,
            accent: '#FFD600',
          });
          announceInHelmet('You have fallen behind the pack');
        }
      }

      const peerHealth = members
        .filter((m) => m.uid !== meta.myUid)
        .map((m) => ({
          uid: m.uid,
          connected: peerStatuses[m.uid] === 'connected',
          lastSeenMs: lastPeerSeenRef.current.get(m.uid) ?? now,
        }));
      const lost = new Set(findLostContactUids(peerHealth, now));
      setLostUids(lost);
    }, 1_000);

    return () => window.clearInterval(timer);
  }, [session, meta.createdAt, meta.myUid, locations, members, peerStatuses, announceInHelmet, showCockpitBanner]);

  const handleSendAlert = (preset: RoadAlertPreset) => {
    const now = Date.now();
    const check = alertGuardRef.current.canSend(meta.myUid, now);
    if (!check.allowed) return;

    const me = members.find((m) => m.uid === meta.myUid);
    const fromName = me?.name ?? (prefs.riderName || 'Rider');
    const id = `${meta.myUid}-${now}`;

    alertGuardRef.current.recordSent(id, meta.myUid, now);
    meshRef.current?.broadcastData({
      type: 'alert',
      id,
      alertKey: preset.key,
      fromUid: meta.myUid,
      fromName,
      ts: now,
    });

    playCommsTone('alert');
    triggerHaptic(35);
    showCockpitBanner({
      id,
      title: `SENT: ${preset.label.toUpperCase()}`,
      subtitle: preset.spokenPhrase,
      accent: preset.accent,
    });
    announceInHelmet(`${fromName}: ${preset.spokenPhrase}`);

    setAlertCooldown(true);
    window.setTimeout(() => setAlertCooldown(false), 3_000);
  };

  const handleShareQuick = async () => {
    const joinUrl = `${window.location.origin}/r/${meta.code}`;
    if (navigator.share) {
      try {
        await navigator.share({
          title: `RiderLink Pack ${meta.code}`,
          text: `Join our helmet intercom! Pack code: ${meta.code}`,
          url: joinUrl,
        });
        return;
      } catch {
        // Fallback to QR modal
      }
    }
    setShowQr(true);
  };

  const handleEndRide = async () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    playCommsTone('end');
    const summary = recorderRef.current.finalize(Date.now());
    await saveCompletedRide(summary);
    await session.endRoom();
    onRideEnded(summary, 'RIDE ENDED BY LEAD');
  };

  const handleLeaveRide = async () => {
    if (finalizedRef.current) return;
    finalizedRef.current = true;
    playCommsTone('leave');
    const summary = recorderRef.current.finalize(Date.now());
    await saveCompletedRide(summary);
    await session.leaveRoom();
    onVoluntaryLeave(summary);
  };

  const activeSpeakerName = useMemo(() => {
    for (const m of members) {
      if (m.muted) continue;
      if (m.uid === meta.myUid && localSpeaking) return `${m.name} (YOU)`;
      if (m.uid !== meta.myUid && remoteSpeaking[m.uid]) return m.name;
    }
    return null;
  }, [members, meta.myUid, localSpeaking, remoteSpeaking]);

  const memberBySlot = useMemo(() => {
    const map = new Map<number, RoomMember>();
    for (const m of members) map.set(m.slot, m);
    return map;
  }, [members]);

  const myLocation = locations[meta.myUid] ?? null;

  if (stealthMode) {
    return (
      <StealthHud
        code={meta.code}
        speedKmh={speedKmh}
        muted={muted}
        activeSpeakerName={activeSpeakerName}
        remainingTimeLabel={formatDurationClock(remainingMs)}
        onToggleMute={toggleMute}
        onExit={() => setStealthMode(false)}
      />
    );
  }

  return (
    <main className="cockpit-shell room-screen" data-testid="room-screen">
      {/* Top Motorcycle TFT Telemetry Cluster */}
      <header className="cluster-bar">
        <div className="cluster-speedo" aria-label="Current GPS speed">
          <span className="cluster-speedo__digits" data-testid="cockpit-speed">
            {speedKmh}
          </span>
          <span className="cluster-speedo__unit">KM/H</span>
        </div>

        <button
          type="button"
          className="cluster-plate-btn"
          data-testid="room-code-badge"
          onClick={() => setShowQr(true)}
          title="Tap for QR code & link"
        >
          <span className="cluster-plate-btn__code">{formatPlateCode(meta.code)}</span>
          <span className="cluster-plate-btn__sub">
            {members.length}/{MAX_RIDERS} PACK · {formatDurationClock(remainingMs)}
          </span>
        </button>

        <div className="cluster-actions">
          <button
            type="button"
            className="icon-pill-btn"
            onClick={handleShareQuick}
            aria-label="Share invite link"
            title="Share Pack Invite"
          >
            <Share2 size={17} />
          </button>
          <button
            type="button"
            className="icon-pill-btn"
            data-testid="open-qr-btn"
            onClick={() => setShowQr(true)}
            aria-label="Show QR code"
            title="Show Fuel-Stop QR"
          >
            <QrCode size={17} />
          </button>
          <button
            type="button"
            className="icon-pill-btn"
            data-testid="open-settings-btn"
            onClick={() => setShowSettings(true)}
            aria-label="Open helmet settings"
            title="Cockpit Settings"
          >
            <Settings size={17} />
          </button>
        </div>
      </header>

      {/* Mode Switcher: Pack Comms Grid vs Live Pack Radar Map */}
      <nav className="cockpit-tabs" aria-label="Cockpit view">
        <button
          type="button"
          data-testid="tab-comms"
          className={`cockpit-tab ${activeTab === 'comms' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('comms')}
        >
          <Users size={16} />
          <span>PACK COMMS ({members.length}/{MAX_RIDERS})</span>
        </button>
        <button
          type="button"
          data-testid="tab-radar"
          className={`cockpit-tab ${activeTab === 'radar' ? 'is-active' : ''}`}
          onClick={() => setActiveTab('radar')}
        >
          <MapIcon size={16} />
          <span>PACK RADAR</span>
        </button>
      </nav>

      {/* Live Road Alert Toast Banner */}
      {banner && (
        <div
          className="road-alert-toast"
          style={{ ['--toast-accent' as string]: banner.accent }}
          role="status"
          data-testid="road-alert-toast"
        >
          <strong>{banner.title}</strong>
          <span>{banner.subtitle}</span>
        </div>
      )}

      {/* Main Middle Viewport: 2x3 Helmet Pod Grid OR Pack Radar Map */}
      <div className="cockpit-stage">
        {activeTab === 'comms' ? (
          <section className="pods-grid" aria-label="Pack riders">
            {Array.from({ length: MAX_RIDERS }).map((_, slotIdx) => {
              const m = memberBySlot.get(slotIdx);
              const isMe = Boolean(m && m.uid === meta.myUid);
              const speaking = m
                ? isMe
                  ? localSpeaking
                  : Boolean(remoteSpeaking[m.uid])
                : false;
              const peerLoc = m && !isMe ? locations[m.uid] : undefined;
              const distKm =
                myLocation && peerLoc ? haversineKm(myLocation, peerLoc) : null;

              return (
                <RiderPod
                  key={slotIdx}
                  slotIndex={slotIdx}
                  member={m}
                  isMe={isMe}
                  speaking={speaking}
                  connStatus={m ? peerStatuses[m.uid] : undefined}
                  distanceKm={distKm}
                  lostContact={m ? lostUids.has(m.uid) : false}
                  onEmptySlotTap={() => setShowQr(true)}
                  onToggleRole={
                    isMe && !meta.isHost && m
                      ? () => {
                          const nextRole = m.role === 'sweep' ? 'rider' : 'sweep';
                          session.updateMyState({ role: nextRole }).catch(() => undefined);
                        }
                      : undefined
                  }
                />
              );
            })}
          </section>
        ) : (
          <MapView
            myUid={meta.myUid}
            members={members}
            locations={locations}
            daylightTheme={prefs.daylightTheme}
          />
        )}
      </div>

      {/* Quick Road Alerts Strip (Glove-Sized) */}
      <AlertBar onSendAlert={handleSendAlert} cooldownActive={alertCooldown} />

      {/* Bottom Thumb-Zone Comms Deck */}
      <footer className="comms-deck">
        <button
          type="button"
          data-testid="mute-toggle-btn"
          className={`giant-mic-btn ${muted ? 'is-muted' : 'is-live'}`}
          onClick={toggleMute}
        >
          <span className="giant-mic-btn__icon">
            {muted ? <MicOff size={26} /> : <Mic size={26} />}
          </span>
          <span className="giant-mic-btn__copy">
            <strong>{muted ? 'MIC MUTED' : 'MIC LIVE'}</strong>
            <small>{muted ? 'Tap to talk to pack' : 'Hands-free · Wind filter ON'}</small>
          </span>
        </button>

        <div className="comms-deck__secondary">
          <button
            type="button"
            data-testid="stealth-hud-btn"
            className="btn-stealth"
            onClick={() => setStealthMode(true)}
            title="Dim screen to OLED black while keeping mic & Wake Lock active"
          >
            <EyeOff size={17} />
            <span>STEALTH HUD</span>
          </button>

          {meta.isHost ? (
            <HoldButton
              testId="end-ride-btn"
              variant="danger"
              icon={<PowerOff size={17} />}
              label="HOLD TO END RIDE"
              holdingLabel="ENDING PACK…"
              onComplete={handleEndRide}
            />
          ) : (
            <HoldButton
              testId="leave-ride-btn"
              variant="secondary"
              icon={<LogOut size={17} />}
              label="HOLD TO LEAVE"
              holdingLabel="LEAVING…"
              onComplete={handleLeaveRide}
            />
          )}
        </div>
      </footer>

      {showQr && <QrModal code={meta.code} onClose={() => setShowQr(false)} />}

      {showSettings && (
        <SettingsDrawer
          prefs={prefs}
          onUpdatePrefs={onUpdatePrefs}
          onClose={() => setShowSettings(false)}
        />
      )}
    </main>
  );
}

