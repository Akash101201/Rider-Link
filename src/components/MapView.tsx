import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { LocateFixed, Maximize2 } from 'lucide-react';
import { getRiderColor } from '../lib/constants';
import type { GeoPoint } from '../lib/geo';
import type { RoomMember } from '../lib/signaling';

interface MapViewProps {
  myUid: string;
  members: RoomMember[];
  locations: Record<string, GeoPoint>;
  daylightTheme: boolean;
}

function buildMarkerHtml(opts: {
  initials: string;
  name: string;
  color: string;
  heading: number | null;
  role: RoomMember['role'];
  stale: boolean;
  isMe: boolean;
}): string {
  const arrowRot = opts.heading !== null ? opts.heading : 0;
  const roleBadge =
    opts.role === 'lead'
      ? '<span class="radar-pin__role radar-pin__role--lead">LEAD</span>'
      : opts.role === 'sweep'
        ? '<span class="radar-pin__role radar-pin__role--sweep">SWEEP</span>'
        : '';

  return `
    <div class="radar-pin ${opts.stale ? 'is-stale' : ''} ${opts.isMe ? 'is-me' : ''}" style="--pin-color:${opts.color}">
      <div class="radar-pin__puck">
        ${
          opts.heading !== null
            ? `<span class="radar-pin__arrow" style="transform: rotate(${arrowRot}deg)">▲</span>`
            : ''
        }
        <span class="radar-pin__initials">${opts.initials}</span>
      </div>
      <div class="radar-pin__label">${opts.name}${roleBadge}</div>
    </div>
  `;
}

export function MapView({ myUid, members, locations, daylightTheme }: MapViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  const [followMe, setFollowMe] = useState(true);
  const hasCenteredOnceRef = useRef(false);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;

    const map = L.map(containerRef.current, {
      center: [19.076, 72.8777],
      zoom: 14,
      zoomControl: false,
      attributionControl: true,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap',
    }).addTo(map);

    map.on('dragstart', () => {
      setFollowMe(false);
    });

    mapRef.current = map;
    const markerMap = markersRef.current;

    const resizeTimer = window.setTimeout(() => map.invalidateSize(), 120);

    return () => {
      window.clearTimeout(resizeTimer);
      markerMap.clear();
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    const now = Date.now();
    const activeIds = new Set<string>();

    for (const member of members) {
      const fix = locations[member.uid];
      if (!fix) continue;
      activeIds.add(member.uid);

      const stale = now - fix.ts > 60_000;
      const initials = member.name
        .trim()
        .split(/\s+/)
        .filter((p) => p.length > 0 && /[A-Za-z0-9]/.test(p[0]))
        .map((p) => p[0])
        .join('')
        .slice(0, 2)
        .toUpperCase();

      const icon = L.divIcon({
        className: 'radar-div-icon',
        html: buildMarkerHtml({
          initials: initials || 'R',
          name: member.name,
          color: getRiderColor(member.slot),
          heading: fix.heading,
          role: member.role,
          stale,
          isMe: member.uid === myUid,
        }),
        iconSize: [52, 52],
        iconAnchor: [26, 26],
      });

      const existing = markersRef.current.get(member.uid);
      if (existing) {
        existing.setLatLng([fix.lat, fix.lng]);
        existing.setIcon(icon);
      } else {
        const marker = L.marker([fix.lat, fix.lng], { icon }).addTo(map);
        markersRef.current.set(member.uid, marker);
      }
    }

    for (const [uid, marker] of Array.from(markersRef.current.entries())) {
      if (!activeIds.has(uid)) {
        marker.remove();
        markersRef.current.delete(uid);
      }
    }

    const myFix = locations[myUid];
    if (myFix && (followMe || !hasCenteredOnceRef.current)) {
      hasCenteredOnceRef.current = true;
      map.setView([myFix.lat, myFix.lng], map.getZoom(), { animate: false });
    }
  }, [members, locations, myUid, followMe]);

  const handleFitPack = () => {
    const map = mapRef.current;
    if (!map) return;
    const coords = members
      .map((m) => locations[m.uid])
      .filter((f): f is GeoPoint => Boolean(f))
      .map((f) => [f.lat, f.lng] as [number, number]);
    if (coords.length === 0) return;
    setFollowMe(false);
    if (coords.length === 1) {
      map.setView(coords[0], 15);
    } else {
      map.fitBounds(L.latLngBounds(coords), { padding: [42, 42], maxZoom: 16 });
    }
  };

  const trackedCount = members.filter((m) => Boolean(locations[m.uid])).length;

  return (
    <section
      className={`pack-radar ${daylightTheme ? 'is-daylight' : 'is-dark-tiles'}`}
      data-testid="pack-radar-map"
    >
      <div ref={containerRef} className="pack-radar__canvas" />

      <div className="pack-radar__hud-top">
        <span className="radar-pill" data-testid="radar-tracked-count">
          GPS LIVE: {trackedCount}/{members.length} RIDERS
        </span>
      </div>

      <div className="pack-radar__controls">
        <button
          type="button"
          className={`radar-ctrl-btn ${followMe ? 'is-active' : ''}`}
          onClick={() => setFollowMe(true)}
          title="Center on my bike"
        >
          <LocateFixed size={18} />
          <span>FOLLOW</span>
        </button>
        <button
          type="button"
          className="radar-ctrl-btn"
          onClick={handleFitPack}
          title="Fit all riders on screen"
        >
          <Maximize2 size={18} />
          <span>FIT PACK</span>
        </button>
      </div>
    </section>
  );
}

