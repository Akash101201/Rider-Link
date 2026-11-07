import { CODE_ALPHABET, CODE_LENGTH } from './constants';

/**
 * Generates an unambiguous 6-character alphanumeric room code using CSPRNG
 * with rejection sampling so every character has an exact uniform probability.
 */
export function generateRoomCode(length: number = CODE_LENGTH): string {
  const alphaLen = CODE_ALPHABET.length;
  const maxUnbiased = Math.floor(256 / alphaLen) * alphaLen;
  const chars: string[] = [];
  const buf = new Uint8Array(length * 2);

  while (chars.length < length) {
    crypto.getRandomValues(buf);
    for (let i = 0; i < buf.length && chars.length < length; i++) {
      const byte = buf[i];
      if (byte < maxUnbiased) {
        chars.push(CODE_ALPHABET[byte % alphaLen]);
      }
    }
  }

  return chars.join('');
}

/**
 * Normalizes user-entered room codes: uppercases and strips whitespace, dots, and dashes.
 */
export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, CODE_LENGTH);
}

/**
 * Checks whether a normalized code matches the 6-character RiderLink alphabet.
 */
export function isValidRoomCode(code: string): boolean {
  if (code.length !== CODE_LENGTH) return false;
  for (let i = 0; i < code.length; i++) {
    if (!CODE_ALPHABET.includes(code[i])) return false;
  }
  return true;
}

/**
 * Formats a 6-char room code like a motorcycle number plate: "K7M · Q3X".
 */
export function formatPlateCode(code: string): string {
  const clean = normalizeCode(code);
  if (clean.length <= 3) return clean;
  return `${clean.slice(0, 3)} · ${clean.slice(3)}`;
}
