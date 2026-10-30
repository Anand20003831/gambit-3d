import { useCallback, useEffect, useState } from 'react';
import { MenuShell } from '../components/menu/MenuShell.js';
import { useNavigate } from 'react-router-dom';
import type { LanInfo, RoomView } from '@gambit3d/shared';
import { DEFAULT_ROOM_SETTINGS, TIME_PRESETS } from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { QrCode } from '../components/panels/SharePanel.js';
import { Badge, Button, CopyButton, Field, Panel, Select, Spinner } from '../components/ui/index.js';

/**
 * Local Wi-Fi setup.
 *
 * This page exists to answer one question honestly: "what address do I type on
 * the other device?" It never reports loopback as the LAN address, and it says
 * plainly when the server is not actually reachable from the network.
 */
export function LanPage(): JSX.Element {
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);

  const [info, setInfo] = useState<LanInfo | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [presetId, setPresetId] = useState('rapid-10-5');
  const [theme, setTheme] = useState(DEFAULT_ROOM_SETTINGS.theme);
  const [creating, setCreating] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    // The HTTP endpoint also returns human-readable diagnostics.
    try {
      const response = await fetch('/api/lan');
      if (response.ok) {
        const body = (await response.json()) as { ok: boolean; data: LanInfo & { warnings: string[] } };
        if (body.ok) {
          setInfo(body.data);
          setWarnings(body.data.warnings ?? []);
          setLoading(false);
          return;
        }
      }
    } catch {
      // Fall through to the socket path.
    }
    const result = await rpc<'lan:info', LanInfo>('lan:info', {});
    setLoading(false);
    if (result.ok) setInfo(result.data);
    else toast('error', 'Could not read this computer’s network addresses.');
  }, [toast]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const createRoom = useCallback(async () => {
    const preset = TIME_PRESETS.find((p) => p.id === presetId) ?? TIME_PRESETS[8]!;
    setCreating(true);
    const result = await rpc<'room:create', { room: RoomView }>('room:create', {
      settings: {
        ...DEFAULT_ROOM_SETTINGS,
        name: 'Wi-Fi game',
        mode: 'lan',
        theme,
        timeControl: { initialSeconds: preset.initialSeconds, incrementSeconds: preset.incrementSeconds },
        passwordProtected: undefined,
      },
    });
    setCreating(false);
    if (!result.ok) {
      toast('error', result.message);
      return;
    }
    useStore.getState().setRoom(result.data.room);
    navigate(`/room/${result.data.room.id}`);
  }, [presetId, theme, navigate, toast]);

  const joinUrl = info?.joinUrl ?? null;
  const usable = Boolean(info?.reachableFromLan && info?.primary);

  return (
    <MenuShell
      wide
      title="Play over local Wi-Fi"
      back={{ to: '/play', label: 'Play' }}
    >
      <div className="page lan">
        <header className="page__head">
          <div>

            <p className="muted">
              Both devices need to be on the same Wi-Fi network. No internet connection is required.
            </p>
          </div>
          <Button onClick={() => void refresh()}>Re-check network</Button>
        </header>

        <div className="lan__grid">
          <Panel title="This computer">
            {loading ? (
              <Spinner label="Reading network addresses" />
            ) : (
              <div className="lan__status">
                <div className="lan__statusRow">
                  <span>Listening on</span>
                  <code>
                    {info?.boundHost}:{info?.port}
                  </code>
                  <Badge tone={info?.reachableFromLan ? 'success' : 'danger'}>
                    {info?.reachableFromLan ? 'Reachable from your Wi-Fi' : 'This computer only'}
                  </Badge>
                </div>

                <div className="lan__statusRow">
                  <span>Computer name</span>
                  <code>{info?.hostname}</code>
                </div>

                {info?.primary ? (
                  <div className="lan__statusRow">
                    <span>Wi-Fi address</span>
                    <code className="lan__primary">{info.primary.address}</code>
                    <Badge>{info.primary.iface}</Badge>
                  </div>
                ) : (
                  <p className="lan__warn" role="alert">
                    No private network address found. This computer does not appear to be on a Wi-Fi or
                    wired network.
                  </p>
                )}

                {warnings.map((warning) => (
                  <p key={warning} className="lan__warn" role="alert">
                    {warning}
                  </p>
                ))}
              </div>
            )}
          </Panel>

          <Panel title="Join from another device">
            {usable && joinUrl ? (
              <div className="lan__join">
                <p className="lan__joinLead">On the other device, open a browser and go to:</p>
                <div className="lan__url">
                  <code>{joinUrl}</code>
                  <CopyButton value={joinUrl} label="Copy" size="md" />
                </div>
                <QrCode value={joinUrl} label="Or scan this with a phone camera" size={220} />
              </div>
            ) : (
              <div className="lan__notReady">
                <p>
                  Nothing to share yet. Start the server so it accepts connections from your network:
                </p>
                <pre className="lan__cmd">
                  <code>npm run start:lan</code>
                </pre>
                <p className="muted">
                  The first time you run it, Windows will ask whether to allow Node.js through the
                  firewall. Tick <strong>Private networks</strong> and click Allow. Full instructions
                  are in <code>LAN_SETUP.md</code>.
                </p>
              </div>
            )}
          </Panel>

          {info && info.candidates.filter((c) => c.isPrivateLan && !c.isLoopback).length > 1 && (
            <Panel title="Other addresses on this computer" collapsible defaultOpen={false}>
              <p className="muted">
                If the address above does not work, one of these may be the right adapter. Loopback
                addresses are listed for completeness but will never work from another device.
              </p>
              <ul className="lan__addresses">
                {info.candidates.map((candidate) => (
                  <li key={`${candidate.iface}-${candidate.address}`}>
                    <code>{candidate.address}</code>
                    <span className="lan__iface">{candidate.iface}</span>
                    <span className="lan__family">{candidate.family}</span>
                    {candidate.isLoopback && <Badge tone="danger">Loopback — not usable</Badge>}
                    {candidate.isPrivateLan && !candidate.isLoopback && <Badge tone="success">Usable</Badge>}
                    {!candidate.isPrivateLan && !candidate.isLoopback && <Badge tone="warn">Public/unknown</Badge>}
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel title="Start the game">
            <Field label="Time control">
              {(id) => (
                <Select
                  id={id}
                  value={presetId}
                  onValueChange={setPresetId}
                  options={TIME_PRESETS.map((p) => ({ value: p.id, label: p.label }))}
                />
              )}
            </Field>
            <Field label="Map">
              {(id) => (
                <Select
                  id={id}
                  value={theme}
                  onValueChange={(v) => setTheme(v as typeof theme)}
                  options={[
                    { value: 'apartment', label: 'Neon City Apartment' },
                    { value: 'station', label: 'Orbital Station' },
                  ]}
                />
              )}
            </Field>
            <Button variant="primary" size="lg" full loading={creating} onClick={() => void createRoom()}>
              Create Wi-Fi room
            </Button>
            <p className="muted lan__afterCreate">
              After the room opens, its Room panel shows the exact join link and QR code to use on the
              other device.
            </p>
          </Panel>
        </div>
      </div>
    </MenuShell>
  );
}
