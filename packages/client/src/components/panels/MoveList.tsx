import { useEffect, useRef } from 'react';
import type { RecordedMove, RoomView } from '@gambit3d/shared';
import { toMovePairs } from '../../lib/board.js';
import { Button, CopyButton, EmptyState } from '../ui/index.js';

/**
 * Move history in standard algebraic notation.
 *
 * Hidden entirely from spectators when the host has disabled it - the server
 * simply does not send the moves in that case, so there is nothing to leak.
 */
export function MoveList({ room }: { room: RoomView }): JSX.Element {
  const scroller = useRef<HTMLDivElement>(null);
  const moves = room.game.moves;
  const pairs = toMovePairs(moves);

  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    node.scrollTop = node.scrollHeight;
  }, [moves.length]);

  if (!room.you.can.seeMoveHistory) {
    return (
      <EmptyState
        icon="👁"
        title="Move list hidden"
        message="The host has turned off the move list for spectators in this room."
      />
    );
  }

  if (moves.length === 0) {
    return (
      <EmptyState
        icon="♙"
        title="No moves yet"
        message={
          room.game.phase === 'active'
            ? 'White to move.'
            : 'The move list will fill in once the game starts.'
        }
      />
    );
  }

  return (
    <div className="movelist">
      <div className="movelist__scroll" ref={scroller} role="log" aria-label="Move history">
        <table className="movelist__table">
          <caption className="sr-only">Moves in standard algebraic notation</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">White</th>
              <th scope="col">Black</th>
            </tr>
          </thead>
          <tbody>
            {pairs.map((pair) => (
              <tr key={pair.number}>
                <td className="movelist__num">{pair.number}.</td>
                <MoveCell move={pair.white} isLast={pair.white?.ply === moves.length - 1} />
                <MoveCell move={pair.black} isLast={pair.black?.ply === moves.length - 1} />
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="movelist__foot">
        <span className="movelist__count">
          {moves.length} half-move{moves.length === 1 ? '' : 's'}
          {room.game.halfmoveClock >= 80 && (
            <span className="movelist__warn"> · {Math.floor(room.game.halfmoveClock / 2)} moves toward the 50-move rule</span>
          )}
        </span>
        <CopyButton value={room.game.pgn || moves.map((m) => m.san).join(' ')} label="Copy PGN" />
      </div>
    </div>
  );
}

function MoveCell({ move, isLast }: { move: RecordedMove | null; isLast: boolean }): JSX.Element {
  if (!move) return <td className="movelist__san" />;
  return (
    <td className={`movelist__san ${isLast ? 'is-current' : ''}`}>
      <span title={`${move.from}–${move.to}${move.captured ? ' (capture)' : ''}`}>{move.san}</span>
    </td>
  );
}

/** Result banner shown under the board when a game has ended. */
export function ResultBanner({
  room,
  onRematch,
  onLeave,
}: {
  room: RoomView;
  onRematch: () => void;
  onLeave: () => void;
}): JSX.Element | null {
  const result = room.game.result;
  if (!result) return null;

  const tone =
    result.result === '1/2-1/2' ? 'draw' : result.winner === room.you.seat ? 'win' : room.you.seat ? 'loss' : 'draw';

  return (
    <div className={`result result--${tone}`} role="status" aria-live="polite">
      <div className="result__headline">
        <span className="result__score">{result.result}</span>
        <span className="result__message">{result.message}</span>
      </div>
      {result.ratingChange && (
        <p className="result__rating">
          White {formatDelta(result.ratingChange.w)} → {result.ratingChange.wAfter} · Black{' '}
          {formatDelta(result.ratingChange.b)} → {result.ratingChange.bAfter}
        </p>
      )}
      <div className="result__actions">
        {room.you.can.offerRematch && (
          <Button variant="primary" onClick={onRematch}>
            Offer rematch
          </Button>
        )}
        <Button onClick={onLeave}>Leave room</Button>
      </div>
    </div>
  );
}

function formatDelta(delta: number): string {
  return delta >= 0 ? `+${delta}` : String(delta);
}
