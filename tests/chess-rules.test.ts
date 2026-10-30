import { describe, expect, it } from 'vitest';
import { ChessEngine } from '../packages/server/src/chessEngine.js';

/**
 * Rules coverage.
 *
 * These drive the same `ChessEngine` the server uses to accept or reject every
 * move, so a regression here is a regression in real games.
 */

const META = { at: 0, spentMs: 0, clockAfter: null };

/** Plays a list of SAN-ish from/to pairs, asserting each one is accepted. */
function play(engine: ChessEngine, moves: [string, string, ('q' | 'r' | 'b' | 'n')?][]): void {
  for (const [from, to, promotion] of moves) {
    const result = engine.applyMove({ from, to, ...(promotion ? { promotion } : {}) }, META);
    expect(result, `expected ${from}->${to} to be legal`).not.toBeNull();
  }
}

describe('move legality', () => {
  it('accepts a normal opening move and rejects an impossible one', () => {
    const engine = new ChessEngine();
    expect(engine.applyMove({ from: 'e2', to: 'e4' }, META)).not.toBeNull();
    expect(engine.applyMove({ from: 'e7', to: 'e4' }, META)).toBeNull();
  });

  it('rejects moving out of turn', () => {
    const engine = new ChessEngine();
    // It is White to move; a black move must not be applied.
    expect(engine.applyMove({ from: 'e7', to: 'e5' }, META)).toBeNull();
    expect(engine.turn).toBe('w');
  });

  it('rejects a move that would leave the king in check', () => {
    // Black king on e8, white rook on e1, black bishop pinned on e5.
    const engine = new ChessEngine('4k3/8/8/4b3/8/8/8/4R1K1 b - - 0 1');
    expect(engine.applyMove({ from: 'e5', to: 'd4' }, META)).toBeNull();
  });

  it('leaves the board untouched when a move is rejected', () => {
    const engine = new ChessEngine();
    const before = engine.fen;
    engine.applyMove({ from: 'e2', to: 'e5' }, META);
    expect(engine.fen).toBe(before);
    expect(engine.ply).toBe(0);
  });
});

describe('castling', () => {
  it('allows kingside castling and moves the rook', () => {
    const engine = new ChessEngine('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    const move = engine.applyMove({ from: 'e1', to: 'g1' }, META);
    expect(move?.san).toBe('O-O');
    expect(move?.flags).toContain('k');
    // The back rank is the last field of the placement: king on g1, rook on f1.
    const placement = engine.fen.split(' ')[0]!;
    expect(placement.split('/').at(-1)).toBe('R4RK1');
  });

  it('allows queenside castling', () => {
    const engine = new ChessEngine('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    const move = engine.applyMove({ from: 'e1', to: 'c1' }, META);
    expect(move?.san).toBe('O-O-O');
    expect(move?.flags).toContain('q');
  });

  it('refuses castling through check', () => {
    // Black rook on f8 attacks f1, so White may not castle kingside.
    const engine = new ChessEngine('4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1');
    expect(engine.applyMove({ from: 'e1', to: 'g1' }, META)).toBeNull();
    // Queenside is still fine.
    expect(engine.applyMove({ from: 'e1', to: 'c1' }, META)).not.toBeNull();
  });

  it('refuses castling once the king has moved', () => {
    const engine = new ChessEngine('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    play(engine, [
      ['e1', 'f1'],
      ['e8', 'f8'],
      ['f1', 'e1'],
      ['f8', 'e8'],
    ]);
    expect(engine.applyMove({ from: 'e1', to: 'g1' }, META)).toBeNull();
  });
});

describe('en passant', () => {
  it('allows the capture and removes the passed pawn', () => {
    const engine = new ChessEngine();
    play(engine, [
      ['e2', 'e4'],
      ['a7', 'a6'],
      ['e4', 'e5'],
      ['d7', 'd5'],
    ]);
    const move = engine.applyMove({ from: 'e5', to: 'd6' }, META);
    expect(move).not.toBeNull();
    expect(move?.flags).toContain('e');
    expect(move?.captured).toBe('p');
    // The captured pawn was on d5, which must now be empty.
    expect(engine.fen.split(' ')[0]).not.toContain('3p');
  });

  it('only allows en passant on the very next move', () => {
    const engine = new ChessEngine();
    play(engine, [
      ['e2', 'e4'],
      ['a7', 'a6'],
      ['e4', 'e5'],
      ['d7', 'd5'],
      ['a2', 'a3'],
      ['a6', 'a5'],
    ]);
    expect(engine.applyMove({ from: 'e5', to: 'd6' }, META)).toBeNull();
  });
});

describe('promotion', () => {
  it('requires an explicit choice', () => {
    const engine = new ChessEngine('8/P6k/8/8/8/8/8/K7 w - - 0 1');
    expect(engine.isPromotion('a7', 'a8')).toBe(true);
    // No promotion piece supplied - the server must not guess.
    expect(engine.applyMove({ from: 'a7', to: 'a8' }, META)).toBeNull();
  });

  it('promotes to each piece type', () => {
    for (const piece of ['q', 'r', 'b', 'n'] as const) {
      const engine = new ChessEngine('8/P6k/8/8/8/8/8/K7 w - - 0 1');
      const move = engine.applyMove({ from: 'a7', to: 'a8', promotion: piece }, META);
      expect(move?.promotion).toBe(piece);
      expect(move?.san).toContain(`=${piece.toUpperCase()}`);
    }
  });

  it('handles promotion with capture', () => {
    const engine = new ChessEngine('1r5k/P7/8/8/8/8/8/K7 w - - 0 1');
    const move = engine.applyMove({ from: 'a7', to: 'b8', promotion: 'q' }, META);
    expect(move?.captured).toBe('r');
    expect(move?.promotion).toBe('q');
  });
});

describe('check and checkmate', () => {
  it("reports check without ending the game", () => {
    const engine = new ChessEngine('4k3/8/8/8/8/8/8/4R1K1 w - - 0 1');
    const move = engine.applyMove({ from: 'e1', to: 'e7' }, META);
    expect(move?.isCheck).toBe(true);
    expect(move?.isCheckmate).toBe(false);
    expect(engine.detectGameOver()).toBeNull();
  });

  it('detects back-rank mate and awards the win to the mating side', () => {
    const engine = new ChessEngine('6k1/5ppp/8/8/8/8/8/R5K1 w - - 0 1');
    const move = engine.applyMove({ from: 'a1', to: 'a8' }, META);
    expect(move?.isCheckmate).toBe(true);

    const over = engine.detectGameOver();
    expect(over?.reason).toBe('checkmate');
    expect(over?.winner).toBe('w');
    expect(over?.result).toBe('1-0');
  });

  it("detects fool's mate for Black", () => {
    const engine = new ChessEngine();
    play(engine, [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
    ]);
    const mate = engine.applyMove({ from: 'd8', to: 'h4' }, META);
    expect(mate?.isCheckmate).toBe(true);
    expect(engine.detectGameOver()?.winner).toBe('b');
  });
});

describe('draws', () => {
  it('detects stalemate', () => {
    // Black king on a8 has no legal move but is not in check.
    const engine = new ChessEngine('k7/8/1Q6/8/8/8/8/7K b - - 0 1');
    const over = engine.detectGameOver();
    expect(over?.reason).toBe('stalemate');
    expect(over?.result).toBe('1/2-1/2');
  });

  it('detects insufficient material for king versus king', () => {
    const engine = new ChessEngine('8/8/4k3/8/8/4K3/8/8 w - - 0 1');
    expect(engine.detectGameOver()?.reason).toBe('insufficient_material');
  });

  it('detects insufficient material for king and bishop versus king', () => {
    const engine = new ChessEngine('8/8/4k3/8/8/4KB2/8/8 w - - 0 1');
    expect(engine.detectGameOver()?.reason).toBe('insufficient_material');
  });

  it('does not call king and rook insufficient', () => {
    const engine = new ChessEngine('8/8/4k3/8/8/4KR2/8/8 w - - 0 1');
    expect(engine.detectGameOver()).toBeNull();
  });

  it('makes threefold repetition claimable but not automatic', () => {
    const engine = new ChessEngine('4k3/8/8/8/8/8/8/R3K2R w - - 0 1');
    expect(engine.canClaimThreefold()).toBe(false);

    // Shuffle both kings/rooks back and forth to repeat the position.
    play(engine, [
      ['a1', 'b1'],
      ['e8', 'd8'],
      ['b1', 'a1'],
      ['d8', 'e8'],
    ]);
    expect(engine.countRepetitions()).toBe(2);
    expect(engine.canClaimThreefold()).toBe(false);

    play(engine, [
      ['a1', 'b1'],
      ['e8', 'd8'],
      ['b1', 'a1'],
      ['d8', 'e8'],
    ]);
    expect(engine.countRepetitions()).toBe(3);
    expect(engine.canClaimThreefold()).toBe(true);
    // Still claimable, not forced.
    expect(engine.detectGameOver()).toBeNull();
  });

  it('ends the game automatically on fivefold repetition', () => {
    const engine = new ChessEngine('4k3/8/8/8/8/8/8/R3K2R w - - 0 1');
    for (let i = 0; i < 4; i += 1) {
      play(engine, [
        ['a1', 'b1'],
        ['e8', 'd8'],
        ['b1', 'a1'],
        ['d8', 'e8'],
      ]);
    }
    expect(engine.countRepetitions()).toBe(5);
    expect(engine.detectGameOver()?.reason).toBe('fivefold_repetition');
  });

  it('makes the fifty-move rule claimable at 100 half-moves', () => {
    // halfmoveClock is read straight from the FEN.
    const almost = new ChessEngine('4k3/8/8/8/8/8/8/R3K2R w - - 99 60');
    expect(almost.canClaimFiftyMove()).toBe(false);

    const at100 = new ChessEngine('4k3/8/8/8/8/8/8/R3K2R w - - 100 60');
    expect(at100.canClaimFiftyMove()).toBe(true);
    expect(at100.detectGameOver()).toBeNull();
  });

  it('ends the game automatically at the seventy-five-move rule', () => {
    const engine = new ChessEngine('4k3/8/8/8/8/8/8/R3K2R w - - 150 90');
    expect(engine.detectGameOver()?.reason).toBe('seventyfive_move_rule');
  });

  it('resets the halfmove clock on a capture or pawn move', () => {
    const engine = new ChessEngine('4k3/8/8/8/8/8/P7/R3K2R w - - 40 60');
    expect(engine.halfmoveClock).toBe(40);
    play(engine, [['a2', 'a3']]);
    expect(engine.halfmoveClock).toBe(0);
  });
});

describe('mating material', () => {
  it.each([
    ['8/8/4k3/8/8/4K3/8/8 w - - 0 1', 'w', false, 'lone king'],
    ['8/8/4k3/8/8/4KB2/8/8 w - - 0 1', 'w', false, 'king and one bishop'],
    ['8/8/4k3/8/8/4KN2/8/8 w - - 0 1', 'w', false, 'king and one knight'],
    ['8/8/4k3/8/8/3NKN2/8/8 w - - 0 1', 'w', true, 'king and two knights'],
    ['8/8/4k3/8/8/3BKB2/8/8 w - - 0 1', 'w', true, 'king and two bishops'],
    ['8/8/4k3/8/8/4KR2/8/8 w - - 0 1', 'w', true, 'king and rook'],
    ['8/8/4k3/8/8/4K3/P7/8 w - - 0 1', 'w', true, 'king and pawn'],
  ])('%s -> %s can mate = %s (%s)', (fen, color, expected) => {
    const engine = new ChessEngine(fen);
    expect(engine.hasMatingMaterial(color as 'w' | 'b')).toBe(expected);
  });
});

describe('takebacks', () => {
  it('undoes the requested number of half-moves', () => {
    const engine = new ChessEngine();
    play(engine, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
    ]);
    expect(engine.ply).toBe(3);

    expect(engine.undo(2)).toBe(true);
    expect(engine.ply).toBe(1);
    expect(engine.turn).toBe('b');
  });

  it('refuses to undo more moves than have been played', () => {
    const engine = new ChessEngine();
    play(engine, [['e2', 'e4']]);
    expect(engine.undo(5)).toBe(false);
    expect(engine.ply).toBe(1);
  });

  it('restores castling rights that the undone move removed', () => {
    const engine = new ChessEngine('r3k2r/pppppppp/8/8/8/8/PPPPPPPP/R3K2R w KQkq - 0 1');
    play(engine, [['e1', 'f1']]);
    expect(engine.fen).toContain('kq -');
    engine.undo(1);
    expect(engine.fen).toContain('KQkq');
  });
});

describe('serialisation', () => {
  it('replays a game from its recorded move list', () => {
    const engine = new ChessEngine();
    play(engine, [
      ['e2', 'e4'],
      ['e7', 'e5'],
      ['g1', 'f3'],
      ['b8', 'c6'],
      ['f1', 'b5'],
    ]);

    const restored = ChessEngine.restore(engine.moves);
    expect(restored.fen).toBe(engine.fen);
    expect(restored.ply).toBe(engine.ply);
    expect(restored.pgn()).toBe(engine.pgn());
  });

  it('exposes legal destinations only for the side to move', () => {
    const engine = new ChessEngine();
    const map = engine.legalMoveMap();
    expect(map.e2).toEqual(expect.arrayContaining(['e3', 'e4']));
    // Black pieces are not the side to move, so they have no entries.
    expect(map.e7).toBeUndefined();
  });
});
