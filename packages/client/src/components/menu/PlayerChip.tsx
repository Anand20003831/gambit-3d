import { useCallback, useEffect, useState } from 'react';
import { formatRating, type IdentityGrant } from '@gambit3d/shared';
import { identify } from '../../net/socket.js';
import { useStore } from '../../net/store.js';
import { Button, TextInput } from '../ui/index.js';

/**
 * Who you are playing as, in the menu header.
 *
 * Small on purpose. Your own name is the least interesting thing on a main
 * menu, but it has to be changeable before you join a game where other people
 * will see it.
 */
export function PlayerChip(): JSX.Element {
  const identity = useStore((s) => s.identity);
  const setIdentity = useStore((s) => s.setIdentity);
  const toast = useStore((s) => s.toast);

  const [name, setName] = useState(identity?.name ?? '');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (identity && !editing) setName(identity.name);
  }, [identity, editing]);

  const save = useCallback(async () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast('warn', 'Names need at least two characters.');
      return;
    }
    setSaving(true);
    const result = await identify(trimmed);
    setSaving(false);
    if (result.ok) {
      setIdentity(result.data as IdentityGrant);
      setEditing(false);
      toast('success', 'Name updated.');
    } else {
      toast('error', result.message);
    }
  }, [name, setIdentity, toast]);

  if (editing) {
    return (
      <div className="playerchip">
        <div className="playerchip__edit">
          <TextInput
            aria-label="Display name"
            value={name}
            maxLength={20}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === 'Enter' && void save()}
          />
          <div className="playerchip__editRow">
            <Button size="sm" variant="primary" loading={saving} onClick={() => void save()}>
              Save
            </Button>
            <Button
              size="sm"
              onClick={() => {
                setEditing(false);
                setName(identity?.name ?? '');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="playerchip">
      <div className="playerchip__who">
        <p className="playerchip__label">Playing as</p>
        <p className="playerchip__name home__name">
          {identity?.name ?? 'Guest'}
          {identity && (
            <span className="playerchip__rating">{formatRating(identity.rating, identity.provisional)}</span>
          )}
        </p>
      </div>
      <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
        Change name
      </Button>
    </div>
  );
}
