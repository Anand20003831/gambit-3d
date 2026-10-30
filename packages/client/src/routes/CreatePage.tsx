import { useCallback, useMemo, useState } from 'react';
import { MenuShell } from '../components/menu/MenuShell.js';
import { useNavigate, useSearchParams } from 'react-router-dom';
import {
  DEFAULT_ROOM_SETTINGS,
  LIMITS,
  THEME_META,
  TIME_PRESETS,
  classifyTimeControl,
  type ColorChoice,
  type HostRole,
  type RoomMode,
  type RoomSettings,
  type RoomView,
  type ThemeId,
} from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { Button, Field, Panel, Segmented, Select, TextInput, Toggle } from '../components/ui/index.js';

/**
 * Room creation.
 *
 * Every control here maps to a real server-enforced setting. Options that do not
 * apply to the chosen mode are disabled with an explanation rather than hidden,
 * so the shape of the form stays predictable.
 */
export function CreatePage(): JSX.Element {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const toast = useStore((s) => s.toast);
  const identity = useStore((s) => s.identity);

  const initialMode = (params.get('mode') as RoomMode | null) ?? 'public';

  const [settings, setSettings] = useState<RoomSettings>(() => ({
    ...DEFAULT_ROOM_SETTINGS,
    mode: isMode(initialMode) ? initialMode : 'public',
    name: defaultRoomName(initialMode, identity?.name),
    ...(initialMode === 'local'
      ? { hostRole: 'play' as HostRole, allowSpectators: false, rated: false, requireApproval: false }
      : {}),
  }));

  const [presetId, setPresetId] = useState('rapid-10-5');
  const [customMinutes, setCustomMinutes] = useState(10);
  const [customIncrement, setCustomIncrement] = useState(5);
  const [usePassword, setUsePassword] = useState(false);
  const [password, setPassword] = useState('');
  const [creating, setCreating] = useState(false);

  const isLocal = settings.mode === 'local';
  const isPublic = settings.mode === 'public';

  const patch = useCallback(<K extends keyof RoomSettings>(key: K, value: RoomSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const timeControl = useMemo(() => {
    if (presetId === 'custom') {
      const initialSeconds = Math.round(customMinutes * 60);
      return {
        kind: classifyTimeControl(initialSeconds, customIncrement),
        initialSeconds,
        incrementSeconds: customIncrement,
      };
    }
    const preset = TIME_PRESETS.find((p) => p.id === presetId) ?? TIME_PRESETS[8]!;
    return {
      kind: preset.kind,
      initialSeconds: preset.initialSeconds,
      incrementSeconds: preset.incrementSeconds,
    };
  }, [presetId, customMinutes, customIncrement]);

  const changeMode = useCallback(
    (mode: RoomMode) => {
      setSettings((prev) => ({
        ...prev,
        mode,
        name: prev.name === defaultRoomName(prev.mode, identity?.name) ? defaultRoomName(mode, identity?.name) : prev.name,
        // Same-device play has no second party to moderate, rate or approve.
        ...(mode === 'local'
          ? { hostRole: 'play' as HostRole, rated: false, requireApproval: false, allowSpectators: false, ratingRangeEnabled: false }
          : {}),
        // Rating ranges only mean anything in a browsable pool.
        ...(mode !== 'public' ? { ratingRangeEnabled: false, casualOnly: false } : {}),
      }));
      if (mode === 'local') setUsePassword(false);
    },
    [identity?.name],
  );

  const create = useCallback(async () => {
    if (usePassword && password.length < LIMITS.passwordMinLength) {
      toast('warn', `Passwords need at least ${LIMITS.passwordMinLength} characters.`);
      return;
    }
    setCreating(true);

    const payload = {
      settings: {
        ...settings,
        timeControl: {
          initialSeconds: timeControl.initialSeconds,
          incrementSeconds: timeControl.incrementSeconds,
        },
      },
      ...(usePassword && password ? { password } : {}),
    };
    // `passwordProtected` is derived server-side from whether a password arrived.
    delete (payload.settings as Partial<RoomSettings>).passwordProtected;

    const result = await rpc<'room:create', { room: RoomView }>('room:create', payload);
    setCreating(false);

    if (!result.ok) {
      toast('error', result.message);
      return;
    }
    useStore.getState().setRoom(result.data.room);
    navigate(`/room/${result.data.room.id}`);
  }, [settings, timeControl, usePassword, password, toast, navigate]);

  return (
    <MenuShell
      wide
      title="New game"
      back={{ to: '/play', label: 'Play' }}
    >
      <div className="page create">
        <header className="page__head">
          <div>

            <p className="muted">Everything here is enforced by the server, not just the interface.</p>
          </div>
        </header>

        <div className="create__grid">
          <div className="create__column">
            <Panel title="Game type">
              <Segmented
                label="Where this game is visible"
                value={settings.mode}
                onChange={changeMode}
                options={[
                  { value: 'public', label: 'Public' },
                  { value: 'private', label: 'Private' },
                  { value: 'lan', label: 'Local Wi-Fi' },
                  { value: 'local', label: 'Same device' },
                ]}
              />
              <p className="create__modeHelp">{MODE_HELP[settings.mode]}</p>

              <Field label="Room name">
                {(id) => (
                  <TextInput
                    id={id}
                    value={settings.name}
                    maxLength={LIMITS.roomNameMaxLength}
                    onChange={(e) => patch('name', e.target.value)}
                  />
                )}
              </Field>

              <Field label="Map" hint="Sets the environment, pieces, music and interface style.">
                {(id) => (
                  <Select
                    id={id}
                    value={settings.theme}
                    onValueChange={(theme) => patch('theme', theme as ThemeId)}
                    options={THEME_META.map((m) => ({ value: m.id, label: m.name }))}
                  />
                )}
              </Field>
              <p className="create__mapTagline">
                {THEME_META.find((m) => m.id === settings.theme)?.tagline}
              </p>
            </Panel>

            <Panel title="Time control">
              <Field label="Preset">
                {(id) => (
                  <Select
                    id={id}
                    value={presetId}
                    onValueChange={setPresetId}
                    options={[
                      ...TIME_PRESETS.map((p) => ({ value: p.id, label: p.label })),
                      { value: 'custom', label: 'Custom…' },
                    ]}
                  />
                )}
              </Field>

              {presetId === 'custom' && (
                <div className="create__customTime">
                  <Field label="Minutes per side">
                    {(id) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={0}
                        max={LIMITS.maxInitialSeconds / 60}
                        step={0.5}
                        value={customMinutes}
                        onChange={(e) => setCustomMinutes(Math.max(0, Number(e.target.value)))}
                      />
                    )}
                  </Field>
                  <Field label="Increment (seconds)">
                    {(id) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={0}
                        max={LIMITS.maxIncrementSeconds}
                        value={customIncrement}
                        onChange={(e) => setCustomIncrement(Math.max(0, Number(e.target.value)))}
                      />
                    )}
                  </Field>
                </div>
              )}

              <p className="create__timeSummary">
                {timeControl.initialSeconds === 0
                  ? 'No clock — the game runs until someone resigns or the position ends it.'
                  : `${(timeControl.initialSeconds / 60).toFixed(timeControl.initialSeconds % 60 === 0 ? 0 : 1)} minutes each, +${timeControl.incrementSeconds}s per move (${timeControl.kind}).`}
              </p>
            </Panel>

            <Panel title="Your role">
              <Segmented
                label="How you take part"
                value={settings.hostRole}
                onChange={(hostRole) => patch('hostRole', hostRole)}
                options={[
                  { value: 'play', label: 'Play' },
                  { value: 'spectate', label: 'Spectate', disabled: isLocal },
                  { value: 'moderate', label: 'Moderate only', disabled: isLocal },
                ]}
              />

              {settings.hostRole === 'play' && (
                <Field label="Your colour">
                  {(id) => (
                    <Select
                      id={id}
                      value={settings.hostColor}
                      onValueChange={(hostColor) => patch('hostColor', hostColor as ColorChoice)}
                      options={[
                        { value: 'random', label: 'Random' },
                        { value: 'white', label: 'White' },
                        { value: 'black', label: 'Black' },
                      ]}
                    />
                  )}
                </Field>
              )}
            </Panel>
          </div>

          <div className="create__column">
            <Panel title="Who can join">
              <Toggle
                checked={usePassword}
                onChange={setUsePassword}
                label="Require a password"
                disabled={isLocal}
                disabledReason="Same-device games are never joinable over the network."
              />
              {usePassword && !isLocal && (
                <Field
                  label="Password"
                  hint={`At least ${LIMITS.passwordMinLength} characters. Stored hashed, never sent back to clients.`}
                >
                  {(id, describedBy) => (
                    <TextInput
                      id={id}
                      aria-describedby={describedBy}
                      type="password"
                      autoComplete="new-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                  )}
                </Field>
              )}

              <Toggle
                checked={settings.requireApproval}
                onChange={(v) => patch('requireApproval', v)}
                label="Approve each person before they enter"
                disabled={isLocal}
                disabledReason="Nobody else can join a same-device game."
              />

              <Toggle
                checked={settings.allowGuests}
                onChange={(v) => patch('allowGuests', v)}
                label="Allow brand-new guests"
                hint="When off, only people who have finished at least one game here can take a seat."
                disabled={isLocal}
                disabledReason="Not applicable to same-device games."
              />

              <Toggle
                checked={settings.lockOnStart}
                onChange={(v) => patch('lockOnStart', v)}
                label="Lock the room once the game starts"
                hint="Nobody new can join mid-game, including spectators."
                disabled={isLocal}
                disabledReason="Not applicable to same-device games."
              />
            </Panel>

            <Panel title="Spectators">
              <Toggle
                checked={settings.allowSpectators}
                onChange={(v) => patch('allowSpectators', v)}
                label="Allow spectators"
                disabled={isLocal}
                disabledReason="Same-device games have no spectator slots."
              />
              <Toggle
                checked={settings.spectatorChat}
                onChange={(v) => patch('spectatorChat', v)}
                label="Spectators can chat"
                disabled={!settings.allowSpectators || isLocal}
                disabledReason="Turn spectators on first."
              />
              <Toggle
                checked={settings.spectatorsSeeMoveHistory}
                onChange={(v) => patch('spectatorsSeeMoveHistory', v)}
                label="Spectators can see the move list"
                disabled={!settings.allowSpectators || isLocal}
                disabledReason="Turn spectators on first."
              />
              <div className="create__spectatorCount">
                <Field label="Maximum spectators">
                  {(id) => (
                    <TextInput
                      id={id}
                      type="number"
                      min={0}
                      max={LIMITS.maxSpectators}
                      value={settings.maxSpectators}
                      disabled={!settings.allowSpectators || isLocal}
                      onChange={(e) =>
                        patch('maxSpectators', clamp(Number(e.target.value), 0, LIMITS.maxSpectators))
                      }
                    />
                  )}
                </Field>
              </div>
            </Panel>

            <Panel title="During the game">
              <Toggle checked={settings.playerChat} onChange={(v) => patch('playerChat', v)} label="Players can chat" />
              <Toggle
                checked={settings.allowDrawOffers}
                onChange={(v) => patch('allowDrawOffers', v)}
                label="Allow draw offers"
              />
              <Toggle
                checked={settings.allowTakebacks}
                onChange={(v) => patch('allowTakebacks', v)}
                label="Allow takeback requests"
                hint="A takeback always needs the opponent to accept."
              />
              <Toggle checked={settings.allowRematch} onChange={(v) => patch('allowRematch', v)} label="Allow rematches" />
              <Toggle
                checked={settings.allowPremoves}
                onChange={(v) => patch('allowPremoves', v)}
                label="Allow premoves"
                hint="Premoves are a client convenience; the server still validates every move."
              />
              <p className="create__frozenNote">
                Once the first move is played, these can no longer be changed — a host cannot alter the
                terms of a game in progress.
              </p>
            </Panel>

            <Panel title="Rating">
              <Toggle
                checked={settings.rated}
                onChange={(v) => patch('rated', v)}
                label="Rated game"
                hint="Elo is tracked in this server's own database only. It is not connected to FIDE or any online federation."
                disabled={isLocal || settings.casualOnly}
                disabledReason={isLocal ? 'Same-device games are never rated.' : 'Turn off "casual only" first.'}
              />
              <Toggle
                checked={settings.casualOnly}
                onChange={(v) => {
                  patch('casualOnly', v);
                  if (v) patch('rated', false);
                }}
                label="Casual only"
                hint="Shown in the browser so people know this is a friendly game."
                disabled={!isPublic}
                disabledReason="Only meaningful for games listed publicly."
              />
              <Toggle
                checked={settings.ratingRangeEnabled}
                onChange={(v) => patch('ratingRangeEnabled', v)}
                label="Restrict by rating"
                disabled={!isPublic}
                disabledReason="Only meaningful for games listed publicly."
              />
              {settings.ratingRangeEnabled && isPublic && (
                <div className="create__ratingRange">
                  <Field label="Minimum">
                    {(id) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={LIMITS.minRating}
                        max={LIMITS.maxRating}
                        value={settings.ratingMin}
                        onChange={(e) =>
                          patch('ratingMin', clamp(Number(e.target.value), LIMITS.minRating, LIMITS.maxRating))
                        }
                      />
                    )}
                  </Field>
                  <Field label="Maximum">
                    {(id) => (
                      <TextInput
                        id={id}
                        type="number"
                        min={LIMITS.minRating}
                        max={LIMITS.maxRating}
                        value={settings.ratingMax}
                        onChange={(e) =>
                          patch('ratingMax', clamp(Number(e.target.value), LIMITS.minRating, LIMITS.maxRating))
                        }
                      />
                    )}
                  </Field>
                </div>
              )}
              {settings.ratingRangeEnabled && settings.ratingMin > settings.ratingMax && (
                <p className="field__error" role="alert">
                  The minimum rating must not be higher than the maximum.
                </p>
              )}
            </Panel>
          </div>
        </div>

        <footer className="create__footer">
          <Button onClick={() => navigate(-1)}>Cancel</Button>
          <Button
            variant="primary"
            size="lg"
            loading={creating}
            disabled={settings.ratingMin > settings.ratingMax || settings.name.trim().length < 2}
            onClick={() => void create()}
          >
            Create game
          </Button>
        </footer>
      </div>
    </MenuShell>
  );
}

const MODE_HELP: Record<RoomMode, string> = {
  public: 'Listed in the public browser. Anyone can find it and join.',
  private: 'Never listed. Only people with the code or link can find it.',
  lan: 'Never listed. For devices on your own Wi-Fi — share the LAN address from the room.',
  local: 'Two players sharing this screen. The board turns around between moves.',
};

function isMode(value: string): value is RoomMode {
  return value === 'public' || value === 'private' || value === 'lan' || value === 'local';
}

function defaultRoomName(mode: RoomMode, name: string | undefined): string {
  const who = name ? `${name}'s` : 'New';
  if (mode === 'local') return `${who} kitchen-table game`;
  if (mode === 'lan') return `${who} Wi-Fi game`;
  if (mode === 'private') return `${who} private game`;
  return `${who} game`;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}
