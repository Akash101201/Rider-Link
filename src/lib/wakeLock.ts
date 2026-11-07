/**
 * Keeps the smartphone screen awake during riding mode (crucial for iOS Safari
 * and handlebar-mounted TFT cockpit / Pack Radar views) and binds MediaSession
 * headset buttons to Mute/Unmute.
 */

interface WakeLockSentinelLike {
  released: boolean;
  release: () => Promise<void>;
  addEventListener: (type: string, listener: () => void) => void;
}

export class WakeLockController {
  private sentinel: WakeLockSentinelLike | null = null;
  private active = false;
  private readonly onVisibilityChange: () => void;

  constructor() {
    this.onVisibilityChange = () => {
      if (this.active && document.visibilityState === 'visible') {
        this.requestLock().catch(() => undefined);
      }
    };
  }

  async enable(): Promise<boolean> {
    this.active = true;
    document.addEventListener('visibilitychange', this.onVisibilityChange);
    return this.requestLock();
  }

  private async requestLock(): Promise<boolean> {
    const nav = navigator as Navigator & {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    };
    if (!nav.wakeLock) return false;
    try {
      this.sentinel = await nav.wakeLock.request('screen');
      this.sentinel.addEventListener('release', () => {
        this.sentinel = null;
      });
      return true;
    } catch {
      return false;
    }
  }

  async disable(): Promise<void> {
    this.active = false;
    document.removeEventListener('visibilitychange', this.onVisibilityChange);
    if (this.sentinel && !this.sentinel.released) {
      await this.sentinel.release().catch(() => undefined);
    }
    this.sentinel = null;
  }

  isLocked(): boolean {
    return Boolean(this.sentinel && !this.sentinel.released);
  }
}

export function bindHelmetMediaSession(
  roomCode: string,
  riderCount: number,
  onToggleMute: () => void,
): () => void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
    return () => undefined;
  }

  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: `Pack ${roomCode}`,
      artist: `RiderLink Intercom · ${riderCount} Rider${riderCount === 1 ? '' : 's'}`,
      album: 'Encrypted P2P Comms',
    });

    navigator.mediaSession.setActionHandler('play', onToggleMute);
    navigator.mediaSession.setActionHandler('pause', onToggleMute);
  } catch {
    // Ignore on unsupported browsers
  }

  return () => {
    try {
      navigator.mediaSession.setActionHandler('play', null);
      navigator.mediaSession.setActionHandler('pause', null);
    } catch {
      // Ignore
    }
  };
}

