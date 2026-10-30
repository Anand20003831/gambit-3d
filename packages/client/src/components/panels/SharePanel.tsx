import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import type { LanInfo, RoomView } from '@gambit3d/shared';
import { rpc } from '../../net/socket.js';
import { Badge, CopyButton, Panel, Spinner } from '../ui/index.js';

/**
 * Sharing a room: the code, the link, and - for Wi-Fi games - the LAN address
 * plus a scannable QR code.
 */

export function SharePanel({ room }: { room: RoomView }): JSX.Element | null {
  const [lan, setLan] = useState<LanInfo | null>(null);
  const [lanLoading, setLanLoading] = useState(room.settings.mode === 'lan');

  useEffect(() => {
    if (room.settings.mode !== 'lan') return undefined;
    let cancelled = false;
    void (async () => {
      const result = await rpc<'lan:info', LanInfo>('lan:info', {});
      if (cancelled) return;
      setLanLoading(false);
      if (result.ok) setLan(result.data);
    })();
    return () => {
      cancelled = true;
    };
  }, [room.settings.mode]);

  if (room.settings.mode === 'local') {
    return (
      <Panel title="Same-device game">
        <p className="muted">
          Both players share this screen. The board turns around after each move so the side to play
          is always nearest.
        </p>
      </Panel>
    );
  }

  const origin = window.location.origin;
  const joinLink = `${origin}/join/${room.code}`;
  const lanLink = lan?.joinUrl ? `${lan.joinUrl}/join/${room.code}` : null;

  return (
    <Panel title="Invite">
      <div className="share">
        <div className="share__row">
          <span className="share__label">Room code</span>
          <code className="share__code">{room.code}</code>
          <CopyButton value={room.code} />
        </div>

        <div className="share__row">
          <span className="share__label">Link</span>
          <code className="share__link" title={joinLink}>
            {joinLink}
          </code>
          <CopyButton value={joinLink} label="Copy link" />
        </div>

        {room.settings.passwordProtected && (
          <p className="share__note">
            <Badge tone="warn">Password</Badge> Whoever you invite also needs the password — send it
            separately, not in the same message as the link.
          </p>
        )}

        {room.settings.mode === 'lan' && (
          <div className="share__lan">
            {lanLoading && <Spinner label="Finding this computer's Wi-Fi address" />}

            {!lanLoading && !lan?.reachableFromLan && (
              <p className="share__warn" role="alert">
                The server is only listening on this computer, so other devices cannot reach it.
                Restart it with <code>npm run start:lan</code> and reload this page.
              </p>
            )}

            {!lanLoading && lan?.reachableFromLan && !lan.primary && (
              <p className="share__warn" role="alert">
                No Wi-Fi or wired network address was found on this computer, so there is nothing to
                share. Connect to your network and reload.
              </p>
            )}

            {lanLink && lan?.primary && (
              <>
                <div className="share__row">
                  <span className="share__label">On your Wi-Fi</span>
                  <code className="share__link" title={lanLink}>
                    {lanLink}
                  </code>
                  <CopyButton value={lanLink} label="Copy" />
                </div>
                <p className="share__iface">
                  Using <strong>{lan.primary.address}</strong> on the “{lan.primary.iface}” adapter.
                  {lan.candidates.filter((c) => c.isPrivateLan && !c.isLoopback).length > 1 &&
                    ' If that does not work, try another address from the LAN page.'}
                </p>
                <QrCode value={lanLink} label="Scan to join on a phone" />
              </>
            )}
          </div>
        )}
      </div>
    </Panel>
  );
}

/** Renders a QR code to a canvas. Fails visibly rather than showing a blank box. */
export function QrCode({ value, label, size = 208 }: { value: string; label?: string; size?: number }): JSX.Element {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(value, {
      width: size,
      margin: 1,
      errorCorrectionLevel: 'M',
      color: { dark: '#0b0b12ff', light: '#ffffffff' },
    })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Could not build a QR code');
      });
    return () => {
      cancelled = true;
    };
  }, [value, size]);

  if (error) {
    return (
      <p className="qr__error" role="alert">
        Could not draw a QR code ({error}). Use the link above instead.
      </p>
    );
  }

  return (
    <figure className="qr">
      {dataUrl ? (
        <img className="qr__img" src={dataUrl} alt={`QR code for ${value}`} width={size} height={size} />
      ) : (
        <div className="qr__placeholder" style={{ width: size, height: size }}>
          <Spinner label="Generating QR code" />
        </div>
      )}
      {label && <figcaption className="qr__caption">{label}</figcaption>}
    </figure>
  );
}
