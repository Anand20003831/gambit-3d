import { z } from 'zod';
import { LIMITS } from './constants.js';
import { THEME_IDS } from './types.js';

/**
 * Every inbound socket payload is parsed through one of these schemas before it
 * reaches any game logic. Nothing that fails validation ever mutates state.
 */

// --- Primitives -------------------------------------------------------------

export const squareSchema = z
  .string()
  .regex(/^[a-h][1-8]$/u, 'Not a board square');

export const promotionSchema = z.enum(['q', 'r', 'b', 'n']);

export const themeIdSchema = z.enum(THEME_IDS);

/**
 * Player-visible display names.
 *
 * Control characters, bidi overrides and zero-width joiners are stripped so a
 * name cannot spoof another user or break layout. The result is trimmed and
 * whitespace-collapsed, then length-checked.
 */
export const displayNameSchema = z
  .string()
  .max(200) // pre-sanitisation guard so we never regex over huge inputs
  .transform(sanitizeName)
  .pipe(
    z
      .string()
      .min(LIMITS.nameMinLength, `Name must be at least ${LIMITS.nameMinLength} characters`)
      .max(LIMITS.nameMaxLength, `Name must be at most ${LIMITS.nameMaxLength} characters`),
  );

export const roomNameSchema = z
  .string()
  .max(200)
  .transform(sanitizeName)
  .pipe(
    z
      .string()
      .min(LIMITS.roomNameMinLength)
      .max(LIMITS.roomNameMaxLength),
  );

export const chatTextSchema = z
  .string()
  .max(2000)
  .transform(sanitizeChat)
  .pipe(z.string().min(1, 'Message is empty').max(LIMITS.chatMaxLength));

export const passwordSchema = z
  .string()
  .min(LIMITS.passwordMinLength)
  .max(LIMITS.passwordMaxLength);

export const roomIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/u, 'Malformed room id');
export const roomCodeSchema = z.string().regex(/^[A-Za-z0-9_-]{4,64}$/u, 'Malformed room code');
export const memberIdSchema = z.string().regex(/^[A-Za-z0-9_-]{6,64}$/u, 'Malformed member id');
export const tokenSchema = z.string().regex(/^[A-Za-z0-9_.-]{16,512}$/u, 'Malformed token');

// --- Sanitisers -------------------------------------------------------------

/**
 * Invisible and direction-changing characters. These let text lie about who
 * wrote it (a right-to-left override can make "alice" render as "ecila") or
 * smuggle zero-width padding past a length check, so they are always removed.
 */
const INVISIBLE_AND_SPOOFING =
  '\u007F-\u009F' + // C1 control characters
  '\u200B-\u200F' + // zero-width space/non-joiner/joiner, LRM, RLM
  '\u202A-\u202E' + // bidi embedding/override
  '\u2060-\u2064' + // word joiner + invisible operators
  '\u2066-\u2069' + // bidi isolates
  '\uFEFF'; // byte-order mark

/** Names are single-line, so every C0 control including newlines goes. */
const NAME_STRIP = new RegExp(`[\u0000-\u001F${INVISIBLE_AND_SPOOFING}]`, 'gu');

/**
 * Chat keeps newlines and tabs - a multi-line message is legitimate - but
 * drops every other C0 control. Stripping \n here would silently mash a
 * multi-line message into one run-on line.
 */
const CHAT_STRIP = new RegExp(`[\u0000-\u0008\u000B\u000C\u000E-\u001F${INVISIBLE_AND_SPOOFING}]`, 'gu');

export function sanitizeName(input: string): string {
  return input.normalize('NFKC').replace(NAME_STRIP, '').replace(/\s+/gu, ' ').trim();
}

export function sanitizeChat(input: string): string {
  return (
    input
      .normalize('NFKC')
      .replace(CHAT_STRIP, '')
      // Normalise line endings so \r\n does not count as two blank lines.
      .replace(/\r\n?/gu, '\n')
      .replace(/[ \t]{3,}/gu, '  ')
      .replace(/\n{3,}/gu, '\n\n')
      .trim()
  );
}

// --- Time control -----------------------------------------------------------

export const timeControlInputSchema = z
  .object({
    initialSeconds: z.number().int().min(0).max(LIMITS.maxInitialSeconds),
    incrementSeconds: z.number().int().min(0).max(LIMITS.maxIncrementSeconds),
  })
  .refine(
    (tc) => tc.initialSeconds > 0 || (tc.initialSeconds === 0 && tc.incrementSeconds === 0),
    { message: 'A timed game needs a starting time greater than zero' },
  );

// --- Room settings ----------------------------------------------------------

/** Unrefined object form, so `.partial()` stays available for settings patches. */
export const roomSettingsShape = z.object({
  name: roomNameSchema,
  mode: z.enum(['public', 'private', 'lan', 'local']),
  hostRole: z.enum(['play', 'spectate', 'moderate']),
  hostColor: z.enum(['white', 'black', 'random']),
  timeControl: timeControlInputSchema,
  rated: z.boolean(),
  ratingRangeEnabled: z.boolean(),
  ratingMin: z.number().int().min(LIMITS.minRating).max(LIMITS.maxRating),
  ratingMax: z.number().int().min(LIMITS.minRating).max(LIMITS.maxRating),
  casualOnly: z.boolean(),
  requireApproval: z.boolean(),
  allowSpectators: z.boolean(),
  spectatorChat: z.boolean(),
  playerChat: z.boolean(),
  allowTakebacks: z.boolean(),
  allowDrawOffers: z.boolean(),
  allowRematch: z.boolean(),
  spectatorsSeeMoveHistory: z.boolean(),
  maxSpectators: z.number().int().min(LIMITS.minSpectators).max(LIMITS.maxSpectators),
  lockOnStart: z.boolean(),
  allowGuests: z.boolean(),
  allowPremoves: z.boolean(),
  theme: themeIdSchema,
});

export const roomSettingsInputSchema = roomSettingsShape.refine(
  (s) => s.ratingMin <= s.ratingMax,
  { message: 'Minimum rating must not exceed maximum rating', path: ['ratingMin'] },
);

/**
 * Settings patches are validated field-by-field; the server additionally
 * rejects any key that is frozen for the room's current phase.
 */
export const roomSettingsPatchSchema = roomSettingsShape.partial();

export type RoomSettingsInput = z.infer<typeof roomSettingsShape>;
export type RoomSettingsPatch = z.infer<typeof roomSettingsPatchSchema>;

// --- Requests ---------------------------------------------------------------

export const identifyRequestSchema = z.object({
  token: tokenSchema.optional(),
  name: displayNameSchema.optional(),
});

export const createRoomRequestSchema = z.object({
  settings: roomSettingsInputSchema,
  password: passwordSchema.optional(),
});

export const joinRoomRequestSchema = z.object({
  /** Either a room id or a shareable code. */
  target: z.string().min(4).max(64),
  password: z.string().max(LIMITS.passwordMaxLength).optional(),
  asSpectator: z.boolean().optional(),
});

export const listRoomsRequestSchema = z.object({
  search: z.string().max(60).optional(),
  rated: z.enum(['any', 'rated', 'casual']).optional(),
  timeKind: z.enum(['any', 'untimed', 'bullet', 'blitz', 'rapid', 'classical', 'custom']).optional(),
  hideFull: z.boolean().optional(),
  hidePasswordProtected: z.boolean().optional(),
  theme: z.enum(['any', ...THEME_IDS]).optional(),
});

export const moveRequestSchema = z.object({
  roomId: roomIdSchema,
  from: squareSchema,
  to: squareSchema,
  promotion: promotionSchema.optional(),
  /**
   * Ply the client believed was next. Lets the server reject a move computed
   * against a stale board instead of silently applying it somewhere else.
   */
  expectedPly: z.number().int().min(0).max(10_000).optional(),
});

export const roomActionSchema = z.object({ roomId: roomIdSchema });

export const memberActionSchema = z.object({
  roomId: roomIdSchema,
  memberId: memberIdSchema,
});

export const respondJoinSchema = z.object({
  roomId: roomIdSchema,
  requestId: memberIdSchema,
  accept: z.boolean(),
  asSpectator: z.boolean().optional(),
});

export const offerResponseSchema = z.object({
  roomId: roomIdSchema,
  kind: z.enum(['draw', 'takeback', 'rematch']),
  accept: z.boolean(),
});

export const makeOfferSchema = z.object({
  roomId: roomIdSchema,
  kind: z.enum(['draw', 'takeback', 'rematch']),
});

export const takebackRequestSchema = z.object({
  roomId: roomIdSchema,
  plies: z.number().int().min(1).max(LIMITS.maxTakebackPlies).optional(),
});

export const claimDrawSchema = z.object({
  roomId: roomIdSchema,
  claim: z.enum(['threefold', 'fifty_move']),
});

export const chatRequestSchema = z.object({
  roomId: roomIdSchema,
  text: chatTextSchema,
  channel: z.enum(['player', 'spectator']).optional(),
});

export const updateSettingsSchema = z.object({
  roomId: roomIdSchema,
  patch: roomSettingsPatchSchema,
  /** Supplying a password rotates it; supplying null clears it. */
  password: passwordSchema.nullish(),
});

export const setSeatSchema = z.object({
  roomId: roomIdSchema,
  seat: z.enum(['w', 'b']).nullable(),
});

export const setModeratorSchema = z.object({
  roomId: roomIdSchema,
  memberId: memberIdSchema,
  isModerator: z.boolean(),
});

export const lockRoomSchema = z.object({
  roomId: roomIdSchema,
  locked: z.boolean(),
});

export const muteSchema = z.object({
  roomId: roomIdSchema,
  memberId: memberIdSchema,
  muted: z.boolean(),
});

export type CreateRoomRequest = z.infer<typeof createRoomRequestSchema>;
export type JoinRoomRequest = z.infer<typeof joinRoomRequestSchema>;
export type MoveRequest = z.infer<typeof moveRequestSchema>;
export type ChatRequest = z.infer<typeof chatRequestSchema>;
export type ListRoomsRequest = z.infer<typeof listRoomsRequestSchema>;
