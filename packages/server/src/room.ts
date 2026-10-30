import {
  DEFAULT_ROOM_SETTINGS,
  LIMITS,
  applyResult,
  canActOn,
  canSeeLegalMoves,
  computeCapabilities,
  err,
  isProvisional,
  mutableSettingKeys,
  ok,
  type Capabilities,
  type Err,
  type ChatMessage,
  type GameOverInfo,
  type GamePhase,
  type GameView,
  type MemberRole,
  type MemberView,
  type MoveIntent,
  type PendingJoinRequest,
  type PendingOffer,
  type PermissionSubject,
  type PieceColor,
  type PublicRoomSummary,
  type RecordedMove,
  type Result,
  type RoomSettings,
  type RoomView,
  type Seat,
  type SelfView,
} from '@gambit3d/shared';
import type { RoomSettingsPatch } from '@gambit3d/shared';
import { ChessEngine, buildResult } from './chessEngine.js';
import { GameClock } from './clock.js';
import { config } from './env.js';
import * as db from './db.js';
import { generateId } from './security.js';

/**
 * A single game room: membership, permissions, the authoritative board and the
 * authoritative clock.
 *
 * Every mutating method re-derives the caller's capabilities from the room's
 * own state before acting. The capability flags shipped to clients are produced
 * by the same function, so the UI can never be more permissive than the server.
 */

/**
 * What the transcript says when a same-device player takes one of these
 * actions. There is no offer to accept, so the log records the outcome.
 */
const LOCAL_OFFER_MESSAGE: Record<'draw' | 'takeback' | 'rematch', string> = {
  draw: 'Both players agreed a draw.',
  takeback: 'The last move was taken back.',
  rematch: 'Rematch: a new game from the start.',
};

export interface Member {
  id: string;
  name: string;
  role: MemberRole;
  seat: Seat | null;
  isHost: boolean;
  isModerator: boolean;
  connected: boolean;
  muted: boolean;
  rating: number;
  gamesPlayed: number;
  joinedAt: number;
  disconnectedAt: number | null;
  /** Live sockets for this identity. More than one means extra tabs. */
  sockets: Set<string>;
}

export interface JoinRequestRecord extends PendingJoinRequest {
  userId: string;
  createdAt: number;
}

export interface RoomEvents {
  /** State changed; re-broadcast per-viewer snapshots. */
  onChange(room: Room): void;
  onChat(room: Room, message: ChatMessage): void;
  onMove(room: Room, move: RecordedMove): void;
  onGameStart(room: Room): void;
  onGameOver(room: Room, result: GameOverInfo): void;
  onJoinRequest(room: Room, request: JoinRequestRecord): void;
  onJoinResolved(room: Room, userId: string, accepted: boolean, message: string): void;
  onRemoved(room: Room, userId: string, reason: 'kicked' | 'banned' | 'closed' | 'left' | 'rejected', message: string): void;
  onNotice(room: Room, level: 'info' | 'warn' | 'error', text: string, onlyUserId?: string): void;
  onClosed(room: Room): void;
}

export interface RoomInit {
  id: string;
  code: string;
  settings: RoomSettings;
  passwordHash: string | null;
  hostUserId: string;
  createdAt?: number;
}

export interface UserIdentity {
  id: string;
  name: string;
  rating: number;
  gamesPlayed: number;
}

const NOOP_EVENTS: RoomEvents = {
  onChange: () => {},
  onChat: () => {},
  onMove: () => {},
  onGameStart: () => {},
  onGameOver: () => {},
  onJoinRequest: () => {},
  onJoinResolved: () => {},
  onRemoved: () => {},
  onNotice: () => {},
  onClosed: () => {},
};

export class Room {
  readonly id: string;
  readonly code: string;
  readonly createdAt: number;

  settings: RoomSettings;
  passwordHash: string | null;
  hostUserId: string;
  locked = false;
  closed = false;

  private readonly members = new Map<string, Member>();
  private readonly requests = new Map<string, JoinRequestRecord>();
  private chat: ChatMessage[] = [];

  private engine = new ChessEngine();
  private clock: GameClock;
  private phase: GamePhase = 'waiting';
  private result: GameOverInfo | null = null;
  private startedAt: number | null = null;
  private offer: PendingOffer | null = null;
  /** Rematch acceptance flips colours, tracked so the next game alternates. */
  private colorsSwapped = false;

  private lastActivityAt: number;
  private flagTimer: NodeJS.Timeout | null = null;
  private graceTimer: NodeJS.Timeout | null = null;

  events: RoomEvents = NOOP_EVENTS;

  constructor(init: RoomInit) {
    this.id = init.id;
    this.code = init.code;
    this.settings = init.settings;
    this.passwordHash = init.passwordHash;
    this.hostUserId = init.hostUserId;
    this.createdAt = init.createdAt ?? Date.now();
    this.lastActivityAt = this.createdAt;
    this.clock = new GameClock(init.settings.timeControl, this.createdAt);
  }

  // =========================================================================
  // Introspection
  // =========================================================================

  get phaseName(): GamePhase {
    return this.phase;
  }

  get memberList(): Member[] {
    return [...this.members.values()];
  }

  get connectedCount(): number {
    return this.memberList.filter((m) => m.connected).length;
  }

  get spectatorCount(): number {
    return this.memberList.filter((m) => m.role === 'spectator').length;
  }

  get seatMap(): { w: string | null; b: string | null } {
    const out: { w: string | null; b: string | null } = { w: null, b: null };
    for (const m of this.members.values()) {
      if (m.seat === 'w') out.w = m.id;
      if (m.seat === 'b') out.b = m.id;
    }
    return out;
  }

  /** Same-device play: one person at one keyboard moving for both colours. */
  get isLocalGame(): boolean {
    return this.settings.mode === 'local';
  }

  get seatsFull(): boolean {
    const s = this.seatMap;
    // A kitchen-table game is ready as soon as somebody is sitting at it;
    // there is no second person to wait for.
    if (this.isLocalGame) return s.w !== null || s.b !== null;
    return s.w !== null && s.b !== null;
  }

  /**
   * Whether a member may move the given colour. Normally that is only their
   * own seat; in a same-device game the seated player owns both sides.
   */
  private controlsSeat(m: Member, seat: Seat): boolean {
    if (m.role !== 'player' || m.seat === null) return false;
    return this.isLocalGame ? true : m.seat === seat;
  }

  get movesPlayed(): boolean {
    return this.engine.ply > 0;
  }

  get idleMs(): number {
    return Date.now() - this.lastActivityAt;
  }

  get ageMs(): number {
    return Date.now() - this.createdAt;
  }

  member(userId: string): Member | undefined {
    return this.members.get(userId);
  }

  memberBySeat(seat: Seat): Member | undefined {
    return this.memberList.find((m) => m.seat === seat);
  }

  hasMember(userId: string): boolean {
    return this.members.has(userId);
  }

  private touch(): void {
    this.lastActivityAt = Date.now();
  }

  // =========================================================================
  // Membership
  // =========================================================================

  /**
   * Adds an identity to the room, or reattaches an existing one.
   *
   * Callers are responsible for password and ban checks - those happen before
   * a join request is even queued.
   */
  admit(
    user: UserIdentity,
    desiredRole: MemberRole,
    opts: { asHost?: boolean } = {},
  ): Result<{ member: Member }> {
    const existing = this.members.get(user.id);
    if (existing) {
      existing.name = user.name;
      existing.rating = user.rating;
      existing.gamesPlayed = user.gamesPlayed;
      existing.connected = true;
      existing.disconnectedAt = null;
      this.touch();
      this.emitChange();
      return ok({ member: existing });
    }

    const asHost = opts.asHost === true;
    let role: MemberRole = desiredRole;

    if (!asHost) {
      if (this.locked) return err('ROOM_LOCKED', 'The host has locked this room.');
      if (role === 'spectator' && !this.settings.allowSpectators) {
        return err('SPECTATORS_DISABLED', 'Spectators are not allowed in this room.');
      }
      if (role === 'spectator' && this.spectatorCount >= this.settings.maxSpectators) {
        return err('SPECTATORS_FULL', 'The spectator limit for this room has been reached.');
      }
      if (role === 'player' && this.seatsFull) {
        // Fall back to spectating rather than refusing outright, when allowed.
        if (this.settings.allowSpectators && this.spectatorCount < this.settings.maxSpectators) {
          role = 'spectator';
        } else {
          return err('ROOM_FULL', 'Both seats are already taken.');
        }
      }
      if (role === 'player' && this.settings.ratingRangeEnabled) {
        if (user.rating < this.settings.ratingMin || user.rating > this.settings.ratingMax) {
          return err(
            'RATING_OUT_OF_RANGE',
            `This host is looking for players rated ${this.settings.ratingMin}-${this.settings.ratingMax}.`,
          );
        }
      }
    }

    const member: Member = {
      id: user.id,
      name: user.name,
      role,
      seat: null,
      isHost: asHost,
      isModerator: asHost,
      connected: true,
      muted: false,
      rating: user.rating,
      gamesPlayed: user.gamesPlayed,
      joinedAt: Date.now(),
      disconnectedAt: null,
      sockets: new Set(),
    };
    this.members.set(user.id, member);

    if (asHost) {
      this.assignHostSeat(member);
    } else if (role === 'player') {
      this.assignFreeSeat(member);
    }

    this.recomputePhase();
    this.touch();
    this.emitChange();
    return ok({ member });
  }

  /** Places the host according to their chosen role and colour. */
  private assignHostSeat(host: Member): void {
    if (this.settings.hostRole !== 'play') {
      host.role = 'spectator';
      host.seat = null;
      return;
    }
    host.role = 'player';
    const wanted =
      this.settings.hostColor === 'random'
        ? Math.random() < 0.5
          ? 'w'
          : 'b'
        : this.settings.hostColor === 'white'
          ? 'w'
          : 'b';
    host.seat = this.seatMap[wanted] === null ? wanted : wanted === 'w' ? 'b' : 'w';
  }

  private assignFreeSeat(member: Member): void {
    const seats = this.seatMap;
    if (seats.w === null) member.seat = 'w';
    else if (seats.b === null) member.seat = 'b';
    else {
      member.seat = null;
      member.role = 'spectator';
    }
  }

  attachSocket(userId: string, socketId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.sockets.add(socketId);
    if (!m.connected) {
      m.connected = true;
      m.disconnectedAt = null;
      this.events.onNotice(this, 'info', `${m.name} reconnected.`);
    }
    this.clearGraceTimerIfSatisfied();
    this.touch();
    this.emitChange();
  }

  detachSocket(userId: string, socketId: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    m.sockets.delete(socketId);
    if (m.sockets.size === 0) {
      m.connected = false;
      m.disconnectedAt = Date.now();
      if (this.phase === 'active' && m.seat) {
        this.events.onNotice(this, 'warn', `${m.name} disconnected. Waiting for them to return...`);
        this.scheduleAbandonmentCheck();
      } else if (m.isHost && this.phase !== 'finished') {
        // Host left before/after the game: hand the room to someone present.
        this.maybeTransferHostAutomatically();
      }
    }
    this.touch();
    this.emitChange();
  }

  /** Removes a member entirely (they left, were kicked, or were banned). */
  evict(userId: string, reason: 'kicked' | 'banned' | 'closed' | 'left' | 'rejected', message: string): void {
    const m = this.members.get(userId);
    if (!m) return;
    const wasSeated = m.seat !== null && this.phase === 'active';
    this.members.delete(userId);
    this.requests.delete(userId);

    if (wasSeated && this.phase === 'active') {
      if (this.isLocalGame) {
        // Nobody was playing against them, so nobody wins.
        this.finish(buildResult('*', 'aborted', null, Date.now()));
      } else {
        // Leaving a live game forfeits it.
        const winner: PieceColor = m.seat === 'w' ? 'b' : 'w';
        this.finish(buildResult(winner === 'w' ? '1-0' : '0-1', 'abandonment', winner, Date.now()));
      }
    }

    if (m.isHost) this.maybeTransferHostAutomatically();
    this.recomputePhase();
    this.events.onRemoved(this, userId, reason, message);
    this.touch();
    this.emitChange();
  }

  private maybeTransferHostAutomatically(): void {
    const current = this.members.get(this.hostUserId);
    if (current?.connected) return;

    // Prefer a connected seated player, then any connected member, then anyone.
    const candidates = this.memberList.filter((m) => m.id !== this.hostUserId);
    const next =
      candidates.find((m) => m.connected && m.seat !== null) ??
      candidates.find((m) => m.connected) ??
      candidates[0];

    if (!next) return;
    if (current) current.isHost = false;
    next.isHost = true;
    next.isModerator = true;
    this.hostUserId = next.id;
    this.events.onNotice(this, 'info', `${next.name} is now the host.`);
  }

  // =========================================================================
  // Join approval queue
  // =========================================================================

  queueJoinRequest(user: UserIdentity, desiredRole: MemberRole): Result<{ requestId: string }> {
    if (this.locked) return err('ROOM_LOCKED', 'The host has locked this room.');
    const existing = this.requests.get(user.id);
    if (existing) return ok({ requestId: existing.id });

    const record: JoinRequestRecord = {
      id: user.id,
      userId: user.id,
      name: user.name,
      desiredRole,
      requestedAt: Date.now(),
      createdAt: Date.now(),
      rating: user.rating,
    };
    this.requests.set(user.id, record);
    this.events.onJoinRequest(this, record);
    this.touch();
    this.emitChange();
    return ok({ requestId: record.id });
  }

  pendingRequestList(): JoinRequestRecord[] {
    this.expireStaleRequests();
    return [...this.requests.values()];
  }

  private expireStaleRequests(): void {
    const cutoff = Date.now() - LIMITS.joinRequestTtlMs;
    for (const [id, r] of this.requests) {
      if (r.createdAt < cutoff) {
        this.requests.delete(id);
        this.events.onJoinResolved(this, r.userId, false, 'Your request to join timed out.');
      }
    }
  }

  resolveJoinRequest(
    actorId: string,
    requestId: string,
    accept: boolean,
    asSpectator: boolean | undefined,
    lookup: (userId: string) => UserIdentity | null,
  ): Result<{ admitted: boolean }> {
    const denied = this.deny(actorId, 'approveJoins');
    if (denied) return denied;

    const record = this.requests.get(requestId);
    if (!record) return err('NOT_FOUND', 'That join request is no longer pending.');
    this.requests.delete(requestId);

    if (!accept) {
      this.events.onJoinResolved(this, record.userId, false, 'The host declined your request to join.');
      this.emitChange();
      return ok({ admitted: false });
    }

    const identity = lookup(record.userId) ?? {
      id: record.userId,
      name: record.name,
      rating: record.rating,
      gamesPlayed: 0,
    };
    const role: MemberRole = asSpectator ? 'spectator' : record.desiredRole;
    const admitted = this.admit(identity, role);
    if (!admitted.ok) {
      this.events.onJoinResolved(this, record.userId, false, admitted.message);
      return admitted;
    }
    this.events.onJoinResolved(this, record.userId, true, 'You were admitted to the room.');
    this.emitChange();
    return ok({ admitted: true });
  }

  // =========================================================================
  // Seats
  // =========================================================================

  setSeat(actorId: string, seat: Seat | null): Result<{ seat: Seat | null }> {
    const m = this.members.get(actorId);
    if (!m) return err('FORBIDDEN', 'You are not in this room.');

    if (seat === null) {
      if (this.phase === 'active') {
        return err('FORBIDDEN', 'You cannot leave your seat during a game. Resign instead.');
      }
      m.seat = null;
      m.role = 'spectator';
      this.recomputePhase();
      this.touch();
      this.emitChange();
      return ok({ seat: null });
    }

    const caps = this.capabilitiesFor(actorId);
    if (!caps.takeSeat && m.seat !== seat) {
      if (this.phase === 'active' || this.phase === 'finished') {
        return err('GAME_ALREADY_ACTIVE', 'Seats are locked once the game has started.');
      }
      if (this.locked) return err('ROOM_LOCKED', 'The host has locked this room.');
      return err('FORBIDDEN', 'You cannot take a seat right now.');
    }

    const occupant = this.memberBySeat(seat);
    if (occupant && occupant.id !== actorId) {
      return err('ROOM_FULL', 'That seat is already taken.');
    }

    if (
      this.settings.ratingRangeEnabled &&
      (m.rating < this.settings.ratingMin || m.rating > this.settings.ratingMax)
    ) {
      return err(
        'RATING_OUT_OF_RANGE',
        `This host is looking for players rated ${this.settings.ratingMin}-${this.settings.ratingMax}.`,
      );
    }

    m.seat = seat;
    m.role = 'player';
    this.recomputePhase();
    this.touch();
    this.emitChange();
    return ok({ seat });
  }

  // =========================================================================
  // Game lifecycle
  // =========================================================================

  private recomputePhase(): void {
    if (this.phase === 'active' || this.phase === 'finished') return;
    this.phase = this.seatsFull ? 'ready' : 'waiting';
  }

  startGame(actorId: string): Result<{ started: true }> {
    const denied = this.deny(actorId, 'startGame');
    if (denied) return denied;
    return this.beginGame();
  }

  private beginGame(): Result<{ started: true }> {
    if (this.phase === 'active') return err('GAME_ALREADY_ACTIVE', 'The game is already in progress.');
    if (!this.seatsFull) return err('ROOM_FULL', 'Both seats must be filled before starting.');

    const now = Date.now();
    this.phase = 'active';
    this.result = null;
    this.startedAt = now;
    this.offer = null;
    this.clock.reset(now);
    this.clock.start('w', now);
    if (this.settings.lockOnStart) this.locked = true;

    this.armFlagTimer();
    this.events.onGameStart(this);
    this.systemMessage('The game has started. White to move.');
    this.touch();
    this.emitChange();
    return ok({ started: true });
  }

  /**
   * Starts a same-device game as soon as the room exists.
   *
   * There is nobody to wait for, so making the host press Start first would
   * only be a step whose answer is always yes.
   */
  autoStartLocalGame(): void {
    if (!this.isLocalGame || this.phase !== 'ready') return;
    this.beginGame();
  }

  abortGame(actorId: string): Result<{ aborted: true }> {
    const denied = this.deny(actorId, 'abortGame');
    if (denied) return denied;
    this.finish(buildResult('*', 'aborted', null, Date.now()));
    return ok({ aborted: true });
  }

  move(actorId: string, intent: MoveIntent, expectedPly?: number): Result<{ move: RecordedMove }> {
    const m = this.members.get(actorId);
    if (!m) return err('FORBIDDEN', 'You are not in this room.');
    if (this.phase !== 'active') return err('GAME_NOT_ACTIVE', 'The game is not currently in progress.');
    if (!m.seat) return err('FORBIDDEN', 'Only seated players may move.');
    if (!this.controlsSeat(m, this.engine.turn)) return err('NOT_YOUR_TURN', 'It is not your turn.');

    if (this.isLocalGame) {
      // The same-device player owns both colours, so the useful check is
      // whether they picked up the side that is actually to move.
      const piece = this.engine.pieceAt(intent.from);
      if (piece && piece.color !== this.engine.turn) {
        const side = this.engine.turn === 'w' ? 'White' : 'Black';
        return err('NOT_YOUR_TURN', `It is ${side} to move.`);
      }
    }

    if (expectedPly !== undefined && expectedPly !== this.engine.ply) {
      return err('BAD_REQUEST', 'Your board was out of date. It has been refreshed.');
    }

    const now = Date.now();

    // A flag that fell while this move was in flight takes precedence.
    if (this.settleFlag(now)) {
      return err('GAME_NOT_ACTIVE', 'The game ended on time.');
    }

    if (!intent.promotion && this.engine.isPromotion(intent.from, intent.to)) {
      return err('BAD_REQUEST', 'That move promotes a pawn - choose a piece to promote to.');
    }

    const mover = this.engine.turn;
    const spentMs = this.clock.commitMove(mover, now);
    const clockAfter = this.clock.peek(now);

    const record = this.engine.applyMove(intent, {
      at: now,
      spentMs,
      clockAfter: this.clock.isUntimed ? null : { w: clockAfter.w, b: clockAfter.b },
    });

    if (!record) {
      // Roll the clock back: the move never happened.
      this.clock.revertMove(mover, spentMs, true, now);
      return err('ILLEGAL_MOVE', 'That move is not legal.');
    }

    // Any pending offer is cancelled by a move.
    this.offer = null;

    this.events.onMove(this, record);

    const over = this.engine.detectGameOver(now);
    if (over) {
      this.finish(over);
    } else {
      this.clock.start(this.engine.turn, now);
      this.armFlagTimer();
      this.emitChange();
    }

    this.touch();
    return ok({ move: record });
  }

  resign(actorId: string): Result<{ resigned: true }> {
    const denied = this.deny(actorId, 'resign');
    if (denied) return denied;
    const m = this.members.get(actorId)!;
    // In a same-device game one player holds both seats, so the side that
    // resigns is whichever one is to move.
    const loser: Seat = this.isLocalGame ? this.engine.turn : (m.seat as Seat);
    const winner: PieceColor = loser === 'w' ? 'b' : 'w';
    this.finish(buildResult(winner === 'w' ? '1-0' : '0-1', 'resignation', winner, Date.now()));
    return ok({ resigned: true });
  }

  claimDraw(actorId: string, claim: 'threefold' | 'fifty_move'): Result<{ claimed: true }> {
    const m = this.members.get(actorId);
    if (!m?.seat) return err('FORBIDDEN', 'Only seated players may claim a draw.');
    if (this.phase !== 'active') return err('GAME_NOT_ACTIVE', 'The game is not currently in progress.');
    // The rules give the claim to the side to move.
    if (!this.controlsSeat(m, this.engine.turn)) {
      return err('NOT_YOUR_TURN', 'Only the side to move may claim a draw.');
    }

    if (claim === 'threefold') {
      if (!this.engine.canClaimThreefold()) {
        return err('BAD_REQUEST', 'This position has not occurred three times.');
      }
      this.finish(buildResult('1/2-1/2', 'threefold_repetition', null, Date.now()));
    } else {
      if (!this.engine.canClaimFiftyMove()) {
        return err('BAD_REQUEST', 'Fifty moves have not passed without a capture or pawn move.');
      }
      this.finish(buildResult('1/2-1/2', 'fifty_move_rule', null, Date.now()));
    }
    return ok({ claimed: true });
  }

  // =========================================================================
  // Offers: draw, takeback, rematch
  // =========================================================================

  makeOffer(actorId: string, kind: 'draw' | 'takeback' | 'rematch'): Result<{ offer: PendingOffer }> {
    const m = this.members.get(actorId);
    if (!m?.seat) return err('FORBIDDEN', 'Only seated players may do that.');

    const caps = this.capabilitiesFor(actorId);
    if (kind === 'draw' && !caps.offerDraw) {
      return this.settings.allowDrawOffers
        ? err('GAME_NOT_ACTIVE', 'The game is not currently in progress.')
        : err('FEATURE_DISABLED', 'The host has disabled draw offers in this room.');
    }
    if (kind === 'takeback' && !caps.requestTakeback) {
      if (!this.settings.allowTakebacks) {
        return err('FEATURE_DISABLED', 'The host has disabled takebacks in this room.');
      }
      if (!this.movesPlayed) return err('BAD_REQUEST', 'There is no move to take back yet.');
      return err('GAME_NOT_ACTIVE', 'The game is not currently in progress.');
    }
    if (kind === 'rematch' && !caps.offerRematch) {
      return this.settings.allowRematch
        ? err('GAME_NOT_ACTIVE', 'A rematch can only be offered once the game has finished.')
        : err('FEATURE_DISABLED', 'The host has disabled rematches in this room.');
    }

    /**
     * Nobody to negotiate with. A draw, takeback or rematch in a same-device
     * game is something the two people at the keyboard have already agreed
     * between themselves, so it takes effect at once rather than hanging as
     * an offer addressed to the person who made it.
     */
    if (this.isLocalGame) {
      const applied = this.acceptOffer(actorId, kind);
      if (!applied.ok) return applied;
      this.systemMessage(LOCAL_OFFER_MESSAGE[kind]);
      this.touch();
      this.emitChange();
      return applied;
    }

    this.expireOffer();
    if (this.offer) {
      if (this.offer.from === actorId && this.offer.kind === kind) {
        return err('OFFER_EXISTS', 'Your offer is already pending.');
      }
      // Symmetrical offers resolve immediately: both sides asked for the same thing.
      if (this.offer.kind === kind && this.offer.from !== actorId) {
        return this.acceptOffer(actorId, kind);
      }
      return err('OFFER_EXISTS', 'Another offer is already pending. Respond to it first.');
    }

    const now = Date.now();
    const offer: PendingOffer = {
      kind,
      from: actorId,
      fromSeat: m.seat,
      createdAt: now,
      expiresAt: now + LIMITS.offerTtlMs,
      ...(kind === 'takeback' ? { plies: this.takebackPlies(m.seat) } : {}),
    };
    this.offer = offer;
    this.systemMessage(`${m.name} offered a ${kind === 'takeback' ? 'takeback' : kind}.`);
    this.touch();
    this.emitChange();
    return ok({ offer });
  }

  /**
   * How many half-moves a takeback should undo so the requester gets their own
   * last move back: 1 if they just moved, 2 if the opponent has since replied.
   */
  private takebackPlies(requester: Seat): number {
    const history = this.engine.moves;
    if (history.length === 0) return 0;
    // One player, one board: take back the move that was just made.
    if (this.isLocalGame) return 1;
    const last = history.at(-1)!;
    return last.color === requester ? 1 : 2;
  }

  respondToOffer(actorId: string, kind: 'draw' | 'takeback' | 'rematch', accept: boolean): Result<{ resolved: true }> {
    this.expireOffer();
    const offer = this.offer;
    if (!offer || offer.kind !== kind) return err('NO_SUCH_OFFER', 'There is no pending offer to respond to.');

    const m = this.members.get(actorId);
    if (!m?.seat) return err('FORBIDDEN', 'Only seated players may respond to offers.');
    if (offer.from === actorId) return err('BAD_REQUEST', 'You cannot respond to your own offer.');

    if (!accept) {
      this.offer = null;
      this.systemMessage(`${m.name} declined the ${kind}.`);
      this.touch();
      this.emitChange();
      return ok({ resolved: true });
    }

    const result = this.acceptOffer(actorId, kind);
    if (!result.ok) return result;
    return ok({ resolved: true });
  }

  private acceptOffer(accepterId: string, kind: 'draw' | 'takeback' | 'rematch'): Result<{ offer: PendingOffer }> {
    const offer = this.offer;
    const now = Date.now();
    this.offer = null;

    switch (kind) {
      case 'draw': {
        this.finish(buildResult('1/2-1/2', 'draw_agreement', null, now));
        return ok({ offer: offer ?? emptyOffer(kind, accepterId, now) });
      }
      case 'takeback': {
        const plies = offer?.plies ?? 1;
        if (plies <= 0 || plies > this.engine.ply) {
          return err('BAD_REQUEST', 'There is nothing to take back.');
        }
        this.applyTakeback(plies, now);
        this.systemMessage('The takeback was accepted.');
        this.touch();
        this.emitChange();
        return ok({ offer: offer ?? emptyOffer(kind, accepterId, now) });
      }
      case 'rematch': {
        const started = this.startRematch(now);
        if (!started.ok) return started;
        return ok({ offer: offer ?? emptyOffer(kind, accepterId, now) });
      }
      default:
        return err('BAD_REQUEST', 'Unknown offer type.');
    }
  }

  /** Undoes `plies` half-moves and restores the clock as it was beforehand. */
  private applyTakeback(plies: number, now: number): void {
    const undone: RecordedMove[] = [];
    for (let i = 0; i < plies; i += 1) {
      const last = this.engine.moves.at(-1);
      if (!last) break;
      if (!this.engine.undo(1)) break;
      undone.push(last);
    }
    // Give back the time each undone move consumed, and remove its increment.
    for (const move of undone) {
      this.clock.revertMove(move.color, move.spentMs, true, now);
    }
    this.clock.start(this.engine.turn, now);
    this.armFlagTimer();
  }

  private startRematch(now: number): Result<{ started: true }> {
    if (!this.settings.allowRematch) {
      return err('FEATURE_DISABLED', 'The host has disabled rematches in this room.');
    }
    const white = this.memberBySeat('w');
    const black = this.memberBySeat('b');

    if (this.isLocalGame) {
      // One player holds the board, so there are no colours to swap.
      if (!white && !black) return err('ROOM_FULL', 'Somebody has to be sitting at the board.');
    } else {
      if (!white || !black) return err('ROOM_FULL', 'Both seats must be filled for a rematch.');
      // Swap colours so a rematch is fair.
      white.seat = 'b';
      black.seat = 'w';
      this.colorsSwapped = !this.colorsSwapped;
    }

    this.engine = new ChessEngine();
    this.clock = new GameClock(this.settings.timeControl, now);
    this.result = null;
    this.phase = 'ready';
    this.locked = this.settings.lockOnStart ? false : this.locked;
    this.systemMessage(
      this.isLocalGame ? 'Rematch: a new game from the start.' : 'Rematch: colours have been swapped.',
    );
    return this.beginGame();
  }

  private expireOffer(now = Date.now()): void {
    if (this.offer && this.offer.expiresAt <= now) {
      this.offer = null;
    }
  }

  // =========================================================================
  // Clock enforcement
  // =========================================================================

  private armFlagTimer(): void {
    this.clearFlagTimer();
    if (this.phase !== 'active' || this.clock.isUntimed) return;
    const ms = this.clock.msUntilFlag();
    if (!Number.isFinite(ms)) return;
    this.flagTimer = setTimeout(() => {
      this.flagTimer = null;
      this.settleFlag(Date.now());
    }, Math.max(20, ms + 15));
    this.flagTimer.unref?.();
  }

  private clearFlagTimer(): void {
    if (this.flagTimer) clearTimeout(this.flagTimer);
    this.flagTimer = null;
  }

  /**
   * Ends the game if a flag has fallen.
   *
   * A flag fall is a draw rather than a loss when the opponent has no material
   * with which they could ever mate.
   *
   * @returns true when the game was ended by this call.
   */
  settleFlag(now = Date.now()): boolean {
    if (this.phase !== 'active') return false;
    const flagged = this.clock.flagged(now);
    if (!flagged) return false;

    const opponent: PieceColor = flagged === 'w' ? 'b' : 'w';
    if (!this.engine.hasMatingMaterial(opponent)) {
      this.finish(buildResult('1/2-1/2', 'timeout_vs_insufficient_material', null, now));
    } else {
      this.finish(buildResult(opponent === 'w' ? '1-0' : '0-1', 'timeout', opponent, now));
    }
    return true;
  }

  /** Called periodically by the room manager. */
  tick(now = Date.now()): void {
    this.expireOffer(now);
    this.expireStaleRequests();
    if (this.phase === 'active') {
      this.settleFlag(now);
      this.checkAbandonment(now);
    }
  }

  private scheduleAbandonmentCheck(): void {
    if (this.graceTimer) return;
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      this.checkAbandonment(Date.now());
    }, config.disconnectGraceMs + 250);
    this.graceTimer.unref?.();
  }

  private clearGraceTimerIfSatisfied(): void {
    const anyoneMissing = this.memberList.some((m) => m.seat && !m.connected);
    if (!anyoneMissing && this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /**
   * Forfeits a seated player who has been gone longer than the grace period,
   * but only when their opponent is present to receive the win.
   */
  private checkAbandonment(now: number): void {
    if (this.phase !== 'active') return;
    for (const m of this.memberList) {
      if (!m.seat || m.connected || m.disconnectedAt === null) continue;
      if (now - m.disconnectedAt < config.disconnectGraceMs) continue;

      const opponent = this.memberBySeat(m.seat === 'w' ? 'b' : 'w');
      if (!opponent?.connected) continue; // Nobody is around to claim the win.

      const winner: PieceColor = m.seat === 'w' ? 'b' : 'w';
      this.finish(buildResult(winner === 'w' ? '1-0' : '0-1', 'abandonment', winner, now));
      return;
    }
  }

  // =========================================================================
  // Finishing
  // =========================================================================

  private finish(result: GameOverInfo): void {
    if (this.phase === 'finished') return;
    this.clearFlagTimer();
    this.clock.pause(result.endedAt);
    this.phase = 'finished';
    this.offer = null;

    const rated = this.applyRatings(result);
    this.result = rated;

    if (this.settings.lockOnStart) this.locked = false;

    this.persistGame(rated);
    this.systemMessage(rated.message);
    this.events.onGameOver(this, rated);
    this.touch();
    this.emitChange();
  }

  /**
   * Updates Elo when the game was rated, both seats were filled by distinct
   * identities, and the game was not aborted before any move was played.
   */
  private applyRatings(result: GameOverInfo): GameOverInfo {
    if (!this.settings.rated) return result;
    if (result.reason === 'aborted' || !this.movesPlayed) return result;

    const white = this.memberBySeat('w');
    const black = this.memberBySeat('b');
    if (!white || !black || white.id === black.id) return result;

    const score = result.result === '1-0' ? 1 : result.result === '0-1' ? 0 : 0.5;
    const outcome = applyResult(
      { rating: white.rating, gamesPlayed: white.gamesPlayed },
      { rating: black.rating, gamesPlayed: black.gamesPlayed },
      score as 0 | 0.5 | 1,
    );

    const whiteBefore = white.rating;
    const blackBefore = black.rating;

    white.rating = outcome.whiteAfter;
    black.rating = outcome.blackAfter;
    white.gamesPlayed += 1;
    black.gamesPlayed += 1;

    try {
      db.updateRating(white.id, white.rating, white.gamesPlayed);
      db.updateRating(black.id, black.rating, black.gamesPlayed);
    } catch (error) {
      console.error('[room] failed to persist ratings', error);
    }

    return {
      ...result,
      ratingChange: {
        w: outcome.whiteDelta,
        b: outcome.blackDelta,
        wAfter: outcome.whiteAfter,
        bAfter: outcome.blackAfter,
      },
      // Keep the pre-game ratings visible in the message for clarity.
      message: `${result.message} (${whiteBefore}->${outcome.whiteAfter} / ${blackBefore}->${outcome.blackAfter})`,
    };
  }

  private persistGame(result: GameOverInfo): void {
    if (!this.movesPlayed) return;
    try {
      db.recordGame({
        id: generateId('g_'),
        room_id: this.id,
        white_user_id: this.seatMap.w,
        black_user_id: this.seatMap.b,
        result: result.result,
        reason: result.reason,
        pgn: this.engine.pgn(),
        final_fen: this.engine.fen,
        rated: this.settings.rated ? 1 : 0,
        white_rating_before: result.ratingChange ? result.ratingChange.wAfter - result.ratingChange.w : null,
        black_rating_before: result.ratingChange ? result.ratingChange.bAfter - result.ratingChange.b : null,
        white_rating_after: result.ratingChange?.wAfter ?? null,
        black_rating_after: result.ratingChange?.bAfter ?? null,
        started_at: this.startedAt,
        ended_at: result.endedAt,
      });
    } catch (error) {
      console.error('[room] failed to persist game', error);
    }
  }

  // =========================================================================
  // Moderation
  // =========================================================================

  /** Returns an error to propagate, or null when the caller holds the capability. */
  private deny(actorId: string, cap: keyof Capabilities): Err | null {
    if (!this.members.has(actorId)) return err('FORBIDDEN', 'You are not in this room.');
    if (!this.capabilitiesFor(actorId)[cap]) {
      return err('FORBIDDEN', 'You do not have permission to do that.');
    }
    return null;
  }

  private requireActOn(actorId: string, targetId: string): Result<{ target: Member }> {
    const actor = this.members.get(actorId);
    const target = this.members.get(targetId);
    if (!actor) return err('FORBIDDEN', 'You are not in this room.');
    if (!target) return err('NOT_FOUND', 'That person is no longer in the room.');
    if (!canActOn(subjectOf(actor, actor.id), subjectOf(target, target.id))) {
      return err('FORBIDDEN', 'You do not have permission to do that.');
    }
    return ok({ target });
  }

  kick(actorId: string, targetId: string): Result<{ kicked: true }> {
    const denied = this.deny(actorId, 'kick');
    if (denied) return denied;
    const target = this.requireActOn(actorId, targetId);
    if (!target.ok) return target;

    this.evict(targetId, 'kicked', 'You were removed from the room by a moderator.');
    this.systemMessage(`${target.data.target.name} was removed from the room.`);
    return ok({ kicked: true });
  }

  ban(actorId: string, targetId: string): Result<{ banned: true }> {
    const denied = this.deny(actorId, 'ban');
    if (denied) return denied;
    const target = this.requireActOn(actorId, targetId);
    if (!target.ok) return target;

    db.addBan(this.id, targetId, target.data.target.name);
    this.evict(targetId, 'banned', 'You have been banned from this room.');
    this.systemMessage(`${target.data.target.name} was banned from the room.`);
    return ok({ banned: true });
  }

  unban(actorId: string, targetId: string): Result<{ unbanned: true }> {
    const denied = this.deny(actorId, 'ban');
    if (denied) return denied;
    db.removeBan(this.id, targetId);
    this.touch();
    this.emitChange();
    return ok({ unbanned: true });
  }

  setMuted(actorId: string, targetId: string, muted: boolean): Result<{ muted: boolean }> {
    const denied = this.deny(actorId, 'mute');
    if (denied) return denied;
    const target = this.requireActOn(actorId, targetId);
    if (!target.ok) return target;

    target.data.target.muted = muted;
    this.systemMessage(`${target.data.target.name} was ${muted ? 'muted' : 'unmuted'}.`);
    this.touch();
    this.emitChange();
    return ok({ muted });
  }

  transferHost(actorId: string, targetId: string): Result<{ hostId: string }> {
    const denied = this.deny(actorId, 'transferHost');
    if (denied) return denied;
    const actor = this.members.get(actorId)!;
    const target = this.members.get(targetId);
    if (!target) return err('NOT_FOUND', 'That person is no longer in the room.');
    if (target.id === actor.id) return err('BAD_REQUEST', 'You are already the host.');

    actor.isHost = false;
    target.isHost = true;
    target.isModerator = true;
    this.hostUserId = target.id;
    this.systemMessage(`${target.name} is now the host.`);
    this.touch();
    this.emitChange();
    return ok({ hostId: target.id });
  }

  setModerator(actorId: string, targetId: string, isModerator: boolean): Result<{ isModerator: boolean }> {
    const actor = this.members.get(actorId);
    if (!actor?.isHost) return err('FORBIDDEN', 'Only the host can change moderators.');
    const target = this.members.get(targetId);
    if (!target) return err('NOT_FOUND', 'That person is no longer in the room.');
    if (target.isHost) return err('BAD_REQUEST', 'The host is always a moderator.');

    target.isModerator = isModerator;
    this.systemMessage(`${target.name} is ${isModerator ? 'now' : 'no longer'} a moderator.`);
    this.touch();
    this.emitChange();
    return ok({ isModerator });
  }

  setLocked(actorId: string, locked: boolean): Result<{ locked: boolean }> {
    const denied = this.deny(actorId, 'lockRoom');
    if (denied) return denied;
    this.locked = locked;
    this.systemMessage(locked ? 'The room is now locked.' : 'The room is now unlocked.');
    this.touch();
    this.emitChange();
    return ok({ locked });
  }

  // =========================================================================
  // Settings
  // =========================================================================

  updateSettings(actorId: string, patch: RoomSettingsPatch): Result<{ settings: RoomSettings }> {
    const denied = this.deny(actorId, 'manageSettings');
    if (denied) return denied;

    const allowed = mutableSettingKeys(this.phase, this.movesPlayed);
    const rejected: string[] = [];
    const next: RoomSettings = { ...this.settings };

    for (const [rawKey, value] of Object.entries(patch)) {
      if (value === undefined) continue;
      const key = rawKey as keyof RoomSettings;
      if (key === 'mode') {
        rejected.push('mode');
        continue;
      }
      if (!allowed.has(key)) {
        rejected.push(rawKey);
        continue;
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (next as any)[key] = value;
    }

    if (rejected.length > 0 && Object.keys(patch).length === rejected.length) {
      return err('SETTINGS_LOCKED', `These cannot be changed now: ${rejected.join(', ')}.`);
    }

    // Shrinking the spectator cap evicts the most recent spectators.
    if (next.maxSpectators < this.spectatorCount) {
      const spectators = this.memberList
        .filter((m) => m.role === 'spectator' && !m.isHost)
        .sort((a, b) => b.joinedAt - a.joinedAt);
      const excess = this.spectatorCount - next.maxSpectators;
      for (const s of spectators.slice(0, excess)) {
        this.evict(s.id, 'kicked', 'The host reduced the spectator limit.');
      }
    }
    if (!next.allowSpectators) {
      for (const s of this.memberList.filter((m) => m.role === 'spectator' && !m.isHost)) {
        this.evict(s.id, 'kicked', 'The host disabled spectators for this room.');
      }
    }

    // Changing the time control before the game starts rebuilds the clock.
    if (
      this.phase !== 'active' &&
      this.phase !== 'finished' &&
      (next.timeControl.initialSeconds !== this.settings.timeControl.initialSeconds ||
        next.timeControl.incrementSeconds !== this.settings.timeControl.incrementSeconds)
    ) {
      this.clock = new GameClock(next.timeControl);
    }

    this.settings = next;
    if (rejected.length > 0) {
      this.events.onNotice(this, 'warn', `Ignored locked settings: ${rejected.join(', ')}.`, actorId);
    }
    this.touch();
    this.emitChange();
    return ok({ settings: next });
  }

  // =========================================================================
  // Chat
  // =========================================================================

  postChat(actorId: string, text: string): Result<{ message: ChatMessage }> {
    const m = this.members.get(actorId);
    if (!m) return err('FORBIDDEN', 'You are not in this room.');
    if (m.muted) return err('MUTED', 'You have been muted in this room.');

    const caps = this.capabilitiesFor(actorId);
    const channel: 'player' | 'spectator' = m.seat ? 'player' : 'spectator';
    if (channel === 'player' && !caps.chatAsPlayer) {
      return err('FEATURE_DISABLED', 'Player chat is disabled in this room.');
    }
    if (channel === 'spectator' && !caps.chatAsSpectator) {
      return err('FEATURE_DISABLED', 'Spectator chat is disabled in this room.');
    }

    const message: ChatMessage = {
      id: generateId('c_'),
      roomId: this.id,
      authorId: m.id,
      authorName: m.name,
      channel,
      text,
      at: Date.now(),
    };
    this.pushChat(message);
    this.events.onChat(this, message);
    this.touch();
    return ok({ message });
  }

  systemMessage(text: string): void {
    const message: ChatMessage = {
      id: generateId('c_'),
      roomId: this.id,
      authorId: 'system',
      authorName: 'System',
      channel: 'system',
      text,
      at: Date.now(),
    };
    this.pushChat(message);
    this.events.onChat(this, message);
  }

  private pushChat(message: ChatMessage): void {
    this.chat.push(message);
    if (this.chat.length > LIMITS.chatHistory) {
      this.chat = this.chat.slice(-LIMITS.chatHistory);
    }
  }

  // =========================================================================
  // Views
  // =========================================================================

  private permissionContext(userId: string) {
    const m = this.members.get(userId);
    return {
      settings: this.settings,
      phase: this.phase,
      locked: this.locked,
      seatsFull: this.seatsFull,
      movesPlayed: this.movesPlayed,
      localGame: this.isLocalGame,
      // The same-device player is always the side to move, because they are
      // playing both sides.
      isTheirTurn: m?.seat ? this.controlsSeat(m, this.engine.turn) : false,
      spectatorCount: this.spectatorCount,
    };
  }

  capabilitiesFor(userId: string): Capabilities {
    const m = this.members.get(userId);
    if (!m) {
      return computeCapabilities(
        { role: 'spectator', seat: null, isHost: false, isModerator: false, muted: true },
        this.permissionContext(userId),
      );
    }
    return computeCapabilities(subjectOf(m, m.id), this.permissionContext(userId));
  }

  gameView(userId: string): GameView {
    const m = this.members.get(userId);
    const caps = this.capabilitiesFor(userId);
    const subject: PermissionSubject = m
      ? subjectOf(m, m.id)
      : { role: 'spectator', seat: null, isHost: false, isModerator: false, muted: true };

    const showLegal = canSeeLegalMoves(subject, this.permissionContext(userId));
    const seeHistory = caps.seeMoveHistory;

    return {
      phase: this.phase,
      fen: this.engine.fen,
      turn: this.engine.turn,
      moves: seeHistory ? [...this.engine.moves] : [],
      pgn: seeHistory ? this.engine.pgn() : '',
      clock: this.clock.state(),
      inCheck: this.engine.inCheck,
      lastMove: this.engine.lastMove,
      legalMoves: showLegal ? this.engine.legalMoveMap() : null,
      result: this.result,
      startedAt: this.startedAt,
      claimable: {
        threefold: this.phase === 'active' && this.engine.canClaimThreefold(),
        fiftyMove: this.phase === 'active' && this.engine.canClaimFiftyMove(),
      },
      halfmoveClock: this.engine.halfmoveClock,
    };
  }

  viewFor(userId: string): RoomView {
    const m = this.members.get(userId);
    const caps = this.capabilitiesFor(userId);
    const staff = m?.isHost === true || m?.isModerator === true;

    const self: SelfView = {
      id: userId,
      name: m?.name ?? 'Observer',
      role: m?.role ?? 'spectator',
      seat: m?.seat ?? null,
      isHost: m?.isHost ?? false,
      isModerator: m?.isModerator ?? false,
      muted: m?.muted ?? false,
      rating: m?.rating ?? 0,
      can: caps,
    };

    const visibleChat = this.chat.filter((c) => {
      if (c.channel === 'system') return true;
      if (c.channel === 'player') return self.seat !== null || staff || this.settings.spectatorsSeeMoveHistory;
      return true; // spectator channel is visible to everyone in the room
    });

    return {
      id: this.id,
      // The code is the join secret for private rooms, so only members see it.
      code: m ? this.code : '',
      settings: this.settings,
      createdAt: this.createdAt,
      hostId: this.hostUserId,
      locked: this.locked,
      members: this.memberList.map(toMemberView),
      seats: this.seatMap,
      game: this.gameView(userId),
      pendingRequests: staff ? this.pendingRequestList().map(toRequestView) : [],
      pendingOffer: this.offer,
      bans: staff ? db.listBans(this.id).map((b) => ({ id: b.user_id, name: b.name, at: b.created_at })) : [],
      spectatorCount: this.spectatorCount,
      chat: visibleChat,
      you: self,
    };
  }

  summary(): PublicRoomSummary {
    const host = this.members.get(this.hostUserId);
    const seats = this.seatMap;
    return {
      id: this.id,
      code: this.code,
      name: this.settings.name,
      hostName: host?.name ?? 'Host',
      hostRating: host?.rating ?? 0,
      timeControl: this.settings.timeControl,
      rated: this.settings.rated,
      casualOnly: this.settings.casualOnly,
      ratingRangeEnabled: this.settings.ratingRangeEnabled,
      ratingMin: this.settings.ratingMin,
      ratingMax: this.settings.ratingMax,
      passwordProtected: this.passwordHash !== null,
      requireApproval: this.settings.requireApproval,
      allowSpectators: this.settings.allowSpectators,
      spectatorCount: this.spectatorCount,
      seatsOpen: (seats.w === null ? 1 : 0) + (seats.b === null ? 1 : 0),
      phase: this.phase,
      theme: this.settings.theme,
      createdAt: this.createdAt,
      locked: this.locked,
    };
  }

  private emitChange(): void {
    if (!this.closed) this.events.onChange(this);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearFlagTimer();
    if (this.graceTimer) clearTimeout(this.graceTimer);
    this.graceTimer = null;
    this.events.onClosed(this);
  }

  /** Test/diagnostic hook: the raw engine. */
  get board(): ChessEngine {
    return this.engine;
  }

  /** Test/diagnostic hook: the raw clock. */
  get gameClock(): GameClock {
    return this.clock;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function subjectOf(m: Member, id: string): PermissionSubject & { id: string } {
  return {
    id,
    role: m.role,
    seat: m.seat,
    isHost: m.isHost,
    isModerator: m.isModerator,
    muted: m.muted,
  };
}

function toMemberView(m: Member): MemberView {
  return {
    id: m.id,
    name: m.name,
    role: m.role,
    seat: m.seat,
    isHost: m.isHost,
    isModerator: m.isModerator,
    connected: m.connected,
    muted: m.muted,
    rating: m.rating,
    provisional: isProvisional(m.gamesPlayed),
    joinedAt: m.joinedAt,
    disconnectedAt: m.disconnectedAt,
  };
}

function toRequestView(r: JoinRequestRecord): PendingJoinRequest {
  return {
    id: r.id,
    name: r.name,
    desiredRole: r.desiredRole,
    requestedAt: r.requestedAt,
    rating: r.rating,
  };
}

function emptyOffer(kind: 'draw' | 'takeback' | 'rematch', from: string, now: number): PendingOffer {
  return { kind, from, fromSeat: 'w', createdAt: now, expiresAt: now };
}

export function defaultSettings(overrides: Partial<RoomSettings> = {}): RoomSettings {
  return { ...DEFAULT_ROOM_SETTINGS, ...overrides };
}
