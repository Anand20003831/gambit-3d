import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { z } from 'zod';

const here = path.dirname(fileURLToPath(import.meta.url));
/** packages/server (src/ during dev, dist/ after a build - both are one level down). */
export const SERVER_ROOT = path.resolve(here, '..');
export const REPO_ROOT = path.resolve(SERVER_ROOT, '..', '..');

// Load .env from the repo root, then allow a server-local override.
for (const candidate of [path.join(REPO_ROOT, '.env'), path.join(SERVER_ROOT, '.env')]) {
  if (existsSync(candidate)) dotenv.config({ path: candidate, override: false });
}

const boolish = (fallback: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const intish = (fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return fallback;
      const n = Number.parseInt(v, 10);
      return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
    });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: intish(8787, 1, 65535),
  HOST: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : '127.0.0.1')),

  CORS_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? 'http://localhost:5173,http://127.0.0.1:5173')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ALLOW_LAN_ORIGINS: boolish(true),
  /** Lets the in-app level editor write layouts back into the project. */
  LEVEL_EDITOR: z.string().optional(),
  /** Where the level editor writes scene layouts. Relative paths resolve from the repo root. */
  LAYOUT_DIR: z.string().optional(),
  SESSION_SECRET: z.string().optional(),
  TRUST_PROXY: boolish(false),

  DATABASE_PATH: z.string().optional().transform((v) => (v && v.trim() ? v.trim() : './data/gambit3d.db')),

  ROOM_EMPTY_TTL_MS: intish(300_000, 5_000),
  ROOM_MAX_AGE_MS: intish(86_400_000, 60_000),
  ROOM_SWEEP_INTERVAL_MS: intish(60_000, 1_000),
  DISCONNECT_GRACE_MS: intish(90_000, 5_000),
  MAX_ROOMS: intish(500, 1),
  MAX_ROOMS_PER_IP_PER_HOUR: intish(30, 1),

  RATE_LIMIT_CHAT_PER_MIN: intish(25, 1),
  RATE_LIMIT_MOVES_PER_MIN: intish(300, 1),
  RATE_LIMIT_JOIN_PER_MIN: intish(20, 1),
  RATE_LIMIT_CREATE_PER_MIN: intish(6, 1),
  RATE_LIMIT_HTTP_PER_MIN: intish(240, 1),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('[env] Invalid configuration:\n', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const raw = parsed.data;

/** Explicit on/off wins; otherwise the environment decides. */
function parseEditorFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

/** Resolve a possibly-relative layout directory against the repo root. */
function resolveLayoutDir(value: string | undefined): string {
  const fallback = path.join(REPO_ROOT, 'packages', 'client', 'public', 'layouts');
  if (!value || !value.trim()) return fallback;
  const trimmed = value.trim();
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(REPO_ROOT, trimmed);
}

/** Resolve a possibly-relative database path against the server package root. */
function resolveDbPath(p: string): string {
  if (p === ':memory:') return p;
  return path.isAbsolute(p) ? p : path.resolve(SERVER_ROOT, p);
}

let sessionSecret = raw.SESSION_SECRET?.trim();
let ephemeralSecret = false;
if (!sessionSecret) {
  sessionSecret = randomBytes(48).toString('base64url');
  ephemeralSecret = true;
}

export const config = {
  nodeEnv: raw.NODE_ENV,
  isProduction: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  port: raw.PORT,
  host: raw.HOST,
  /** True when bound to every interface, i.e. reachable from the LAN. */
  bindsAllInterfaces: raw.HOST === '0.0.0.0' || raw.HOST === '::',

  corsOrigins: raw.CORS_ORIGINS,
  allowLanOrigins: raw.ALLOW_LAN_ORIGINS,
  /**
   * Level editor saving. On by default in development, off in production:
   * a public deployment has no business writing files from a web request.
   */
  levelEditor: parseEditorFlag(raw.LEVEL_EDITOR, raw.NODE_ENV !== 'production'),
  /**
   * Where saved scene layouts live. Overridable so a test run cannot write
   * over somebody's hand-tuned map.
   */
  layoutDir: resolveLayoutDir(raw.LAYOUT_DIR),
  sessionSecret,
  /** True when no SESSION_SECRET was supplied, so tokens die with the process. */
  ephemeralSecret,
  trustProxy: raw.TRUST_PROXY,

  databasePath: resolveDbPath(raw.DATABASE_PATH),

  roomEmptyTtlMs: raw.ROOM_EMPTY_TTL_MS,
  roomMaxAgeMs: raw.ROOM_MAX_AGE_MS,
  roomSweepIntervalMs: raw.ROOM_SWEEP_INTERVAL_MS,
  disconnectGraceMs: raw.DISCONNECT_GRACE_MS,
  maxRooms: raw.MAX_ROOMS,
  maxRoomsPerIpPerHour: raw.MAX_ROOMS_PER_IP_PER_HOUR,

  rateLimits: {
    chatPerMin: raw.RATE_LIMIT_CHAT_PER_MIN,
    movesPerMin: raw.RATE_LIMIT_MOVES_PER_MIN,
    joinPerMin: raw.RATE_LIMIT_JOIN_PER_MIN,
    createPerMin: raw.RATE_LIMIT_CREATE_PER_MIN,
    httpPerMin: raw.RATE_LIMIT_HTTP_PER_MIN,
  },
} as const;

export type Config = typeof config;

/**
 * Whether a browser Origin header is allowed to talk to this server.
 *
 * Production deployments should list explicit origins. LAN mode additionally
 * accepts private-network origins so phones on the same Wi-Fi can connect
 * without every device address being enumerated in advance.
 */
export function isOriginAllowed(origin: string | undefined): boolean {
  // Non-browser clients (curl, native sockets, same-origin fetches) send no Origin.
  if (!origin) return true;
  if (config.corsOrigins.includes('*')) return true;
  if (config.corsOrigins.includes(origin)) return true;

  if (!config.allowLanOrigins) return false;

  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return isPrivateHostname(url.hostname);
}

const PRIVATE_V4 =
  /^(10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|127\.\d{1,3}\.\d{1,3}\.\d{1,3})$/u;

export function isPrivateHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/gu, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h.endsWith('.local')) return true; // mDNS / Bonjour names
  if (PRIVATE_V4.test(h)) return true;
  if (h === '::1' || h === '::') return true;
  // Unique-local (fc00::/7) and link-local (fe80::/10) IPv6.
  if (/^f[cd][0-9a-f]{2}:/u.test(h)) return true;
  if (/^fe[89ab][0-9a-f]:/u.test(h)) return true;
  return false;
}

export function describeConfig(): string {
  return [
    `env=${config.nodeEnv}`,
    `bind=${config.host}:${config.port}`,
    `db=${config.databasePath}`,
    `origins=${config.corsOrigins.join('|') || '(none)'}`,
    `lanOrigins=${config.allowLanOrigins}`,
  ].join(' ');
}
