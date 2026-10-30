import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { JoinOutcome, PublicRoomSummary, RoomView } from '@gambit3d/shared';
import { connect, settingsFor, startTestServer, waitFor, type TestClient, type TestServer } from './helpers/server.js';

/**
 * Room lifecycle, matchmaking and permissions, over real sockets against the
 * real server. These are the tests that would catch a client being able to talk
 * its way past a rule.
 */

let server: TestServer;

beforeAll(async () => {
  server = await startTestServer();
}, 30_000);

afterAll(async () => {
  await server.shutdown();
});

async function hostRoom(
  client: TestClient,
  overrides: Record<string, unknown> = {},
  password?: string,
): Promise<RoomView> {
  const result = await client.rpc<{ room: RoomView }>('room:create', {
    settings: await settingsFor(overrides),
    ...(password ? { password } : {}),
  });
  if (!result.ok) throw new Error(`create failed: ${result.message} ${JSON.stringify(result.details ?? {})}`);
  return result.data.room;
}

describe('identity', () => {
  it('mints a guest identity and lets the same token reclaim it', async () => {
    const first = await connect(server, 'Reclaimer');
    expect(first.identity.name).toBe('Reclaimer');
    expect(first.identity.rating).toBe(1200);
    const token = first.identity.token;
    first.close();

    const second = await connect(server, undefined, token);
    expect(second.identity.userId).toBe(first.identity.userId);
    expect(second.identity.name).toBe('Reclaimer');
    second.close();
  });

  it('ignores a forged token and issues a fresh identity instead', async () => {
    const forged = 'AAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBBBB.CCCCCCCCCCCCCCCCCCCCCCCC';
    const client = await connect(server, 'Forger', forged);
    expect(client.identity.token).not.toBe(forged);
    expect(client.identity.name).toBe('Forger');
    client.close();
  });

  it('rejects an unusable display name', async () => {
    const client = await connect(server, 'Namer');
    const result = await client.rpc('identify', { name: 'x' });
    expect(result.ok).toBe(false);
    client.close();
  });
});

describe('public rooms', () => {
  it('lists a public room and lets a second player take the other seat', async () => {
    const host = await connect(server, 'PubHost');
    const guest = await connect(server, 'PubGuest');

    const room = await hostRoom(host, { name: 'Listed Game', mode: 'public', hostColor: 'white' });
    expect(room.you.seat).toBe('w');

    const list = await guest.rpc<{ rooms: PublicRoomSummary[] }>('lobby:list', {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const found = list.data.rooms.find((r) => r.id === room.id);
    expect(found?.name).toBe('Listed Game');
    expect(found?.seatsOpen).toBe(1);

    const joined = await guest.rpc<JoinOutcome>('room:join', { target: room.id });
    expect(joined.ok).toBe(true);
    if (!joined.ok || joined.data.status !== 'joined') throw new Error('expected an immediate join');
    expect(joined.data.room.you.seat).toBe('b');

    host.close();
    guest.close();
  });

  it('never lists private, LAN or same-device rooms', async () => {
    const host = await connect(server, 'Hider');
    const watcher = await connect(server, 'Watcher');

    const priv = await hostRoom(host, { name: 'Hidden Private', mode: 'private' });
    const lan = await hostRoom(host, { name: 'Hidden Lan', mode: 'lan' });
    const local = await hostRoom(host, { name: 'Hidden Local', mode: 'local' });

    const list = await watcher.rpc<{ rooms: PublicRoomSummary[] }>('lobby:list', {});
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const ids = list.data.rooms.map((r) => r.id);
    expect(ids).not.toContain(priv.id);
    expect(ids).not.toContain(lan.id);
    expect(ids).not.toContain(local.id);

    host.close();
    watcher.close();
  });

  it('lets a private room be joined by its code', async () => {
    const host = await connect(server, 'CodeHost');
    const guest = await connect(server, 'CodeGuest');

    const room = await hostRoom(host, { mode: 'private' });
    expect(room.code.length).toBeGreaterThanOrEqual(10);

    const joined = await guest.rpc<JoinOutcome>('room:join', { target: room.code });
    expect(joined.ok).toBe(true);

    host.close();
    guest.close();
  });

  it('does not reveal the join code to non-members', async () => {
    const host = await connect(server, 'SecretHost');
    const room = await hostRoom(host, { mode: 'private' });
    // The host is a member and sees the code.
    expect(room.code).not.toBe('');

    const outsider = await connect(server, 'Outsider');
    const peek = await outsider.rpc('room:get', { roomId: room.id });
    // Not a member, so the room is not readable at all.
    expect(peek.ok).toBe(false);

    host.close();
    outsider.close();
  });
});

describe('passwords', () => {
  it('refuses a wrong password and accepts the right one', async () => {
    const host = await connect(server, 'PwHost');
    const guest = await connect(server, 'PwGuest');
    const room = await hostRoom(host, { mode: 'private' }, 'correct horse');

    const none = await guest.rpc('room:join', { target: room.code });
    expect(none.ok).toBe(false);
    if (!none.ok) expect(none.code).toBe('BAD_PASSWORD');

    const wrong = await guest.rpc('room:join', { target: room.code, password: 'nope nope' });
    expect(wrong.ok).toBe(false);
    if (!wrong.ok) expect(wrong.code).toBe('BAD_PASSWORD');

    const right = await guest.rpc<JoinOutcome>('room:join', { target: room.code, password: 'correct horse' });
    expect(right.ok).toBe(true);

    host.close();
    guest.close();
  });

  it('marks the room as password protected without exposing the password', async () => {
    const host = await connect(server, 'PwMeta');
    const room = await hostRoom(host, { mode: 'public' }, 'hunter22');
    expect(room.settings.passwordProtected).toBe(true);
    expect(JSON.stringify(room)).not.toContain('hunter22');
    host.close();
  });
});

describe('host approval', () => {
  it('queues a joiner and admits them when the host accepts', async () => {
    const host = await connect(server, 'GateHost');
    const guest = await connect(server, 'GateGuest');
    const room = await hostRoom(host, { mode: 'private', requireApproval: true });

    const requestPromise = host.next<{ request: { id: string } }>('room:joinRequest');
    const attempt = await guest.rpc<JoinOutcome>('room:join', { target: room.code });
    expect(attempt.ok).toBe(true);
    if (!attempt.ok) return;
    expect(attempt.data.status).toBe('pending');

    const request = await requestPromise;
    const resolved = guest.next<{ accepted: boolean }>('room:joinResolved');
    const approve = await host.rpc('room:respondJoin', {
      roomId: room.id,
      requestId: request.request.id,
      accept: true,
    });
    expect(approve.ok).toBe(true);
    expect((await resolved).accepted).toBe(true);

    host.close();
    guest.close();
  });

  it('tells a declined joiner they were turned away', async () => {
    const host = await connect(server, 'DenyHost');
    const guest = await connect(server, 'DenyGuest');
    const room = await hostRoom(host, { mode: 'private', requireApproval: true });

    const requestPromise = host.next<{ request: { id: string } }>('room:joinRequest');
    await guest.rpc('room:join', { target: room.code });
    const request = await requestPromise;

    const resolved = guest.next<{ accepted: boolean }>('room:joinResolved');
    await host.rpc('room:respondJoin', { roomId: room.id, requestId: request.request.id, accept: false });
    expect((await resolved).accepted).toBe(false);

    host.close();
    guest.close();
  });

  it('refuses to let a non-host answer a join request', async () => {
    const host = await connect(server, 'OwnerHost');
    const guest = await connect(server, 'OwnerGuest');
    const other = await connect(server, 'Meddler');
    const room = await hostRoom(host, { mode: 'private', requireApproval: true });

    // The meddler gets in first, before approval matters for them.
    const requestA = host.next<{ request: { id: string } }>('room:joinRequest');
    await other.rpc('room:join', { target: room.code });
    const meddlerRequest = await requestA;
    await host.rpc('room:respondJoin', { roomId: room.id, requestId: meddlerRequest.request.id, accept: true });

    const requestB = host.next<{ request: { id: string } }>('room:joinRequest');
    await guest.rpc('room:join', { target: room.code });
    const guestRequest = await requestB;

    const attempt = await other.rpc('room:respondJoin', {
      roomId: room.id,
      requestId: guestRequest.request.id,
      accept: true,
    });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('FORBIDDEN');

    host.close();
    guest.close();
    other.close();
  });
});

describe('spectators', () => {
  it('admits a spectator and withholds the legal-move map', async () => {
    const host = await connect(server, 'SpecHost');
    const player = await connect(server, 'SpecPlayer');
    const watcher = await connect(server, 'SpecWatcher');

    const room = await hostRoom(host, { hostColor: 'white' });
    await player.rpc('room:join', { target: room.id });
    const joined = await watcher.rpc<JoinOutcome>('room:join', { target: room.id, asSpectator: true });
    expect(joined.ok).toBe(true);
    if (!joined.ok || joined.data.status !== 'joined') throw new Error('expected join');

    expect(joined.data.room.you.role).toBe('spectator');
    expect(joined.data.room.you.seat).toBeNull();
    expect(joined.data.room.game.legalMoves).toBeNull();

    host.close();
    player.close();
    watcher.close();
  });

  it('refuses spectators when the host has turned them off', async () => {
    const host = await connect(server, 'NoSpecHost');
    const watcher = await connect(server, 'NoSpecWatcher');
    const room = await hostRoom(host, { allowSpectators: false });

    const attempt = await watcher.rpc('room:join', { target: room.id, asSpectator: true });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('SPECTATORS_DISABLED');

    host.close();
    watcher.close();
  });

  it('enforces the spectator limit', async () => {
    const host = await connect(server, 'LimitHost');
    const room = await hostRoom(host, { maxSpectators: 1, hostRole: 'play' });

    const first = await connect(server, 'Watcher1');
    const second = await connect(server, 'Watcher2');

    const a = await first.rpc('room:join', { target: room.id, asSpectator: true });
    expect(a.ok).toBe(true);

    const b = await second.rpc('room:join', { target: room.id, asSpectator: true });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.code).toBe('SPECTATORS_FULL');

    host.close();
    first.close();
    second.close();
  });

  it('hides the move list from spectators when the host disables it', async () => {
    const host = await connect(server, 'HideHost');
    const player = await connect(server, 'HidePlayer');
    const watcher = await connect(server, 'HideWatcher');

    const room = await hostRoom(host, { hostColor: 'white', spectatorsSeeMoveHistory: false });
    await player.rpc('room:join', { target: room.id });
    await watcher.rpc('room:join', { target: room.id, asSpectator: true });
    await host.rpc('game:start', { roomId: room.id });
    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });

    const view = await watcher.rpc<{ room: RoomView }>('room:get', { roomId: room.id });
    expect(view.ok).toBe(true);
    if (!view.ok) return;
    expect(view.data.room.you.can.seeMoveHistory).toBe(false);
    expect(view.data.room.game.moves).toHaveLength(0);
    expect(view.data.room.game.pgn).toBe('');

    host.close();
    player.close();
    watcher.close();
  });
});

describe('moderation', () => {
  it('kicks a member and lets them back in afterwards', async () => {
    const host = await connect(server, 'KickHost');
    const target = await connect(server, 'KickTarget');
    const room = await hostRoom(host, { hostColor: 'white' });
    await target.rpc('room:join', { target: room.id });

    const removed = target.next<{ reason: string }>('room:removed');
    const kick = await host.rpc('room:kick', { roomId: room.id, memberId: target.identity.userId });
    expect(kick.ok).toBe(true);
    expect((await removed).reason).toBe('kicked');

    const rejoin = await target.rpc('room:join', { target: room.id });
    expect(rejoin.ok).toBe(true);

    host.close();
    target.close();
  });

  it('bans a member and keeps them out', async () => {
    const host = await connect(server, 'BanHost');
    const target = await connect(server, 'BanTarget');
    const room = await hostRoom(host, { hostColor: 'white' });
    await target.rpc('room:join', { target: room.id });

    const removed = target.next<{ reason: string }>('room:removed');
    const ban = await host.rpc('room:ban', { roomId: room.id, memberId: target.identity.userId });
    expect(ban.ok).toBe(true);
    expect((await removed).reason).toBe('banned');

    const rejoin = await target.rpc('room:join', { target: room.id });
    expect(rejoin.ok).toBe(false);
    if (!rejoin.ok) expect(rejoin.code).toBe('BANNED');

    // Unbanning restores access.
    const unban = await host.rpc('room:unban', { roomId: room.id, memberId: target.identity.userId });
    expect(unban.ok).toBe(true);
    const after = await target.rpc('room:join', { target: room.id });
    expect(after.ok).toBe(true);

    host.close();
    target.close();
  });

  it('refuses moderation from an ordinary member', async () => {
    const host = await connect(server, 'PlainHost');
    const a = await connect(server, 'PlainA');
    const b = await connect(server, 'PlainB');
    const room = await hostRoom(host, { hostRole: 'moderate' });

    await a.rpc('room:join', { target: room.id });
    await b.rpc('room:join', { target: room.id });

    const attempt = await a.rpc('room:kick', { roomId: room.id, memberId: b.identity.userId });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('FORBIDDEN');

    host.close();
    a.close();
    b.close();
  });

  it('will not let a moderator act on the host', async () => {
    const host = await connect(server, 'ProtHost');
    const mod = await connect(server, 'ProtMod');
    const room = await hostRoom(host, { hostRole: 'moderate' });
    await mod.rpc('room:join', { target: room.id });

    await host.rpc('room:setModerator', { roomId: room.id, memberId: mod.identity.userId, isModerator: true });
    const attempt = await mod.rpc('room:kick', { roomId: room.id, memberId: host.identity.userId });
    expect(attempt.ok).toBe(false);

    host.close();
    mod.close();
  });

  it('mutes a member so their chat is rejected', async () => {
    const host = await connect(server, 'MuteHost');
    const target = await connect(server, 'MuteTarget');
    const room = await hostRoom(host, { hostColor: 'white' });
    await target.rpc('room:join', { target: room.id });

    const ok = await target.rpc('chat:send', { roomId: room.id, text: 'hello' });
    expect(ok.ok).toBe(true);

    await host.rpc('room:mute', { roomId: room.id, memberId: target.identity.userId, muted: true });
    const blocked = await target.rpc('chat:send', { roomId: room.id, text: 'still here' });
    expect(blocked.ok).toBe(false);
    if (!blocked.ok) expect(blocked.code).toBe('MUTED');

    host.close();
    target.close();
  });

  it('locks the room against new joiners', async () => {
    const host = await connect(server, 'LockHost');
    const late = await connect(server, 'LockLate');
    const room = await hostRoom(host, { hostColor: 'white' });

    await host.rpc('room:lock', { roomId: room.id, locked: true });
    const attempt = await late.rpc('room:join', { target: room.id });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('ROOM_LOCKED');

    await host.rpc('room:lock', { roomId: room.id, locked: false });
    expect((await late.rpc('room:join', { target: room.id })).ok).toBe(true);

    host.close();
    late.close();
  });

  it('transfers the host role', async () => {
    const host = await connect(server, 'GiveHost');
    const heir = await connect(server, 'Heir');
    const room = await hostRoom(host, { hostColor: 'white' });
    await heir.rpc('room:join', { target: room.id });

    const transfer = await host.rpc<{ room: RoomView }>('room:transferHost', {
      roomId: room.id,
      memberId: heir.identity.userId,
    });
    expect(transfer.ok).toBe(true);

    const heirView = await waitFor(heir, (r) => r.you.isHost);
    expect(heirView.you.isHost).toBe(true);
    const oldHostView = await waitFor(host, (r) => !r.you.isHost);
    expect(oldHostView.you.isHost).toBe(false);

    host.close();
    heir.close();
  });
});

describe('settings enforcement', () => {
  it('lets the host change presentation settings mid-game but not the rules', async () => {
    const host = await connect(server, 'SetHost');
    const guest = await connect(server, 'SetGuest');
    const room = await hostRoom(host, { hostColor: 'white' });
    await guest.rpc('room:join', { target: room.id });
    await host.rpc('game:start', { roomId: room.id });
    await host.rpc('game:move', { roomId: room.id, from: 'e2', to: 'e4' });

    const allowed = await host.rpc<{ room: RoomView }>('room:updateSettings', {
      roomId: room.id,
      patch: { name: 'Renamed Mid Game' },
    });
    expect(allowed.ok).toBe(true);
    if (allowed.ok) expect(allowed.data.room.settings.name).toBe('Renamed Mid Game');

    const frozen = await host.rpc('room:updateSettings', {
      roomId: room.id,
      patch: { timeControl: { initialSeconds: 60, incrementSeconds: 0 } },
    });
    expect(frozen.ok).toBe(false);
    if (!frozen.ok) expect(frozen.code).toBe('SETTINGS_LOCKED');

    // And the actual clock was not touched.
    const view = await host.rpc<{ room: RoomView }>('room:get', { roomId: room.id });
    if (view.ok) expect(view.data.room.settings.timeControl.initialSeconds).toBe(600);

    host.close();
    guest.close();
  });

  it('refuses settings changes from anyone but the host', async () => {
    const host = await connect(server, 'OnlyHost');
    const guest = await connect(server, 'NotHost');
    const room = await hostRoom(host, { hostColor: 'white' });
    await guest.rpc('room:join', { target: room.id });

    const attempt = await guest.rpc('room:updateSettings', { roomId: room.id, patch: { name: 'Mine now' } });
    expect(attempt.ok).toBe(false);

    host.close();
    guest.close();
  });

  it('never allows the room mode to be changed', async () => {
    const host = await connect(server, 'ModeHost');
    const room = await hostRoom(host, { mode: 'private' });
    const attempt = await host.rpc<{ room: RoomView }>('room:updateSettings', {
      roomId: room.id,
      patch: { mode: 'public' },
    });
    // The patch is accepted but the mode key is ignored.
    if (attempt.ok) expect(attempt.data.room.settings.mode).toBe('private');
    host.close();
  });
});

describe('room capacity', () => {
  it('turns a third joiner into a spectator rather than refusing them', async () => {
    const host = await connect(server, 'FullHost');
    const second = await connect(server, 'FullSecond');
    const third = await connect(server, 'FullThird');

    const room = await hostRoom(host, { hostColor: 'white' });
    await second.rpc('room:join', { target: room.id });

    const joined = await third.rpc<JoinOutcome>('room:join', { target: room.id });
    expect(joined.ok).toBe(true);
    if (!joined.ok || joined.data.status !== 'joined') throw new Error('expected join');
    expect(joined.data.room.you.role).toBe('spectator');

    host.close();
    second.close();
    third.close();
  });

  it('refuses the third joiner outright when spectators are off', async () => {
    const host = await connect(server, 'HardFullHost');
    const second = await connect(server, 'HardFullSecond');
    const third = await connect(server, 'HardFullThird');

    const room = await hostRoom(host, { hostColor: 'white', allowSpectators: false });
    await second.rpc('room:join', { target: room.id });

    const joined = await third.rpc('room:join', { target: room.id });
    expect(joined.ok).toBe(false);
    if (!joined.ok) expect(joined.code).toBe('ROOM_FULL');

    host.close();
    second.close();
    third.close();
  });
});

describe('rating range', () => {
  it('keeps out a player outside the host range', async () => {
    const host = await connect(server, 'RangeHost');
    const guest = await connect(server, 'RangeGuest');
    // A brand-new guest is rated 1200, so a 2000+ room must refuse them.
    const room = await hostRoom(host, {
      mode: 'public',
      hostColor: 'white',
      ratingRangeEnabled: true,
      ratingMin: 2000,
      ratingMax: 2400,
      allowSpectators: false,
    });

    const attempt = await guest.rpc('room:join', { target: room.id });
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) expect(attempt.code).toBe('RATING_OUT_OF_RANGE');

    host.close();
    guest.close();
  });
});
