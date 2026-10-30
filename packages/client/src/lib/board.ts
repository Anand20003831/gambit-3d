import type { PieceColor, PieceType, Seat, Square } from '@gambit3d/shared';

/**
 * Board geometry and coordinate helpers.
 *
 * One convention, used everywhere: the board occupies the XZ plane centred on
 * the origin, one world unit per square. File a..h runs along +X, rank 1..8
 * runs along -Z, so White sits at +Z looking toward -Z.
 */

export const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] as const;
export const RANKS = ['1', '2', '3', '4', '5', '6', '7', '8'] as const;

export const SQUARE_SIZE = 1;
export const BOARD_SPAN = SQUARE_SIZE * 8;
export const BOARD_HALF = BOARD_SPAN / 2;
/** Thickness of the playing surface slab. */
export const BOARD_THICKNESS = 0.32;
/** Width of the decorative frame around the playing surface. */
export const FRAME_WIDTH = 0.62;
/** Y coordinate a piece's base sits at. */
export const PIECE_BASE_Y = 0;

export const ALL_SQUARES: Square[] = RANKS.flatMap((r) => FILES.map((f) => `${f}${r}`));

export function fileIndex(square: Square): number {
  return square.charCodeAt(0) - 97; // 'a'
}

export function rankIndex(square: Square): number {
  return square.charCodeAt(1) - 49; // '1'
}

export function isSquare(value: string): value is Square {
  return /^[a-h][1-8]$/u.test(value);
}

export function squareAt(file: number, rank: number): Square | null {
  if (file < 0 || file > 7 || rank < 0 || rank > 7) return null;
  return `${FILES[file]}${RANKS[rank]}`;
}

/** True for the light-coloured square. a1 is dark, which fixes the parity. */
export function isLightSquare(square: Square): boolean {
  return (fileIndex(square) + rankIndex(square)) % 2 === 1;
}

/** World position of a square's centre, at board level. */
export function squareToWorld(square: Square): [number, number, number] {
  const x = (fileIndex(square) - 3.5) * SQUARE_SIZE;
  const z = (3.5 - rankIndex(square)) * SQUARE_SIZE;
  return [x, PIECE_BASE_Y, z];
}

/** Inverse of `squareToWorld`; returns null when the point is off the board. */
export function worldToSquare(x: number, z: number): Square | null {
  const file = Math.round(x / SQUARE_SIZE + 3.5);
  const rank = Math.round(3.5 - z / SQUARE_SIZE);
  return squareAt(file, rank);
}

// ---------------------------------------------------------------------------
// Orientation
// ---------------------------------------------------------------------------

/**
 * Camera yaw (radians) for a seat. Black's view is the board rotated 180°, so
 * a player always sees their own pieces at the near edge.
 */
export function seatYaw(seat: Seat | null): number {
  return seat === 'b' ? Math.PI : 0;
}

/**
 * Board coordinates as the given seat reads them, for the 2D board and the
 * coordinate labels.
 */
export function orientedSquares(seat: Seat | null): Square[][] {
  const rows: Square[][] = [];
  const rankOrder = seat === 'b' ? [...RANKS] : [...RANKS].reverse();
  const fileOrder = seat === 'b' ? [...FILES].reverse() : [...FILES];
  for (const rank of rankOrder) {
    rows.push(fileOrder.map((file) => `${file}${rank}`));
  }
  return rows;
}

// ---------------------------------------------------------------------------
// FEN
// ---------------------------------------------------------------------------

export interface PlacedPiece {
  square: Square;
  type: PieceType;
  color: PieceColor;
}

/** Parses the placement field of a FEN into a flat list of pieces. */
export function parseFen(fen: string): PlacedPiece[] {
  const placement = fen.split(' ')[0] ?? '';
  const out: PlacedPiece[] = [];
  const rows = placement.split('/');

  for (const [rowIndex, row] of rows.entries()) {
    const rank = 7 - rowIndex; // FEN starts at rank 8
    let file = 0;
    for (const ch of row) {
      if (ch >= '1' && ch <= '8') {
        file += Number.parseInt(ch, 10);
        continue;
      }
      const square = squareAt(file, rank);
      if (square) {
        out.push({
          square,
          type: ch.toLowerCase() as PieceType,
          color: ch === ch.toUpperCase() ? 'w' : 'b',
        });
      }
      file += 1;
    }
  }
  return out;
}

/**
 * Assigns each piece a stable identity across positions so the renderer can
 * animate a piece from square to square instead of destroying and recreating it.
 *
 * Pieces are matched to their previous position greedily by nearest distance
 * within the same colour and type, which tracks normal moves, captures and
 * castling correctly. Promotions produce a new identity, which is what we want
 * visually.
 */
export interface TrackedPiece extends PlacedPiece {
  id: string;
}

export function trackPieces(current: PlacedPiece[], previous: TrackedPiece[]): TrackedPiece[] {
  const unmatched = new Map<string, TrackedPiece[]>();
  for (const prev of previous) {
    const key = `${prev.color}${prev.type}`;
    const list = unmatched.get(key) ?? [];
    list.push(prev);
    unmatched.set(key, list);
  }

  const result: TrackedPiece[] = [];
  const needsId: PlacedPiece[] = [];

  // Exact square matches first - a piece that did not move keeps its id.
  for (const piece of current) {
    const key = `${piece.color}${piece.type}`;
    const candidates = unmatched.get(key);
    const exact = candidates?.findIndex((c) => c.square === piece.square) ?? -1;
    if (candidates && exact >= 0) {
      const [match] = candidates.splice(exact, 1);
      result.push({ ...piece, id: match!.id });
    } else {
      needsId.push(piece);
    }
  }

  // Then nearest remaining piece of the same colour and type.
  for (const piece of needsId) {
    const key = `${piece.color}${piece.type}`;
    const candidates = unmatched.get(key) ?? [];
    if (candidates.length === 0) {
      result.push({ ...piece, id: newPieceId(piece) });
      continue;
    }
    let bestIndex = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const [index, candidate] of candidates.entries()) {
      const d =
        (fileIndex(candidate.square) - fileIndex(piece.square)) ** 2 +
        (rankIndex(candidate.square) - rankIndex(piece.square)) ** 2;
      if (d < bestDistance) {
        bestDistance = d;
        bestIndex = index;
      }
    }
    const [match] = candidates.splice(bestIndex, 1);
    result.push({ ...piece, id: match!.id });
  }

  return result;
}

let pieceSeq = 0;

function newPieceId(piece: PlacedPiece): string {
  pieceSeq += 1;
  return `${piece.color}${piece.type}-${pieceSeq}`;
}

// ---------------------------------------------------------------------------
// Captured material
// ---------------------------------------------------------------------------

export const PIECE_VALUES: Record<PieceType, number> = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };

const FULL_ARMY: Record<PieceType, number> = { p: 8, n: 2, b: 2, r: 2, q: 1, k: 1 };

export interface MaterialTally {
  /** Pieces of each type this side has lost. */
  captured: Record<PieceType, number>;
  /** Positive when this side is ahead. */
  advantage: number;
}

/** Works out captured material from the position alone, so it survives reconnects. */
export function materialFromPosition(pieces: PlacedPiece[]): { w: MaterialTally; b: MaterialTally } {
  const counts: Record<PieceColor, Record<PieceType, number>> = {
    w: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
    b: { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 },
  };
  for (const piece of pieces) counts[piece.color][piece.type] += 1;

  const tally = (color: PieceColor): MaterialTally => {
    const captured: Record<PieceType, number> = { p: 0, n: 0, b: 0, r: 0, q: 0, k: 0 };
    for (const type of Object.keys(FULL_ARMY) as PieceType[]) {
      // Promotions can push a count above the starting number; never report negative.
      captured[type] = Math.max(0, FULL_ARMY[type] - counts[color][type]);
    }
    return { captured, advantage: 0 };
  };

  const white = tally('w');
  const black = tally('b');

  const scoreOf = (c: PieceColor): number =>
    (Object.keys(PIECE_VALUES) as PieceType[]).reduce((sum, t) => sum + counts[c][t] * PIECE_VALUES[t], 0);

  const diff = scoreOf('w') - scoreOf('b');
  white.advantage = diff;
  black.advantage = -diff;
  return { w: white, b: black };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

export const PIECE_NAMES: Record<PieceType, string> = {
  p: 'Pawn',
  n: 'Knight',
  b: 'Bishop',
  r: 'Rook',
  q: 'Queen',
  k: 'King',
};

/** Unicode glyphs, used by the 2D board and the captured-piece strip. */
export const PIECE_GLYPHS: Record<PieceColor, Record<PieceType, string>> = {
  w: { k: '♔', q: '♕', r: '♖', b: '♗', n: '♘', p: '♙' },
  b: { k: '♚', q: '♛', r: '♜', b: '♝', n: '♞', p: '♟' },
};

export function formatClock(ms: number): string {
  if (!Number.isFinite(ms)) return '--:--';
  const clamped = Math.max(0, ms);
  const totalSeconds = Math.floor(clamped / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }
  // Under ten seconds, show tenths - the difference matters in bullet.
  if (clamped < 10_000) {
    const tenths = Math.floor((clamped % 1000) / 100);
    return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths}`;
  }
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

/** Groups a SAN move list into numbered pairs for display. */
export function toMovePairs<T>(moves: T[]): { number: number; white: T | null; black: T | null }[] {
  const pairs: { number: number; white: T | null; black: T | null }[] = [];
  for (let i = 0; i < moves.length; i += 2) {
    pairs.push({
      number: Math.floor(i / 2) + 1,
      white: moves[i] ?? null,
      black: moves[i + 1] ?? null,
    });
  }
  return pairs;
}
