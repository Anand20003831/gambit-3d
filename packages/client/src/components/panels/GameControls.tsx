import { useCallback, useState } from 'react';
import type { RoomView } from '@gambit3d/shared';
import { rpc } from '../../net/socket.js';
import { useStore } from '../../net/store.js';
import { Button, useConfirm } from '../ui/index.js';

/**
 * The in-game action bar.
 *
 * Every button here maps to a server call and is shown only when the server has
 * granted the matching capability, so nothing renders as a dead control.
 */
export function GameControls({ room }: { room: RoomView }): JSX.Element {
  const toast = useStore((s) => s.toast);
  const confirm = useConfirm();
  const [busy, setBusy] = useState<string | null>(null);

  const call = useCallback(
    async (label: string, event: string, payload: Record<string, unknown>) => {
      setBusy(label);
      const result = await rpc(event as never, { roomId: room.id, ...payload });
      setBusy(null);
      if (!result.ok) toast('error', result.message);
      return result.ok;
    },
    [room.id, toast],
  );

  const can = room.you.can;
  const offer = room.pendingOffer;
  /**
   * Same-device play has no second party, so these actions apply at once
   * rather than being proposed. The server does the same - it never opens a
   * pending offer in a local room - so the labels match what happens.
   */
  const isLocalGame = room.settings.mode === 'local';
  const sideToMove = room.game.turn === 'w' ? 'White' : 'Black';
  const theirOffer = offer && offer.from !== room.you.id ? offer : null;
  const myOffer = offer && offer.from === room.you.id ? offer : null;

  return (
    <div className="controls">
      {theirOffer && (
        <div className="controls__offer" role="alertdialog" aria-label="Offer from your opponent">
          <p className="controls__offerText">
            Your opponent offers a <strong>{offerLabel(theirOffer.kind, theirOffer.plies)}</strong>.
          </p>
          <div className="controls__offerActions">
            <Button
              variant="primary"
              size="sm"
              onClick={() => void call('accept', 'game:respondOffer', { kind: theirOffer.kind, accept: true })}
              loading={busy === 'accept'}
            >
              Accept
            </Button>
            <Button
              size="sm"
              onClick={() => void call('decline', 'game:respondOffer', { kind: theirOffer.kind, accept: false })}
              loading={busy === 'decline'}
            >
              Decline
            </Button>
          </div>
        </div>
      )}

      {myOffer && (
        <p className="controls__pending" role="status">
          Waiting for your opponent to respond to your {offerLabel(myOffer.kind, myOffer.plies)}…
        </p>
      )}

      <div className="controls__row">
        {can.startGame && (
          <Button variant="primary" onClick={() => void call('start', 'game:start', {})} loading={busy === 'start'}>
            Start game
          </Button>
        )}

        {can.offerDraw && !offer && (
          <Button
            onClick={async () => {
              if (isLocalGame) {
                const agreed = await confirm({
                  title: 'Agree a draw?',
                  message: 'The game ends here as a draw.',
                  confirmLabel: 'Agree draw',
                });
                if (!agreed) return;
              }
              void call('draw', 'game:offer', { kind: 'draw' });
            }}
            loading={busy === 'draw'}
          >
            {isLocalGame ? 'Agree draw' : 'Offer draw'}
          </Button>
        )}

        {can.requestTakeback && !offer && (
          <Button onClick={() => void call('takeback', 'game:offer', { kind: 'takeback' })} loading={busy === 'takeback'}>
            {isLocalGame ? 'Take back move' : 'Request takeback'}
          </Button>
        )}

        {room.game.claimable.threefold && can.move && (
          <Button
            variant="subtle"
            onClick={() => void call('claim3', 'game:claimDraw', { claim: 'threefold' })}
            loading={busy === 'claim3'}
          >
            Claim threefold draw
          </Button>
        )}

        {room.game.claimable.fiftyMove && can.move && (
          <Button
            variant="subtle"
            onClick={() => void call('claim50', 'game:claimDraw', { claim: 'fifty_move' })}
            loading={busy === 'claim50'}
          >
            Claim 50-move draw
          </Button>
        )}

        {can.abortGame && (
          <Button
            variant="subtle"
            onClick={async () => {
              const ok = await confirm({
                title: 'Abort this game?',
                message: 'No moves have been played, so the game will simply be cancelled. Nobody wins or loses.',
                confirmLabel: 'Abort game',
              });
              if (ok) void call('abort', 'game:abort', {});
            }}
            loading={busy === 'abort'}
          >
            Abort
          </Button>
        )}

        {can.resign && (
          <Button
            variant="danger"
            onClick={async () => {
              const ok = await confirm({
                title: isLocalGame ? `Resign as ${sideToMove}?` : 'Resign the game?',
                message: isLocalGame
                  ? `${sideToMove} is to move, so ${sideToMove} resigns and the other side wins.`
                  : 'Your opponent will be awarded the win. This cannot be undone.',
                confirmLabel: 'Resign',
                tone: 'danger',
              });
              if (ok) void call('resign', 'game:resign', {});
            }}
            loading={busy === 'resign'}
          >
            Resign
          </Button>
        )}

        {can.offerRematch && !offer && (
          <Button
            variant="primary"
            onClick={() => void call('rematch', 'game:offer', { kind: 'rematch' })}
            loading={busy === 'rematch'}
          >
            {isLocalGame ? 'Play again' : 'Offer rematch'}
          </Button>
        )}
      </div>

      {!can.move && room.game.phase === 'active' && room.you.seat && (
        <p className="controls__turn" role="status">
          {room.settings.allowPremoves && room.you.can.usePremoves
            ? 'Opponent to move — you can queue a premove.'
            : 'Opponent to move.'}
        </p>
      )}
    </div>
  );
}

function offerLabel(kind: 'draw' | 'takeback' | 'rematch', plies?: number): string {
  if (kind === 'draw') return 'draw';
  if (kind === 'rematch') return 'rematch';
  return plies && plies > 1 ? `takeback of ${plies} half-moves` : 'takeback';
}
