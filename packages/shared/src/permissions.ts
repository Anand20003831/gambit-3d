import { MUTABLE_AFTER_START } from './types.js';
import type { Capabilities, GamePhase, MemberRole, RoomSettings, Seat } from './types.js';

/**
 * The single source of truth for "who may do what".
 *
 * The server calls `computeCapabilities` to build the flag set it ships to each
 * viewer AND re-checks the same predicate before performing any action. The
 * client only ever *renders* these flags, so a tampered client gains nothing.
 */

export interface PermissionSubject {
  role: MemberRole;
  seat: Seat | null;
  isHost: boolean;
  isModerator: boolean;
  muted: boolean;
}

export interface PermissionContext {
  settings: RoomSettings;
  phase: GamePhase;
  locked: boolean;
  /** True when both seats are occupied. */
  seatsFull: boolean;
  /**
   * Same-device play: one person sits at the board and moves for both
   * colours. There is no second party to offer a draw to, wait for, or
   * premove against, so several capabilities behave differently.
   */
  localGame: boolean;
  /** True when at least one move has been played. */
  movesPlayed: boolean;
  /** True when it is this subject's turn. */
  isTheirTurn: boolean;
  /** Number of spectators currently in the room. */
  spectatorCount: number;
}

export function isStaff(s: PermissionSubject): boolean {
  return s.isHost || s.isModerator;
}

export function computeCapabilities(s: PermissionSubject, ctx: PermissionContext): Capabilities {
  const seated = s.seat !== null && s.role === 'player';
  const staff = isStaff(s);
  const active = ctx.phase === 'active';

  return {
    move: seated && active && ctx.isTheirTurn,

    chatAsPlayer: seated && ctx.settings.playerChat && !s.muted,
    chatAsSpectator: !seated && ctx.settings.spectatorChat && !s.muted,

    offerDraw: seated && active && ctx.settings.allowDrawOffers,
    requestTakeback: seated && active && ctx.settings.allowTakebacks && ctx.movesPlayed,
    resign: seated && active,
    offerRematch: seated && ctx.phase === 'finished' && ctx.settings.allowRematch,

    seeMoveHistory: seated || staff || ctx.settings.spectatorsSeeMoveHistory,

    // A spectator may claim an empty seat while the game has not begun and the
    // room is not locked. Staff-only rooms still respect the lock.
    takeSeat:
      !seated &&
      !ctx.locked &&
      (ctx.phase === 'waiting' || ctx.phase === 'ready') &&
      !ctx.seatsFull,

    manageSettings: s.isHost,
    approveJoins: staff && ctx.settings.requireApproval,
    kick: staff,
    mute: staff,
    ban: staff,
    transferHost: s.isHost,
    lockRoom: staff,

    startGame: s.isHost && ctx.seatsFull && (ctx.phase === 'waiting' || ctx.phase === 'ready'),
    // Aborting is only offered before either side has committed to the game.
    abortGame: (s.isHost || seated) && active && !ctx.movesPlayed,

    // Queueing a move against yourself is meaningless.
    usePremoves: seated && ctx.settings.allowPremoves && !ctx.localGame,
  };
}

/**
 * Which settings keys the host may still change.
 *
 * Once a move has been played the rules of the match are frozen: time control,
 * rated status, takeback/draw/premove availability and the guest policy can no
 * longer be edited, so a host cannot change the terms of a game in progress.
 */
export function mutableSettingKeys(phase: GamePhase, movesPlayed: boolean): ReadonlySet<keyof RoomSettings> {
  const all = new Set<keyof RoomSettings>([
    'name',
    'hostRole',
    'hostColor',
    'timeControl',
    'rated',
    'ratingRangeEnabled',
    'ratingMin',
    'ratingMax',
    'casualOnly',
    'requireApproval',
    'allowSpectators',
    'spectatorChat',
    'playerChat',
    'allowTakebacks',
    'allowDrawOffers',
    'allowRematch',
    'spectatorsSeeMoveHistory',
    'maxSpectators',
    'lockOnStart',
    'allowGuests',
    'allowPremoves',
    'theme',
  ]);

  const started = phase === 'active' || phase === 'finished' || movesPlayed;
  if (!started) {
    // `mode` is never editable after creation - it decides discoverability and
    // is baked into the room's id/code strategy.
    return all;
  }
  return new Set<keyof RoomSettings>(MUTABLE_AFTER_START);
}

/** Moderators may not act on the host, and nobody may act on themselves. */
export function canActOn(
  actor: PermissionSubject & { id: string },
  target: PermissionSubject & { id: string },
): boolean {
  if (actor.id === target.id) return false;
  if (!isStaff(actor)) return false;
  if (target.isHost) return false;
  // A plain moderator cannot discipline another moderator; only the host can.
  if (target.isModerator && !actor.isHost) return false;
  return true;
}

/** Whether a viewer is permitted to see the legal-move map for the side to move. */
export function canSeeLegalMoves(s: PermissionSubject, ctx: PermissionContext): boolean {
  return s.role === 'player' && s.seat !== null && ctx.phase === 'active' && ctx.isTheirTurn;
}
