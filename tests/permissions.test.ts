import { describe, expect, it } from 'vitest';
import {
  DEFAULT_ROOM_SETTINGS,
  canActOn,
  canSeeLegalMoves,
  computeCapabilities,
  mutableSettingKeys,
  sanitizeChat,
  sanitizeName,
  displayNameSchema,
  chatTextSchema,
  roomSettingsInputSchema,
  moveRequestSchema,
  type PermissionContext,
  type PermissionSubject,
  type RoomSettings,
} from '@gambit3d/shared';

/**
 * The permission matrix is the single place that decides who may do what, and
 * the server re-checks it before every action. These tests are the contract.
 */

function subject(overrides: Partial<PermissionSubject> = {}): PermissionSubject {
  return { role: 'player', seat: 'w', isHost: false, isModerator: false, muted: false, ...overrides };
}

function context(overrides: Partial<PermissionContext> = {}): PermissionContext {
  return {
    settings: DEFAULT_ROOM_SETTINGS,
    phase: 'active',
    locked: false,
    seatsFull: true,
    movesPlayed: true,
    isTheirTurn: true,
    localGame: false,
    spectatorCount: 0,
    ...overrides,
  };
}

function withSettings(overrides: Partial<RoomSettings>): RoomSettings {
  return { ...DEFAULT_ROOM_SETTINGS, ...overrides };
}

describe('moving', () => {
  it('lets a seated player move on their turn', () => {
    expect(computeCapabilities(subject(), context()).move).toBe(true);
  });

  it('refuses when it is not their turn', () => {
    expect(computeCapabilities(subject(), context({ isTheirTurn: false })).move).toBe(false);
  });

  it('refuses a spectator', () => {
    const caps = computeCapabilities(subject({ role: 'spectator', seat: null }), context());
    expect(caps.move).toBe(false);
  });

  it('refuses before the game starts and after it ends', () => {
    expect(computeCapabilities(subject(), context({ phase: 'ready' })).move).toBe(false);
    expect(computeCapabilities(subject(), context({ phase: 'finished' })).move).toBe(false);
  });

  it('gives the legal-move map only to the side to move', () => {
    expect(canSeeLegalMoves(subject(), context())).toBe(true);
    expect(canSeeLegalMoves(subject(), context({ isTheirTurn: false }))).toBe(false);
    expect(canSeeLegalMoves(subject({ role: 'spectator', seat: null }), context())).toBe(false);
  });
});

describe('chat', () => {
  it('routes seated players to the player channel and spectators to theirs', () => {
    const player = computeCapabilities(subject(), context());
    expect(player.chatAsPlayer).toBe(true);
    expect(player.chatAsSpectator).toBe(false);

    const watcher = computeCapabilities(subject({ role: 'spectator', seat: null }), context());
    expect(watcher.chatAsPlayer).toBe(false);
    expect(watcher.chatAsSpectator).toBe(true);
  });

  it('honours the host disabling each channel', () => {
    expect(
      computeCapabilities(subject(), context({ settings: withSettings({ playerChat: false }) })).chatAsPlayer,
    ).toBe(false);
    expect(
      computeCapabilities(
        subject({ role: 'spectator', seat: null }),
        context({ settings: withSettings({ spectatorChat: false }) }),
      ).chatAsSpectator,
    ).toBe(false);
  });

  it('silences a muted member on both channels', () => {
    const muted = computeCapabilities(subject({ muted: true }), context());
    expect(muted.chatAsPlayer).toBe(false);
    const mutedWatcher = computeCapabilities(
      subject({ role: 'spectator', seat: null, muted: true }),
      context(),
    );
    expect(mutedWatcher.chatAsSpectator).toBe(false);
  });
});

describe('offers', () => {
  it('gates draw offers, takebacks and rematches on the host settings', () => {
    expect(computeCapabilities(subject(), context({ settings: withSettings({ allowDrawOffers: false }) })).offerDraw).toBe(false);
    expect(
      computeCapabilities(subject(), context({ settings: withSettings({ allowTakebacks: false }) })).requestTakeback,
    ).toBe(false);
    expect(
      computeCapabilities(subject(), context({ phase: 'finished', settings: withSettings({ allowRematch: false }) }))
        .offerRematch,
    ).toBe(false);
  });

  it('only offers a takeback once a move has been played', () => {
    expect(computeCapabilities(subject(), context({ movesPlayed: false })).requestTakeback).toBe(false);
  });

  it('only offers a rematch after the game has finished', () => {
    expect(computeCapabilities(subject(), context()).offerRematch).toBe(false);
    expect(computeCapabilities(subject(), context({ phase: 'finished' })).offerRematch).toBe(true);
  });
});

describe('move history visibility', () => {
  it('always shows the move list to seated players and staff', () => {
    const hidden = withSettings({ spectatorsSeeMoveHistory: false });
    expect(computeCapabilities(subject(), context({ settings: hidden })).seeMoveHistory).toBe(true);
    expect(
      computeCapabilities(subject({ role: 'spectator', seat: null, isModerator: true }), context({ settings: hidden }))
        .seeMoveHistory,
    ).toBe(true);
  });

  it('hides it from plain spectators when the host says so', () => {
    const hidden = withSettings({ spectatorsSeeMoveHistory: false });
    expect(
      computeCapabilities(subject({ role: 'spectator', seat: null }), context({ settings: hidden })).seeMoveHistory,
    ).toBe(false);
  });
});

describe('seats', () => {
  it('lets a spectator claim a free seat before the game', () => {
    const caps = computeCapabilities(
      subject({ role: 'spectator', seat: null }),
      context({ phase: 'waiting', seatsFull: false }),
    );
    expect(caps.takeSeat).toBe(true);
  });

  it('refuses once the game is under way, the room is locked, or seats are full', () => {
    const watcher = subject({ role: 'spectator', seat: null });
    expect(computeCapabilities(watcher, context({ phase: 'active', seatsFull: false })).takeSeat).toBe(false);
    expect(computeCapabilities(watcher, context({ phase: 'waiting', seatsFull: false, locked: true })).takeSeat).toBe(false);
    expect(computeCapabilities(watcher, context({ phase: 'waiting', seatsFull: true })).takeSeat).toBe(false);
  });
});

describe('moderation', () => {
  it('gives staff the moderation tools and withholds them from everyone else', () => {
    const plain = computeCapabilities(subject(), context());
    expect(plain.kick).toBe(false);
    expect(plain.ban).toBe(false);
    expect(plain.manageSettings).toBe(false);

    const mod = computeCapabilities(subject({ isModerator: true }), context());
    expect(mod.kick).toBe(true);
    expect(mod.ban).toBe(true);
    // Only the host may edit settings or hand over the room.
    expect(mod.manageSettings).toBe(false);
    expect(mod.transferHost).toBe(false);

    const host = computeCapabilities(subject({ isHost: true }), context());
    expect(host.manageSettings).toBe(true);
    expect(host.transferHost).toBe(true);
  });

  it('only surfaces the approval queue when approval is switched on', () => {
    expect(computeCapabilities(subject({ isHost: true }), context()).approveJoins).toBe(false);
    expect(
      computeCapabilities(subject({ isHost: true }), context({ settings: withSettings({ requireApproval: true }) }))
        .approveJoins,
    ).toBe(true);
  });

  it('refuses to let anyone act on themselves', () => {
    const host = { ...subject({ isHost: true }), id: 'a' };
    expect(canActOn(host, host)).toBe(false);
  });

  it('protects the host from moderators, and moderators from each other', () => {
    const host = { ...subject({ isHost: true }), id: 'host' };
    const mod = { ...subject({ isModerator: true }), id: 'mod' };
    const otherMod = { ...subject({ isModerator: true }), id: 'mod2' };
    const player = { ...subject(), id: 'player' };

    expect(canActOn(mod, host)).toBe(false);
    expect(canActOn(mod, otherMod)).toBe(false);
    expect(canActOn(host, otherMod)).toBe(true);
    expect(canActOn(mod, player)).toBe(true);
    expect(canActOn(player, mod)).toBe(false);
  });
});

describe('starting and aborting', () => {
  it('only lets the host start, and only with both seats filled', () => {
    expect(computeCapabilities(subject({ isHost: true }), context({ phase: 'ready' })).startGame).toBe(true);
    expect(
      computeCapabilities(subject({ isHost: true }), context({ phase: 'ready', seatsFull: false })).startGame,
    ).toBe(false);
    expect(computeCapabilities(subject(), context({ phase: 'ready' })).startGame).toBe(false);
  });

  it('only allows an abort before either side has committed a move', () => {
    expect(computeCapabilities(subject(), context({ movesPlayed: false })).abortGame).toBe(true);
    expect(computeCapabilities(subject(), context({ movesPlayed: true })).abortGame).toBe(false);
  });
});

describe('settings freeze', () => {
  it('allows everything before the first move', () => {
    const keys = mutableSettingKeys('waiting', false);
    expect(keys.has('timeControl')).toBe(true);
    expect(keys.has('rated')).toBe(true);
    expect(keys.has('allowTakebacks')).toBe(true);
  });

  it('freezes the rules of the match once a move has been played', () => {
    const keys = mutableSettingKeys('active', true);
    for (const frozen of ['timeControl', 'rated', 'allowTakebacks', 'allowDrawOffers', 'allowPremoves', 'allowGuests'] as const) {
      expect(keys.has(frozen), `${frozen} must be frozen`).toBe(false);
    }
    // Presentation and access can still change.
    for (const editable of ['name', 'allowSpectators', 'spectatorChat', 'playerChat', 'maxSpectators'] as const) {
      expect(keys.has(editable), `${editable} should stay editable`).toBe(true);
    }
  });

  it('never allows the room mode to change', () => {
    expect(mutableSettingKeys('waiting', false).has('mode' as never)).toBe(false);
  });
});

describe('input sanitisation', () => {
  it('strips control characters and bidi overrides from names', () => {
    expect(sanitizeName('Al‮ice')).toBe('Alice');
    expect(sanitizeName('  spaced   out  ')).toBe('spaced out');
    expect(sanitizeName('zero​width')).toBe('zerowidth');
  });

  it('rejects names that are too short or too long', () => {
    expect(displayNameSchema.safeParse('a').success).toBe(false);
    expect(displayNameSchema.safeParse('x'.repeat(30)).success).toBe(false);
    expect(displayNameSchema.safeParse('Alice').success).toBe(true);
  });

  it('keeps HTML as literal text rather than stripping it', () => {
    // React escapes on render; the server must not silently mangle the message.
    const parsed = chatTextSchema.safeParse('<b>hi</b> & "quotes"');
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data).toBe('<b>hi</b> & "quotes"');
  });

  it('rejects empty and oversized chat', () => {
    expect(chatTextSchema.safeParse('   ').success).toBe(false);
    expect(chatTextSchema.safeParse('x'.repeat(400)).success).toBe(false);
  });

  it('collapses runs of blank lines in chat', () => {
    expect(sanitizeChat('a\n\n\n\n\nb')).toBe('a\n\nb');
  });
});

describe('request validation', () => {
  it('rejects malformed squares', () => {
    expect(moveRequestSchema.safeParse({ roomId: 'abcdef', from: 'e2', to: 'e4' }).success).toBe(true);
    expect(moveRequestSchema.safeParse({ roomId: 'abcdef', from: 'z9', to: 'e4' }).success).toBe(false);
    expect(moveRequestSchema.safeParse({ roomId: 'abcdef', from: 'e2', to: 'e9' }).success).toBe(false);
  });

  it('rejects a promotion to king or pawn', () => {
    expect(
      moveRequestSchema.safeParse({ roomId: 'abcdef', from: 'a7', to: 'a8', promotion: 'k' }).success,
    ).toBe(false);
    expect(
      moveRequestSchema.safeParse({ roomId: 'abcdef', from: 'a7', to: 'a8', promotion: 'q' }).success,
    ).toBe(true);
  });

  it('rejects a rating range where the minimum exceeds the maximum', () => {
    const base = { ...DEFAULT_ROOM_SETTINGS, timeControl: { initialSeconds: 300, incrementSeconds: 0 } };
    delete (base as Partial<RoomSettings>).passwordProtected;
    expect(roomSettingsInputSchema.safeParse({ ...base, ratingMin: 2000, ratingMax: 1000 }).success).toBe(false);
    expect(roomSettingsInputSchema.safeParse({ ...base, ratingMin: 1000, ratingMax: 2000 }).success).toBe(true);
  });

  it('rejects a timed game with zero starting time but a non-zero increment', () => {
    const base = { ...DEFAULT_ROOM_SETTINGS };
    delete (base as Partial<RoomSettings>).passwordProtected;
    expect(
      roomSettingsInputSchema.safeParse({ ...base, timeControl: { initialSeconds: 0, incrementSeconds: 5 } }).success,
    ).toBe(false);
    expect(
      roomSettingsInputSchema.safeParse({ ...base, timeControl: { initialSeconds: 0, incrementSeconds: 0 } }).success,
    ).toBe(true);
  });

  it('caps the time control at the documented maximum', () => {
    const base = { ...DEFAULT_ROOM_SETTINGS };
    delete (base as Partial<RoomSettings>).passwordProtected;
    expect(
      roomSettingsInputSchema.safeParse({ ...base, timeControl: { initialSeconds: 999_999, incrementSeconds: 0 } })
        .success,
    ).toBe(false);
  });
});

describe('same-device games', () => {
  it('never offers premoves, because there is no opponent to premove against', () => {
    const settings = withSettings({ mode: 'local', allowPremoves: true });
    const online = computeCapabilities(subject(), context({ settings }));
    const local = computeCapabilities(subject(), context({ settings, localGame: true }));

    expect(online.usePremoves).toBe(true);
    expect(local.usePremoves).toBe(false);
  });

  it('lets the seated player move whenever the server says it is their turn', () => {
    // The server passes isTheirTurn for both colours in a local room; the
    // matrix must not add a second, contradicting seat check.
    const caps = computeCapabilities(
      subject({ seat: 'w' }),
      context({ settings: withSettings({ mode: 'local' }), localGame: true, isTheirTurn: true }),
    );
    expect(caps.move).toBe(true);
    expect(caps.resign).toBe(true);
  });

  it('treats one seated player as a full board, so nobody else can sit down', () => {
    const watcher = subject({ role: 'spectator', seat: null });
    const caps = computeCapabilities(
      watcher,
      context({ settings: withSettings({ mode: 'local' }), localGame: true, phase: 'ready', seatsFull: true }),
    );
    expect(caps.takeSeat).toBe(false);
  });

  it('shows the legal-move map to the player for whichever colour is to move', () => {
    const ctx = context({ settings: withSettings({ mode: 'local' }), localGame: true, isTheirTurn: true });
    expect(canSeeLegalMoves(subject({ seat: 'w' }), ctx)).toBe(true);
  });
});
