/**
 * Core domain types shared by the client and the authoritative server.
 * Everything here must be structurally serialisable over Socket.IO.
 */

// ---------------------------------------------------------------------------
// Chess primitives
// ---------------------------------------------------------------------------

export type PieceColor = 'w' | 'b';
export type PieceType = 'p' | 'n' | 'b' | 'r' | 'q' | 'k';
export type Square = string; // 'a1' ... 'h8' - validated at the boundary

export interface PieceOnBoard {
  square: Square;
  type: PieceType;
  color: PieceColor;
  /** Stable identity used by the renderer so a piece animates instead of popping. */
  id: string;
}

export interface MoveIntent {
  from: Square;
  to: Square;
  promotion?: Exclude<PieceType, 'p' | 'k'>;
}

export interface RecordedMove {
  /** Ply index, 0-based. */
  ply: number;
  from: Square;
  to: Square;
  /** Standard algebraic notation, e.g. "Nf3", "O-O", "exd5", "e8=Q+". */
  san: string;
  /** Long algebraic / UCI form, e.g. "g1f3", "e7e8q". */
  lan: string;
  color: PieceColor;
  piece: PieceType;
  captured?: PieceType;
  promotion?: PieceType;
  /** chess.js flag string; contains 'k'/'q' for castling, 'e' for en passant. */
  flags: string;
  /** FEN *after* the move was applied. */
  fenAfter: string;
  /** Wall-clock ms since epoch when the server accepted the move. */
  at: number;
  /** Milliseconds the mover spent on this move. */
  spentMs: number;
  /** Clock remaining for each side after the move, in ms (null when untimed). */
  clockAfter: { w: number; b: number } | null;
  isCheck: boolean;
  isCheckmate: boolean;
}

export type GameResult = '1-0' | '0-1' | '1/2-1/2' | '*';

export type GameEndReason =
  | 'checkmate'
  | 'stalemate'
  | 'insufficient_material'
  | 'threefold_repetition'
  | 'fivefold_repetition'
  | 'fifty_move_rule'
  | 'seventyfive_move_rule'
  | 'timeout'
  | 'timeout_vs_insufficient_material'
  | 'resignation'
  | 'draw_agreement'
  | 'abandonment'
  | 'aborted'
  | 'host_ended';

export interface GameOverInfo {
  result: GameResult;
  reason: GameEndReason;
  /** Winner colour, or null for a draw / abort. */
  winner: PieceColor | null;
  /** Human readable one-liner, e.g. "White wins by checkmate". */
  message: string;
  endedAt: number;
  /** Rating deltas when the game was rated and both seats were occupied. */
  ratingChange?: { w: number; b: number; wAfter: number; bAfter: number };
}

// ---------------------------------------------------------------------------
// Time control
// ---------------------------------------------------------------------------

export type TimeControlKind = 'untimed' | 'bullet' | 'blitz' | 'rapid' | 'classical' | 'custom';

export interface TimeControl {
  kind: TimeControlKind;
  /** Starting time per side in seconds. 0 = untimed. */
  initialSeconds: number;
  /** Fischer increment added after each completed move, in seconds. */
  incrementSeconds: number;
}

export interface ClockState {
  /** Remaining milliseconds. */
  w: number;
  b: number;
  /** Whose clock is currently running, or null if paused / not started. */
  running: PieceColor | null;
  /** Server timestamp (ms since epoch) the running clock was last reconciled. */
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// Rooms, membership and permissions
// ---------------------------------------------------------------------------

export type RoomMode = 'public' | 'private' | 'lan' | 'local';
export type HostRole = 'play' | 'spectate' | 'moderate';
export type ColorChoice = 'white' | 'black' | 'random';
export type ThemeId = 'apartment' | 'station';
export const THEME_IDS = ['apartment', 'station'] as const;

export type Seat = 'w' | 'b';

/** What a participant is allowed to be in the room. */
export type MemberRole = 'player' | 'spectator';

export interface RoomSettings {
  name: string;
  mode: RoomMode;
  hostRole: HostRole;
  hostColor: ColorChoice;
  timeControl: TimeControl;
  rated: boolean;
  /** Only meaningful for public rooms; restricts who may take a seat. */
  ratingRangeEnabled: boolean;
  ratingMin: number;
  ratingMax: number;
  /** Public listing only accepts casual challengers. */
  casualOnly: boolean;
  /** True when a password is set. The password itself is never sent to clients. */
  passwordProtected: boolean;
  requireApproval: boolean;
  allowSpectators: boolean;
  spectatorChat: boolean;
  playerChat: boolean;
  allowTakebacks: boolean;
  allowDrawOffers: boolean;
  allowRematch: boolean;
  spectatorsSeeMoveHistory: boolean;
  maxSpectators: number;
  lockOnStart: boolean;
  allowGuests: boolean;
  allowPremoves: boolean;
  theme: ThemeId;
}

/**
 * Settings the host may still change once the first move has been played.
 * Everything else is frozen so a host cannot bend the rules mid-match.
 */
export const MUTABLE_AFTER_START = [
  'name',
  'allowSpectators',
  'spectatorChat',
  'playerChat',
  'spectatorsSeeMoveHistory',
  'maxSpectators',
  'requireApproval',
] as const satisfies readonly (keyof RoomSettings)[];

export interface MemberView {
  id: string;
  name: string;
  role: MemberRole;
  seat: Seat | null;
  isHost: boolean;
  isModerator: boolean;
  connected: boolean;
  muted: boolean;
  /** Elo rating at the time of the last snapshot. */
  rating: number;
  /** Provisional until enough rated games have been played. */
  provisional: boolean;
  joinedAt: number;
  /** Server timestamp of disconnection, or null when connected. */
  disconnectedAt: number | null;
}

export interface PendingJoinRequest {
  id: string;
  name: string;
  desiredRole: MemberRole;
  requestedAt: number;
  rating: number;
}

export type OfferKind = 'draw' | 'takeback' | 'rematch';

export interface PendingOffer {
  kind: OfferKind;
  from: string; // member id
  fromSeat: Seat;
  createdAt: number;
  expiresAt: number;
  /** For takebacks: how many plies would be undone. */
  plies?: number;
}

export interface ChatMessage {
  id: string;
  roomId: string;
  authorId: string;
  authorName: string;
  channel: 'player' | 'spectator' | 'system';
  text: string;
  at: number;
}

export type GamePhase = 'waiting' | 'ready' | 'active' | 'finished';

export interface GameView {
  phase: GamePhase;
  fen: string;
  turn: PieceColor;
  moves: RecordedMove[];
  /** Full PGN of the game so far. */
  pgn: string;
  clock: ClockState | null;
  inCheck: boolean;
  /** Squares of the last move, for highlighting. */
  lastMove: { from: Square; to: Square } | null;
  /** Legal destination squares keyed by origin square. Null when the viewer may not see them. */
  legalMoves: Record<Square, Square[]> | null;
  result: GameOverInfo | null;
  startedAt: number | null;
  /** Draw claims currently available to the side to move. */
  claimable: { threefold: boolean; fiftyMove: boolean };
  /** Number of half-moves since the last capture or pawn advance. */
  halfmoveClock: number;
}

export interface SelfView {
  id: string;
  name: string;
  role: MemberRole;
  seat: Seat | null;
  isHost: boolean;
  isModerator: boolean;
  muted: boolean;
  rating: number;
  can: Capabilities;
}

/** Server-computed capability flags. The UI mirrors these; the server enforces them. */
export interface Capabilities {
  move: boolean;
  chatAsPlayer: boolean;
  chatAsSpectator: boolean;
  offerDraw: boolean;
  requestTakeback: boolean;
  resign: boolean;
  offerRematch: boolean;
  seeMoveHistory: boolean;
  takeSeat: boolean;
  manageSettings: boolean;
  approveJoins: boolean;
  kick: boolean;
  mute: boolean;
  ban: boolean;
  transferHost: boolean;
  lockRoom: boolean;
  startGame: boolean;
  abortGame: boolean;
  usePremoves: boolean;
}

export interface RoomView {
  id: string;
  /** Short shareable code. For private rooms this is a high-entropy secret. */
  code: string;
  settings: RoomSettings;
  createdAt: number;
  hostId: string;
  locked: boolean;
  members: MemberView[];
  seats: { w: string | null; b: string | null };
  game: GameView;
  /** Only populated for host/moderators. */
  pendingRequests: PendingJoinRequest[];
  pendingOffer: PendingOffer | null;
  /** Only populated for host/moderators. */
  bans: { id: string; name: string; at: number }[];
  spectatorCount: number;
  /** Recent chat, already filtered to channels this viewer may read. */
  chat: ChatMessage[];
  /** The viewer's own resolved identity + capability set. */
  you: SelfView;
}

// ---------------------------------------------------------------------------
// Public room browser
// ---------------------------------------------------------------------------

export interface PublicRoomSummary {
  id: string;
  code: string;
  name: string;
  hostName: string;
  hostRating: number;
  timeControl: TimeControl;
  rated: boolean;
  casualOnly: boolean;
  ratingRangeEnabled: boolean;
  ratingMin: number;
  ratingMax: number;
  passwordProtected: boolean;
  requireApproval: boolean;
  allowSpectators: boolean;
  spectatorCount: number;
  seatsOpen: number;
  phase: GamePhase;
  theme: ThemeId;
  createdAt: number;
  locked: boolean;
}

export interface RoomListFilter {
  /** Substring match against room or host name. */
  search?: string;
  rated?: 'any' | 'rated' | 'casual';
  timeKind?: TimeControlKind | 'any';
  hideFull?: boolean;
  hidePasswordProtected?: boolean;
  theme?: ThemeId | 'any';
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

export interface IdentityGrant {
  userId: string;
  name: string;
  /** Opaque bearer token, persisted client-side, used to reclaim a seat. */
  token: string;
  rating: number;
  gamesPlayed: number;
  provisional: boolean;
}

// ---------------------------------------------------------------------------
// LAN
// ---------------------------------------------------------------------------

export interface LanAddress {
  /** e.g. "192.168.1.42" */
  address: string;
  /** OS interface name, e.g. "Wi-Fi" */
  iface: string;
  family: 'IPv4' | 'IPv6';
  /** True when this address is a genuine private-network (RFC1918) address. */
  isPrivateLan: boolean;
  /** True when this is a loopback address (never advertised as the LAN address). */
  isLoopback: boolean;
}

export interface LanInfo {
  port: number;
  /** Best-guess LAN address; null when the machine has no private network address. */
  primary: LanAddress | null;
  candidates: LanAddress[];
  /** Full join URL for the primary address, or null. */
  joinUrl: string | null;
  hostname: string;
  boundHost: string;
  /** True when the server is bound to 0.0.0.0 and therefore reachable from the LAN. */
  reachableFromLan: boolean;
}
