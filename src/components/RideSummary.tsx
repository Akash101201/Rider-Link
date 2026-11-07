import { Download, Gauge, MapPin, RotateCcw, Timer, Users } from 'lucide-react';
import { formatPlateCode } from '../lib/code';
import { formatDurationClock } from '../lib/expiry';
import { exportRideToGpx, type CompletedRideRecord } from '../lib/rideLog';

interface RideSummaryProps {
  ride: CompletedRideRecord;
  endReasonLabel?: string;
  onDone: () => void;
}

export function RideSummary({ ride, endReasonLabel, onDone }: RideSummaryProps) {
  const handleDownloadGpx = () => {
    const xml = exportRideToGpx(ride);
    const blob = new Blob([xml], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `riderlink-${ride.code.toLowerCase()}.gpx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // Build normalized SVG route preview from recorded GPS breadcrumbs
  let polylinePoints = '';
  if (ride.points.length >= 2) {
    const lats = ride.points.map((p) => p.lat);
    const lngs = ride.points.map((p) => p.lng);
    const minLat = Math.min(...lats);
    const maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs);
    const maxLng = Math.max(...lngs);
    const spanLat = Math.max(0.0005, maxLat - minLat);
    const spanLng = Math.max(0.0005, maxLng - minLng);

    polylinePoints = ride.points
      .map((p) => {
        const x = 18 + ((p.lng - minLng) / spanLng) * 264;
        const y = 122 - ((p.lat - minLat) / spanLat) * 104;
        return `${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(' ');
  }

  return (
    <main className="cockpit-shell summary-screen" data-testid="ride-summary">
      <header className="summary-header">
        <div className="eyebrow-tag">{endReasonLabel ?? 'RIDE COMPLETE'}</div>
        <h1 className="summary-title">Pack Telemetry</h1>
        <div className="plate-badge">{formatPlateCode(ride.code)}</div>
      </header>

      <section className="telemetry-stats-grid">
        <div className="stat-tile">
          <div className="stat-tile__label">
            <MapPin size={14} /> DISTANCE
          </div>
          <div className="stat-tile__value" data-testid="summary-distance">
            {ride.distanceKm.toFixed(2)} <span>km</span>
          </div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile__label">
            <Timer size={14} /> DURATION
          </div>
          <div className="stat-tile__value">{formatDurationClock(ride.durationSec * 1000)}</div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile__label">
            <Gauge size={14} /> TOP SPEED
          </div>
          <div className="stat-tile__value">
            {ride.topSpeedKmh} <span>km/h</span>
          </div>
        </div>

        <div className="stat-tile">
          <div className="stat-tile__label">
            <Gauge size={14} /> AVG SPEED
          </div>
          <div className="stat-tile__value">
            {ride.avgSpeedKmh} <span>km/h</span>
          </div>
        </div>
      </section>

      <section className="route-preview-card">
        <div className="route-preview-card__top">
          <span>GPS ROUTE TRACE (STORED ON PHONE ONLY)</span>
          <span>{ride.points.length} pts</span>
        </div>
        {polylinePoints ? (
          <svg viewBox="0 0 300 140" className="route-svg" aria-label="Recorded ride route">
            <polyline
              fill="none"
              stroke="#FF6B00"
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              points={polylinePoints}
            />
          </svg>
        ) : (
          <div className="route-empty">No GPS movement recorded during this session</div>
        )}
      </section>

      {ride.riders.length > 0 && (
        <section className="pack-roster-box">
          <div className="pack-roster-box__label">
            <Users size={14} /> PACK RIDERS ({ride.riders.length})
          </div>
          <div className="pack-roster-chips">
            {ride.riders.map((name) => (
              <span key={name} className="roster-chip">
                {name}
              </span>
            ))}
          </div>
        </section>
      )}

      <footer className="summary-actions">
        {ride.points.length > 0 && (
          <button
            type="button"
            className="btn-secondary"
            data-testid="export-gpx-btn"
            onClick={handleDownloadGpx}
          >
            <Download size={18} />
            <span>Export GPX</span>
          </button>
        )}
        <button
          type="button"
          className="btn-primary"
          data-testid="back-home-btn"
          onClick={onDone}
        >
          <RotateCcw size={18} />
          <span>Back to Paddock</span>
        </button>
      </footer>
    </main>
  );
}

