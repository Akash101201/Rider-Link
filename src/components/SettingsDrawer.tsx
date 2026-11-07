import { useEffect, useState } from 'react';
import { Sun, Volume2, Wind, X } from 'lucide-react';
import type { RiderPreferences } from '../lib/session';
import { getAvailableHumanVoices, speakHumanCue } from '../lib/tts';

interface SettingsDrawerProps {
  prefs: RiderPreferences;
  onUpdatePrefs: (patch: Partial<RiderPreferences>) => void;
  onClose: () => void;
}

export function SettingsDrawer({ prefs, onUpdatePrefs, onClose }: SettingsDrawerProps) {
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  useEffect(() => {
    const refresh = () => setVoices(getAvailableHumanVoices());
    refresh();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.onvoiceschanged = refresh;
    }
    return () => {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.onvoiceschanged = null;
      }
    };
  }, []);

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card modal-card--sheet" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__header">
          <div>
            <div className="eyebrow-tag">COCKPIT TUNING</div>
            <h2 className="modal-card__title">Helmet &amp; Pack Settings</h2>
          </div>
          <button
            type="button"
            className="icon-pill-btn"
            onClick={onClose}
            aria-label="Close settings"
          >
            <X size={20} />
          </button>
        </div>

        <div className="settings-list">
          <label className="setting-row">
            <div className="setting-row__info">
              <div className="setting-row__title">
                <Wind size={16} /> Wind &amp; Exhaust Filter
              </div>
              <div className="setting-row__desc">
                185 Hz high-pass + compressor cuts highway wind roar
              </div>
            </div>
            <input
              type="checkbox"
              className="moto-switch"
              checked={prefs.windFilter}
              onChange={(e) => onUpdatePrefs({ windFilter: e.target.checked })}
            />
          </label>

          <label className="setting-row">
            <div className="setting-row__info">
              <div className="setting-row__title">
                <Volume2 size={16} /> Spoken Road Alerts
              </div>
              <div className="setting-row__desc">
                Reads Hazard, Police &amp; Fuel alerts in a human voice
              </div>
            </div>
            <input
              type="checkbox"
              className="moto-switch"
              checked={prefs.spokenAlerts}
              onChange={(e) => onUpdatePrefs({ spokenAlerts: e.target.checked })}
            />
          </label>

          {prefs.spokenAlerts && (
            <div className="setting-block">
              <div className="setting-row__title">Helmet Voice</div>
              <div className="voice-picker-row">
                <select
                  className="moto-select"
                  value={prefs.preferredVoice ?? ''}
                  onChange={(e) =>
                    onUpdatePrefs({ preferredVoice: e.target.value || null })
                  }
                >
                  <option value="">Auto (Best Human Voice)</option>
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} ({v.lang})
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn-secondary btn-compact"
                  onClick={() =>
                    speakHumanCue('RiderLink check. Hazard ahead, slow down pack.', {
                      preferredVoiceName: prefs.preferredVoice,
                    })
                  }
                >
                  Test
                </button>
              </div>
            </div>
          )}

          <div className="setting-block">
            <div className="setting-row__title">Falling-Behind Alert Distance</div>
            <div className="segmented-pills">
              {([1, 2, 5] as const).map((km) => (
                <button
                  key={km}
                  type="button"
                  className={`seg-pill ${prefs.behindThresholdKm === km ? 'is-active' : ''}`}
                  onClick={() => onUpdatePrefs({ behindThresholdKm: km })}
                >
                  {km} km
                </button>
              ))}
            </div>
          </div>

          <label className="setting-row">
            <div className="setting-row__info">
              <div className="setting-row__title">
                <Sun size={16} /> Daylight Sun Mode
              </div>
              <div className="setting-row__desc">
                High-contrast light cockpit for bright midday glare
              </div>
            </div>
            <input
              type="checkbox"
              className="moto-switch"
              checked={prefs.daylightTheme}
              onChange={(e) => onUpdatePrefs({ daylightTheme: e.target.checked })}
            />
          </label>
        </div>
      </div>
    </div>
  );
}

