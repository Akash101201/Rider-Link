export const APP_NAME = 'RiderLink';

/** Maximum riders in a pack, including the creator (LEAD). */
export const MAX_RIDERS = 6;

/** Room code character count. */
export const CODE_LENGTH = 6;

/** Unambiguous uppercase alphanumeric characters (excludes 0, O, 1, I, L). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Auto-expire room when 0 riders have been connected for 15 minutes. */
export const MAX_IDLE_MS = 15 * 60 * 1000;

/** Auto-expire room 2 hours after creation regardless of occupancy. */
export const MAX_RIDE_MS = 2 * 60 * 60 * 1000;

/** Minimum interval between quick alerts from the same rider (ms). */
export const ALERT_RATE_LIMIT_MS = 3_000;

/** Distinct high-visibility motorsport helmet accents per slot (0..5). */
export const RIDER_COLORS = [
  '#FF6B00', // Slot 0 (LEAD) — Racing KTM/Amber Orange
  '#00E5FF', // Slot 1 — Telemetry Cyan
  '#00E676', // Slot 2 — Kawasaki Emerald
  '#FFD600', // Slot 3 — High-Vis Volt Yellow
  '#FF2E93', // Slot 4 — MotoGP Berry Magenta
  '#9D6BFF', // Slot 5 — Titanium Violet
] as const;

export function getRiderColor(slot: number): string {
  return RIDER_COLORS[Math.abs(slot) % RIDER_COLORS.length];
}
