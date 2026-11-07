import { describe, expect, it } from 'vitest';
import { RoadAlertGuard } from '../../src/lib/alerts';
import { pickBestHumanVoice, scoreHumanVoice } from '../../src/lib/tts';

describe('RoadAlertGuard rate limit & deduplication', () => {
  it('enforces 3-second per-rider cooldown and drops duplicate alert IDs', () => {
    const guard = new RoadAlertGuard(3_000);
    const t0 = 10_000;

    expect(guard.canSend('rider-a', t0).allowed).toBe(true);
    guard.recordSent('msg-1', 'rider-a', t0);

    // Blocked 1.5s later
    const blocked = guard.canSend('rider-a', t0 + 1_500);
    expect(blocked.allowed).toBe(false);
    expect(blocked.cooldownRemainingMs).toBe(1_500);

    // Allowed 3.1s later
    expect(guard.canSend('rider-a', t0 + 3_100).allowed).toBe(true);

    // Duplicate message ID rejected on receiver
    expect(guard.acceptIncoming({ id: 'msg-1', fromUid: 'rider-b' }, t0 + 5_000)).toBe(false);
    expect(guard.acceptIncoming({ id: 'msg-2', fromUid: 'rider-b' }, t0 + 5_000)).toBe(true);
    expect(guard.acceptIncoming({ id: 'msg-2', fromUid: 'rider-b' }, t0 + 9_000)).toBe(false);
  });
});

describe('Human TTS voice selector', () => {
  it('prefers natural/enhanced human voices over robotic compact voices', () => {
    const voices = [
      { name: 'Zarvox', lang: 'en-US', localService: true, default: false },
      { name: 'eSpeak Compact', lang: 'en-US', localService: true, default: true },
      { name: 'Samantha (Enhanced)', lang: 'en-US', localService: true, default: false },
      { name: 'Rishi', lang: 'en-IN', localService: true, default: false },
    ];

    expect(scoreHumanVoice(voices[2])).toBeGreaterThan(scoreHumanVoice(voices[1]));
    expect(scoreHumanVoice(voices[3])).toBeGreaterThan(scoreHumanVoice(voices[0]));

    const picked = pickBestHumanVoice(voices);
    expect(['Samantha (Enhanced)', 'Rishi']).toContain(picked?.name);

    const explicit = pickBestHumanVoice(voices, 'Samantha (Enhanced)');
    expect(explicit?.name).toBe('Samantha (Enhanced)');
  });
});

