import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Check, Copy, Share2, X } from 'lucide-react';
import { formatPlateCode } from '../lib/code';

interface QrModalProps {
  code: string;
  onClose: () => void;
}

export function QrModal({ code, onClose }: QrModalProps) {
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [copied, setCopied] = useState(false);

  const joinUrl = `${window.location.origin}/r/${code}`;

  useEffect(() => {
    QRCode.toDataURL(joinUrl, {
      width: 240,
      margin: 2,
      color: {
        dark: '#090B0E',
        light: '#FFFFFF',
      },
    })
      .then(setQrDataUrl)
      .catch(() => undefined);
  }, [joinUrl]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(joinUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Ignore
    }
  };

  const handleShare = async () => {
    if (navigator.share) {
      try {
        await navigator.share({
          title: `Join RiderLink Pack ${code}`,
          text: `Hop on our helmet intercom! Pack code: ${code}`,
          url: joinUrl,
        });
        return;
      } catch {
        // User cancelled native share
      }
    }
    await handleCopy();
  };

  return (
    <div className="modal-backdrop" onClick={onClose} role="dialog" aria-modal="true">
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-card__header">
          <div>
            <div className="eyebrow-tag">FUEL-STOP BOARDING</div>
            <h2 className="modal-card__title">Scan to Join Pack</h2>
          </div>
          <button
            type="button"
            className="icon-pill-btn"
            onClick={onClose}
            aria-label="Close QR modal"
          >
            <X size={20} />
          </button>
        </div>

        <div className="plate-badge plate-badge--large">{formatPlateCode(code)}</div>

        <div className="qr-frame">
          {qrDataUrl ? (
            <img src={qrDataUrl} alt={`QR code to join pack ${code}`} width={210} height={210} />
          ) : (
            <div className="qr-placeholder">Generating QR…</div>
          )}
        </div>

        <p className="modal-card__hint">
          Point another rider&apos;s camera here or share the link on WhatsApp. Up to 6 riders
          total.
        </p>

        <div className="modal-card__actions">
          <button type="button" className="btn-primary" onClick={handleShare}>
            <Share2 size={18} />
            <span>Share Invite</span>
          </button>
          <button type="button" className="btn-secondary" onClick={handleCopy}>
            {copied ? <Check size={18} /> : <Copy size={18} />}
            <span>{copied ? 'Link Copied' : 'Copy Link'}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

