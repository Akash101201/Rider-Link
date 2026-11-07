/**
 * Tunes WebRTC SDP for low-bandwidth, packet-loss-resilient motorcycle helmet voice:
 * - Mono (`stereo=0;sprop-stereo=0`)
 * - Forward Error Correction (`useinbandfec=1`) for patchy highway 4G
 * - Discontinuous Transmission (`usedtx=1`) to save mobile data when silent
 * - ~32 kbps average Opus bitrate (`maxaveragebitrate=32000`)
 * - 20ms frame size (`ptime=20`)
 */
export function tuneOpusSdp(sdp: string): string {
  if (!sdp) return sdp;

  const lineEnding = sdp.includes('\r\n') ? '\r\n' : '\n';
  const lines = sdp.split(/\r?\n/);

  let opusPt: string | null = null;
  let rtpmapIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const match = /^a=rtpmap:(\d+)\s+opus\/48000\/2/i.exec(lines[i]);
    if (match) {
      opusPt = match[1];
      rtpmapIndex = i;
      break;
    }
  }

  if (!opusPt) return sdp;

  const desiredParams: Record<string, string> = {
    minptime: '10',
    useinbandfec: '1',
    usedtx: '1',
    stereo: '0',
    'sprop-stereo': '0',
    maxaveragebitrate: '32000',
  };

  const fmtpPrefix = `a=fmtp:${opusPt} `;
  const fmtpIndex = lines.findIndex((l) => l.startsWith(fmtpPrefix));

  if (fmtpIndex !== -1) {
    const existingRaw = lines[fmtpIndex].slice(fmtpPrefix.length);
    const paramMap = new Map<string, string>();
    for (const part of existingRaw.split(';')) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) {
        paramMap.set(trimmed, '');
      } else {
        paramMap.set(trimmed.slice(0, eqIdx).trim(), trimmed.slice(eqIdx + 1).trim());
      }
    }
    for (const [k, v] of Object.entries(desiredParams)) {
      paramMap.set(k, v);
    }
    const serialized = Array.from(paramMap.entries())
      .map(([k, v]) => (v === '' ? k : `${k}=${v}`))
      .join(';');
    lines[fmtpIndex] = `${fmtpPrefix}${serialized}`;
  } else {
    const serialized = Object.entries(desiredParams)
      .map(([k, v]) => `${k}=${v}`)
      .join(';');
    lines.splice(rtpmapIndex + 1, 0, `${fmtpPrefix}${serialized}`);
  }

  if (!lines.some((l) => l.startsWith('a=ptime:'))) {
    const insertIdx = lines.findIndex((l) => l.startsWith(fmtpPrefix));
    lines.splice(insertIdx + 1, 0, 'a=ptime:20');
  }

  return lines.join(lineEnding);
}
