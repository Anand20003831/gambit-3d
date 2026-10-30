import { useStore } from '../net/store.js';

/**
 * Connection status.
 *
 * Only shown when something is wrong - a persistent green "connected" bar is
 * noise. Reconnection is automatic, and the message says so.
 */
export function ConnectionBanner(): JSX.Element | null {
  const status = useStore((s) => s.status);
  if (status === 'online') return null;

  const message =
    status === 'reconnecting'
      ? 'Connection lost. Reconnecting — your game and clock are safe on the server.'
      : status === 'connecting'
        ? 'Connecting to the game server…'
        : 'Disconnected from the game server.';

  return (
    <div className={`conn conn--${status}`} role="status" aria-live="assertive">
      <span className="conn__dot" aria-hidden="true" />
      <span>{message}</span>
      {status === 'offline' && (
        <button type="button" className="conn__retry" onClick={() => window.location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}
