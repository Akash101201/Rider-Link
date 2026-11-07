import { useRef } from 'react';
import { Eye, Mic, MicOff } from 'lucide-react';
import { formatPlateCode } from '../lib/code';

interface StealthHudProps {
  code: string;
  speedKmh: number;
  muted: boolean;
  activeSpeakerName: string | null;
  remainingTimeLabel: string;
  onToggleMute: () => void;
  onExit: () => void;
}

/**
 * Pure OLED-black handlebar/pocket riding HUD:
 * - Saves battery & eliminates night glare while keeping Screen Wake Lock active
 * - Double-tap anywhere on screen toggles Mute/Unmute without aiming at a button
 */
export function StealthHud({
  code,
  speedKmh,
  muted,
  activeSpeakerName,
  remainingTimeLabel,
  onToggleMute,
  onExit,
}: StealthHudProps) {
  const lastTapRef = useRef<number>(0);

  const handleSurfaceTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < 360) {
      lastTapRef.current = 0;
      onToggleMute();
    } else {
      lastTapRef.current = now;
    }
  };

  return (
    <div
      className="stealth-hud"
      onClick={handleSurfaceTap}
      data-testid="stealth-hud"
      role="region"
      aria-label="Stealth Riding HUD — double tap anywhere to toggle mute"
    >
      <div className="stealth-hud__top">
        <span className="stealth-hud__code">{formatPlateCode(code)}</span>
        <span className="stealth-hud__timer">{remainingTimeLabel} LEFT</span>
        <button
          type="button"
          className="stealth-hud__exit"
          onClick={(e) => {
            e.stopPropagation();
            onExit();
          }}
        >
          <Eye size={16} />
          <span>WAKE UI</span>
        </button>
      </div>

      <div className="stealth-hud__speedo">
        <div className="stealth-hud__speed-digits">{speedKmh}</div>
        <div className="stealth-hud__speed-unit">KM/H</div>
      </div>

      <div className="stealth-hud__speaker">
        {activeSpeakerName ? (
          <span className="stealth-hud__speaker-live">● {activeSpeakerName} SPEAKING</span>
        ) : (
          <span className="stealth-hud__speaker-idle">CHANNEL CLEAR</span>
        )}
      </div>

      <div className={`stealth-hud__mic-pill ${muted ? 'is-muted' : 'is-live'}`}>
        {muted ? <MicOff size={26} /> : <Mic size={26} />}
        <span>{muted ? 'MIC MUTED' : 'MIC LIVE'}</span>
      </div>

      <p className="stealth-hud__hint">DOUBLE-TAP ANYWHERE TO MUTE / UNMUTE</p>
    </div>
  );
}

