import {
  classifyTimeControl,
  err,
  ok,
  type MemberRole,
  type PublicRoomSummary,
  type Result,
  type RoomListFilter,
  type RoomSettings,
} from '@gambit3d/shared';
import type { RoomSettingsInput } from '@gambit3d/shared';
import { config } from './env.js';
import * as db from './db.js';
import { Room, type RoomEvents, type UserIdentity } from './room.js';
import { generateJoinCode, generateRoomId, hashPassword, normalizeCode, verifyPassword } from './security.js';
import { SlidingWindowCounter } from './rateLimit.js';

/**
 * Owns the live set of rooms: creation, lookup by id or join code, the public
 * browser listing, and expiry.
 *
 * Rooms live in memory (they hold timers and an in-progress board); their
 * definition, bans and finished games are persisted so a restart does not lose
 * the durable parts.
 */
export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly byCode = new Map<string, string>();
  private readonly createCounter: SlidingWindowCounter;
  private sweepTimer: NodeJS.Timeout | null = null;

  /** Set by the socket gateway so rooms can broadcast. */
  events: RoomEvents | null = null;

  constructor() {
    this.createCounter = new SlidingWindowCounter(config.maxRoomsPerIpPerHour, 60 * 60_000);
  }

  get size(): number {
    return this.rooms.size;
  }

  list(): Room[] {
    return [...this.rooms.values()];
  }

  get(roomId: string): Room | undefined {
    return this.rooms.get(roomId);
  }

  /**
   * Resolves a user-supplied join target, which may be a room id (from a
   * shareable link) or a typed join code.
   */
  resolve(target: string): Room | undefined {
    const direct = this.rooms.get(target);
    if (direct) return direct;

    const code = normalizeCode(target);
    const id = this.byCode.get(code);
    return id ? this.rooms.get(id) : undefined;
  }

  // -------------------------------------------------------------------------
  // Creation
  // -------------------------------------------------------------------------

  async create(
    host: UserIdentity,
    input: RoomSettingsInput,
    password: string | undefined,
    ip: string,
  ): Promise<Result<{ room: Room }>> {
    if (this.rooms.size >= config.maxRooms) {
      return err('INTERNAL', 'This server is at capacity. Try again shortly.');
    }
    const quota = this.createCounter.check(ip);
    if (!quota.allowed) {
      return err('RATE_LIMITED', 'You have created too many rooms recently.', {
        retryAfterMs: quota.retryAfterMs,
      });
    }

    const settings: RoomSettings = {
      ...input,
      timeControl: {
        kind: classifyTimeControl(input.timeControl.initialSeconds, input.timeControl.incrementSeconds),
        initialSeconds: input.timeControl.initialSeconds,
        incrementSeconds: input.timeControl.incrementSeconds,
      },
      passwordProtected: Boolean(password),
    };

    // A casual-only listing cannot simultaneously be rated.
    if (settings.casualOnly) settings.rated = false;
    // Rating ranges are meaningless without a rating pool to filter.
    if (settings.mode === 'local') {
      settings.rated = false;
      settings.ratingRangeEnabled = false;
      settings.requireApproval = false;
      // One person moves for both colours, so there is no opponent to
      // premove against.
      settings.allowPremoves = false;
    }

    const id = generateRoomId();
    const code = this.allocateCode(settings.mode);
    const passwordHash = password ? await hashPassword(password) : null;

    const room = new Room({ id, code, settings, passwordHash, hostUserId: host.id });
    if (this.events) room.events = this.events;

    const admitted = room.admit(host, settings.hostRole === 'play' ? 'player' : 'spectator', { asHost: true });
    if (!admitted.ok) return admitted;

    this.rooms.set(id, room);
    this.byCode.set(code, id);
    this.persist(room);

    // Same-device play has nobody to wait for: hand the host a live board.
    room.autoStartLocalGame();

    return ok({ room });
  }

  private allocateCode(mode: RoomSettings['mode']): string {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const code = generateJoinCode(mode);
      if (!this.byCode.has(code) && !db.codeExists(code)) return code;
    }
    // Astronomically unlikely; fall back to a longer code rather than colliding.
    return generateJoinCode('private') + generateJoinCode('public');
  }

  private persist(room: Room): void {
    try {
      db.persistRoom({
        id: room.id,
        code: room.code,
        mode: room.settings.mode,
        host_user_id: room.hostUserId,
        settings_json: JSON.stringify(room.settings),
        password_hash: room.passwordHash,
        created_at: room.createdAt,
        updated_at: Date.now(),
        closed_at: null,
      });
    } catch (error) {
      console.error('[rooms] failed to persist room', error);
    }
  }

  // -------------------------------------------------------------------------
  // Joining
  // -------------------------------------------------------------------------

  /**
   * Performs every check that must happen *before* a user is either admitted
   * or queued for host approval.
   */
  async authorizeJoin(
    room: Room,
    user: UserIdentity,
    password: string | undefined,
    isGuest: boolean,
  ): Promise<Result<{ ok: true }>> {
    if (room.closed) return err('NOT_FOUND', 'That room no longer exists.');
    if (db.isBanned(room.id, user.id)) return err('BANNED', 'You have been banned from this room.');

    // Members already inside skip the gate - this is the reconnection path.
    if (room.hasMember(user.id)) return ok({ ok: true });

    if (!room.settings.allowGuests && isGuest) {
      return err('GUESTS_DISABLED', 'This room does not accept guest players.');
    }
    if (room.locked) return err('ROOM_LOCKED', 'The host has locked this room.');

    if (room.passwordHash) {
      if (!password) return err('BAD_PASSWORD', 'This room needs a password.');
      const good = await verifyPassword(password, room.passwordHash);
      if (!good) return err('BAD_PASSWORD', 'That password is not correct.');
    }

    return ok({ ok: true });
  }

  /** Decides whether a join goes straight in or into the approval queue. */
  needsApproval(room: Room, user: UserIdentity): boolean {
    if (!room.settings.requireApproval) return false;
    if (room.hasMember(user.id)) return false;
    if (user.id === room.hostUserId) return false;
    return true;
  }

  /**
   * Works out what role a joiner should get.
   *
   * Returns null when there is genuinely nowhere for them to go: they asked to
   * play, both seats are taken, and the host does not allow spectators. That
   * case must report ROOM_FULL - telling someone who wanted to play that
   * "spectators are disabled" is a confusing non-sequitur.
   */
  defaultRoleFor(room: Room, asSpectator: boolean | undefined): MemberRole | null {
    if (asSpectator === true) return 'spectator';
    if (!room.seatsFull) return 'player';
    // Seats are full, so playing is not on offer.
    if (!room.settings.allowSpectators) return null;
    return 'spectator';
  }

  // -------------------------------------------------------------------------
  // Public browser
  // -------------------------------------------------------------------------

  /**
   * The public listing.
   *
   * Private, LAN and same-device rooms are excluded structurally here - not by
   * a flag a client could flip - so they can never surface in the browser.
   */
  publicSummaries(filter: RoomListFilter = {}): PublicRoomSummary[] {
    const search = filter.search?.trim().toLowerCase() ?? '';

    return this.list()
      .filter((room) => room.settings.mode === 'public' && !room.closed)
      .map((room) => room.summary())
      .filter((s) => {
        if (search && !`${s.name} ${s.hostName}`.toLowerCase().includes(search)) return false;
        if (filter.rated === 'rated' && !s.rated) return false;
        if (filter.rated === 'casual' && s.rated) return false;
        if (filter.timeKind && filter.timeKind !== 'any' && s.timeControl.kind !== filter.timeKind) return false;
        if (filter.theme && filter.theme !== 'any' && s.theme !== filter.theme) return false;
        if (filter.hideFull && s.seatsOpen === 0 && !s.allowSpectators) return false;
        if (filter.hidePasswordProtected && s.passwordProtected) return false;
        return true;
      })
      .sort((a, b) => {
        // Rooms waiting for an opponent first, then newest.
        if (a.seatsOpen !== b.seatsOpen) return b.seatsOpen - a.seatsOpen;
        return b.createdAt - a.createdAt;
      });
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  destroy(roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) return;
    room.close();
    this.rooms.delete(roomId);
    this.byCode.delete(room.code);
    try {
      db.closeRoomRow(roomId);
    } catch (error) {
      console.error('[rooms] failed to close room row', error);
    }
  }

  /**
   * Periodic sweep: advances clocks, drops rooms nobody is in, and enforces the
   * absolute room age cap.
   */
  sweep(now = Date.now()): { closed: number } {
    let closed = 0;
    for (const room of this.list()) {
      room.tick(now);

      const empty = room.connectedCount === 0;
      const expiredIdle = empty && room.idleMs > config.roomEmptyTtlMs;
      const expiredAge = room.ageMs > config.roomMaxAgeMs;

      if (expiredIdle || expiredAge) {
        this.destroy(room.id);
        closed += 1;
      }
    }
    this.createCounter.sweep(now);
    return { closed };
  }

  startSweeping(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      try {
        this.sweep();
      } catch (error) {
        console.error('[rooms] sweep failed', error);
      }
    }, config.roomSweepIntervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  /** Closes every room; used on shutdown and between tests. */
  closeAll(): void {
    for (const room of this.list()) {
      room.close();
    }
    this.rooms.clear();
    this.byCode.clear();
  }

  /** Persists mutable room state (settings changes, host transfer). */
  save(room: Room): void {
    this.persist(room);
  }
}
