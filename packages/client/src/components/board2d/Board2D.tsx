import { useMemo } from 'react';
import type { PieceColor, Seat, Square } from '@gambit3d/shared';
import {
  PIECE_GLYPHS,
  PIECE_NAMES,
  isLightSquare,
  orientedSquares,
  type PlacedPiece,
} from '../../lib/board.js';
import type { ThemeModule } from '../../three/themes/types.js';

/**
 * Accessible 2D board.
 *
 * This is a real, fully playable board, not a placeholder: it is what runs on
 * devices without WebGL, what the user gets if they choose "2D" in settings, and
 * what appears if the 3D context is lost mid-game. It is also the keyboard-
 * accessible path - every square is a button with a descriptive label.
 */

export interface Board2DProps {
  theme: ThemeModule;
  pieces: PlacedPiece[];
  seat: Seat | null;
  selected: Square | null;
  legalMoves: Square[];
  legalCaptures: Square[];
  lastMove: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  premove: { from: Square; to: Square } | null;
  interactive: boolean;
  controllable: PieceColor | null;
  showCoordinates: boolean;
  colorBlindSafe: boolean;
  onSquare: (square: Square) => void;
}

export function Board2D({
  theme,
  pieces,
  seat,
  selected,
  legalMoves,
  legalCaptures,
  lastMove,
  checkSquare,
  premove,
  interactive,
  controllable,
  showCoordinates,
  colorBlindSafe,
  onSquare,
}: Board2DProps): JSX.Element {
  const rows = useMemo(() => orientedSquares(seat), [seat]);
  const bySquare = useMemo(() => {
    const map = new Map<Square, PlacedPiece>();
    for (const piece of pieces) map.set(piece.square, piece);
    return map;
  }, [pieces]);

  const legalSet = useMemo(() => new Set(legalMoves), [legalMoves]);
  const captureSet = useMemo(() => new Set(legalCaptures), [legalCaptures]);

  const highlights = theme.highlights;

  return (
    <div
      className={`board2d ${colorBlindSafe ? 'board2d--cbsafe' : ''}`}
      style={
        {
          '--sq-light': theme.board.lightSquare,
          '--sq-dark': theme.board.darkSquare,
          '--hl-selected': highlights.selected,
          '--hl-move': highlights.legalMove,
          '--hl-capture': highlights.legalCapture,
          '--hl-last': highlights.lastMove,
          '--hl-check': highlights.check,
          '--hl-premove': highlights.premove,
        } as React.CSSProperties
      }
      role="grid"
      aria-label="Chess board"
    >
      {rows.map((row) => (
        <div className="board2d__row" role="row" key={row[0]}>
          {row.map((square) => {
            const piece = bySquare.get(square);
            const isSelected = selected === square;
            const isLegal = legalSet.has(square);
            const isCapture = captureSet.has(square);
            const isLast = lastMove?.from === square || lastMove?.to === square;
            const isCheck = checkSquare === square;
            const isPremove = premove?.from === square || premove?.to === square;
            const canClick = interactive && (isLegal || isCapture || piece?.color === controllable || isSelected);

            const classes = [
              'board2d__sq',
              isLightSquare(square) ? 'is-light' : 'is-dark',
              isSelected && 'is-selected',
              isLegal && 'is-legal',
              isCapture && 'is-capture',
              isLast && 'is-last',
              isCheck && 'is-check',
              isPremove && 'is-premove',
            ]
              .filter(Boolean)
              .join(' ');

            return (
              <button
                key={square}
                type="button"
                role="gridcell"
                className={classes}
                disabled={!interactive}
                aria-label={describeSquare(square, piece, { isLegal, isCapture, isCheck, isSelected, isLast })}
                aria-pressed={isSelected}
                onClick={() => onSquare(square)}
                data-square={square}
                tabIndex={canClick || isSelected ? 0 : -1}
              >
                {showCoordinates && square[1] === (seat === 'b' ? '8' : '1') && (
                  <span className="board2d__file" aria-hidden="true">
                    {square[0]}
                  </span>
                )}
                {showCoordinates && square[0] === (seat === 'b' ? 'h' : 'a') && (
                  <span className="board2d__rank" aria-hidden="true">
                    {square[1]}
                  </span>
                )}

                {piece && (
                  <span
                    className={`board2d__piece ${piece.color === 'w' ? 'is-white' : 'is-black'}`}
                    aria-hidden="true"
                  >
                    {PIECE_GLYPHS[piece.color][piece.type]}
                  </span>
                )}

                {isLegal && !piece && <span className="board2d__dot" aria-hidden="true" />}
                {isCapture && <span className="board2d__ring" aria-hidden="true" />}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function describeSquare(
  square: Square,
  piece: PlacedPiece | undefined,
  flags: { isLegal: boolean; isCapture: boolean; isCheck: boolean; isSelected: boolean; isLast: boolean },
): string {
  const parts: string[] = [square];
  if (piece) {
    parts.push(`${piece.color === 'w' ? 'White' : 'Black'} ${PIECE_NAMES[piece.type].toLowerCase()}`);
  } else {
    parts.push('empty');
  }
  if (flags.isSelected) parts.push('selected');
  if (flags.isCapture) parts.push('can be captured');
  else if (flags.isLegal) parts.push('legal move');
  if (flags.isCheck) parts.push('in check');
  if (flags.isLast) parts.push('last move');
  return parts.join(', ');
}
