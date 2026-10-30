import type { Server as HttpServer } from 'node:http';
import { Server as IOServer, type Socket } from 'socket.io';
import {
  ERROR_MESSAGES,
  chatRequestSchema,
  claimDrawSchema,
  createRoomRequestSchema,
  joinRoomRequestSchema,
  listRoomsRequestSchema,
  lockRoomSchema,
  memberActionSchema,
  moveRequestSchema,
  muteSchema,
  offerResponseSchema,
  ok,
  respondJoinSchema,
  roomActionSchema,
  setModeratorSchema,
  setSeatSchema,
  makeOfferSchema,
  updateSettingsSchema,
  type Cb,
  type ChatMessage,
  type ClientToServerEvents,
  type Err,
  type ErrorCode,
  type GameOverInfo,
  type InterServerEvents,
  type JoinOutcome,
  type RecordedMove,
  type Result,
  type RoomView,
  type ServerToClientEvents,
  type SocketData,
} from '@gambit3d/shared';
import type { ZodTypeAny, z } from 'zod';
import { config, isOriginAllowed } from './env.js';
import { getLanInfo } from './lan.js';
import { identify, isGuestIdentity, lookupIdentity } from './identity.js';
import { RateLimiter } from './rateLimit.js';
import type { Room, JoinRequestRecord } from './room.js';
import { RoomManager } from './roomManager.js';

type AppSocket = Socket<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;
type AppServer = IOServer<ClientToServerEvents, ServerToClientEvents, InterServerEvents, SocketData>;

const LOBBY_CHANNEL = 'lobby';

export interface Gateway {
  io: AppServer;
  rooms: RoomManager;
  shutdown(): Promise<void>;
}

export function createGateway(httpServer: HttpServer, rooms = new RoomManager()): Gateway {
  const io: AppServer = new IOServer(httpServer, {
    cors: {
      origin: (origin, callback) => {
        if (isOriginAllowed(origin ?? undefined)) callback(null, true);
        else callback(new Error('Origin not allowed'));
      },
      credentials: true,
    },
    // Keep a disconnected tab's session alive long enough to survive a refresh
    // or a phone briefly locking, without holding sockets open forever.
    pingTimeout: 25_000,
    pingInterval: 20_000,
    maxHttpBufferSize: 1e5,
    connectionStateRecovery: {
      maxDisconnectionDuration: 60_000,
      skipMiddlewares: false,
    },
  });

  const limiter = new RateLimiter({
    create: { perMinute: config.rateLimits.createPerMin },
    join: { perMinute: config.rateLimits.joinPerMin },
    move: { perMinute: config.rateLimits.movesPerMin, burst: 20 },
    chat: { perMinute: config.rateLimits.chatPerMin },
    action: { perMinute: 120 },
    list: { perMinute: 60 },
  });
  limiter.startSweeping();

  /** userId -> socket ids, so we can push to every tab an identity has open. */
  const socketsByUser = new Map<string, Set<string>>();

  // -------------------------------------------------------------------------
  // Broadcasting
  // -------------------------------------------------------------------------

  function socketsFor(userId: string): AppSocket[] {
    const ids = socketsByUser.get(userId);
    if (!ids) return [];
    const out: AppSocket[] = [];
    for (const id of ids) {
      const s = io.sockets.sockets.get(id) as AppSocket | undefined;
      if (s) out.push(s);
    }
    return out;
  }

  /**
   * Sends every member their own redacted snapshot.
   *
   * Each viewer gets a different object - spectators may not see the legal-move
   * map, non-staff never see the ban list or the pending approval queue - so
   * this cannot be collapsed into a single room-wide emit.
   */
  function broadcastRoom(room: Room): void {
    for (const member of room.memberList) {
      const view = room.viewFor(member.id);
      for (const socket of socketsFor(member.id)) {
        socket.emit('room:state', view);
      }
    }
    if (room.settings.mode === 'public') pushLobby();
  }

  function pushLobby(): void {
    io.to(LOBBY_CHANNEL).emit('lobby:rooms', rooms.publicSummaries());
  }

  function emitToUser<E extends keyof ServerToClientEvents>(
    userId: string,
    event: E,
    ...args: Parameters<ServerToClientEvents[E]>
  ): void {
    for (const socket of socketsFor(userId)) {
      (socket.emit as (e: E, ...a: Parameters<ServerToClientEvents[E]>) => void)(event, ...args);
    }
  }

  rooms.events = {
    onChange: (room) => broadcastRoom(room),
    onChat: (room: Room, message: ChatMessage) => {
      for (const member of room.memberList) {
        // Player-channel chat is hidden from spectators unless the host allows it.
        const isPlayer = member.seat !== null;
        const staff = member.isHost || member.isModerator;
        if (message.channel === 'player' && !isPlayer && !staff && !room.settings.spectatorsSeeMoveHistory) {
          continue;
        }
        emitToUser(member.id, 'chat:message', message);
      }
    },
    onMove: (room: Room, move: RecordedMove) => {
      for (const member of room.memberList) {
        if (!room.capabilitiesFor(member.id).seeMoveHistory) continue;
        emitToUser(member.id, 'game:moved', {
          roomId: room.id,
          move,
          fen: move.fenAfter,
          clock: room.gameClock.state(),
        });
      }
    },
    onGameStart: (room: Room) => {
      for (const member of room.memberList) {
        emitToUser(member.id, 'game:started', { roomId: room.id, startedAt: Date.now() });
      }
    },
    onGameOver: (room: Room, result: GameOverInfo) => {
      for (const member of room.memberList) {
        emitToUser(member.id, 'game:over', { roomId: room.id, result });
      }
      rooms.save(room);
    },
    onJoinRequest: (room: Room, request: JoinRequestRecord) => {
      for (const member of room.memberList) {
        if (!member.isHost && !member.isModerator) continue;
        emitToUser(member.id, 'room:joinRequest', {
          roomId: room.id,
          request: {
            id: request.id,
            name: request.name,
            desiredRole: request.desiredRole,
            requestedAt: request.requestedAt,
            rating: request.rating,
          },
        });
      }
    },
    onJoinResolved: (room: Room, userId: string, accepted: boolean, message: string) => {
      emitToUser(userId, 'room:joinResolved', {
        roomId: room.id,
        accepted,
        ...(accepted ? { room: room.viewFor(userId) } : {}),
        message,
      });
      if (accepted) {
        for (const socket of socketsFor(userId)) {
          void socket.join(roomChannel(room.id));
          socket.data.rooms.add(room.id);
        }
      }
    },
    onRemoved: (room: Room, userId: string, reason, message) => {
      emitToUser(userId, 'room:removed', { roomId: room.id, reason, message });
      for (const socket of socketsFor(userId)) {
        void socket.leave(roomChannel(room.id));
        socket.data.rooms.delete(room.id);
      }
    },
    onNotice: (room: Room, level, text, onlyUserId) => {
      if (onlyUserId) {
        emitToUser(onlyUserId, 'notice', { roomId: room.id, level, text });
        return;
      }
      for (const member of room.memberList) {
        emitToUser(member.id, 'notice', { roomId: room.id, level, text });
      }
    },
    onClosed: (room: Room) => {
      for (const member of room.memberList) {
        emitToUser(member.id, 'room:removed', {
          roomId: room.id,
          reason: 'closed',
          message: 'This room has been closed.',
        });
      }
      pushLobby();
    },
  };

  rooms.startSweeping();

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function roomChannel(roomId: string): string {
    return `room:${roomId}`;
  }

  function fail(cb: Cb<unknown>, code: ErrorCode, message?: string, extra?: Partial<Err>): void {
    cb({ ok: false, code, message: message ?? ERROR_MESSAGES[code], ...extra } as Err);
  }

  /** Validates a payload, replying with a structured error when it fails. */
  function parse<S extends ZodTypeAny>(schema: S, payload: unknown, cb: Cb<never>): z.infer<S> | null {
    const result = schema.safeParse(payload);
    if (!result.success) {
      fail(cb as Cb<unknown>, 'BAD_REQUEST', 'That request was not understood.', {
        details: result.error.flatten().fieldErrors as Record<string, string[]>,
      });
      return null;
    }
    return result.data;
  }

  function limit(socket: AppSocket, action: string, cb: Cb<never>): boolean {
    const decision = limiter.check(action, socket.data.userId || socket.id);
    if (!decision.allowed) {
      fail(cb as Cb<unknown>, 'RATE_LIMITED', undefined, { retryAfterMs: decision.retryAfterMs });
      return false;
    }
    return true;
  }

  /** Resolves the room and asserts the caller is a member of it. */
  function memberRoom(socket: AppSocket, roomId: string, cb: Cb<never>): Room | null {
    const room = rooms.get(roomId);
    if (!room || room.closed) {
      fail(cb as Cb<unknown>, 'NOT_FOUND');
      return null;
    }
    if (!room.hasMember(socket.data.userId)) {
      fail(cb as Cb<unknown>, 'FORBIDDEN', 'You are not in this room.');
      return null;
    }
    return room;
  }

  /** Wraps a Room result, replying with the room view on success. */
  function replyWithRoom(socket: AppSocket, room: Room, result: Result<unknown>, cb: Cb<{ room: RoomView }>): void {
    if (!result.ok) {
      cb(result);
      return;
    }
    cb(ok({ room: room.viewFor(socket.data.userId) }));
  }

  // -------------------------------------------------------------------------
  // Connection
  // -------------------------------------------------------------------------

  io.on('connection', (socket: AppSocket) => {
    socket.data.rooms = new Set<string>();
    socket.data.userId = '';
    socket.data.name = '';
    socket.data.ip = extractIp(socket);

    // --- identify ---------------------------------------------------------
    socket.on('identify', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const result = identify(payload);
      if (!result.ok) {
        cb(result);
        return;
      }
      const { identity, grant } = result.data;

      // Move this socket onto the resolved identity.
      if (socket.data.userId && socket.data.userId !== identity.id) {
        unregisterSocket(socket.data.userId, socket.id);
      }
      socket.data.userId = identity.id;
      socket.data.name = identity.name;
      registerSocket(identity.id, socket.id);

      // Reattach to any live rooms this identity is still a member of.
      for (const room of rooms.list()) {
        if (!room.hasMember(identity.id)) continue;
        void socket.join(roomChannel(room.id));
        socket.data.rooms.add(room.id);
        room.attachSocket(identity.id, socket.id);
        socket.emit('room:state', room.viewFor(identity.id));
      }

      cb(ok(grant));
    });

    // --- LAN info ---------------------------------------------------------
    socket.on('lan:info', (_payload, cb) => {
      if (typeof cb !== 'function') return;
      cb(ok(getLanInfo()));
    });

    // --- lobby ------------------------------------------------------------
    socket.on('lobby:list', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'list', cb as Cb<never>)) return;
      const input = parse(listRoomsRequestSchema, payload ?? {}, cb as Cb<never>);
      if (!input) return;
      cb(ok({ rooms: rooms.publicSummaries(input) }));
    });

    socket.on('lobby:subscribe', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const subscribe = (payload as { subscribe?: boolean } | undefined)?.subscribe !== false;
      if (subscribe) {
        void socket.join(LOBBY_CHANNEL);
        socket.emit('lobby:rooms', rooms.publicSummaries());
      } else {
        void socket.leave(LOBBY_CHANNEL);
      }
      cb(ok({ subscribed: subscribe }));
    });

    // --- room creation ----------------------------------------------------
    socket.on('room:create', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!requireIdentity(socket, cb as Cb<never>)) return;
      if (!limit(socket, 'create', cb as Cb<never>)) return;

      const input = parse(createRoomRequestSchema, payload, cb as Cb<never>);
      if (!input) return;

      const identity = lookupIdentity(socket.data.userId);
      if (!identity) {
        fail(cb as Cb<unknown>, 'FORBIDDEN', 'Your session expired. Reload the page.');
        return;
      }

      void rooms
        .create(identity, input.settings, input.password, socket.data.ip)
        .then((result) => {
          if (!result.ok) {
            cb(result);
            return;
          }
          const room = result.data.room;
          void socket.join(roomChannel(room.id));
          socket.data.rooms.add(room.id);
          room.attachSocket(identity.id, socket.id);
          pushLobby();
          cb(ok({ room: room.viewFor(identity.id) }));
        })
        .catch((error: unknown) => {
          console.error('[gateway] room:create failed', error);
          fail(cb as Cb<unknown>, 'INTERNAL');
        });
    });

    // --- joining ----------------------------------------------------------
    socket.on('room:join', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!requireIdentity(socket, cb as Cb<never>)) return;
      if (!limit(socket, 'join', cb as Cb<never>)) return;

      const input = parse(joinRoomRequestSchema, payload, cb as Cb<never>);
      if (!input) return;

      const room = rooms.resolve(input.target);
      if (!room || room.closed) {
        fail(cb as Cb<unknown>, 'NOT_FOUND');
        return;
      }

      const identity = lookupIdentity(socket.data.userId);
      if (!identity) {
        fail(cb as Cb<unknown>, 'FORBIDDEN', 'Your session expired. Reload the page.');
        return;
      }

      void rooms
        .authorizeJoin(room, identity, input.password, isGuestIdentity(identity))
        .then((authorized) => {
          if (!authorized.ok) {
            cb(authorized);
            return;
          }

          const role = rooms.defaultRoleFor(room, input.asSpectator);
          if (role === null) {
            // Both seats taken and the host does not allow spectators.
            fail(cb as Cb<unknown>, 'ROOM_FULL');
            return;
          }

          if (rooms.needsApproval(room, identity)) {
            const queued = room.queueJoinRequest(identity, role);
            if (!queued.ok) {
              cb(queued);
              return;
            }
            cb(
              ok<JoinOutcome>({
                status: 'pending',
                roomId: room.id,
                roomName: room.settings.name,
                requestId: queued.data.requestId,
              }),
            );
            return;
          }

          const admitted = room.admit(identity, role);
          if (!admitted.ok) {
            cb(admitted);
            return;
          }

          void socket.join(roomChannel(room.id));
          socket.data.rooms.add(room.id);
          room.attachSocket(identity.id, socket.id);
          room.systemMessage(`${identity.name} joined as ${admitted.data.member.seat ? 'a player' : 'a spectator'}.`);
          pushLobby();
          cb(ok<JoinOutcome>({ status: 'joined', room: room.viewFor(identity.id) }));
        })
        .catch((error: unknown) => {
          console.error('[gateway] room:join failed', error);
          fail(cb as Cb<unknown>, 'INTERNAL');
        });
    });

    socket.on('room:get', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(roomActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      cb(ok({ room: room.viewFor(socket.data.userId) }));
    });

    socket.on('room:leave', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(roomActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = rooms.get(input.roomId);
      if (!room) {
        cb(ok({ left: true }));
        return;
      }
      room.evict(socket.data.userId, 'left', 'You left the room.');
      void socket.leave(roomChannel(room.id));
      socket.data.rooms.delete(room.id);
      if (room.memberList.length === 0) rooms.destroy(room.id);
      pushLobby();
      cb(ok({ left: true }));
    });

    // --- host + moderation ------------------------------------------------
    socket.on('room:updateSettings', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'action', cb as Cb<never>)) return;
      const input = parse(updateSettingsSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;

      const result = room.updateSettings(socket.data.userId, input.patch);
      if (result.ok) {
        rooms.save(room);
        pushLobby();
      }
      replyWithRoom(socket, room, result, cb);
    });

    socket.on('room:lock', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(lockRoomSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.setLocked(socket.data.userId, input.locked), cb);
      pushLobby();
    });

    socket.on('room:respondJoin', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(respondJoinSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const result = room.resolveJoinRequest(
        socket.data.userId,
        input.requestId,
        input.accept,
        input.asSpectator,
        lookupIdentity,
      );
      replyWithRoom(socket, room, result, cb);
      pushLobby();
    });

    socket.on('room:kick', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(memberActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.kick(socket.data.userId, input.memberId), cb);
    });

    socket.on('room:ban', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(memberActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.ban(socket.data.userId, input.memberId), cb);
    });

    socket.on('room:unban', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(memberActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.unban(socket.data.userId, input.memberId), cb);
    });

    socket.on('room:mute', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(muteSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.setMuted(socket.data.userId, input.memberId, input.muted), cb);
    });

    socket.on('room:transferHost', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(memberActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const result = room.transferHost(socket.data.userId, input.memberId);
      if (result.ok) rooms.save(room);
      replyWithRoom(socket, room, result, cb);
    });

    socket.on('room:setModerator', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(setModeratorSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.setModerator(socket.data.userId, input.memberId, input.isModerator), cb);
    });

    socket.on('room:setSeat', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'action', cb as Cb<never>)) return;
      const input = parse(setSeatSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const result = room.setSeat(socket.data.userId, input.seat);
      if (result.ok) pushLobby();
      replyWithRoom(socket, room, result, cb);
    });

    // --- game -------------------------------------------------------------
    socket.on('game:start', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(roomActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const result = room.startGame(socket.data.userId);
      if (result.ok) pushLobby();
      replyWithRoom(socket, room, result, cb);
    });

    socket.on('game:abort', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(roomActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.abortGame(socket.data.userId), cb);
    });

    socket.on('game:move', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'move', cb as Cb<never>)) return;
      const input = parse(moveRequestSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;

      const result = room.move(
        socket.data.userId,
        {
          from: input.from,
          to: input.to,
          ...(input.promotion ? { promotion: input.promotion } : {}),
        },
        input.expectedPly,
      );

      if (!result.ok) {
        // Hand back a fresh snapshot so a client that got out of sync recovers.
        socket.emit('room:state', room.viewFor(socket.data.userId));
        cb(result);
        return;
      }
      cb(ok({ room: room.viewFor(socket.data.userId), move: result.data.move }));
    });

    socket.on('game:resign', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(roomActionSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.resign(socket.data.userId), cb);
    });

    socket.on('game:offer', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'action', cb as Cb<never>)) return;
      const input = parse(makeOfferSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.makeOffer(socket.data.userId, input.kind), cb);
    });

    socket.on('game:respondOffer', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(offerResponseSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      replyWithRoom(socket, room, room.respondToOffer(socket.data.userId, input.kind, input.accept), cb);
    });

    socket.on('game:claimDraw', (payload, cb) => {
      if (typeof cb !== 'function') return;
      const input = parse(claimDrawSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const claim = input.claim === 'threefold' ? 'threefold' : 'fifty_move';
      replyWithRoom(socket, room, room.claimDraw(socket.data.userId, claim), cb);
    });

    // --- chat -------------------------------------------------------------
    socket.on('chat:send', (payload, cb) => {
      if (typeof cb !== 'function') return;
      if (!limit(socket, 'chat', cb as Cb<never>)) return;
      const input = parse(chatRequestSchema, payload, cb as Cb<never>);
      if (!input) return;
      const room = memberRoom(socket, input.roomId, cb as Cb<never>);
      if (!room) return;
      const result = room.postChat(socket.data.userId, input.text);
      if (!result.ok) {
        cb(result);
        return;
      }
      cb(ok({ message: result.data.message }));
    });

    // --- teardown ---------------------------------------------------------
    socket.on('disconnect', () => {
      const userId = socket.data.userId;
      if (!userId) return;
      unregisterSocket(userId, socket.id);

      for (const roomId of socket.data.rooms) {
        const room = rooms.get(roomId);
        room?.detachSocket(userId, socket.id);
      }
      socket.data.rooms.clear();
    });
  });

  function registerSocket(userId: string, socketId: string): void {
    const set = socketsByUser.get(userId) ?? new Set<string>();
    set.add(socketId);
    socketsByUser.set(userId, set);
  }

  function unregisterSocket(userId: string, socketId: string): void {
    const set = socketsByUser.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) socketsByUser.delete(userId);
  }

  function requireIdentity(socket: AppSocket, cb: Cb<never>): boolean {
    if (!socket.data.userId) {
      fail(cb as Cb<unknown>, 'FORBIDDEN', 'Send "identify" before using the server.');
      return false;
    }
    return true;
  }

  // A periodic clock reconciliation keeps every client honest about the time
  // remaining without relying on their own drifting local timers.
  const clockTimer = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.list()) {
      if (room.phaseName !== 'active') continue;
      const clock = room.gameClock.state(now);
      if (!clock) continue;
      io.to(roomChannel(room.id)).emit('clock:sync', { roomId: room.id, clock, serverTime: now });
    }
  }, 3_000);
  clockTimer.unref?.();

  async function shutdown(): Promise<void> {
    clearInterval(clockTimer);
    limiter.stopSweeping();
    rooms.stopSweeping();
    rooms.closeAll();
    await new Promise<void>((resolve) => {
      io.close(() => resolve());
    });
  }

  return { io, rooms, shutdown };
}

function extractIp(socket: AppSocket): string {
  if (config.trustProxy) {
    const forwarded = socket.handshake.headers['x-forwarded-for'];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(',')[0];
    if (first) return first.trim();
  }
  return socket.handshake.address || 'unknown';
}
