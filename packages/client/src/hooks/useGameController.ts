import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Chess } from 'chess.js';
import type { PieceColor, RecordedMove, RoomView, Square } from '@gambit3d/shared';
import { rpc } from '../net/socket.js';
import { useStore } from '../net/store.js';
import { parseFen, trackPieces, type TrackedPiece } from '../lib/board.js';
import { audio } from '../audio/engine.js';
import { useSettings } from './useSettings.js';

/**
 * Turns pointer/keyboard input into validated move intents.
 *
 * The server is authoritative, but the client keeps a local chess.js instance
 * for two things it genuinely needs: knowing whether a click is a promotion (so
 * it can ask which piece), and validating a premove locally before it is fired.
 * It never decides whether a move is legal for scoring purposes.
 */

export interface Premove {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

export interface GameController {
  pieces: TrackedPiece[];
  selected: Square | null;
  legalMoves: Square[];
  legalCaptures: Square[];
  premove: Premove | null;
  promotionPrompt: { from: Square; to: Square } | null;
  checkSquare: Square | null;
  /** True when this viewer may currently move. */
  canMove: boolean;
  /** The colour this viewer controls, or null for spectators. */
  controllable: PieceColor | null;
  busy: boolean;

  onSquare: (square: Square) => void;
  choosePromotion: (piece: 'q' | 'r' | 'b' | 'n') => void;
  cancelPromotion: () => void;
  clearPremove: () => void;
  clearSelection: () => void;
}

export function useGameController(room: RoomView | null): GameController {
  const settings = useSettings();
  const toast = useStore((s) => s.toast);

  const [selected, setSelected] = useState<Square | null>(null);
  const [premove, setPremove] = useState<Premove | null>(null);
  const [promotionPrompt, setPromotionPrompt] = useState<{ from: Square; to: Square } | null>(null);
  const [busy, setBusy] = useState(false);

  const trackedRef = useRef<TrackedPiece[]>([]);
  const lastPlyRef = useRef(-1);
  const premoveRef = useRef<Premove | null>(null);
  premoveRef.current = premove;

  const seat = room?.you.seat ?? null;
  const phase = room?.game.phase ?? 'waiting';

  /**
   * Which colour this viewer may pick up.
   *
   * Normally their own seat. In a same-device game one person plays both
   * sides, so it follows the side to move - which is also the side the board
   * has just turned to face.
   */
  const isLocalGame = room?.settings.mode === 'local';
  const controllable: PieceColor | null = isLocalGame
    ? (phase === 'active' ? (room?.game.turn ?? 'w') : 'w')
    : seat;
  const canMove = Boolean(room?.you.can.move);

  // --- position ------------------------------------------------------------

  const pieces = useMemo(() => {
    if (!room) {
      trackedRef.current = [];
      return [];
    }
    const placed = parseFen(room.game.fen);
    const tracked = trackPieces(placed, trackedRef.current);
    trackedRef.current = tracked;
    return tracked;
  }, [room]);

  /** Local engine mirroring the server position, for promotion + premove checks. */
  const engine = useMemo(() => {
    if (!room) return null;
    try {
      return new Chess(room.game.fen);
    } catch {
      return null;
    }
  }, [room]);

  const checkSquare = useMemo(() => {
    if (!room?.game.inCheck || !engine) return null;
    const side = engine.turn();
    for (const row of engine.board()) {
      for (const cell of row) {
        if (cell && cell.type === 'k' && cell.color === side) return cell.square as Square;
      }
    }
    return null;
  }, [room?.game.inCheck, engine]);

  // --- legal destinations --------------------------------------------------

  const { legalMoves, legalCaptures } = useMemo(() => {
    if (!selected || !room) return { legalMoves: [] as Square[], legalCaptures: [] as Square[] };

    // Prefer the server's map; fall back to the local engine when the viewer
    // is not entitled to it (spectators never get one, and never need one).
    const serverMap = room.game.legalMoves?.[selected];
    let destinations: Square[] = serverMap ?? [];

    if (!serverMap && engine) {
      try {
        destinations = engine
          .moves({ square: selected as never, verbose: true })
          .map((m) => m.to as Square);
      } catch {
        destinations = [];
      }
    }

    const occupied = new Set(pieces.filter((p) => p.color !== controllable).map((p) => p.square));
    // En passant captures land on an empty square; treat them as captures too.
    const epTarget = room.game.fen.split(' ')[3];
    const moving = pieces.find((p) => p.square === selected);

    const captures: Square[] = [];
    const quiet: Square[] = [];
    for (const target of destinations) {
      const isEnPassant = moving?.type === 'p' && epTarget && epTarget !== '-' && target === epTarget;
      if (occupied.has(target) || isEnPassant) captures.push(target);
      else quiet.push(target);
    }
    return { legalMoves: quiet, legalCaptures: captures };
  }, [selected, room, engine, pieces, controllable]);

  // --- sounds --------------------------------------------------------------

  useEffect(() => {
    if (!room) return;
    const moves = room.game.moves;
    const last = moves.at(-1);
    const ply = last?.ply ?? -1;

    if (ply === lastPlyRef.current) return;
    const isNewer = ply > lastPlyRef.current;
    lastPlyRef.current = ply;
    if (!isNewer || !last) return;

    playMoveSound(last);
  }, [room?.game.moves, room]);

  useEffect(() => {
    if (room?.game.phase === 'active' && room.game.moves.length === 0) audio.play('gameStart');
  }, [room?.game.phase, room?.game.moves.length, room]);

  useEffect(() => {
    if (room?.game.result) audio.play('gameEnd');
  }, [room?.game.result, room]);

  // --- selection reset -----------------------------------------------------

  useEffect(() => {
    // A new position invalidates the current selection.
    setSelected(null);
    setPromotionPrompt(null);
  }, [room?.game.fen]);

  useEffect(() => {
    if (phase !== 'active') {
      setPremove(null);
      setSelected(null);
    }
  }, [phase]);

  // --- premove firing ------------------------------------------------------

  const submit = useCallback(
    async (from: Square, to: Square, promotion?: 'q' | 'r' | 'b' | 'n'): Promise<boolean> => {
      if (!room) return false;
      setBusy(true);
      const result = await rpc<'game:move', { room: RoomView; move: RecordedMove }>('game:move', {
        roomId: room.id,
        from,
        to,
        ...(promotion ? { promotion } : {}),
        expectedPly: room.game.moves.length,
      });
      setBusy(false);

      if (!result.ok) {
        audio.play('illegal');
        // Only surface real problems; a stale-board rejection self-heals via
        // the fresh snapshot the server pushes alongside it.
        if (result.code !== 'BAD_REQUEST') toast('error', result.message);
        return false;
      }
      setSelected(null);
      return true;
    },
    [room, toast],
  );

  useEffect(() => {
    const queued = premoveRef.current;
    if (!queued || !canMove || !engine) return;

    // Validate against the position that actually arrived before firing.
    const legal = engine
      .moves({ verbose: true })
      .some(
        (m) =>
          m.from === queued.from &&
          m.to === queued.to &&
          (queued.promotion ? m.promotion === queued.promotion : !m.promotion),
      );

    setPremove(null);
    if (!legal) {
      audio.play('illegal');
      toast('warn', 'Your premove was no longer legal.');
      return;
    }
    void submit(queued.from, queued.to, queued.promotion);
  }, [canMove, engine, submit, toast]);

  // --- interaction ---------------------------------------------------------

  const pieceAt = useCallback((square: Square) => pieces.find((p) => p.square === square), [pieces]);

  const onSquare = useCallback(
    (square: Square) => {
      if (!room || phase === 'finished' || !controllable) return;
      void audio.unlock();

      const occupant = pieceAt(square);

      // --- premove path: it is not our turn, but the game is live.
      if (!canMove) {
        const allowPremove =
          settings.premovesEnabled && room.you.can.usePremoves && phase === 'active' && Boolean(seat);
        if (!allowPremove) return;

        if (selected) {
          if (square === selected) {
            setSelected(null);
            return;
          }
          // Premoves are queued optimistically; legality is re-checked on arrival.
          setPremove({ from: selected, to: square, promotion: settings.autoQueen ? 'q' : undefined });
          setSelected(null);
          audio.play('select');
          return;
        }
        if (occupant?.color === controllable) {
          setSelected(square);
          audio.play('select');
        }
        return;
      }

      // --- normal path
      if (selected) {
        if (square === selected) {
          setSelected(null);
          return;
        }
        const isTarget = legalMoves.includes(square) || legalCaptures.includes(square);
        if (isTarget) {
          if (needsPromotion(engine, selected, square)) {
            if (settings.autoQueen) {
              void submit(selected, square, 'q');
            } else {
              setPromotionPrompt({ from: selected, to: square });
            }
            return;
          }
          void submit(selected, square);
          return;
        }
        // Clicking another of your own pieces re-targets the selection.
        if (occupant?.color === controllable) {
          setSelected(square);
          audio.play('select');
          return;
        }
        setSelected(null);
        return;
      }

      if (occupant?.color === controllable) {
        setSelected(square);
        audio.play('select');
      }
    },
    [
      room,
      phase,
      controllable,
      canMove,
      selected,
      legalMoves,
      legalCaptures,
      engine,
      pieceAt,
      settings.premovesEnabled,
      settings.autoQueen,
      seat,
      submit,
    ],
  );

  const choosePromotion = useCallback(
    (piece: 'q' | 'r' | 'b' | 'n') => {
      const prompt = promotionPrompt;
      setPromotionPrompt(null);
      if (!prompt) return;
      void submit(prompt.from, prompt.to, piece);
    },
    [promotionPrompt, submit],
  );

  return {
    pieces,
    selected,
    legalMoves: settings.showLegalMoves ? legalMoves : [],
    legalCaptures: settings.showLegalMoves ? legalCaptures : [],
    premove,
    promotionPrompt,
    checkSquare,
    canMove,
    controllable,
    busy,
    onSquare,
    choosePromotion,
    cancelPromotion: () => setPromotionPrompt(null),
    clearPremove: () => setPremove(null),
    clearSelection: () => setSelected(null),
  };
}

function needsPromotion(engine: Chess | null, from: Square, to: Square): boolean {
  if (!engine) return false;
  try {
    return engine.moves({ verbose: true }).some((m) => m.from === from && m.to === to && Boolean(m.promotion));
  } catch {
    return false;
  }
}

function playMoveSound(move: RecordedMove): void {
  if (move.isCheckmate) {
    audio.play('check');
    return;
  }
  if (move.isCheck) {
    audio.play('check');
    return;
  }
  if (move.promotion) {
    audio.play('promote');
    return;
  }
  if (move.flags.includes('k') || move.flags.includes('q')) {
    audio.play('castle');
    return;
  }
  if (move.captured) {
    audio.play('capture');
    return;
  }
  audio.play('move');
}
