import { describe, expect, it } from 'vitest';
import { tuneOpusSdp } from '../../src/lib/sdp';

describe('tuneOpusSdp', () => {
  it('injects FEC, DTX, mono, 32kbps bitrate and 20ms ptime into Opus fmtp line', () => {
    const rawSdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111 103',
      'a=rtpmap:111 opus/48000/2',
      'a=fmtp:111 minptime=10;useinbandfec=0',
      'a=rtpmap:103 ISAC/16000',
    ].join('\r\n');

    const tuned = tuneOpusSdp(rawSdp);
    expect(tuned).toContain('useinbandfec=1');
    expect(tuned).toContain('usedtx=1');
    expect(tuned).toContain('stereo=0');
    expect(tuned).toContain('sprop-stereo=0');
    expect(tuned).toContain('maxaveragebitrate=32000');
    expect(tuned).toContain('a=ptime:20');
  });

  it('creates fmtp line when Opus rtpmap has none', () => {
    const rawSdp = [
      'v=0',
      'm=audio 9 UDP/TLS/RTP/SAVPF 96',
      'a=rtpmap:96 opus/48000/2',
    ].join('\r\n');

    const tuned = tuneOpusSdp(rawSdp);
    expect(tuned).toContain('a=fmtp:96 ');
    expect(tuned).toContain('maxaveragebitrate=32000');
    expect(tuned).toContain('a=ptime:20');
  });
});

