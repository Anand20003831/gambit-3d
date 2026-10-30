import type { RoomSettings, TimeControl, TimeControlKind, ThemeId } from './types.js';

export const PROTOCOL_VERSION = 1;

export const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

// --- Limits -----------------------------------------------------------------

export const LIMITS = {
  nameMinLength: 2,
  nameMaxLength: 20,
  roomNameMinLength: 2,
  roomNameMaxLength: 40,
  passwordMinLength: 4,
  passwordMaxLength: 72,
  chatMaxLength: 300,
  chatHistory: 200,
  maxSpectators: 50,
  minSpectators: 0,
  /** Hard cap on custom time control, in seconds (3 hours). */
  maxInitialSeconds: 10800,
  maxIncrementSeconds: 180,
  /** How long an offer stays open before it self-expires. */
  offerTtlMs: 60_000,
  /** How long a join request stays queued. */
  joinRequestTtlMs: 120_000,
  /** Maximum plies a single takeback may undo. */
  maxTakebackPlies: 2,
  minRating: 100,
  maxRating: 3000,
} as const;

// --- Ratings ----------------------------------------------------------------

export const RATING = {
  initial: 1200,
  /** Games required before a rating stops being provisional. */
  provisionalGames: 10,
  /** K-factor while provisional. */
  kProvisional: 40,
  /** K-factor for established players below the elite threshold. */
  kStandard: 20,
  /** K-factor above the elite threshold. */
  kElite: 10,
  eliteThreshold: 2400,
  floor: 100,
  ceiling: 3000,
} as const;

// --- Time controls ----------------------------------------------------------

export interface TimeControlPreset {
  id: string;
  label: string;
  kind: TimeControlKind;
  initialSeconds: number;
  incrementSeconds: number;
}

export const TIME_PRESETS: readonly TimeControlPreset[] = [
  { id: 'untimed', label: 'Untimed', kind: 'untimed', initialSeconds: 0, incrementSeconds: 0 },
  { id: 'bullet-1-0', label: 'Bullet 1+0', kind: 'bullet', initialSeconds: 60, incrementSeconds: 0 },
  { id: 'bullet-1-1', label: 'Bullet 1+1', kind: 'bullet', initialSeconds: 60, incrementSeconds: 1 },
  { id: 'bullet-2-1', label: 'Bullet 2+1', kind: 'bullet', initialSeconds: 120, incrementSeconds: 1 },
  { id: 'blitz-3-0', label: 'Blitz 3+0', kind: 'blitz', initialSeconds: 180, incrementSeconds: 0 },
  { id: 'blitz-3-2', label: 'Blitz 3+2', kind: 'blitz', initialSeconds: 180, incrementSeconds: 2 },
  { id: 'blitz-5-0', label: 'Blitz 5+0', kind: 'blitz', initialSeconds: 300, incrementSeconds: 0 },
  { id: 'blitz-5-3', label: 'Blitz 5+3', kind: 'blitz', initialSeconds: 300, incrementSeconds: 3 },
  { id: 'rapid-10-0', label: 'Rapid 10+0', kind: 'rapid', initialSeconds: 600, incrementSeconds: 0 },
  { id: 'rapid-10-5', label: 'Rapid 10+5', kind: 'rapid', initialSeconds: 600, incrementSeconds: 5 },
  { id: 'rapid-15-10', label: 'Rapid 15+10', kind: 'rapid', initialSeconds: 900, incrementSeconds: 10 },
  { id: 'classical-30-20', label: 'Classical 30+20', kind: 'classical', initialSeconds: 1800, incrementSeconds: 20 },
] as const;

/**
 * Derives the canonical category for an arbitrary time control, using the same
 * bucketing convention as major chess servers (estimated duration = initial + 40*inc).
 */
export function classifyTimeControl(initialSeconds: number, incrementSeconds: number): TimeControlKind {
  if (initialSeconds <= 0 && incrementSeconds <= 0) return 'untimed';
  const estimate = initialSeconds + 40 * incrementSeconds;
  if (estimate < 179) return 'bullet';
  if (estimate < 479) return 'blitz';
  if (estimate < 1499) return 'rapid';
  return 'classical';
}

export function makeTimeControl(initialSeconds: number, incrementSeconds: number): TimeControl {
  return {
    kind: classifyTimeControl(initialSeconds, incrementSeconds),
    initialSeconds,
    incrementSeconds,
  };
}

export function formatTimeControl(tc: TimeControl): string {
  if (tc.kind === 'untimed' || tc.initialSeconds <= 0) return 'Untimed';
  const minutes = tc.initialSeconds / 60;
  const shown = Number.isInteger(minutes) ? String(minutes) : minutes.toFixed(1);
  return `${shown}+${tc.incrementSeconds}`;
}

// --- Themes -----------------------------------------------------------------

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  tagline: string;
  /** Primary accent colour, used before the 3D bundle loads. */
  accent: string;
  background: string;
}

export const THEME_META: readonly ThemeMeta[] = [
  {
    id: 'apartment',
    name: 'Neon City Apartment',
    tagline: 'A high-rise apartment, rain on the glass, the city burning below.',
    accent: '#00e5ff',
    background: '#08040f',
  },
  {
    id: 'station',
    name: 'Orbital Station',
    tagline: 'A quiet observation deck aboard a station in high orbit.',
    accent: '#a99bff',
    background: '#05061a',
  },
] as const;

// --- Defaults ---------------------------------------------------------------

export const DEFAULT_ROOM_SETTINGS: RoomSettings = {
  name: 'Chess Room',
  mode: 'public',
  hostRole: 'play',
  hostColor: 'random',
  timeControl: { kind: 'rapid', initialSeconds: 600, incrementSeconds: 5 },
  rated: false,
  ratingRangeEnabled: false,
  ratingMin: 800,
  ratingMax: 2000,
  casualOnly: false,
  passwordProtected: false,
  requireApproval: false,
  allowSpectators: true,
  spectatorChat: true,
  playerChat: true,
  allowTakebacks: true,
  allowDrawOffers: true,
  allowRematch: true,
  spectatorsSeeMoveHistory: true,
  maxSpectators: 20,
  lockOnStart: false,
  allowGuests: true,
  allowPremoves: true,
  theme: 'apartment',
};

// --- Errors -----------------------------------------------------------------

export const ERROR_CODES = [
  'BAD_REQUEST',
  'RATE_LIMITED',
  'NOT_FOUND',
  'ROOM_FULL',
  'ROOM_LOCKED',
  'SPECTATORS_DISABLED',
  'SPECTATORS_FULL',
  'BAD_PASSWORD',
  'BANNED',
  'FORBIDDEN',
  'NOT_YOUR_TURN',
  'ILLEGAL_MOVE',
  'GAME_NOT_ACTIVE',
  'GAME_ALREADY_ACTIVE',
  'AWAITING_APPROVAL',
  'REJECTED',
  'DUPLICATE_SESSION',
  'RATING_OUT_OF_RANGE',
  'GUESTS_DISABLED',
  'NO_SUCH_OFFER',
  'OFFER_EXISTS',
  'FEATURE_DISABLED',
  'SETTINGS_LOCKED',
  'MUTED',
  'INTERNAL',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_MESSAGES: Record<ErrorCode, string> = {
  BAD_REQUEST: 'That request was not understood.',
  RATE_LIMITED: 'You are doing that too quickly. Slow down a moment.',
  NOT_FOUND: 'That room no longer exists.',
  ROOM_FULL: 'Both seats are already taken.',
  ROOM_LOCKED: 'The host has locked this room.',
  SPECTATORS_DISABLED: 'Spectators are not allowed in this room.',
  SPECTATORS_FULL: 'The spectator limit for this room has been reached.',
  BAD_PASSWORD: 'That password is not correct.',
  BANNED: 'You have been banned from this room.',
  FORBIDDEN: 'You do not have permission to do that.',
  NOT_YOUR_TURN: 'It is not your turn.',
  ILLEGAL_MOVE: 'That move is not legal.',
  GAME_NOT_ACTIVE: 'The game is not currently in progress.',
  GAME_ALREADY_ACTIVE: 'The game is already in progress.',
  AWAITING_APPROVAL: 'Waiting for the host to approve your request.',
  REJECTED: 'The host declined your request to join.',
  DUPLICATE_SESSION: 'This seat is already open in another tab or device.',
  RATING_OUT_OF_RANGE: 'Your rating is outside the range this host allows.',
  GUESTS_DISABLED: 'This room does not accept guest players.',
  NO_SUCH_OFFER: 'There is no pending offer to respond to.',
  OFFER_EXISTS: 'An offer is already pending.',
  FEATURE_DISABLED: 'The host has disabled that for this room.',
  SETTINGS_LOCKED: 'That setting cannot be changed once the game has started.',
  MUTED: 'You have been muted in this room.',
  INTERNAL: 'Something went wrong on the server.',
};
