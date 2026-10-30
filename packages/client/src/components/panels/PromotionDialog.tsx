import type { PieceColor } from '@gambit3d/shared';
import { PIECE_GLYPHS, PIECE_NAMES } from '../../lib/board.js';
import { Modal } from '../ui/index.js';

const CHOICES = ['q', 'r', 'b', 'n'] as const;

/**
 * Promotion picker.
 *
 * Shown whenever a pawn reaches the last rank and "always promote to queen" is
 * off. The server rejects an ambiguous promotion outright, so this is the only
 * way the choice is made.
 */
export function PromotionDialog({
  open,
  color,
  onChoose,
  onCancel,
}: {
  open: boolean;
  color: PieceColor;
  onChoose: (piece: 'q' | 'r' | 'b' | 'n') => void;
  onCancel: () => void;
}): JSX.Element {
  return (
    <Modal
      open={open}
      title="Promote your pawn"
      description="Choose the piece your pawn becomes."
      onClose={onCancel}
      size="sm"
    >
      <div className="promotion">
        {CHOICES.map((piece, index) => (
          <button
            key={piece}
            type="button"
            className="promotion__option"
            onClick={() => onChoose(piece)}
            data-autofocus={index === 0 ? true : undefined}
            aria-label={`Promote to ${PIECE_NAMES[piece]}`}
          >
            <span className={`promotion__glyph is-${color === 'w' ? 'white' : 'black'}`} aria-hidden="true">
              {PIECE_GLYPHS[color][piece]}
            </span>
            <span className="promotion__name">{PIECE_NAMES[piece]}</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}
