/**
 * Audio pipeline for RiderLink:
 * - Captures Bluetooth helmet mic or phone mic
 * - Routes through a Web Audio wind/engine roar filter (180 Hz high-pass + compressor)
 * - Monitors voice activity (speaking rings) for local & remote riders
 * - Plays remote rider streams with ducking support during spoken road alerts
 * - Synthesizes crisp helmet-comms chimes + haptic vibration cues
 */

export type CommsToneKind = 'unmute' | 'mute' | 'join' | 'leave' | 'alert' | 'end';

export function triggerHaptic(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(pattern);
    }
  } catch {
    // Ignore on platforms without Vibration API (e.g. iOS Safari)
  }
}

let sharedToneCtx: AudioContext | null = null;

function getToneContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedToneCtx || sharedToneCtx.state === 'closed') {
    sharedToneCtx = new Ctx();
  }
  if (sharedToneCtx.state === 'suspended') {
    sharedToneCtx.resume().catch(() => undefined);
  }
  return sharedToneCtx;
}

export function playCommsTone(kind: CommsToneKind): void {
  const ctx = getToneContext();
  if (!ctx) return;

  const now = ctx.currentTime;
  const notes: Array<{ freq: number; start: number; dur: number; type?: OscillatorType }> =
    kind === 'unmute'
      ? [
          { freq: 587.33, start: 0, dur: 0.075 },
          { freq: 880, start: 0.085, dur: 0.1 },
        ]
      : kind === 'mute'
        ? [
            { freq: 660, start: 0, dur: 0.075 },
            { freq: 440, start: 0.085, dur: 0.11 },
          ]
        : kind === 'join'
          ? [
              { freq: 523.25, start: 0, dur: 0.07 },
              { freq: 783.99, start: 0.08, dur: 0.11 },
            ]
          : kind === 'leave'
            ? [{ freq: 392, start: 0, dur: 0.14 }]
            : kind === 'alert'
              ? [
                  { freq: 784, start: 0, dur: 0.09, type: 'triangle' },
                  { freq: 1046.5, start: 0.1, dur: 0.13, type: 'triangle' },
                ]
              : [
                  { freq: 659.25, start: 0, dur: 0.09 },
                  { freq: 523.25, start: 0.1, dur: 0.09 },
                  { freq: 392, start: 0.2, dur: 0.16 },
                ];

  for (const n of notes) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = n.type ?? 'sine';
    osc.frequency.setValueAtTime(n.freq, now + n.start);
    gain.gain.setValueAtTime(0.001, now + n.start);
    gain.gain.exponentialRampToValueAtTime(0.16, now + n.start + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now + n.start);
    osc.stop(now + n.start + n.dur + 0.02);
  }
}

export interface LocalAudioRig {
  /** Outbound stream to attach to WebRTC peer connections. */
  outboundStream: MediaStream;
  /** Raw hardware stream for mic-pause recovery checks. */
  rawStream: MediaStream;
  setMuted: (muted: boolean) => void;
  setWindFilter: (enabled: boolean) => void;
  isTrackLive: () => boolean;
  restartMic: () => Promise<MediaStreamTrack | null>;
  onSpeakingChange: (cb: (speaking: boolean, level: number) => void) => () => void;
  destroy: () => void;
}

export async function createLocalAudioRig(initialWindFilter = true): Promise<LocalAudioRig> {
  let rawStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
    video: false,
  });

  const Ctx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;

  let ctx: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let highPass: BiquadFilterNode | null = null;
  let lowPass: BiquadFilterNode | null = null;
  let compressor: DynamicsCompressorNode | null = null;
  let analyser: AnalyserNode | null = null;
  let destination: MediaStreamAudioDestinationNode | null = null;
  let outboundStream: MediaStream = rawStream;

  let muted = false;
  let windFilterEnabled = initialWindFilter;
  const speakingListeners = new Set<(speaking: boolean, level: number) => void>();
  let speaking = false;
  let rafOrInterval: number | null = null;

  const wireGraph = (stream: MediaStream) => {
    if (!ctx || !highPass || !lowPass || !compressor || !analyser || !destination) return;
    try {
      sourceNode?.disconnect();
    } catch {
      // Ignore
    }
    sourceNode = ctx.createMediaStreamSource(stream);
    highPass.frequency.value = windFilterEnabled ? 185 : 20;
    lowPass.frequency.value = windFilterEnabled ? 6200 : 16000;

    sourceNode.connect(highPass);
    highPass.connect(lowPass);
    lowPass.connect(compressor);
    compressor.connect(analyser);
    compressor.connect(destination);
  };

  if (Ctx) {
    try {
      ctx = new Ctx();
      highPass = ctx.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.Q.value = 0.707;

      lowPass = ctx.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.Q.value = 0.707;

      compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 18;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.005;
      compressor.release.value = 0.18;

      analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.65;

      destination = ctx.createMediaStreamDestination();
      wireGraph(rawStream);
      outboundStream = destination.stream;

      const freqData = new Uint8Array(analyser.frequencyBinCount);
      rafOrInterval = window.setInterval(() => {
        if (!analyser) return;
        if (muted) {
          if (speaking) {
            speaking = false;
            for (const cb of speakingListeners) cb(false, 0);
          }
          return;
        }
        analyser.getByteFrequencyData(freqData);
        let sum = 0;
        for (let i = 2; i < Math.min(40, freqData.length); i++) {
          sum += freqData[i];
        }
        const avg = sum / 38;
        const normalized = Math.min(1, avg / 95);
        const nowSpeaking = normalized > 0.16;
        if (nowSpeaking !== speaking || nowSpeaking) {
          speaking = nowSpeaking;
          for (const cb of speakingListeners) cb(speaking, normalized);
        }
      }, 120);
    } catch {
      outboundStream = rawStream;
    }
  }

  const applyMuteToTracks = (s: MediaStream, isMuted: boolean) => {
    for (const t of s.getAudioTracks()) {
      t.enabled = !isMuted;
    }
  };

  return {
    outboundStream,
    get rawStream() {
      return rawStream;
    },
    setMuted: (nextMuted: boolean) => {
      muted = nextMuted;
      applyMuteToTracks(rawStream, muted);
      applyMuteToTracks(outboundStream, muted);
      if (ctx && ctx.state === 'suspended') {
        ctx.resume().catch(() => undefined);
      }
    },
    setWindFilter: (enabled: boolean) => {
      windFilterEnabled = enabled;
      if (highPass && lowPass) {
        highPass.frequency.value = enabled ? 185 : 20;
        lowPass.frequency.value = enabled ? 6200 : 16000;
      }
    },
    isTrackLive: () => {
      const tracks = rawStream.getAudioTracks();
      return tracks.length > 0 && tracks.every((t) => t.readyState === 'live');
    },
    restartMic: async () => {
      try {
        for (const t of rawStream.getTracks()) t.stop();
        rawStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
            channelCount: 1,
          },
          video: false,
        });
        applyMuteToTracks(rawStream, muted);
        if (ctx && destination) {
          if (ctx.state === 'suspended') await ctx.resume().catch(() => undefined);
          wireGraph(rawStream);
          applyMuteToTracks(outboundStream, muted);
          return outboundStream.getAudioTracks()[0] ?? null;
        }
        outboundStream = rawStream;
        return rawStream.getAudioTracks()[0] ?? null;
      } catch {
        return null;
      }
    },
    onSpeakingChange: (cb) => {
      speakingListeners.add(cb);
      return () => {
        speakingListeners.delete(cb);
      };
    },
    destroy: () => {
      if (rafOrInterval !== null) window.clearInterval(rafOrInterval);
      speakingListeners.clear();
      for (const t of rawStream.getTracks()) t.stop();
      for (const t of outboundStream.getTracks()) t.stop();
      ctx?.close().catch(() => undefined);
    },
  };
}

/**
 * Manages playback and voice-activity monitoring of remote riders' audio streams,
 * plus temporary volume ducking when spoken road alerts play.
 */
export class RemoteAudioStage {
  private readonly players = new Map<
    string,
    {
      audioEl: HTMLAudioElement;
      analyser?: AnalyserNode;
      speaking: boolean;
    }
  >();
  private ctx: AudioContext | null = null;
  private monitorTimer: number | null = null;
  private ducked = false;
  private readonly speakingListeners = new Set<
    (speakingByUid: Record<string, boolean>) => void
  >();

  constructor() {
    const Ctx =
      typeof window !== 'undefined'
        ? window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
        : undefined;
    if (Ctx) {
      try {
        this.ctx = new Ctx();
      } catch {
        this.ctx = null;
      }
    }

    this.monitorTimer = window.setInterval(() => {
      let changed = false;
      const snapshot: Record<string, boolean> = {};
      for (const [uid, entry] of this.players.entries()) {
        if (!entry.analyser) {
          snapshot[uid] = false;
          continue;
        }
        const buf = new Uint8Array(entry.analyser.frequencyBinCount);
        entry.analyser.getByteFrequencyData(buf);
        let sum = 0;
        for (let i = 2; i < Math.min(36, buf.length); i++) sum += buf[i];
        const isSpeaking = sum / 34 > 14;
        if (isSpeaking !== entry.speaking) {
          entry.speaking = isSpeaking;
          changed = true;
        }
        snapshot[uid] = isSpeaking;
      }
      if (changed) {
        for (const cb of this.speakingListeners) cb(snapshot);
      }
    }, 150);
  }

  attachPeerStream(peerUid: string, stream: MediaStream): void {
    this.removePeerStream(peerUid);

    const audioEl = document.createElement('audio');
    audioEl.autoplay = true;
    audioEl.setAttribute('playsinline', 'true');
    audioEl.srcObject = stream;
    audioEl.volume = this.ducked ? 0.25 : 1.0;
    audioEl.style.display = 'none';
    document.body.appendChild(audioEl);
    audioEl.play().catch(() => undefined);

    let analyser: AnalyserNode | undefined;
    if (this.ctx) {
      try {
        if (this.ctx.state === 'suspended') {
          this.ctx.resume().catch(() => undefined);
        }
        const src = this.ctx.createMediaStreamSource(stream);
        analyser = this.ctx.createAnalyser();
        analyser.fftSize = 256;
        src.connect(analyser);
      } catch {
        analyser = undefined;
      }
    }

    this.players.set(peerUid, { audioEl, analyser, speaking: false });
  }

  removePeerStream(peerUid: string): void {
    const existing = this.players.get(peerUid);
    if (!existing) return;
    existing.audioEl.pause();
    existing.audioEl.srcObject = null;
    existing.audioEl.remove();
    this.players.delete(peerUid);
  }

  setDucked(ducked: boolean): void {
    this.ducked = ducked;
    const vol = ducked ? 0.25 : 1.0;
    for (const entry of this.players.values()) {
      entry.audioEl.volume = vol;
    }
  }

  unlockPlayback(): void {
    if (this.ctx?.state === 'suspended') {
      this.ctx.resume().catch(() => undefined);
    }
    for (const entry of this.players.values()) {
      entry.audioEl.play().catch(() => undefined);
    }
  }

  onSpeakingChange(cb: (speakingByUid: Record<string, boolean>) => void): () => void {
    this.speakingListeners.add(cb);
    return () => {
      this.speakingListeners.delete(cb);
    };
  }

  destroy(): void {
    if (this.monitorTimer !== null) window.clearInterval(this.monitorTimer);
    for (const uid of Array.from(this.players.keys())) {
      this.removePeerStream(uid);
    }
    this.speakingListeners.clear();
    this.ctx?.close().catch(() => undefined);
  }
}

