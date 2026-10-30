import { useMemo, useState } from 'react';
import {
  LIMITS,
  mutableSettingKeys,
  type RoomSettings,
  type RoomView,
} from '@gambit3d/shared';
import { rpc } from '../../net/socket.js';
import { useStore } from '../../net/store.js';
import { Panel, TextInput, Toggle, Field } from '../ui/index.js';

/**
 * Live room settings for the host.
 *
 * The set of editable keys comes from the same `mutableSettingKeys` function the
 * server uses, so what looks editable here is exactly what will be accepted.
 * Once a move has been played, the rules of the match are frozen.
 */
export function RoomSettingsPanel({ room }: { room: RoomView }): JSX.Element | null {
  const toast = useStore((s) => s.toast);
  const [busy, setBusy] = useState<string | null>(null);

  const movesPlayed = room.game.moves.length > 0;
  const editable = useMemo(
    () => mutableSettingKeys(room.game.phase, movesPlayed),
    [room.game.phase, movesPlayed],
  );

  if (!room.you.can.manageSettings) return null;

  const frozen = room.game.phase === 'active' || room.game.phase === 'finished' || movesPlayed;

  const update = async <K extends keyof RoomSettings>(key: K, value: RoomSettings[K]): Promise<void> => {
    setBusy(String(key));
    const result = await rpc('room:updateSettings', { roomId: room.id, patch: { [key]: value } });
    setBusy(null);
    if (!result.ok) toast('error', result.message);
  };

  const lockedReason = 'Frozen for the rest of this game — the terms cannot change mid-match.';

  return (
    <Panel title="Room settings">
      {frozen && (
        <p className="settingspanel__frozen">
          The game is under way, so only presentation and access settings can still change.
        </p>
      )}

      <Field label="Room name">
        {(id) => (
          <TextInput
            id={id}
            defaultValue={room.settings.name}
            maxLength={LIMITS.roomNameMaxLength}
            disabled={!editable.has('name') || busy === 'name'}
            onBlur={(e) => {
              const value = e.target.value.trim();
              if (value && value !== room.settings.name) void update('name', value);
            }}
          />
        )}
      </Field>

      <Toggle
        checked={room.settings.allowSpectators}
        onChange={(v) => void update('allowSpectators', v)}
        label="Allow spectators"
        disabled={!editable.has('allowSpectators') || busy === 'allowSpectators'}
        disabledReason={lockedReason}
      />
      <Toggle
        checked={room.settings.spectatorChat}
        onChange={(v) => void update('spectatorChat', v)}
        label="Spectator chat"
        disabled={!editable.has('spectatorChat') || !room.settings.allowSpectators}
        disabledReason={room.settings.allowSpectators ? lockedReason : 'Turn spectators on first.'}
      />
      <Toggle
        checked={room.settings.playerChat}
        onChange={(v) => void update('playerChat', v)}
        label="Player chat"
        disabled={!editable.has('playerChat')}
        disabledReason={lockedReason}
      />
      <Toggle
        checked={room.settings.spectatorsSeeMoveHistory}
        onChange={(v) => void update('spectatorsSeeMoveHistory', v)}
        label="Spectators see the move list"
        disabled={!editable.has('spectatorsSeeMoveHistory')}
        disabledReason={lockedReason}
      />
      <Toggle
        checked={room.settings.requireApproval}
        onChange={(v) => void update('requireApproval', v)}
        label="Approve people before they enter"
        disabled={!editable.has('requireApproval')}
        disabledReason={lockedReason}
      />

      <Field label="Maximum spectators">
        {(id) => (
          <TextInput
            id={id}
            type="number"
            min={0}
            max={LIMITS.maxSpectators}
            defaultValue={room.settings.maxSpectators}
            disabled={!editable.has('maxSpectators') || !room.settings.allowSpectators}
            onBlur={(e) => {
              const value = Math.min(LIMITS.maxSpectators, Math.max(0, Math.round(Number(e.target.value))));
              if (Number.isFinite(value) && value !== room.settings.maxSpectators) {
                void update('maxSpectators', value);
              }
            }}
          />
        )}
      </Field>

      <div className="settingspanel__frozenList">
        <h4>Fixed for this game</h4>
        <dl>
          <div>
            <dt>Time control</dt>
            <dd>
              {room.settings.timeControl.initialSeconds === 0
                ? 'Untimed'
                : `${room.settings.timeControl.initialSeconds / 60}+${room.settings.timeControl.incrementSeconds}`}
            </dd>
          </div>
          <div>
            <dt>Rated</dt>
            <dd>{room.settings.rated ? 'Yes' : 'No'}</dd>
          </div>
          <div>
            <dt>Takebacks</dt>
            <dd>{room.settings.allowTakebacks ? 'Allowed' : 'Off'}</dd>
          </div>
          <div>
            <dt>Draw offers</dt>
            <dd>{room.settings.allowDrawOffers ? 'Allowed' : 'Off'}</dd>
          </div>
          <div>
            <dt>Premoves</dt>
            <dd>{room.settings.allowPremoves ? 'Allowed' : 'Off'}</dd>
          </div>
        </dl>
        <p className="muted">
          {frozen
            ? 'These were set when the room was created and cannot be changed now.'
            : 'These can still be changed until the first move is played — create a new room to change them afterwards.'}
        </p>
      </div>
    </Panel>
  );
}
