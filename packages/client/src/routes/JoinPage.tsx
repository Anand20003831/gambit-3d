import { useCallback, useEffect, useState } from 'react';
import { MenuShell } from '../components/menu/MenuShell.js';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { JoinOutcome } from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { Button, Field, TextInput, Toggle } from '../components/ui/index.js';

/**
 * Join by code or link.
 *
 * `/join/:code` auto-attempts once; if the room needs a password the form stays
 * on screen and asks for it rather than failing silently.
 */
export function JoinPage(): JSX.Element {
  const { code: codeParam } = useParams<{ code?: string }>();
  const navigate = useNavigate();
  const toast = useStore((s) => s.toast);
  const status = useStore((s) => s.status);

  const [code, setCode] = useState(codeParam ?? '');
  const [password, setPassword] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [asSpectator, setAsSpectator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [autoTried, setAutoTried] = useState(false);

  const attempt = useCallback(
    async (target: string, pass?: string) => {
      const cleaned = target.trim();
      if (cleaned.length < 4) {
        toast('warn', 'That code looks too short.');
        return;
      }
      setBusy(true);
      const result = await rpc<'room:join', JoinOutcome>('room:join', {
        target: cleaned,
        asSpectator,
        ...(pass ? { password: pass } : {}),
      });
      setBusy(false);

      if (!result.ok) {
        if (result.code === 'BAD_PASSWORD') {
          setNeedsPassword(true);
          toast('warn', result.message);
          return;
        }
        toast('error', result.message);
        return;
      }

      if (result.data.status === 'pending') {
        useStore.getState().setPendingJoin({
          roomId: result.data.roomId,
          roomName: result.data.roomName,
          requestId: result.data.requestId,
        });
        navigate(`/room/${result.data.roomId}`);
        return;
      }
      useStore.getState().setRoom(result.data.room);
      navigate(`/room/${result.data.room.id}`);
    },
    [asSpectator, navigate, toast],
  );

  // A shared link should just work.
  useEffect(() => {
    if (!codeParam || autoTried || status !== 'online') return;
    setAutoTried(true);
    void attempt(codeParam);
  }, [codeParam, autoTried, status, attempt]);

  return (
    <MenuShell
      title="Join a game"
      back={{ to: '/play', label: 'Play' }}
    >
      <div className="page page--narrow join">

        <p className="muted">
          Enter the code someone shared with you, or open the link they sent. Codes are not
          case-sensitive.
        </p>

        <form
          className="join__form"
          onSubmit={(event) => {
            event.preventDefault();
            void attempt(code, needsPassword ? password : undefined);
          }}
        >
          <Field label="Room code or link">
            {(id) => (
              <TextInput
                id={id}
                value={code}
                autoFocus={!codeParam}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                placeholder="e.g. K4M2XQ8P7T"
                onChange={(event) => setCode(extractCode(event.target.value))}
              />
            )}
          </Field>

          {needsPassword && (
            <Field label="Room password" hint="Ask whoever invited you.">
              {(id, describedBy) => (
                <TextInput
                  id={id}
                  aria-describedby={describedBy}
                  type="password"
                  value={password}
                  autoFocus
                  autoComplete="off"
                  onChange={(event) => setPassword(event.target.value)}
                />
              )}
            </Field>
          )}

          <Toggle
            checked={asSpectator}
            onChange={setAsSpectator}
            label="Join as a spectator"
            hint="Watch without taking a seat. Only works if the host allows spectators."
          />

          <Button type="submit" variant="primary" size="lg" full loading={busy} disabled={code.trim().length < 4}>
            Join
          </Button>
        </form>

        <p className="join__alt">
          No code? <Link to="/lobby">Browse public games</Link> or <Link to="/create">host your own</Link>.
        </p>
      </div>
    </MenuShell>
  );
}

/** Accepts a bare code or a full /join/<code> URL and returns just the code. */
function extractCode(input: string): string {
  const trimmed = input.trim();
  const match = /\/join\/([A-Za-z0-9_-]+)/u.exec(trimmed);
  if (match?.[1]) return match[1].toUpperCase();
  return trimmed.toUpperCase().replace(/[^A-Z0-9_-]/gu, '');
}
