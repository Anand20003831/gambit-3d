import type { ErrorCode } from './constants.js';
import type {
  ChatMessage,
  ClockState,
  GameOverInfo,
  IdentityGrant,
  LanInfo,
  MemberRole,
  PendingJoinRequest,
  PublicRoomSummary,
  RecordedMove,
  RoomView,
  Seat,
} from './types.js';

/**
 * The complete wire contract. Both sides import these interfaces so a typo in
 * an event name or payload is a compile error rather than a silent no-op.
 */

// --- Envelopes --------------------------------------------------------------

export interface Ok<T> {
  ok: true;
  data: T;
}

export interface Err {
  ok: false;
  code: ErrorCode;
  message: string;
  /** Field-level detail for validation failures. */
  details?: Record<string, string[]>;
  /** For RATE_LIMITED: milliseconds until the caller may retry. */
  retryAfterMs?: number;
}

export type Result<T> = Ok<T> | Err;

export function ok<T>(data: T): Ok<T> {
  return { ok: true, data };
}

export function err(code: ErrorCode, message: string, extra?: Omit<Err, 'ok' | 'code' | 'message'>): Err {
  return { ok: false, code, message, ...extra };
}

export function isOk<T>(r: Result<T>): r is Ok<T> {
  return r.ok;
}

// --- Server -> client -------------------------------------------------------

export interface JoinOutcomeJoined {
  status: 'joined';
  room: RoomView;
}

export interface JoinOutcomePending {
  status: 'pending';
  roomId: string;
  roomName: string;
  requestId: string;
}

export type JoinOutcome = JoinOutcomeJoined | JoinOutcomePending;

export interface ServerToClientEvents {
  /** Full authoritative snapshot, redacted per-viewer. Sent on every state change. */
  'room:state': (room: RoomView) => void;
  /** The viewer was removed from the room. */
  'room:removed': (payload: { roomId: string; reason: 'kicked' | 'banned' | 'closed' | 'left' | 'rejected'; message: string }) => void;
  /** A new join request arrived (host/moderators only). */
  'room:joinRequest': (payload: { roomId: string; request: PendingJoinRequest }) => void;
  /** Result of this viewer's own pending join request. */
  'room:joinResolved': (payload: { roomId: string; accepted: boolean; room?: RoomView; message: string }) => void;

  /** A move was accepted by the server. */
  'game:moved': (payload: { roomId: string; move: RecordedMove; fen: string; clock: ClockState | null }) => void;
  'game:started': (payload: { roomId: string; startedAt: number }) => void;
  'game:over': (payload: { roomId: string; result: GameOverInfo }) => void;
  /** Periodic authoritative clock reconciliation. */
  'clock:sync': (payload: { roomId: string; clock: ClockState; serverTime: number }) => void;

  'chat:message': (message: ChatMessage) => void;
  /** Transient toast-style notice (someone joined, offer declined, etc). */
  'notice': (payload: { roomId?: string; level: 'info' | 'warn' | 'error'; text: string }) => void;

  /** Public room browser push updates. */
  'lobby:rooms': (rooms: PublicRoomSummary[]) => void;
}

// --- Client -> server -------------------------------------------------------

export interface ClientToServerEvents {
  'identify': (payload: unknown, cb: Cb<IdentityGrant>) => void;
  'lan:info': (payload: unknown, cb: Cb<LanInfo>) => void;

  'room:create': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:join': (payload: unknown, cb: Cb<JoinOutcome>) => void;
  'room:leave': (payload: unknown, cb: Cb<{ left: true }>) => void;
  'room:get': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:updateSettings': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:lock': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:respondJoin': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:kick': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:ban': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:unban': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:mute': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:transferHost': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:setModerator': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'room:setSeat': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;

  'lobby:list': (payload: unknown, cb: Cb<{ rooms: PublicRoomSummary[] }>) => void;
  'lobby:subscribe': (payload: unknown, cb: Cb<{ subscribed: boolean }>) => void;

  'game:start': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'game:abort': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'game:move': (payload: unknown, cb: Cb<{ room: RoomView; move: RecordedMove }>) => void;
  'game:resign': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'game:offer': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'game:respondOffer': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;
  'game:claimDraw': (payload: unknown, cb: Cb<{ room: RoomView }>) => void;

  'chat:send': (payload: unknown, cb: Cb<{ message: ChatMessage }>) => void;
}

export type Cb<T> = (result: Result<T>) => void;

export interface InterServerEvents {
  ping: () => void;
}

export interface SocketData {
  userId: string;
  name: string;
  /** Room ids this socket is currently a member of. */
  rooms: Set<string>;
  ip: string;
}

// --- Helpers shared by both sides ------------------------------------------

export interface SeatAssignment {
  seat: Seat;
  memberId: string;
}

export function otherSeat(seat: Seat): Seat {
  return seat === 'w' ? 'b' : 'w';
}

export function roleLabel(role: MemberRole, isHost: boolean, isModerator: boolean): string {
  const base = role === 'player' ? 'Player' : 'Spectator';
  if (isHost) return `${base} · Host`;
  if (isModerator) return `${base} · Moderator`;
  return base;
}
