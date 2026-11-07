interface VercelRequest {
  method?: string;
}

interface VercelResponse {
  status: (code: number) => VercelResponse;
  setHeader: (name: string, value: string) => void;
  json: (body: unknown) => void;
}

const DEFAULT_STUN = [
  {
    urls: [
      'stun:stun.cloudflare.com:3478',
      'stun:stun.l.google.com:19302',
    ],
  },
];

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  res.setHeader('Cache-Control', 'no-store');

  const keyId = process.env.CF_TURN_KEY_ID;
  const apiToken = process.env.CF_TURN_API_TOKEN;

  if (!keyId || !apiToken) {
    res.status(200).json({ iceServers: DEFAULT_STUN, relay: false });
    return;
  }

  try {
    const response = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ ttl: 7200 }), // Matches 2-hour max ride lifetime
      },
    );

    if (!response.ok) {
      res.status(200).json({ iceServers: DEFAULT_STUN, relay: false });
      return;
    }

    const data = (await response.json()) as { iceServers?: unknown[] };
    if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
      res.status(200).json({ iceServers: data.iceServers, relay: true });
      return;
    }

    res.status(200).json({ iceServers: DEFAULT_STUN, relay: false });
  } catch {
    res.status(200).json({ iceServers: DEFAULT_STUN, relay: false });
  }
}
