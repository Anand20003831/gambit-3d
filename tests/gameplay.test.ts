import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JoinOutcome, RecordedMove, RoomView } from '@gambit3d/shared';
import {
  connect,
  settingsFor,
  sleep,
  startTestServer,
  waitFor,
  type TestClient,
  type TestServer,
} from './helpers/server.js';

/**
 * A full game played over real sockets: seating, turn order, server-side move
 * validation, offers, resignation, reconnection and abandonment.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
}, 30_000);

afterAll(async () => {
  await server.shutdown();
});

interface Table {
  white: TestClient;
  black: TestClient;
  room: RoomView;
  roomId: string;
  close: () => void;
}

/** Seats two clients, starts the game, and returns them keyed by colour. */
async function seatedGame(overrides: Record<string, unknown> = {}, start = true): Promise<Table> {
  const host = await connect(server, `H${Math.random().toString(36).slice(2, 8)}`);
  const guest = await connect(server, `G${Math.random().toString(36).slice(2, 8)}`);

  const created = await host.rpc<{ room: RoomView }>('room:create', {
    settings: await settingsFor({ hostColor: 'white', ...overrides }),
  });
  if (!created.ok) throw new Error(`create failed: ${created.message}`);
  const room = created.data.room;

  const joined = await guest.rpc<JoinOutcome>('room:join', { target: room.id });
  if (!joined.ok || joined.data.status !== 'joined') throw new Error('guest could not join');

  if (start) {
    const started = await host.rpc('game:start', { roomId: room.id });
    if (!started.ok) throw new Error(`start failed: ${started.message}`);
    await waitFor(host, (r) => r.game.phase === 'active');
    await waitFor(guest, (r) => r.game.phase === 'active');
  }

  return {
    white: host,
    black: guest,
    room,
    roomId: room.id,
    close: () => {
      host.close();
      guest.close();
    },
  };
}

async function move(
  client: TestClient,
  roomId: string,
  from: string,
  to: string,
  promotion?: string,
): Promise<{ ok: boolean; code?: string; move?: RecordedMove }> {
  const result = await client.rpc<{ room: RoomView; move: RecordedMove }>('game:move', {
    roomId,
    from,
    to,
    ...(promotion ? { promotion } : {}),
  });
  return result.ok ? { ok: true, move: result.data.move } : { ok: false, code: result.code };
}

describe('starting a game', () => {
  it('waits for the host to start even with both seats filled', async () => {
    const table = await seatedGame({}, false);
    const before = await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });
    if (before.ok) expect(before.data.room.game.phase).toBe('ready');

    // A move before the game starts must be refused.
    const early = await move(table.white, table.roomId, 'e2', 'e4');
    expect(early.ok).toBe(false);
    expect(early.code).toBe('GAME_NOT_ACTIVE');

    await table.white.rpc('game:start', { roomId: table.roomId });
    await waitFor(table.white, (r) => r.game.phase === 'active');
    table.close();
  });

  it('refuses to start from a non-host', async () => {
    const table = await seatedGame({}, false);
    const attempt = await table.black.rpc('game:start', { roomId: table.roomId });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('FORBIDDEN');
    table.close();
  });
});

describe('server-side move validation', () => {
  it('accepts a legal move and broadcasts it to both sides', async () => {
    const table = await seatedGame();
    const blackSaw = table.black.next<{ move: RecordedMove }>('game:moved');

    const played = await move(table.white, table.roomId, 'e2', 'e4');
    expect(played.ok).toBe(true);
    expect(played.move?.san).toBe('e4');

    const seen = await blackSaw;
    expect(seen.move.san).toBe('e4');
    table.close();
  });

  it('rejects a move from the side not to move', async () => {
    const table = await seatedGame();
    const wrong = await move(table.black, table.roomId, 'e7', 'e5');
    expect(wrong.ok).toBe(false);
    expect(wrong.code).toBe('NOT_YOUR_TURN');
    table.close();
  });

  it('rejects an illegal move and leaves the position untouched', async () => {
    const table = await seatedGame();
    const before = (await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId })) as {
      ok: true;
      data: { room: RoomView };
    };

    const bad = await move(table.white, table.roomId, 'e2', 'e5');
    expect(bad.ok).toBe(false);
    expect(bad.code).toBe('ILLEGAL_MOVE');

    const after = await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });
    if (after.ok) expect(after.data.room.game.fen).toBe(before.data.room.game.fen);
    table.close();
  });

  it('rejects a move from a spectator', async () => {
    const table = await seatedGame();
    const watcher = await connect(server, 'GameWatcher');
    await watcher.rpc('room:join', { target: table.roomId, asSpectator: true });

    const attempt = await move(watcher, table.roomId, 'e2', 'e4');
    expect(attempt.ok).toBe(false);
    expect(attempt.code).toBe('FORBIDDEN');

    watcher.close();
    table.close();
  });

  it('rejects a move against a stale board', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');

    // Black claims the board is still at ply 0.
    const stale = await table.black.rpc('game:move', {
      roomId: table.roomId,
      from: 'e7',
      to: 'e5',
      expectedPly: 0,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('BAD_REQUEST');
    table.close();
  });

  it('refuses an ambiguous promotion and accepts an explicit one', async () => {
    const table = await seatedGame();
    // Walk a white pawn up the h-file to the eighth rank.
    const script: [TestClient, string, string][] = [
      [table.white, 'h2', 'h4'],
      [table.black, 'g7', 'g5'],
      [table.white, 'h4', 'g5'], // hxg5
      [table.black, 'h7', 'h6'],
      [table.white, 'g5', 'h6'], // gxh6
      [table.black, 'a7', 'a6'],
      [table.white, 'h6', 'h7'], // h7, with h7 now empty
      [table.black, 'a6', 'a5'],
    ];
    for (const [who, from, to] of script) {
      const r = await move(who, table.roomId, from, to);
      expect(r.ok, `${from}->${to}`).toBe(true);
    }

    // hxg8 captures the knight and promotes, so it must name a piece.
    const ambiguous = await move(table.white, table.roomId, 'h7', 'g8');
    expect(ambiguous.ok).toBe(false);
    expect(ambiguous.code).toBe('BAD_REQUEST');

    const explicit = await move(table.white, table.roomId, 'h7', 'g8', 'q');
    expect(explicit.ok).toBe(true);
    expect(explicit.move?.promotion).toBe('q');
    expect(explicit.move?.captured).toBe('n');
    table.close();
  });

  it('only sends the legal-move map to the side to move', async () => {
    const table = await seatedGame();
    const whiteView = await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });
    const blackView = await table.black.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });

    if (whiteView.ok) expect(whiteView.data.room.game.legalMoves).not.toBeNull();
    if (blackView.ok) expect(blackView.data.room.game.legalMoves).toBeNull();
    table.close();
  });

  it("plays fool's mate through to a finished game", async () => {
    const table = await seatedGame();
    const script: [TestClient, string, string][] = [
      [table.white, 'f2', 'f3'],
      [table.black, 'e7', 'e5'],
      [table.white, 'g2', 'g4'],
      [table.black, 'd8', 'h4'],
    ];
    for (const [who, from, to] of script) {
      expect((await move(who, table.roomId, from, to)).ok).toBe(true);
    }

    const finished = await waitFor(table.white, (r) => r.game.phase === 'finished');
    expect(finished.game.result?.reason).toBe('checkmate');
    expect(finished.game.result?.winner).toBe('b');
    expect(finished.game.result?.result).toBe('0-1');

    // No further moves are accepted.
    const after = await move(table.white, table.roomId, 'e2', 'e4');
    expect(after.ok).toBe(false);
    table.close();
  });
});

describe('resignation and draws', () => {
  it('awards the win to the opponent on resignation', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');

    const resigned = await table.black.rpc('game:resign', { roomId: table.roomId });
    expect(resigned.ok).toBe(true);

    const view = await waitFor(table.white, (r) => r.game.phase === 'finished');
    expect(view.game.result?.reason).toBe('resignation');
    expect(view.game.result?.winner).toBe('w');
    table.close();
  });

  it('agrees a draw when the opponent accepts', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');

    const offered = await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'draw' });
    expect(offered.ok).toBe(true);
    await waitFor(table.black, (r) => r.pendingOffer?.kind === 'draw');

    const accepted = await table.black.rpc('game:respondOffer', {
      roomId: table.roomId,
      kind: 'draw',
      accept: true,
    });
    expect(accepted.ok).toBe(true);

    const view = await waitFor(table.black, (r) => r.game.phase === 'finished');
    expect(view.game.result?.reason).toBe('draw_agreement');
    expect(view.game.result?.result).toBe('1/2-1/2');
    table.close();
  });

  it('keeps the game going when a draw is declined', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');
    await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'draw' });
    await waitFor(table.black, (r) => r.pendingOffer !== null);

    await table.black.rpc('game:respondOffer', { roomId: table.roomId, kind: 'draw', accept: false });
    const view = await waitFor(table.black, (r) => r.pendingOffer === null);
    expect(view.game.phase).toBe('active');
    table.close();
  });

  it('refuses draw offers when the host has disabled them', async () => {
    const table = await seatedGame({ allowDrawOffers: false });
    const attempt = await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'draw' });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('FEATURE_DISABLED');
    table.close();
  });

  it('will not let a player answer their own offer', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');
    await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'draw' });

    const attempt = await table.white.rpc('game:respondOffer', {
      roomId: table.roomId,
      kind: 'draw',
      accept: true,
    });
    expect(attempt.ok).toBe(false);
    table.close();
  });
});

describe('takebacks', () => {
  it('undoes the move once the opponent agrees', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'e2', 'e4');
    await move(table.black, table.roomId, 'e7', 'e5');
    const beforePly = (await waitFor(table.white, (r) => r.game.moves.length === 2)).game.moves.length;
    expect(beforePly).toBe(2);

    const requested = await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'takeback' });
    expect(requested.ok).toBe(true);
    await waitFor(table.black, (r) => r.pendingOffer?.kind === 'takeback');

    await table.black.rpc('game:respondOffer', { roomId: table.roomId, kind: 'takeback', accept: true });
    const after = await waitFor(table.white, (r) => r.game.moves.length < 2);
    // White asked after Black replied, so both half-moves come back.
    expect(after.game.moves.length).toBe(0);
    expect(after.game.turn).toBe('w');
    table.close();
  });

  it('refuses takebacks when the host has disabled them', async () => {
    const table = await seatedGame({ allowTakebacks: false });
    await move(table.white, table.roomId, 'e2', 'e4');
    const attempt = await table.black.rpc('game:offer', { roomId: table.roomId, kind: 'takeback' });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('FEATURE_DISABLED');
    table.close();
  });
});

describe('rematch', () => {
  it('starts a new game with the colours swapped', async () => {
    const table = await seatedGame();
    await table.white.rpc('game:resign', { roomId: table.roomId });
    await waitFor(table.white, (r) => r.game.phase === 'finished');

    await table.white.rpc('game:offer', { roomId: table.roomId, kind: 'rematch' });
    await waitFor(table.black, (r) => r.pendingOffer?.kind === 'rematch');
    await table.black.rpc('game:respondOffer', { roomId: table.roomId, kind: 'rematch', accept: true });

    const view = await waitFor(table.white, (r) => r.game.phase === 'active' && r.game.moves.length === 0);
    // The original host played White; after a rematch they are Black.
    expect(view.you.seat).toBe('b');
    table.close();
  });
});

describe('clocks', () => {
  it('deducts thinking time and adds the increment', async () => {
    const table = await seatedGame({ timeControl: { initialSeconds: 60, incrementSeconds: 2 } });
    await sleep(700);
    const played = await move(table.white, table.roomId, 'e2', 'e4');
    expect(played.ok).toBe(true);

    const clockAfter = played.move?.clockAfter;
    expect(clockAfter).not.toBeNull();
    // Started at 60s, spent ~0.7s, gained 2s.
    expect(clockAfter!.w).toBeGreaterThan(60_000);
    expect(clockAfter!.w).toBeLessThan(62_000);
    expect(clockAfter!.b).toBe(60_000);
    table.close();
  });

  it('ends the game on time and awards the win to the opponent', async () => {
    const table = await seatedGame({ timeControl: { initialSeconds: 1, incrementSeconds: 0 } });
    // White has one second and never moves.
    const finished = await waitFor(table.black, (r) => r.game.phase === 'finished', 6000);
    expect(finished.game.result?.reason).toBe('timeout');
    expect(finished.game.result?.winner).toBe('b');
    table.close();
  }, 15_000);

  it('reports no clock at all for an untimed game', async () => {
    const table = await seatedGame({ timeControl: { initialSeconds: 0, incrementSeconds: 0 } });
    const view = await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });
    if (view.ok) expect(view.data.room.game.clock).toBeNull();
    await sleep(300);
    const later = await table.white.rpc<{ room: RoomView }>('room:get', { roomId: table.roomId });
    if (later.ok) expect(later.data.room.game.phase).toBe('active');
    table.close();
  });
});

describe('reconnection', () => {
  it('restores the seat, position and clock after a dropped connection', async () => {
    const table = await seatedGame({ timeControl: { initialSeconds: 300, incrementSeconds: 0 } });
    await move(table.white, table.roomId, 'e2', 'e4');
    await move(table.black, table.roomId, 'e7', 'e5');
    await move(table.white, table.roomId, 'g1', 'f3');

    const token = table.black.identity.token;
    const userId = table.black.identity.userId;
    table.black.close();

    // Reconnect as the same identity, exactly as a browser refresh would.
    const returning = await connect(server, undefined, token);
    expect(returning.identity.userId).toBe(userId);

    const restored = await waitFor(returning, (r) => r.id === table.roomId);
    expect(restored.you.seat).toBe('b');
    expect(restored.game.moves).toHaveLength(3);
    expect(restored.game.fen).toContain('N');
    expect(restored.game.phase).toBe('active');
    expect(restored.game.clock).not.toBeNull();
    expect(restored.game.clock!.running).toBe('b');
    // Their own clock kept running while they were away, as it should.
    expect(restored.game.clock!.b).toBeLessThanOrEqual(300_000);

    // And they can move immediately.
    const played = await move(returning, table.roomId, 'b8', 'c6');
    expect(played.ok).toBe(true);

    returning.close();
    table.close();
  }, 20_000);

  it('lets the returning player keep playing to the end', async () => {
    const table = await seatedGame();
    await move(table.white, table.roomId, 'f2', 'f3');

    const token = table.black.identity.token;
    table.black.close();
    const returning = await connect(server, undefined, token);
    await waitFor(returning, (r) => r.id === table.roomId);

    expect((await move(returning, table.roomId, 'e7', 'e5')).ok).toBe(true);
    expect((await move(table.white, table.roomId, 'g2', 'g4')).ok).toBe(true);
    expect((await move(returning, table.roomId, 'd8', 'h4')).ok).toBe(true);

    const finished = await waitFor(returning, (r) => r.game.phase === 'finished');
    expect(finished.game.result?.reason).toBe('checkmate');
    returning.close();
    table.close();
  }, 20_000);
});

describe('abandonment', () => {
  it('awards the win once the grace period expires', async () => {
    // The helper sets DISCONNECT_GRACE_MS to 400ms for the test server.
    const table = await seatedGame({ timeControl: { initialSeconds: 0, incrementSeconds: 0 } });
    await move(table.white, table.roomId, 'e2', 'e4');

    table.black.close();
    const finished = await waitFor(table.white, (r) => r.game.phase === 'finished', 8000);
    expect(finished.game.result?.reason).toBe('abandonment');
    expect(finished.game.result?.winner).toBe('w');
    table.close();
  }, 20_000);
});

describe('chat', () => {
  it('delivers a player message to both sides', async () => {
    const table = await seatedGame();
    const received = table.black.next<{ text: string; authorName: string }>('chat:message');
    const sent = await table.white.rpc('chat:send', { roomId: table.roomId, text: 'good luck' });
    expect(sent.ok).toBe(true);
    const message = await received;
    expect(message.text).toBe('good luck');
    table.close();
  });

  it('rejects chat from someone outside the room', async () => {
    const table = await seatedGame();
    const outsider = await connect(server, 'Interloper');
    const attempt = await outsider.rpc('chat:send', { roomId: table.roomId, text: 'hello?' });
    expect(attempt.ok).toBe(false);
    outsider.close();
    table.close();
  });

  it('rejects empty and oversized messages', async () => {
    const table = await seatedGame();
    expect((await table.white.rpc('chat:send', { roomId: table.roomId, text: '   ' })).ok).toBe(false);
    expect((await table.white.rpc('chat:send', { roomId: table.roomId, text: 'x'.repeat(500) })).ok).toBe(false);
    table.close();
  });
});

describe('rated games', () => {
  it('moves both ratings when a rated game finishes', async () => {
    const table = await seatedGame({ rated: true });
    await move(table.white, table.roomId, 'f2', 'f3');
    await move(table.black, table.roomId, 'e7', 'e5');
    await move(table.white, table.roomId, 'g2', 'g4');
    await move(table.black, table.roomId, 'd8', 'h4');

    const finished = await waitFor(table.white, (r) => r.game.phase === 'finished');
    const change = finished.game.result?.ratingChange;
    expect(change).toBeDefined();
    // Black won, so Black gains and White loses.
    expect(change!.b).toBeGreaterThan(0);
    expect(change!.w).toBeLessThan(0);
    table.close();
  });

  it('leaves ratings alone for a casual game', async () => {
    const table = await seatedGame({ rated: false });
    await move(table.white, table.roomId, 'e2', 'e4');
    await table.white.rpc('game:resign', { roomId: table.roomId });
    const finished = await waitFor(table.white, (r) => r.game.phase === 'finished');
    expect(finished.game.result?.ratingChange).toBeUndefined();
    table.close();
  });
});
