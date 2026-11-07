import {
  AlertTriangle,
  Coffee,
  Fuel,
  Gauge,
  OctagonAlert,
  ShieldAlert,
} from 'lucide-react';
import { ROAD_ALERTS, type RoadAlertPreset } from '../lib/alerts';

interface AlertBarProps {
  onSendAlert: (preset: RoadAlertPreset) => void;
  cooldownActive: boolean;
}

function renderAlertIcon(key: RoadAlertPreset['key']) {
  switch (key) {
    case 'hazard':
      return <AlertTriangle size={18} />;
    case 'police':
      return <ShieldAlert size={18} />;
    case 'slow':
      return <Gauge size={18} />;
    case 'pullover':
      return <OctagonAlert size={18} />;
    case 'fuel':
      return <Fuel size={18} />;
    case 'break':
      return <Coffee size={18} />;
  }
}

export function AlertBar({ onSendAlert, cooldownActive }: AlertBarProps) {
  return (
    <section className="alert-strip" aria-label="Quick road alerts">
      <div className="alert-strip__grid">
        {ROAD_ALERTS.map((preset) => (
          <button
            key={preset.key}
            type="button"
            data-testid={`alert-btn-${preset.key}`}
            disabled={cooldownActive}
            className="alert-chip-btn"
            style={{ ['--alert-accent' as string]: preset.accent }}
            onClick={() => onSendAlert(preset)}
          >
            <span className="alert-chip-btn__icon">{renderAlertIcon(preset.key)}</span>
            <span className="alert-chip-btn__text">{preset.shortLabel}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

