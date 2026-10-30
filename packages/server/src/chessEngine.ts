import { Chess, type Move as ChessJsMove, type Square as ChessJsSquare } from 'chess.js';
import type {
  GameEndReason,
  GameOverInfo,
  GameResult,
  MoveIntent,
  PieceColor,
  RecordedMove,
  Square,
} from '@gambit3d/shared';

/**
 * Thin authoritative wrapper around chess.js.
 *
 * Every rule decision the server makes goes through this class. It is the only
 * place that touches chess.js, which keeps the rest of the server free of
 * library-shaped edge cases and makes the rules independently testable.
 */
export class ChessEngine {
  private chess: Chess;
  private history: RecordedMove[] = [];
  private readonly startFen: string;

  constructor(fen?: string) {
    this.chess = fen ? new Chess(fen) : new Chess();
    this.startFen = this.chess.fen();
  }

  // --- Reads ---------------------------------------------------------------

  get fen(): string {
    return this.chess.fen();
  }

  get turn(): PieceColor {
    return this.chess.turn();
  }

  get ply(): number {
    return this.history.length;
  }

  get moves(): readonly RecordedMove[] {
    return this.history;
  }

  get inCheck(): boolean {
    return this.chess.inCheck();
  }

  /**
   * Half-moves since the last capture or pawn move, read from the FEN.
   * chess.js does not expose this directly.
   */
  get halfmoveClock(): number {
    return Number.parseInt(this.chess.fen().split(' ')[4] ?? '0', 10) || 0;
  }

  get lastMove(): { from: Square; to: Square } | null {
    const last = this.history.at(-1);
    return last ? { from: last.from, to: last.to } : null;
  }

  /** Legal destinations keyed by origin square, for the side to move. */
  legalMoveMap(): Record<Square, Square[]> {
    const map: Record<Square, Square[]> = {};
    for (const move of this.chess.moves({ verbose: true }) as ChessJsMove[]) {
      const list = map[move.from] ?? (map[move.from] = []);
      if (!list.includes(move.to)) list.push(move.to);
    }
    return map;
  }

  /** True when moving from->to would require choosing a promotion piece. */
  isPromotion(from: Square, to: Square): boolean {
    return (this.chess.moves({ verbose: true }) as ChessJsMove[]).some(
      (m) => m.from === from && m.to === to && Boolean(m.promotion),
    );
  }

  pgn(): string {
    return this.chess.pgn();
  }

  /** The piece standing on a square, or null. */
  pieceAt(square: Square): { type: string; color: PieceColor } | null {
    const piece = this.chess.get(square as never);
    return piece ? { type: piece.type, color: piece.color as PieceColor } : null;
  }

  board() {
    return this.chess.board();
  }

  /** Serialisable snapshot used to restore a game after a restart. */
  snapshot(): { fen: string; history: RecordedMove[] } {
    return { fen: this.chess.fen(), history: [...this.history] };
  }

  // --- Draw conditions -----------------------------------------------------

  /**
   * A draw the side to move may *claim* but is not forced to take: the current
   * position has now occurred three times.
   */
  canClaimThreefold(): boolean {
    return this.countRepetitions() >= 3;
  }

  /** A draw the side to move may claim: 50 full moves without a capture or pawn move. */
  canClaimFiftyMove(): boolean {
    return this.halfmoveClock >= 100;
  }

  /**
   * How many times the current position has occurred in this game.
   *
   * Positions are compared on the first four FEN fields - placement, side to
   * move, castling rights and en passant target - as the rules require.
   */
  countRepetitions(): number {
    const key = positionKey(this.chess.fen());
    let count = positionKey(this.startFen) === key ? 1 : 0;
    for (const move of this.history) {
      if (positionKey(move.fenAfter) === key) count += 1;
    }
    return count;
  }

  /**
   * Draws that end the game automatically, with no claim required.
   * Checked explicitly rather than via `isDraw()` so behaviour does not shift
   * with the chess.js build in use.
   */
  private automaticDraw(): GameEndReason | null {
    if (this.chess.isStalemate()) return 'stalemate';
    if (this.chess.isInsufficientMaterial()) return 'insufficient_material';
    if (this.halfmoveClock >= 150) return 'seventyfive_move_rule';
    if (this.countRepetitions() >= 5) return 'fivefold_repetition';
    return null;
  }

  // --- Terminal detection --------------------------------------------------

  /**
   * Detects a game-ending condition in the *current* position.
   *
   * Returns null when play should continue. Claimable draws (threefold, fifty
   * move) are deliberately excluded - those require an explicit claim.
   */
  detectGameOver(now = Date.now()): GameOverInfo | null {
    if (this.chess.isCheckmate()) {
      // The side to move has been mated, so the other side won.
      const winner: PieceColor = this.chess.turn() === 'w' ? 'b' : 'w';
      return buildResult(winner === 'w' ? '1-0' : '0-1', 'checkmate', winner, now);
    }
    const auto = this.automaticDraw();
    if (auto) return buildResult('1/2-1/2', auto, null, now);
    return null;
  }

  // --- Writes --------------------------------------------------------------

  /**
   * Validates and applies a move.
   *
   * A pawn move onto the last rank must carry an explicit `promotion`; an
   * ambiguous intent is rejected rather than silently auto-queened.
   *
   * @returns the recorded move, or null when the move is illegal. The board is
   * never left partially mutated.
   */
  applyMove(
    intent: MoveIntent,
    meta: { at: number; spentMs: number; clockAfter: { w: number; b: number } | null },
  ): RecordedMove | null {
    const candidates = this.chess.moves({ verbose: true }) as ChessJsMove[];
    const legal = candidates.find(
      (m) =>
        m.from === intent.from &&
        m.to === intent.to &&
        (intent.promotion ? m.promotion === intent.promotion : !m.promotion),
    );
    if (!legal) return null;

    let applied: ChessJsMove;
    try {
      applied = this.chess.move({
        from: intent.from as ChessJsSquare,
        to: intent.to as ChessJsSquare,
        ...(intent.promotion ? { promotion: intent.promotion } : {}),
      });
    } catch {
      return null;
    }

    const record: RecordedMove = {
      ply: this.history.length,
      from: applied.from,
      to: applied.to,
      san: applied.san,
      lan: applied.lan,
      color: applied.color,
      piece: applied.piece,
      ...(applied.captured ? { captured: applied.captured } : {}),
      ...(applied.promotion ? { promotion: applied.promotion } : {}),
      flags: applied.flags,
      fenAfter: applied.after,
      at: meta.at,
      spentMs: meta.spentMs,
      clockAfter: meta.clockAfter,
      isCheck: this.chess.inCheck(),
      isCheckmate: this.chess.isCheckmate(),
    };
    this.history.push(record);
    return record;
  }

  /**
   * Undoes `plies` half-moves. Returns false and changes nothing when there are
   * not enough moves to undo.
   */
  undo(plies: number): boolean {
    if (plies <= 0 || plies > this.history.length) return false;
    for (let i = 0; i < plies; i += 1) {
      const undone = this.chess.undo();
      if (!undone) {
        this.rebuildFromHistory();
        return false;
      }
      this.history.pop();
    }
    return true;
  }

  private rebuildFromHistory(): void {
    const replay = new Chess(this.startFen);
    for (const m of this.history) {
      replay.move({
        from: m.from as ChessJsSquare,
        to: m.to as ChessJsSquare,
        ...(m.promotion ? { promotion: m.promotion } : {}),
      });
    }
    this.chess = replay;
  }

  reset(): void {
    this.chess = new Chess(this.startFen);
    this.history = [];
  }

  /** Restore a persisted game by replaying its move list. */
  static restore(history: readonly RecordedMove[]): ChessEngine {
    const engine = new ChessEngine();
    for (const m of history) {
      engine.applyMove(
        {
          from: m.from,
          to: m.to,
          ...(m.promotion ? { promotion: m.promotion as 'q' | 'r' | 'b' | 'n' } : {}),
        },
        { at: m.at, spentMs: m.spentMs, clockAfter: m.clockAfter },
      );
    }
    return engine;
  }

  /**
   * Whether `color` retains material that could conceivably deliver mate.
   *
   * Used for the "timeout versus insufficient material" rule: a flag fall is a
   * draw rather than a loss when the opponent could never mate. The test is the
   * permissive FIDE one - any position where mate is possible with cooperative
   * play counts, so K+N+N qualifies.
   */
  hasMatingMaterial(color: PieceColor): boolean {
    let knights = 0;
    let bishops = 0;
    for (const row of this.chess.board()) {
      for (const cell of row) {
        if (!cell || cell.color !== color) continue;
        switch (cell.type) {
          case 'p':
          case 'r':
          case 'q':
            return true;
          case 'n':
            knights += 1;
            break;
          case 'b':
            bishops += 1;
            break;
          default:
            break;
        }
      }
    }
    return bishops >= 2 || (bishops >= 1 && knights >= 1) || knights >= 2;
  }
}

function positionKey(fen: string): string {
  return fen.split(' ').slice(0, 4).join(' ');
}

export function buildResult(
  result: GameResult,
  reason: GameEndReason,
  winner: PieceColor | null,
  endedAt: number,
): GameOverInfo {
  return { result, reason, winner, message: describeResult(result, reason, winner), endedAt };
}

export function describeResult(
  result: GameResult,
  reason: GameEndReason,
  winner: PieceColor | null,
): string {
  const side = winner === 'w' ? 'White' : winner === 'b' ? 'Black' : 'Nobody';
  switch (reason) {
    case 'checkmate':
      return `${side} wins by checkmate`;
    case 'resignation':
      return `${side} wins by resignation`;
    case 'timeout':
      return `${side} wins on time`;
    case 'abandonment':
      return `${side} wins - opponent abandoned the game`;
    case 'stalemate':
      return 'Draw by stalemate';
    case 'insufficient_material':
      return 'Draw - insufficient material';
    case 'threefold_repetition':
      return 'Draw by threefold repetition';
    case 'fivefold_repetition':
      return 'Draw by fivefold repetition';
    case 'fifty_move_rule':
      return 'Draw by the fifty-move rule';
    case 'seventyfive_move_rule':
      return 'Draw by the seventy-five-move rule';
    case 'timeout_vs_insufficient_material':
      return 'Draw - flag fall with insufficient mating material';
    case 'draw_agreement':
      return 'Draw by agreement';
    case 'aborted':
      return 'Game aborted';
    case 'host_ended':
      return 'The host ended the game';
    default:
      return result === '1/2-1/2' ? 'Draw' : `${side} wins`;
  }
}
