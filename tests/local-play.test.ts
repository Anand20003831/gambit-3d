import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Result, RoomView } from '@gambit3d/shared';
import { connect, settingsFor, startTestServer, waitFor, type TestClient, type TestServer } from './helpers/server.js';

/**
 * Same-device ("pass and play") games.
 *
 * One person sits at one keyboard and moves for both colours. Everything the
 * online modes wait for - a second player arriving, an opponent accepting an
 * offer - has to resolve on its own here, or the mode is unplayable. These
 * tests are that contract.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
});

afterAll(async () => {
  await server.shutdown();
});

async function createLocalRoom(
  client: TestClient,
  overrides: Record<string, unknown> = {},
): Promise<RoomView> {
  const result = await client.rpc<{ room: RoomView }>('room:create', {
    settings: await settingsFor({ mode: 'local', name: 'Kitchen table', ...overrides }),
  });
  if (!result.ok) throw new Error(`create failed: ${result.message}`);
  return result.data.room;
}

describe('same-device rooms', () => {
  it('is playable immediately, with nobody else in the room', async () => {
    const host = await connect(server, 'Solo Host');
    const room = await createLocalRoom(host);

    expect(room.settings.mode).toBe('local');
    expect(room.game.phase).toBe('active');
    expect(room.members).toHaveLength(1);

    host.close();
  });

  it('lets the one player move both colours, alternating', async () => {
    const host = await connect(server, 'Both Sides');
    const room = await createLocalRoom(host);

    const e4 = await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    expect(e4.ok).toBe(true);

    // The same socket now moves Black, which every other mode would refuse.
    const e5 = await host.rpc('game:move', { roomId: room.id, from: 'e7', to: 'e5' });
    expect(e5.ok).toBe(true);

    const nf3 = await host.rpc('game:move', { roomId: room.id, from: 'g1', to: 'f3' });
    expect(nf3.ok).toBe(true);

    const state = await waitFor(host, (r) => r.game.moves.length === 3);
    expect(state.game.moves.map((m) => m.san)).toEqual(['e4', 'e5', 'Nf3']);
    expect(state.game.turn).toBe('b');

    host.close();
  });

  it('still rejects an illegal move', async () => {
    const host = await connect(server, 'Rule Test');
    const room = await createLocalRoom(host);

    const illegal = await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e5' });
    expect(illegal.ok).toBe(false);
    if (!illegal.ok) expect(illegal.code).toBe('ILLEGAL_MOVE');

    host.close();
  });

  it('still rejects moving the side that is not to move', async () => {
    const host = await connect(server, 'Turn Test');
    const room = await createLocalRoom(host);

    // White has not moved yet, so Black may not.
    const outOfTurn = await host.rpc('game:move', { roomId: room.id, from: 'e7', to: 'e5' });
    expect(outOfTurn.ok).toBe(false);
    if (!outOfTurn.ok) expect(outOfTurn.code).toBe('NOT_YOUR_TURN');

    host.close();
  });

  it('grants the move capability to whichever colour is to move', async () => {
    const host = await connect(server, 'Caps');
    const room = await createLocalRoom(host);

    const before = await waitFor(host, (r) => r.game.phase === 'active');
    expect(before.you.can.move).toBe(true);

    await host.rpc('game:move', { roomId: room.id, from: 'd2', to: 'd4' });
    const after = await waitFor(host, (r) => r.game.turn === 'b');
    // Still allowed to move - now as Black.
    expect(after.you.can.move).toBe(true);

    host.close();
  });

  it('gives the player the legal-move map for both colours', async () => {
    const host = await connect(server, 'Legal Map');
    const room = await createLocalRoom(host);

    const white = await waitFor(host, (r) => r.game.phase === 'active');
    expect(white.game.legalMoves?.e2).toContain('e4');

    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    const black = await waitFor(host, (r) => r.game.turn === 'b');
    expect(black.game.legalMoves?.e7).toContain('e5');

    host.close();
  });

  it('takes a move back immediately, with nobody to approve it', async () => {
    const host = await connect(server, 'Takeback');
    const room = await createLocalRoom(host, { allowTakebacks: true });

    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    await waitFor(host, (r) => r.game.moves.length === 1);

    const takeback = await host.rpc('game:offer', { roomId: room.id, kind: 'takeback' });
    expect(takeback.ok).toBe(true);

    const state = await waitFor(host, (r) => r.game.moves.length === 0);
    // No offer is left hanging, because there is nobody to hang it on.
    expect(state.pendingOffer).toBeNull();
    expect(state.game.turn).toBe('w');

    host.close();
  });

  it('agrees a draw immediately', async () => {
    const host = await connect(server, 'Draw');
    const room = await createLocalRoom(host, { allowDrawOffers: true });

    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    const draw = await host.rpc('game:offer', { roomId: room.id, kind: 'draw' });
    expect(draw.ok).toBe(true);

    const state = await waitFor(host, (r) => r.game.phase === 'finished');
    expect(state.game.result?.result).toBe('1/2-1/2');
    expect(state.game.result?.reason).toBe('draw_agreement');
    expect(state.pendingOffer).toBeNull();

    host.close();
  });

  it('resigns on behalf of the side to move', async () => {
    const host = await connect(server, 'Resign');
    const room = await createLocalRoom(host);

    // White plays, so Black is to move and Black is the side that resigns.
    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    await waitFor(host, (r) => r.game.turn === 'b');

    const resigned = await host.rpc('game:resign', { roomId: room.id });
    expect(resigned.ok).toBe(true);

    const state = await waitFor(host, (r) => r.game.phase === 'finished');
    expect(state.game.result?.result).toBe('1-0');
    expect(state.game.result?.winner).toBe('w');

    host.close();
  });

  it('restarts on a rematch without needing a second player', async () => {
    const host = await connect(server, 'Rematch');
    const room = await createLocalRoom(host, { allowRematch: true });

    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });
    await host.rpc('game:resign', { roomId: room.id });
    await waitFor(host, (r) => r.game.phase === 'finished');

    const rematch = await host.rpc('game:offer', { roomId: room.id, kind: 'rematch' });
    expect(rematch.ok).toBe(true);

    const state = await waitFor(host, (r) => r.game.phase === 'active' && r.game.moves.length === 0);
    expect(state.game.turn).toBe('w');
    expect(state.game.result).toBeNull();

    host.close();
  });

  it('plays a whole game through to checkmate', async () => {
    const host = await connect(server, "Fool's Mate");
    const room = await createLocalRoom(host);

    const moves: [string, string][] = [
      ['f2', 'f3'],
      ['e7', 'e5'],
      ['g2', 'g4'],
      ['d8', 'h4'],
    ];
    for (const [from, to] of moves) {
      const result: Result<unknown> = await host.rpc('game:move', { roomId: room.id, from, to });
      expect(result.ok).toBe(true);
    }

    const state = await waitFor(host, (r) => r.game.phase === 'finished');
    expect(state.game.result?.result).toBe('0-1');
    expect(state.game.result?.reason).toBe('checkmate');

    host.close();
  });

  it('is never rated, and never offers premoves', async () => {
    const host = await connect(server, 'Settings');
    const room = await createLocalRoom(host, { rated: true, allowPremoves: true });

    expect(room.settings.rated).toBe(false);
    expect(room.settings.allowPremoves).toBe(false);
    expect(room.you.can.usePremoves).toBe(false);

    host.close();
  });

  it('is not listed in the public lobby', async () => {
    const host = await connect(server, 'Unlisted');
    const room = await createLocalRoom(host, { name: 'Very Private Kitchen' });

    const browser = await connect(server, 'Browser');
    const listed = await browser.rpc<{ rooms: { id: string }[] }>('lobby:list', {});
    expect(listed.ok).toBe(true);
    if (listed.ok) {
      expect(listed.data.rooms.some((r) => r.id === room.id)).toBe(false);
    }

    host.close();
    browser.close();
  });

  it('does not forfeit the game when the single player disconnects', async () => {
    const host = await connect(server, 'Flaky Wifi');
    const room = await createLocalRoom(host);
    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });

    const token = host.identity.token;
    host.close();

    // Well past DISCONNECT_GRACE_MS: an online game would have been forfeited.
    await new Promise((r) => setTimeout(r, 900));

    // Reconnecting with the same token is what a browser refresh does.
    const back = await connect(server, undefined, token);
    const restored = await waitFor(back, (r) => r.id === room.id);
    expect(restored.game.phase).toBe('active');
    expect(restored.game.moves).toHaveLength(1);
    expect(restored.you.can.move).toBe(true);

    back.close();
  });
});
