import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, CODE_LENGTH } from '../../src/lib/constants';
import {
  formatPlateCode,
  generateRoomCode,
  isValidRoomCode,
  normalizeCode,
} from '../../src/lib/code';

describe('Room code generator & plate formatter', () => {
  it('generates 6-character codes strictly from unambiguous alphabet', () => {
    const counts = new Map<string, number>();
    for (let i = 0; i < 1200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(CODE_LENGTH);
      expect(isValidRoomCode(code)).toBe(true);
      expect(code).not.toMatch(/[0O1IL]/);
      for (const ch of code) {
        counts.set(ch, (counts.get(ch) ?? 0) + 1);
      }
    }

    // Every character in the 31-char alphabet should appear with healthy frequency
    for (const ch of CODE_ALPHABET) {
      expect(counts.get(ch) ?? 0).toBeGreaterThan(100);
    }
  });

  it('normalizes user input and formats license-plate display', () => {
    expect(normalizeCode(' k7m · q3x ')).toBe('K7MQ3X');
    expect(normalizeCode('ab2-cd3-extra')).toBe('AB2CD3');
    expect(formatPlateCode('k7mq3x')).toBe('K7M · Q3X');
    expect(isValidRoomCode('K7MQ3X')).toBe(true);
    expect(isValidRoomCode('K0MQ1X')).toBe(false); // 0 and 1 excluded
    expect(isValidRoomCode('ABC')).toBe(false);
  });
});

