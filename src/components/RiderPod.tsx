import { Mic, MicOff, Plus, Radio, WifiOff } from 'lucide-react';
import { getRiderColor } from '../lib/constants';
import type { PeerConnStatus } from '../lib/mesh';
import type { RoomMember } from '../lib/signaling';
import { HelmetAvatar } from './HelmetAvatar';

interface RiderPodProps {
  slotIndex: number;
  member?: RoomMember;
  isMe: boolean;
  speaking: boolean;
  connStatus?: PeerConnStatus;
  distanceKm?: number | null;
  lostContact?: boolean;
  onEmptySlotTap: () => void;
  onToggleRole?: () => void;
}

export function RiderPod({
  slotIndex,
  member,
  isMe,
  speaking,
  connStatus,
  distanceKm,
  lostContact = false,
  onEmptySlotTap,
  onToggleRole,
}: RiderPodProps) {
  const color = getRiderColor(slotIndex);

  if (!member) {
    return (
      <button
        type="button"
        className="rider-pod rider-pod--empty"
        onClick={onEmptySlotTap}
        data-testid={`pod-empty-${slotIndex}`}
        aria-label={`Open rider slot ${slotIndex + 1} — tap to invite`}
      >
        <div className="rider-pod__empty-icon">
          <Plus size={20} />
        </div>
        <span className="rider-pod__empty-label">SLOT {slotIndex + 1}</span>
        <span className="rider-pod__empty-sub">TAP TO INVITE</span>
      </button>
    );
  }

  const effectiveStatus: 'live' | 'connecting' | 'reconnecting' = isMe
    ? 'live'
    : connStatus === 'connected'
      ? 'live'
      : connStatus === 'reconnecting'
        ? 'reconnecting'
        : 'connecting';

  return (
    <div
      className={`rider-pod rider-pod--occupied ${speaking ? 'is-speaking' : ''} ${
        member.muted ? 'is-muted' : ''
      } ${lostContact ? 'is-lost' : ''}`}
      style={{ ['--pod-color' as string]: color }}
      data-testid={`pod-rider-${member.slot}`}
      data-conn-status={effectiveStatus}
    >
      <div className="rider-pod__top">
        <div className="rider-pod__badges">
          {member.role === 'lead' && <span className="role-chip role-chip--lead">LEAD</span>}
          {member.role === 'sweep' && <span className="role-chip role-chip--sweep">SWEEP</span>}
          {isMe && member.role !== 'lead' && onToggleRole && (
            <button
              type="button"
              className="role-chip role-chip--toggle"
              onClick={onToggleRole}
              title="Toggle Tail/Sweep Rider badge"
            >
              {member.role === 'rider' ? '+SWEEP' : 'SWEEP'}
            </button>
          )}
          {isMe && <span className="you-chip">YOU</span>}
        </div>

        <span
          className={`conn-pill conn-pill--${effectiveStatus}`}
          data-testid={`conn-status-${member.slot}`}
        >
          {effectiveStatus === 'live' ? (
            <>
              <Radio size={11} /> LIVE
            </>
          ) : effectiveStatus === 'reconnecting' ? (
            <>
              <WifiOff size={11} /> RETRY
            </>
          ) : (
            'SYNC…'
          )}
        </span>
      </div>

      <div className="rider-pod__center">
        <HelmetAvatar
          color={color}
          speaking={speaking && !member.muted}
          muted={member.muted}
          size={44}
        />
        <div className="rider-pod__identity">
          <div className="rider-pod__name" title={member.name}>
            {member.name}
          </div>
          <div className="rider-pod__telemetry">
            {lostContact ? (
              <span className="telemetry-warn">SIGNAL LOST</span>
            ) : distanceKm !== undefined && distanceKm !== null ? (
              <span>{distanceKm < 0.1 ? '<100 m' : `${distanceKm.toFixed(1)} km`}</span>
            ) : speaking && !member.muted ? (
              <span className="telemetry-speaking">TALKING</span>
            ) : member.muted ? (
              <span>MIC MUTED</span>
            ) : (
              <span>OPEN MIC</span>
            )}
          </div>
        </div>
      </div>

      <div className="rider-pod__mic-indicator" aria-label={member.muted ? 'Muted' : 'Mic open'}>
        {member.muted ? <MicOff size={15} /> : <Mic size={15} />}
      </div>
    </div>
  );
}

