/**
 * Human-voice speech synthesizer for hands-free helmet road alerts & pack status.
 * Automatically ranks and picks natural/neural voices on Android & iOS over robotic compact voices.
 */

export interface VoiceCandidate {
  name: string;
  lang: string;
  localService: boolean;
  default: boolean;
}

const NATURAL_VOICE_KEYWORDS = [
  'natural',
  'neural',
  'enhanced',
  'premium',
  'siri',
  'google',
  'samantha',
  'ava',
  'allison',
  'daniel',
  'karen',
  'moira',
  'rishi',
  'tessa',
  'serena',
  'aria',
  'jenny',
  'sonia',
];

const ROBOTIC_VOICE_KEYWORDS = [
  'compact',
  'espeak',
  'zarvox',
  'trinoids',
  'whisper',
  'albert',
  'bad news',
  'bahh',
  'bells',
  'boing',
  'bubbles',
  'cellos',
  'deranged',
  'fred',
  'good news',
  'hysterical',
  'jester',
  'organ',
  'superstar',
  'wobble',
];

/**
 * Scores a `SpeechSynthesisVoice`-compatible descriptor so genuine human-sounding voices
 * consistently outrank robotic or novelty synthesizers.
 */
export function scoreHumanVoice(v: VoiceCandidate): number {
  const lowerName = v.name.toLowerCase();
  const lowerLang = v.lang.toLowerCase();

  let score = 0;

  if (lowerLang.startsWith('en-in')) score += 45;
  else if (lowerLang.startsWith('en-gb') || lowerLang.startsWith('en-us') || lowerLang.startsWith('en-au')) {
    score += 40;
  } else if (lowerLang.startsWith('en')) {
    score += 30;
  } else {
    score -= 25;
  }

  for (const kw of NATURAL_VOICE_KEYWORDS) {
    if (lowerName.includes(kw)) {
      score += 35;
    }
  }

  for (const kw of ROBOTIC_VOICE_KEYWORDS) {
    if (lowerName.includes(kw)) {
      score -= 80;
    }
  }

  if (v.localService) {
    score += 10; // Works reliably offline in mountain passes without cell data
  }
  if (v.default) {
    score += 5;
  }

  return score;
}

export function pickBestHumanVoice<T extends VoiceCandidate>(
  voices: readonly T[],
  preferredVoiceName?: string | null,
): T | null {
  if (!voices.length) return null;

  if (preferredVoiceName) {
    const exact = voices.find((v) => v.name === preferredVoiceName);
    if (exact) return exact;
  }

  const ranked = [...voices].sort((a, b) => scoreHumanVoice(b) - scoreHumanVoice(a));
  return ranked[0] ?? null;
}

export function getAvailableHumanVoices(): SpeechSynthesisVoice[] {
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) return [];
  const all = window.speechSynthesis.getVoices();
  return [...all]
    .filter((v) => v.lang.toLowerCase().startsWith('en') || v.default)
    .sort((a, b) => scoreHumanVoice(b) - scoreHumanVoice(a));
}

export interface SpeakOptions {
  preferredVoiceName?: string | null;
  enabled?: boolean;
  onStart?: () => void;
  onEnd?: () => void;
}

export function speakHumanCue(text: string, opts: SpeakOptions = {}): void {
  if (opts.enabled === false) return;
  if (typeof window === 'undefined' || !('speechSynthesis' in window)) {
    opts.onEnd?.();
    return;
  }

  try {
    const synth = window.speechSynthesis;
    synth.cancel();

    const utterance = new SpeechSynthesisUtterance(text);
    const chosen = pickBestHumanVoice(synth.getVoices(), opts.preferredVoiceName);
    if (chosen) {
      utterance.voice = chosen;
      utterance.lang = chosen.lang;
    } else {
      utterance.lang = 'en-US';
    }

    utterance.rate = 1.02;
    utterance.pitch = 1.0;
    utterance.volume = 1.0;

    let finished = false;
    const finishOnce = () => {
      if (finished) return;
      finished = true;
      window.clearTimeout(safetyTimer);
      opts.onEnd?.();
    };

    const safetyTimer = window.setTimeout(finishOnce, 4_500);
    utterance.onstart = () => opts.onStart?.();
    utterance.onend = finishOnce;
    utterance.onerror = finishOnce;

    synth.speak(utterance);
  } catch {
    opts.onEnd?.();
  }
}

