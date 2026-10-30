import { create } from 'zustand';
import type {
  ChatMessage,
  ClockState,
  GameOverInfo,
  IdentityGrant,
  PublicRoomSummary,
  RecordedMove,
  RoomView,
  Square,
} from '@gambit3d/shared';
import { getSocket, identify, rpc } from './socket.js';

/**
 * Client state.
 *
 * The server's `RoomView` is the single source of truth for anything that
 * matters; this store keeps the latest snapshot plus purely local concerns
 * (which square is selected, a queued premove, toasts).
 */

export type ConnectionStatus = 'connecting' | 'online' | 'reconnecting' | 'offline';

export interface Toast {
  id: string;
  level: 'info' | 'warn' | 'error' | 'success';
  text: string;
  at: number;
}

export interface PendingJoin {
  roomId: string;
  roomName: string;
  requestId: string;
}

export interface Premove {
  from: Square;
  to: Square;
  promotion?: 'q' | 'r' | 'b' | 'n';
}

interface AppState {
  // --- connection + identity
  status: ConnectionStatus;
  identity: IdentityGrant | null;
  bootstrapped: boolean;

  // --- lobby
  publicRooms: PublicRoomSummary[];
  lobbySubscribed: boolean;

  // --- current room
  room: RoomView | null;
  pendingJoin: PendingJoin | null;
  /** Server clock snapshot + the local time it arrived, for drift-free display. */
  clockSync: { clock: ClockState; serverTime: number; receivedAt: number } | null;
  chat: ChatMessage[];

  // --- local board interaction
  selected: Square | null;
  premove: Premove | null;
  promotionPrompt: { from: Square; to: Square } | null;
  lastResult: GameOverInfo | null;

  // --- ui
  toasts: Toast[];

  // --- actions
  bootstrap: (name?: string) => Promise<void>;
  setStatus: (status: ConnectionStatus) => void;
  setIdentity: (identity: IdentityGrant) => void;
  setRoom: (room: RoomView | null) => void;
  setPendingJoin: (pending: PendingJoin | null) => void;
  applyClockSync: (clock: ClockState, serverTime: number) => void;
  appendChat: (message: ChatMessage) => void;
  appendMove: (move: RecordedMove) => void;

  select: (square: Square | null) => void;
  setPremove: (premove: Premove | null) => void;
  promptPromotion: (prompt: { from: Square; to: Square } | null) => void;

  toast: (level: Toast['level'], text: string) => void;
  dismissToast: (id: string) => void;

  setPublicRooms: (rooms: PublicRoomSummary[]) => void;
  subscribeLobby: (on: boolean) => Promise<void>;
  refreshLobby: () => Promise<void>;
  leaveRoom: () => Promise<void>;
  reset: () => void;
}

let toastSeq = 0;

export const useStore = create<AppState>((set, get) => ({
  status: 'connecting',
  identity: null,
  bootstrapped: false,

  publicRooms: [],
  lobbySubscribed: false,

  room: null,
  pendingJoin: null,
  clockSync: null,
  chat: [],

  selected: null,
  premove: null,
  promotionPrompt: null,
  lastResult: null,

  toasts: [],

  async bootstrap(name) {
    const result = await identify(name);
    if (result.ok) {
      set({ identity: result.data, bootstrapped: true, status: 'online' });
    } else {
      set({ bootstrapped: true });
      get().toast('error', result.message);
    }
  },

  setStatus: (status) => set({ status }),
  setIdentity: (identity) => set({ identity }),

  setRoom: (room) =>
    set((state) => ({
      room,
      chat: room ? room.chat : [],
      // Drop board selection when the position changes underneath us.
      selected: room && state.room && room.game.fen !== state.room.game.fen ? null : state.selected,
      lastResult: room?.game.result ?? null,
      clockSync: room?.game.clock
        ? { clock: room.game.clock, serverTime: room.game.clock.updatedAt, receivedAt: Date.now() }
        : null,
    })),

  setPendingJoin: (pendingJoin) => set({ pendingJoin }),

  applyClockSync: (clock, serverTime) => set({ clockSync: { clock, serverTime, receivedAt: Date.now() } }),

  appendChat: (message) =>
    set((state) => {
      if (state.chat.some((c) => c.id === message.id)) return state;
      return { chat: [...state.chat, message].slice(-200) };
    }),

  appendMove: (move) =>
    set((state) => {
      if (!state.room) return state;
      if (state.room.game.moves.some((m) => m.ply === move.ply)) return state;
      return {
        room: {
          ...state.room,
          game: {
            ...state.room.game,
            moves: [...state.room.game.moves, move],
            fen: move.fenAfter,
            lastMove: { from: move.from, to: move.to },
          },
        },
      };
    }),

  select: (selected) => set({ selected }),
  setPremove: (premove) => set({ premove }),
  promptPromotion: (promotionPrompt) => set({ promotionPrompt }),

  toast: (level, text) => {
    toastSeq += 1;
    const t: Toast = { id: `t${toastSeq}`, level, text, at: Date.now() };
    set((state) => ({ toasts: [...state.toasts, t].slice(-4) }));
    window.setTimeout(() => get().dismissToast(t.id), level === 'error' ? 7000 : 4500);
  },

  dismissToast: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),

  setPublicRooms: (publicRooms) => set({ publicRooms }),

  async subscribeLobby(on) {
    await rpc('lobby:subscribe', { subscribe: on });
    set({ lobbySubscribed: on });
  },

  async refreshLobby() {
    const result = await rpc<'lobby:list', { rooms: PublicRoomSummary[] }>('lobby:list', {});
    if (result.ok) set({ publicRooms: result.data.rooms });
  },

  async leaveRoom() {
    const room = get().room;
    if (room) await rpc('room:leave', { roomId: room.id });
    set({ room: null, chat: [], selected: null, premove: null, clockSync: null, pendingJoin: null });
  },

  reset: () =>
    set({
      room: null,
      chat: [],
      selected: null,
      premove: null,
      promotionPrompt: null,
      clockSync: null,
      pendingJoin: null,
      lastResult: null,
    }),
}));

/**
 * Attaches the socket listeners exactly once.
 * Re-identifying on every reconnect is what restores a seat after a refresh,
 * a dropped Wi-Fi connection or a phone waking from sleep.
 */
let wired = false;

export function wireSocket(): void {
  if (wired) return;
  wired = true;

  const socket = getSocket();
  const store = useStore.getState;

  socket.on('connect', () => {
    store().setStatus('online');
    void store()
      .bootstrap()
      .then(() => {
        // Re-subscribe to whatever this tab was watching.
        if (store().lobbySubscribed) void rpc('lobby:subscribe', { subscribe: true });
      });
  });

  socket.on('disconnect', (reason) => {
    store().setStatus(reason === 'io client disconnect' ? 'offline' : 'reconnecting');
  });

  socket.io.on('reconnect_attempt', () => store().setStatus('reconnecting'));
  socket.io.on('error', () => store().setStatus('reconnecting'));

  socket.on('room:state', (room) => {
    store().setRoom(room);
    store().setPendingJoin(null);
  });

  socket.on('room:removed', ({ reason, message }) => {
    store().reset();
    store().toast(reason === 'banned' || reason === 'kicked' ? 'error' : 'info', message);
  });

  socket.on('room:joinRequest', ({ request }) => {
    store().toast('info', `${request.name} would like to join.`);
  });

  socket.on('room:joinResolved', ({ accepted, room, message }) => {
    store().setPendingJoin(null);
    if (accepted && room) store().setRoom(room);
    store().toast(accepted ? 'success' : 'warn', message);
  });

  socket.on('game:moved', ({ move, clock }) => {
    store().appendMove(move);
    if (clock) store().applyClockSync(clock, clock.updatedAt);
  });

  socket.on('game:started', () => store().toast('success', 'The game has started.'));

  socket.on('game:over', ({ result }) => {
    store().toast(result.winner ? 'info' : 'warn', result.message);
  });

  socket.on('clock:sync', ({ clock, serverTime }) => store().applyClockSync(clock, serverTime));

  socket.on('chat:message', (message) => store().appendChat(message));

  socket.on('notice', ({ level, text }) => store().toast(level, text));

  socket.on('lobby:rooms', (rooms) => store().setPublicRooms(rooms));
}

// --- Derived selectors ------------------------------------------------------

/**
 * Remaining time for each side, interpolated from the last server snapshot.
 * Display only - the server decides when a flag actually falls.
 */
export function interpolatedClock(
  sync: AppState['clockSync'],
  now = Date.now(),
): { w: number; b: number; running: 'w' | 'b' | null } | null {
  if (!sync) return null;
  const { clock, receivedAt } = sync;
  if (!clock.running) return { w: clock.w, b: clock.b, running: null };
  const elapsed = Math.max(0, now - receivedAt);
  const out = { w: clock.w, b: clock.b, running: clock.running };
  out[clock.running] = Math.max(0, out[clock.running] - elapsed);
  return out;
}
