import { io, type Socket } from 'socket.io-client';
import type {
  ClientToServerEvents,
  Err,
  IdentityGrant,
  Result,
  ServerToClientEvents,
} from '@gambit3d/shared';

/**
 * The single socket connection, plus a promise-shaped RPC helper.
 *
 * Every server call returns a `Result`, so callers handle failure explicitly
 * rather than relying on thrown errors that are easy to forget.
 */

export type AppSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

const TOKEN_KEY = 'gambit3d.token';
const NAME_KEY = 'gambit3d.name';

/**
 * Where to reach the server.
 *
 * With no explicit VITE_SERVER_URL we use the page's own origin. That is the
 * correct answer for LAN play (the phone loaded the page from the PC's LAN
 * address, so it should talk back to that same address) and for single-origin
 * production deploys. Hard-coding localhost here is exactly the bug that makes
 * LAN mode appear broken.
 */
export function serverUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL;
  if (configured && configured.trim()) return configured.trim();
  if (typeof window === 'undefined') return 'http://127.0.0.1:8787';
  return window.location.origin;
}

let socket: AppSocket | null = null;

export function getSocket(): AppSocket {
  if (socket) return socket;
  socket = io(serverUrl(), {
    transports: ['websocket', 'polling'],
    autoConnect: true,
    reconnection: true,
    reconnectionAttempts: Number.POSITIVE_INFINITY,
    reconnectionDelay: 500,
    reconnectionDelayMax: 5_000,
    timeout: 12_000,
    withCredentials: true,
  }) as AppSocket;
  return socket;
}

export function disposeSocket(): void {
  socket?.close();
  socket = null;
}

const TIMEOUT_ERROR: Err = {
  ok: false,
  code: 'INTERNAL',
  message: 'The server did not respond. Check your connection.',
};

/** Typed request/response over the socket, with a hard timeout. */
export function rpc<K extends keyof ClientToServerEvents, T>(
  event: K,
  payload: unknown,
  timeoutMs = 10_000,
): Promise<Result<T>> {
  const s = getSocket();
  return new Promise((resolve) => {
    let settled = false;
    const timer = window.setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(TIMEOUT_ERROR);
    }, timeoutMs);

    const done = (result: Result<T>): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      resolve(result);
    };

    try {
      (s.emit as unknown as (e: string, p: unknown, cb: (r: Result<T>) => void) => void)(
        event as string,
        payload,
        done,
      );
    } catch {
      done(TIMEOUT_ERROR);
    }
  });
}

// --- Persisted identity -----------------------------------------------------

export function storedToken(): string | undefined {
  try {
    return window.localStorage.getItem(TOKEN_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function storedName(): string | undefined {
  try {
    return window.localStorage.getItem(NAME_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

export function rememberIdentity(grant: IdentityGrant): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, grant.token);
    window.localStorage.setItem(NAME_KEY, grant.name);
  } catch {
    // Private browsing with storage disabled: the session still works, it just
    // will not survive a reload.
  }
}

export function forgetIdentity(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(NAME_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Establishes (or restores) this browser's identity.
 * Called on connect and on every reconnect, which is what restores a seat.
 */
export async function identify(name?: string): Promise<Result<IdentityGrant>> {
  const token = storedToken();
  const result = await rpc<'identify', IdentityGrant>('identify', {
    ...(token ? { token } : {}),
    ...(name ? { name } : {}),
  });
  if (result.ok) rememberIdentity(result.data);
  return result;
}
