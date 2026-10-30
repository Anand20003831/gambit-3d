import { useEffect, useRef, useState } from 'react';
import { formatRating, type MemberView, type PieceColor, type RoomView } from '@gambit3d/shared';
import { PIECE_GLYPHS, formatClock, materialFromPosition, parseFen, type MaterialTally } from '../../lib/board.js';
import { interpolatedClock, useStore } from '../../net/store.js';
import { audio } from '../../audio/engine.js';
import { Badge } from '../ui/index.js';

/**
 * One side's status: who is playing, their clock, and the material they are up.
 *
 * The clock ticks locally between server snapshots for smoothness, but the
 * server decides when a flag actually falls - this display never ends a game.
 */

export interface PlayerCardProps {
  room: RoomView;
  color: PieceColor;
  /** True when this card represents the viewer's own seat. */
  isSelf: boolean;
  compact?: boolean;
}

export function PlayerCard({ room, color, isSelf, compact = false }: PlayerCardProps): JSX.Element {
  /**
   * In a same-device game one member holds the board and plays both colours,
   * so the other seat looks empty in the member list. Fall back to the seated
   * player and label the card by colour, which is what the two people sharing
   * the screen actually need to read.
   */
  const isLocalGame = room.settings.mode === 'local';
  const seated = room.members.find((m) => m.seat === color) ?? null;
  const member = seated ?? (isLocalGame ? (room.members.find((m) => m.seat !== null) ?? null) : null);
  const displayName = isLocalGame ? (color === 'w' ? 'White' : 'Black') : member?.name;
  const clockSync = useStore((s) => s.clockSync);
  const [now, setNow] = useState(() => Date.now());

  const running = clockSync?.clock.running === color && room.game.phase === 'active';
  const lowTimeFired = useRef(false);

  useEffect(() => {
    if (!clockSync) return undefined;
    // Only run a timer for the side actually on the clock.
    if (!running) {
      setNow(Date.now());
      return undefined;
    }
    const id = window.setInterval(() => setNow(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [clockSync, running]);

  const clock = interpolatedClock(clockSync, now);
  const remaining = clock ? clock[color] : null;
  const isLow = remaining !== null && remaining < 20_000 && running;

  useEffect(() => {
    if (!isSelf) return;
    if (isLow && !lowTimeFired.current) {
      lowTimeFired.current = true;
      audio.play('lowTime');
    } else if (!isLow) {
      lowTimeFired.current = false;
    }
  }, [isLow, isSelf]);

  const material = materialFromPosition(parseFen(room.game.fen));
  const tally = material[color];

  return (
    <article
      className={[
        'playercard',
        compact && 'playercard--compact',
        running && 'is-running',
        isLow && 'is-low',
        isSelf && 'is-self',
        member && !member.connected && 'is-away',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="playercard__identity">
        <span className={`playercard__swatch playercard__swatch--${color}`} aria-hidden="true" />
        <div className="playercard__who">
          <span className="playercard__name">
            {displayName ?? <span className="playercard__empty">Empty seat</span>}
            {isSelf && !isLocalGame && <span className="playercard__you"> (you)</span>}
          </span>
          <span className="playercard__meta">
            {isLocalGame
              ? (member?.name ?? 'This device')
              : member
                ? formatRating(member.rating, member.provisional)
                : '—'}
            {!isLocalGame && member?.isHost && <Badge tone="accent">Host</Badge>}
            {!isLocalGame && member?.isModerator && !member.isHost && <Badge>Mod</Badge>}
            {member && !member.connected && <Badge tone="warn">Reconnecting…</Badge>}
          </span>
        </div>
      </div>

      <MaterialStrip tally={tally} color={color} />

      {remaining !== null && (
        <div
          className="playercard__clock"
          aria-label={`${color === 'w' ? 'White' : 'Black'} clock`}
          aria-live={isLow ? 'assertive' : 'off'}
        >
          {formatClock(remaining)}
        </div>
      )}
      {remaining === null && room.settings.timeControl.initialSeconds === 0 && (
        <div className="playercard__clock playercard__clock--untimed">∞</div>
      )}
    </article>
  );
}

/** The pieces this side has captured, plus the running material advantage. */
function MaterialStrip({ tally, color }: { tally: MaterialTally; color: PieceColor }): JSX.Element | null {
  // A side's captured tally counts pieces *it* has lost, so we show the
  // opponent's losses next to this player.
  const opponent: PieceColor = color === 'w' ? 'b' : 'w';
  const lost = tally.captured;
  const glyphs = PIECE_GLYPHS[opponent];

  const entries = (['q', 'r', 'b', 'n', 'p'] as const).flatMap((type) =>
    Array.from({ length: lost[type] }, (_, i) => ({ type, key: `${type}${i}` })),
  );

  const advantage = tally.advantage;

  if (entries.length === 0 && advantage <= 0) return <div className="playercard__material" />;

  return (
    <div className="playercard__material" aria-label="Captured pieces">
      <span className="playercard__captured" aria-hidden="true">
        {entries.map((e) => (
          <span key={e.key}>{glyphs[e.type]}</span>
        ))}
      </span>
      {advantage > 0 && <span className="playercard__advantage">+{advantage}</span>}
    </div>
  );
}

/** Compact seat row used in the members list. */
export function MemberRow({
  member,
  isSelf,
  actions,
}: {
  member: MemberView;
  isSelf: boolean;
  actions?: JSX.Element;
}): JSX.Element {
  return (
    <div className={`memberrow ${member.connected ? '' : 'is-away'}`}>
      <span className="memberrow__name">
        {member.name}
        {isSelf && <span className="memberrow__you"> (you)</span>}
      </span>
      <span className="memberrow__tags">
        {member.seat && <Badge tone="accent">{member.seat === 'w' ? 'White' : 'Black'}</Badge>}
        {!member.seat && <Badge>Spectator</Badge>}
        {member.isHost && <Badge tone="success">Host</Badge>}
        {member.isModerator && !member.isHost && <Badge>Mod</Badge>}
        {member.muted && <Badge tone="warn">Muted</Badge>}
        {!member.connected && <Badge tone="warn">Away</Badge>}
      </span>
      {actions && <span className="memberrow__actions">{actions}</span>}
    </div>
  );
}
