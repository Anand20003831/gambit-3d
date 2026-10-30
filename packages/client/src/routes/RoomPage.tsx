import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { JoinOutcome, RoomView, Seat, Square } from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { useGameController } from '../hooks/useGameController.js';
import { useAudioBinding } from '../hooks/useAudio.js';
import { budgetFor, detectDevice, shouldReduceMotion, useSettings } from '../hooks/useSettings.js';
import { getTheme } from '../three/themes/index.js';
import { Scene, useWebGLHealth } from '../three/Scene.js';
import { Board2D } from '../components/board2d/Board2D.js';
import { PlayerCard } from '../components/panels/PlayerCard.js';
import { MoveList, ResultBanner } from '../components/panels/MoveList.js';
import { ChatPanel } from '../components/panels/ChatPanel.js';
import { GameControls } from '../components/panels/GameControls.js';
import { ModerationPanel } from '../components/panels/ModerationPanel.js';
import { SharePanel } from '../components/panels/SharePanel.js';
import { PromotionDialog } from '../components/panels/PromotionDialog.js';
import { RoomSettingsPanel } from '../components/panels/RoomSettingsPanel.js';
import { Button, Panel, Segmented, Spinner } from '../components/ui/index.js';

type DockTab = 'moves' | 'chat' | 'room' | 'manage';

/**
 * The game room.
 *
 * The 3D scene fills the whole viewport; every piece of interface floats above
 * it. Overlay containers are pointer-transparent and only the panels themselves
 * take input, so the board can be orbited from almost anywhere on screen.
 */
export function RoomPage(): JSX.Element {
  const { roomId } = useParams<{ roomId: string }>();
  const navigate = useNavigate();

  const room = useStore((s) => s.room);
  const pendingJoin = useStore((s) => s.pendingJoin);
  const status = useStore((s) => s.status);
  const toast = useStore((s) => s.toast);

  const settings = useSettings();
  const profile = detectDevice();
  const reducedMotion = shouldReduceMotion(settings, profile);
  const quality = useMemo(() => budgetFor(settings.quality, profile), [settings.quality, profile]);

  const [joinState, setJoinState] = useState<'idle' | 'joining' | 'failed'>('idle');
  const [tab, setTab] = useState<DockTab>('moves');
  const [resetCamera, setResetCamera] = useState(0);
  const [dockOpen, setDockOpen] = useState(true);
  const [hudHidden, setHudHidden] = useState(false);

  const { healthy: webglHealthy } = useWebGLHealth();
  const { stalled: sceneStalled, markReady } = useSceneWatchdog(
    settings.renderMode === '3d' && profile.webglAvailable && webglHealthy,
  );

  const theme = useMemo(
    () => getTheme(settings.themeOverride ?? room?.settings.theme ?? 'apartment'),
    [settings.themeOverride, room?.settings.theme],
  );

  useAudioBinding(theme.id);

  // Skin the whole shell to match the map, and stop the page scrolling behind
  // the fullscreen canvas.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.map = theme.id;
    root.dataset.immersive = 'on';
    root.style.setProperty('--map-accent', theme.ui.accent);
    root.style.setProperty('--map-accent-soft', theme.ui.accentSoft);
    root.style.setProperty('--map-surface', theme.ui.surface);
    root.style.setProperty('--map-surface-raised', theme.ui.surfaceRaised);
    root.style.setProperty('--map-text', theme.ui.text);
    root.style.setProperty('--map-text-muted', theme.ui.textMuted);
    root.style.setProperty('--map-border', theme.ui.border);
    root.style.setProperty('--map-display-font', theme.ui.displayFont);
    root.style.setProperty('--map-body-font', theme.ui.bodyFont);
    return () => {
      delete root.dataset.map;
      delete root.dataset.immersive;
    };
  }, [theme]);

  // Join (or re-attach to) the room named in the URL.
  useEffect(() => {
    if (!roomId) return;
    if (room?.id === roomId) return;
    if (pendingJoin?.roomId === roomId) return;
    if (joinState === 'joining' || joinState === 'failed') return;
    if (status !== 'online') return;

    setJoinState('joining');
    void (async () => {
      const result = await rpc<'room:join', JoinOutcome>('room:join', { target: roomId });
      if (!result.ok) {
        setJoinState('failed');
        toast('error', result.message);
        return;
      }
      setJoinState('idle');
      if (result.data.status === 'pending') {
        useStore.getState().setPendingJoin({
          roomId: result.data.roomId,
          roomName: result.data.roomName,
          requestId: result.data.requestId,
        });
      } else {
        useStore.getState().setRoom(result.data.room);
      }
    })();
  }, [roomId, room?.id, pendingJoin?.roomId, joinState, status, toast]);

  const controller = useGameController(room);

  const leave = useCallback(async () => {
    await useStore.getState().leaveRoom();
    navigate('/');
  }, [navigate]);

  // Keyboard: H hides the interface, Escape brings it back, R resets the camera.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;

      if (event.key === 'h' || event.key === 'H') setHudHidden((v) => !v);
      else if (event.key === 'Escape') setHudHidden(false);
      else if (event.key === 'r' || event.key === 'R') setResetCamera((n) => n + 1);
      else if (event.key === 'b' || event.key === 'B') setDockOpen((v) => !v);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // --- pre-room states -----------------------------------------------------

  if (pendingJoin && pendingJoin.roomId === roomId) {
    return (
      <div className="page page--narrow room__waiting">
        <h1>Waiting for the host</h1>
        <Spinner label="Waiting for approval" />
        <p className="muted">
          You asked to join “{pendingJoin.roomName}”. The host has been notified and will let you in
          or decline.
        </p>
        <Button onClick={() => void leave()}>Cancel</Button>
      </div>
    );
  }

  if (!room || room.id !== roomId) {
    if (joinState === 'failed') {
      return (
        <div className="page page--narrow">
          <h1>Could not join that room</h1>
          <p className="muted">It may have closed, be locked, need a password, or the code may be wrong.</p>
          <div className="room__failActions">
            <Link className="btn btn--primary btn--md" to="/join">
              Enter a code
            </Link>
            <Link className="btn btn--secondary btn--md" to="/lobby">
              Browse public games
            </Link>
            <Link className="btn btn--ghost btn--md" to="/">
              Menu
            </Link>
          </div>
        </div>
      );
    }
    return (
      <div className="page page--narrow room__waiting">
        <Spinner label="Joining the room" />
        <p className="muted">Joining…</p>
      </div>
    );
  }

  // --- board ---------------------------------------------------------------

  const use3D = settings.renderMode === '3d' && profile.webglAvailable && webglHealthy && !sceneStalled;
  const seat: Seat | null = boardOrientation(room);
  const nearColor = seat === 'b' ? 'b' : 'w';
  const farColor = seat === 'b' ? 'w' : 'b';

  const markers = {
    selected: controller.selected,
    legalMoves: controller.legalMoves,
    legalCaptures: controller.legalCaptures,
    lastMove: room.game.lastMove,
    checkSquare: controller.checkSquare,
    hovered: null as Square | null,
    premove: controller.premove ? { from: controller.premove.from, to: controller.premove.to } : null,
  };

  const tension = room.game.inCheck && room.game.phase === 'active' ? 1 : 0;
  const staff = room.you.isHost || room.you.isModerator;

  return (
    <div className={`room ${theme.ui.className} ${hudHidden ? 'is-hudHidden' : ''}`}>
      {/* ---------------- stage: fills the viewport ---------------- */}
      <div className="room__stage">
        {use3D ? (
          <Suspense
            fallback={
              <div className="room__sceneLoading" style={{ background: theme.loadingBackground }}>
                <Spinner label="Loading the map" />
                <p style={{ color: theme.loadingAccent }}>Loading {theme.name}…</p>
              </div>
            }
          >
            <Scene
              theme={theme}
              quality={quality}
              settings={settings}
              reducedMotion={reducedMotion}
              pieces={controller.pieces}
              markers={markers}
              seat={seat}
              interactive={room.game.phase === 'active' || room.game.phase === 'ready'}
              controllable={controller.controllable}
              frozen={controller.promotionPrompt !== null}
              tension={tension}
              onSquarePointerDown={(square) => controller.onSquare(square)}
              onHover={() => undefined}
              resetCameraToken={resetCamera}
              onReady={markReady}
            />
          </Suspense>
        ) : (
          <div className="room__stage2d" style={{ background: theme.loadingBackground }}>
            <Board2D
              theme={theme}
              pieces={controller.pieces}
              seat={seat}
              selected={controller.selected}
              legalMoves={controller.legalMoves}
              legalCaptures={controller.legalCaptures}
              lastMove={room.game.lastMove}
              checkSquare={controller.checkSquare}
              premove={markers.premove}
              interactive={room.game.phase === 'active'}
              controllable={controller.controllable}
              showCoordinates={settings.showCoordinates}
              colorBlindSafe={settings.colorBlindSafe}
              onSquare={controller.onSquare}
            />
          </div>
        )}
      </div>

      {/* ---------------- floating interface ---------------- */}
      <div className="hud" aria-hidden={hudHidden}>
        {/* Top-left: identity of the room */}
        <div className="hud__topLeft hud__zone">
          <div className="hud__card hud__roomChip">
            <Link to="/" className="hud__homeBtn" aria-label="Back to menu" title="Back to menu">
              ←
            </Link>
            <div className="hud__roomText">
              <span className="hud__roomName">{room.settings.name}</span>
              <span className="hud__roomMeta">
                {theme.name} · {room.settings.rated ? 'Rated' : 'Casual'} · {modeLabel(room.settings.mode)}
              </span>
            </div>
          </div>

          {(!profile.webglAvailable || !webglHealthy || sceneStalled) && settings.renderMode === '3d' && (
            <div className="hud__card hud__notice" role="status">
              {!profile.webglAvailable
                ? 'This device has no WebGL, so the 2D board is being used. The game is unaffected.'
                : !webglHealthy
                  ? 'The 3D view crashed and was replaced with the 2D board. Reload to try again.'
                  : 'The 3D view did not start in this browser, so the 2D board is being used.'}
            </div>
          )}
        </div>

        {/* Top-right: view controls */}
        <div className="hud__topRight hud__zone">
          <div className="hud__card hud__tools">
            {use3D && (
              <button
                type="button"
                className="hud__tool"
                onClick={() => setResetCamera((n) => n + 1)}
                title="Reset camera (R)"
              >
                Reset view
              </button>
            )}
            <button
              type="button"
              className="hud__tool"
              onClick={() => useSettings.getState().set('renderMode', settings.renderMode === '3d' ? '2d' : '3d')}
              title="Switch between the 3D and 2D board"
            >
              {settings.renderMode === '3d' ? '2D' : '3D'}
            </button>
            <button type="button" className="hud__tool" onClick={() => setHudHidden(true)} title="Hide the interface (H)">
              Hide UI
            </button>
            <Link className="hud__tool" to="/settings" title="Settings">
              Settings
            </Link>
            <button
              type="button"
              className={`hud__tool ${dockOpen ? 'is-active' : ''}`}
              onClick={() => setDockOpen((v) => !v)}
              aria-expanded={dockOpen}
              title="Show or hide the side panel (B)"
            >
              Panel
            </button>
          </div>
        </div>

        {/* Left rail: the two players */}
        <div className="hud__left hud__zone">
          <div className="hud__card hud__player">
            <PlayerCard room={room} color={farColor} isSelf={room.you.seat === farColor} compact />
          </div>
          <div className="hud__card hud__player">
            <PlayerCard room={room} color={nearColor} isSelf={room.you.seat === nearColor} compact />
          </div>

          {room.game.phase !== 'active' && room.game.phase !== 'finished' && (
            <div className="hud__card hud__waiting" role="status">
              <WaitingNotice room={room} />
            </div>
          )}
        </div>

        {/* Bottom-centre: the action bar */}
        <div className="hud__bottom hud__zone">
          <div className="hud__card hud__controls">
            <GameControls room={room} />
          </div>
        </div>

        {/* Right: the dock */}
        <aside className={`hud__dock ${dockOpen ? 'is-open' : ''}`} aria-label="Game panels">
          <div className="hud__card hud__dockInner">
            <Segmented
              label="Panel"
              value={tab}
              onChange={setTab}
              options={[
                { value: 'moves', label: 'Moves' },
                { value: 'chat', label: 'Chat' },
                { value: 'room', label: 'Room' },
                { value: 'manage', label: 'Manage', disabled: !staff },
              ]}
            />

            <div className="hud__dockBody">
              {tab === 'moves' && <MoveList room={room} />}
              {tab === 'chat' && <ChatPanel room={room} />}
              {tab === 'room' && (
                <>
                  <SharePanel room={room} />
                  <SeatPanel room={room} />
                  <Panel title="This map">
                    <p className="muted">{theme.description}</p>
                    {theme.attribution && theme.attribution.length > 0 && (
                      <ul className="room__attribution">
                        {theme.attribution.map((line) => (
                          <li key={line}>{line}</li>
                        ))}
                      </ul>
                    )}
                  </Panel>
                </>
              )}
              {tab === 'manage' && (
                <>
                  <RoomSettingsPanel room={room} />
                  <ModerationPanel room={room} />
                </>
              )}
            </div>

            <Button variant="ghost" full onClick={() => void leave()}>
              Leave room
            </Button>
          </div>
        </aside>
      </div>

      {/* Result overlay, centred over the board */}
      {room.game.result && (
        <div className="room__resultOverlay">
          <div className="hud__card">
            <ResultBanner
              room={room}
              onRematch={() => void rpc('game:offer', { roomId: room.id, kind: 'rematch' })}
              onLeave={() => void leave()}
            />
          </div>
        </div>
      )}

      {/* Restore button when the interface is hidden */}
      {hudHidden && (
        <button type="button" className="room__showHud" onClick={() => setHudHidden(false)}>
          Show interface <kbd>H</kbd>
        </button>
      )}

      <PromotionDialog
        open={controller.promotionPrompt !== null}
        color={controller.controllable ?? 'w'}
        onChoose={controller.choosePromotion}
        onCancel={controller.cancelPromotion}
      />
    </div>
  );
}

function modeLabel(mode: RoomView['settings']['mode']): string {
  switch (mode) {
    case 'public':
      return 'Public';
    case 'private':
      return 'Private';
    case 'lan':
      return 'Local Wi-Fi';
    default:
      return 'Same device';
  }
}

/**
 * Which way round the board is drawn.
 *
 * Normally it follows the viewer's seat. In same-device mode there is only one
 * viewer for both players, so the board turns to face whoever is to move.
 */
function boardOrientation(room: RoomView): Seat | null {
  if (room.settings.mode === 'local') {
    return room.game.phase === 'active' ? room.game.turn : 'w';
  }
  return room.you.seat;
}

/**
 * Watches for a 3D canvas that mounts but never produces a WebGL renderer.
 *
 * That happens in embedded browser views that never report an element size, and
 * it would otherwise leave the player staring at an empty rectangle. After the
 * grace period we hand over to the 2D board, which is fully playable.
 */
function useSceneWatchdog(active: boolean): { ready: boolean; stalled: boolean; markReady: () => void } {
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);

  const markReady = useCallback(() => {
    setReady(true);
    setStalled(false);
  }, []);

  useEffect(() => {
    if (!active || ready) return undefined;
    const id = window.setTimeout(() => setStalled(true), 6000);
    return () => window.clearTimeout(id);
  }, [active, ready]);

  useEffect(() => {
    if (!active) {
      setStalled(false);
      setReady(false);
    }
  }, [active]);

  return { ready, stalled, markReady };
}

function WaitingNotice({ room }: { room: RoomView }): JSX.Element {
  if (room.settings.mode === 'local') {
    return (
      <p>
        Both players share this screen. Press <strong>Start game</strong> to begin.
      </p>
    );
  }

  const missing = room.seats.w === null || room.seats.b === null;
  if (missing) {
    return <p>Waiting for another player. Share the code from the Room panel.</p>;
  }
  return room.you.isHost ? (
    <p>
      Both seats filled. Press <strong>Start game</strong> when ready.
    </p>
  ) : (
    <p>Both seats filled. Waiting for the host to start.</p>
  );
}

/** Lets a spectator claim an empty seat, and a seated player step down before the game. */
function SeatPanel({ room }: { room: RoomView }): JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);

  const take = async (seat: Seat | null): Promise<void> => {
    setBusy(seat ?? 'leave');
    const result = await rpc('room:setSeat', { roomId: room.id, seat });
    setBusy(null);
    if (!result.ok) toast('error', result.message);
  };

  const canTake = room.you.can.takeSeat;
  const seated = room.you.seat !== null;
  const canStepDown = seated && room.game.phase !== 'active' && room.game.phase !== 'finished';

  if (!canTake && !canStepDown) return null;

  return (
    <Panel title="Seats">
      <div className="seatpanel">
        {canTake && (
          <>
            <Button disabled={room.seats.w !== null} loading={busy === 'w'} onClick={() => void take('w')}>
              {room.seats.w === null ? 'Take White' : 'White taken'}
            </Button>
            <Button disabled={room.seats.b !== null} loading={busy === 'b'} onClick={() => void take('b')}>
              {room.seats.b === null ? 'Take Black' : 'Black taken'}
            </Button>
          </>
        )}
        {canStepDown && (
          <Button variant="subtle" loading={busy === 'leave'} onClick={() => void take(null)}>
            Step down to spectator
          </Button>
        )}
      </div>
    </Panel>
  );
}
