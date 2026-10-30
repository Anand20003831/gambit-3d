import { createServer, type Server as HttpServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { io as ioClient, type Socket } from 'socket.io-client';
import type { IdentityGrant, Result, RoomView } from '@gambit3d/shared';

/**
 * Boots a real server on an ephemeral port and hands back real Socket.IO
 * clients. Nothing is stubbed: these tests exercise the same gateway, room
 * manager, chess engine and SQLite layer that production runs.
 */

process.env.NODE_ENV ??= 'test';
process.env.DATABASE_PATH ??= ':memory:';
process.env.SESSION_SECRET ??= 'integration-test-secret-not-used-anywhere-else';
process.env.CORS_ORIGINS ??= '*';
// Short grace so abandonment can be exercised without a long wait.
process.env.DISCONNECT_GRACE_MS ??= '400';
// Layout saves go to a scratch directory: a test run must never overwrite a
// map somebody has dressed by hand.
process.env.LAYOUT_DIR ??= path.join(tmpdir(), 'gambit3d-test-layouts');

export interface TestServer {
  url: string;
  http: HttpServer;
  shutdown: () => Promise<void>;
  clients: Set<Socket>;
}

export async function startTestServer(): Promise<TestServer> {
  const { createHttpApp } = await import('../../packages/server/src/http.js');
  const { createGateway } = await import('../../packages/server/src/gateway.js');
  const { RoomManager } = await import('../../packages/server/src/roomManager.js');

  const rooms = new RoomManager();
  const app = createHttpApp({ rooms });
  const http = createServer(app);
  const gateway = createGateway(http, rooms);

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', () => resolve()));
  const address = http.address();
  if (!address || typeof address === 'string') throw new Error('failed to bind a test port');

  const clients = new Set<Socket>();

  return {
    url: `http://127.0.0.1:${address.port}`,
    http,
    clients,
    shutdown: async () => {
      for (const client of clients) client.close();
      clients.clear();
      await gateway.shutdown();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

export interface TestClient {
  socket: Socket;
  identity: IdentityGrant;
  rpc<T>(event: string, payload?: unknown): Promise<Result<T>>;
  /** Resolves with the next payload for `event`, or rejects after `timeoutMs`. */
  next<T>(event: string, timeoutMs?: number): Promise<T>;
  /** Every `room:state` seen so far, newest last. */
  states: RoomView[];
  latest(): RoomView | undefined;
  close(): void;
}

export async function connect(server: TestServer, name?: string, token?: string): Promise<TestClient> {
  const socket = ioClient(server.url, { transports: ['websocket'], forceNew: true });
  server.clients.add(socket);

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('socket did not connect')), 8000);
    socket.on('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    socket.on('connect_error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });

  const states: RoomView[] = [];
  socket.on('room:state', (room: RoomView) => states.push(room));

  const rpc = <T,>(event: string, payload: unknown = {}): Promise<Result<T>> =>
    new Promise((resolve) => {
      const timer = setTimeout(
        () => resolve({ ok: false, code: 'INTERNAL', message: `timeout waiting for ${event}` }),
        8000,
      );
      socket.emit(event, payload, (result: Result<T>) => {
        clearTimeout(timer);
        resolve(result);
      });
    });

  const identifyResult = await rpc<IdentityGrant>('identify', {
    ...(name ? { name } : {}),
    ...(token ? { token } : {}),
  });
  if (!identifyResult.ok) throw new Error(`identify failed: ${identifyResult.message}`);

  return {
    socket,
    identity: identifyResult.data,
    rpc,
    next: <T,>(event: string, timeoutMs = 4000): Promise<T> =>
      new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), timeoutMs);
        socket.once(event, (payload: T) => {
          clearTimeout(timer);
          resolve(payload);
        });
      }),
    states,
    latest: () => states.at(-1),
    close: () => {
      socket.close();
      server.clients.delete(socket);
    },
  };
}

/** Room settings with the boilerplate filled in; override what a test cares about. */
export async function settingsFor(overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const { DEFAULT_ROOM_SETTINGS } = await import('@gambit3d/shared');
  const base: Record<string, unknown> = {
    ...DEFAULT_ROOM_SETTINGS,
    name: 'Test Room',
    timeControl: {
      initialSeconds: DEFAULT_ROOM_SETTINGS.timeControl.initialSeconds,
      incrementSeconds: DEFAULT_ROOM_SETTINGS.timeControl.incrementSeconds,
    },
  };
  // The server derives this from whether a password was supplied.
  delete base.passwordProtected;
  return { ...base, ...overrides };
}

/** Waits until `predicate` holds for the client's latest room snapshot. */
export async function waitFor(
  client: TestClient,
  predicate: (room: RoomView) => boolean,
  timeoutMs = 4000,
): Promise<RoomView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const latest = client.latest();
    if (latest && predicate(latest)) return latest;
    if (Date.now() > deadline) {
      throw new Error(`condition not met within ${timeoutMs}ms (last phase: ${latest?.game.phase ?? 'none'})`);
    }
    await new Promise((r) => setTimeout(r, 25));
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
