import { useEffect, useRef, useState, type ReactNode } from 'react';
import { triggerHaptic } from '../lib/audio';

interface HoldButtonProps {
  onComplete: () => void;
  holdMs?: number;
  label: string;
  holdingLabel?: string;
  icon?: ReactNode;
  variant?: 'danger' | 'secondary';
  testId?: string;
}

/**
 * Press-and-hold safety button (default 1.5s) designed for motorcycle gloves:
 * prevents rain droplets, road bumps, or accidental brushes from ending a ride.
 */
export function HoldButton({
  onComplete,
  holdMs = 1_500,
  label,
  holdingLabel = 'KEEP HOLDING…',
  icon,
  variant = 'danger',
  testId,
}: HoldButtonProps) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const startRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const firedRef = useRef(false);

  const cancelHold = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    startRef.current = null;
    setHolding(false);
    setProgress(0);
  };

  const beginHold = () => {
    if (holding) return;
    firedRef.current = false;
    startRef.current = performance.now();
    setHolding(true);
    setProgress(0.04);
    triggerHaptic(20);

    timerRef.current = window.setInterval(() => {
      if (startRef.current === null) return;
      const elapsed = performance.now() - startRef.current;
      const ratio = Math.min(1, elapsed / holdMs);
      setProgress(ratio);

      if (ratio >= 1 && !firedRef.current) {
        firedRef.current = true;
        cancelHold();
        triggerHaptic([40, 30, 60]);
        onComplete();
      }
    }, 30);
  };

  useEffect(() => {
    return () => {
      if (timerRef.current !== null) window.clearInterval(timerRef.current);
    };
  }, []);

  return (
    <button
      type="button"
      data-testid={testId}
      className={`hold-btn hold-btn--${variant} ${holding ? 'is-holding' : ''}`}
      onPointerDown={(e) => {
        e.preventDefault();
        beginHold();
      }}
      onPointerUp={cancelHold}
      onPointerLeave={cancelHold}
      onPointerCancel={cancelHold}
      onKeyDown={(e) => {
        if ((e.key === 'Enter' || e.key === ' ') && !e.repeat) {
          beginHold();
        }
      }}
      onKeyUp={cancelHold}
    >
      <span
        className="hold-btn__fill"
        style={{ transform: `scaleX(${progress})` }}
        aria-hidden="true"
      />
      <span className="hold-btn__content">
        {icon}
        <span>{holding ? holdingLabel : label}</span>
      </span>
    </button>
  );
}

