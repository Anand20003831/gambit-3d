import { useCallback, useEffect, useMemo, useState } from 'react';
import { MenuShell } from '../components/menu/MenuShell.js';
import { useNavigate } from 'react-router-dom';
import {
  THEME_META,
  formatRating,
  formatTimeControl,
  type JoinOutcome,
  type PublicRoomSummary,
  type RoomListFilter,
} from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { Badge, Button, EmptyState, Field, Modal, Segmented, Select, Spinner, TextInput, Toggle } from '../components/ui/index.js';

/**
 * The public room browser.
 *
 * Only rooms created in "public" mode appear here - the server filters by mode
 * structurally, so a private or LAN room can never be listed no matter what the
 * client asks for.
 */
export function LobbyPage(): JSX.Element {
  const navigate = useNavigate();
  const rooms = useStore((s) => s.publicRooms);
  const subscribeLobby = useStore((s) => s.subscribeLobby);
  const refreshLobby = useStore((s) => s.refreshLobby);
  const identity = useStore((s) => s.identity);
  const toast = useStore((s) => s.toast);

  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState<RoomListFilter>({ rated: 'any', timeKind: 'any', theme: 'any' });
  const [passwordFor, setPasswordFor] = useState<PublicRoomSummary | null>(null);
  const [password, setPassword] = useState('');
  const [joining, setJoining] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await subscribeLobby(true);
      await refreshLobby();
      if (!cancelled) setLoading(false);
    })();
    return () => {
      cancelled = true;
      void subscribeLobby(false);
    };
  }, [subscribeLobby, refreshLobby]);

  const join = useCallback(
    async (room: PublicRoomSummary, asSpectator: boolean, pass?: string) => {
      setJoining(room.id);
      const result = await rpc<'room:join', JoinOutcome>('room:join', {
        target: room.id,
        asSpectator,
        ...(pass ? { password: pass } : {}),
      });
      setJoining(null);

      if (!result.ok) {
        if (result.code === 'BAD_PASSWORD') {
          setPasswordFor(room);
          setPassword('');
          toast('warn', result.message);
          return;
        }
        toast('error', result.message);
        return;
      }

      setPasswordFor(null);
      if (result.data.status === 'pending') {
        useStore.getState().setPendingJoin({
          roomId: result.data.roomId,
          roomName: result.data.roomName,
          requestId: result.data.requestId,
        });
        toast('info', 'Waiting for the host to let you in…');
        navigate(`/room/${result.data.roomId}`);
        return;
      }
      useStore.getState().setRoom(result.data.room);
      navigate(`/room/${result.data.room.id}`);
    },
    [navigate, toast],
  );

  const visible = useMemo(() => {
    const search = (filter.search ?? '').trim().toLowerCase();
    return rooms.filter((room) => {
      if (search && !`${room.name} ${room.hostName}`.toLowerCase().includes(search)) return false;
      if (filter.rated === 'rated' && !room.rated) return false;
      if (filter.rated === 'casual' && room.rated) return false;
      if (filter.timeKind && filter.timeKind !== 'any' && room.timeControl.kind !== filter.timeKind) return false;
      if (filter.theme && filter.theme !== 'any' && room.theme !== filter.theme) return false;
      if (filter.hidePasswordProtected && room.passwordProtected) return false;
      if (filter.hideFull && room.seatsOpen === 0) return false;
      return true;
    });
  }, [rooms, filter]);

  return (
    <MenuShell
      wide
      title="Public games"
      back={{ to: '/play', label: 'Play' }}
    >
      <div className="page lobby">
        <header className="page__head">
          <div>

            <p className="muted">
              {rooms.length === 0
                ? 'No one is hosting right now.'
                : `${visible.length} of ${rooms.length} game${rooms.length === 1 ? '' : 's'} shown`}
            </p>
          </div>
          <div className="page__headActions">
            <Button onClick={() => void refreshLobby()}>Refresh</Button>
            <Button variant="primary" onClick={() => navigate('/create?mode=public')}>
              Host a game
            </Button>
          </div>
        </header>

        <section className="lobby__filters" aria-label="Filter games">
          <Field label="Search" inline>
            {(id) => (
              <TextInput
                id={id}
                type="search"
                placeholder="Room or host name"
                value={filter.search ?? ''}
                onChange={(e) => setFilter((f) => ({ ...f, search: e.target.value }))}
              />
            )}
          </Field>

          <Segmented
            label="Rated"
            value={filter.rated ?? 'any'}
            onChange={(rated) => setFilter((f) => ({ ...f, rated }))}
            options={[
              { value: 'any', label: 'All' },
              { value: 'rated', label: 'Rated' },
              { value: 'casual', label: 'Casual' },
            ]}
          />

          <Field label="Time control" inline>
            {(id) => (
              <Select
                id={id}
                value={filter.timeKind ?? 'any'}
                onValueChange={(timeKind) => setFilter((f) => ({ ...f, timeKind }))}
                options={[
                  { value: 'any', label: 'Any speed' },
                  { value: 'untimed', label: 'Untimed' },
                  { value: 'bullet', label: 'Bullet' },
                  { value: 'blitz', label: 'Blitz' },
                  { value: 'rapid', label: 'Rapid' },
                  { value: 'classical', label: 'Classical' },
                ]}
              />
            )}
          </Field>

          <Field label="Map" inline>
            {(id) => (
              <Select
                id={id}
                value={filter.theme ?? 'any'}
                onValueChange={(theme) => setFilter((f) => ({ ...f, theme }))}
                options={[
                  { value: 'any', label: 'Any map' },
                  ...THEME_META.map((m) => ({ value: m.id, label: m.name })),
                ]}
              />
            )}
          </Field>

          <Toggle
            checked={filter.hideFull ?? false}
            onChange={(v) => setFilter((f) => ({ ...f, hideFull: v }))}
            label="Only games needing a player"
          />
          <Toggle
            checked={filter.hidePasswordProtected ?? false}
            onChange={(v) => setFilter((f) => ({ ...f, hidePasswordProtected: v }))}
            label="Hide password-protected"
          />
        </section>

        {loading ? (
          <div className="lobby__loading">
            <Spinner label="Loading games" />
          </div>
        ) : visible.length === 0 ? (
          <EmptyState
            icon="♟"
            title={rooms.length === 0 ? 'No public games yet' : 'Nothing matches those filters'}
            message={
              rooms.length === 0
                ? 'Host one and it will appear here for everyone else.'
                : 'Try widening the filters, or host your own game.'
            }
            action={
              <Button variant="primary" onClick={() => navigate('/create?mode=public')}>
                Host a game
              </Button>
            }
          />
        ) : (
          <ul className="lobby__list">
            {visible.map((room) => (
              <li key={room.id}>
                <RoomRow
                  room={room}
                  myRating={identity?.rating ?? 1200}
                  busy={joining === room.id}
                  onJoin={(asSpectator) => {
                    if (room.passwordProtected) {
                      setPasswordFor(room);
                      setPassword('');
                      // Remember whether they wanted to spectate.
                      setSpectateIntent(asSpectator);
                      return;
                    }
                    void join(room, asSpectator);
                  }}
                />
              </li>
            ))}
          </ul>
        )}

        <Modal
          open={passwordFor !== null}
          title={`Password for “${passwordFor?.name ?? ''}”`}
          description="This host requires a password to join."
          onClose={() => setPasswordFor(null)}
          size="sm"
          footer={
            <>
              <Button onClick={() => setPasswordFor(null)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={password.length < 4}
                onClick={() => passwordFor && void join(passwordFor, spectateIntent, password)}
              >
                Join
              </Button>
            </>
          }
        >
          <Field label="Room password">
            {(id) => (
              <TextInput
                id={id}
                type="password"
                value={password}
                data-autofocus
                autoComplete="off"
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password.length >= 4 && passwordFor) {
                    void join(passwordFor, spectateIntent, password);
                  }
                }}
              />
            )}
          </Field>
        </Modal>
      </div>
    </MenuShell>
  );
}

// Module-scoped because it only bridges two event handlers within one page.
let spectateIntent = false;
function setSpectateIntent(value: boolean): void {
  spectateIntent = value;
}

function RoomRow({
  room,
  myRating,
  busy,
  onJoin,
}: {
  room: PublicRoomSummary;
  myRating: number;
  busy: boolean;
  onJoin: (asSpectator: boolean) => void;
}): JSX.Element {
  const outOfRange = room.ratingRangeEnabled && (myRating < room.ratingMin || myRating > room.ratingMax);
  const canSit = room.seatsOpen > 0 && !room.locked && !outOfRange;
  const canWatch = room.allowSpectators && !room.locked;
  const themeName = THEME_META.find((t) => t.id === room.theme)?.name ?? room.theme;

  return (
    <article className="roomrow">
      <div className="roomrow__main">
        <h2 className="roomrow__name">{room.name}</h2>
        <p className="roomrow__host">
          Hosted by {room.hostName} · {formatRating(room.hostRating, false)}
        </p>
        <div className="roomrow__tags">
          <Badge tone="accent">{formatTimeControl(room.timeControl)}</Badge>
          <Badge tone={room.rated ? 'success' : 'neutral'}>{room.rated ? 'Rated' : 'Casual'}</Badge>
          <Badge>{themeName}</Badge>
          {room.passwordProtected && <Badge tone="warn">Password</Badge>}
          {room.requireApproval && <Badge tone="warn">Host approval</Badge>}
          {room.locked && <Badge tone="danger">Locked</Badge>}
          {room.phase === 'active' && <Badge tone="accent">In progress</Badge>}
          {room.ratingRangeEnabled && (
            <Badge tone={outOfRange ? 'danger' : 'neutral'}>
              {room.ratingMin}–{room.ratingMax}
            </Badge>
          )}
        </div>
      </div>

      <div className="roomrow__meta">
        <span className="roomrow__seats">
          {room.seatsOpen === 0 ? 'Both seats taken' : `${room.seatsOpen} seat${room.seatsOpen === 1 ? '' : 's'} open`}
        </span>
        {room.allowSpectators && (
          <span className="roomrow__watchers">
            {room.spectatorCount} watching
          </span>
        )}
      </div>

      <div className="roomrow__actions">
        <Button variant="primary" disabled={!canSit} loading={busy} onClick={() => onJoin(false)}>
          {canSit ? 'Play' : outOfRange ? 'Rating locked' : 'Full'}
        </Button>
        {canWatch && (
          <Button onClick={() => onJoin(true)} disabled={busy}>
            Watch
          </Button>
        )}
      </div>
    </article>
  );
}
