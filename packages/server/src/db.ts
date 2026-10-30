import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { RATING } from '@gambit3d/shared';
import { config } from './env.js';
import { generateUserId, hashNonce } from './security.js';

/**
 * Persistence layer.
 *
 * Uses Node's built-in `node:sqlite` so there is no native module to compile on
 * a fresh Windows machine. Everything the server needs to survive a restart -
 * identities, ratings, room definitions, bans and finished games - lives here.
 */

export interface UserRow {
  id: string;
  name: string;
  rating: number;
  games_played: number;
  created_at: number;
  last_seen_at: number;
}

export interface RoomRow {
  id: string;
  code: string;
  mode: string;
  host_user_id: string;
  settings_json: string;
  password_hash: string | null;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
}

export interface BanRow {
  room_id: string;
  user_id: string;
  name: string;
  created_at: number;
}

export interface GameRow {
  id: string;
  room_id: string;
  white_user_id: string | null;
  black_user_id: string | null;
  result: string;
  reason: string;
  pgn: string;
  final_fen: string;
  rated: number;
  white_rating_before: number | null;
  black_rating_before: number | null;
  white_rating_after: number | null;
  black_rating_after: number | null;
  started_at: number | null;
  ended_at: number;
}

let db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (db) return db;
  db = openDatabase(config.databasePath);
  return db;
}

export function openDatabase(filePath: string): DatabaseSync {
  if (filePath !== ':memory:') {
    mkdirSync(path.dirname(filePath), { recursive: true });
  }
  const handle = new DatabaseSync(filePath);
  handle.exec('PRAGMA journal_mode = WAL;');
  handle.exec('PRAGMA foreign_keys = ON;');
  handle.exec('PRAGMA busy_timeout = 5000;');
  migrate(handle);
  return handle;
}

/** For tests: swap in an isolated database. */
export function setDb(handle: DatabaseSync | null): void {
  db = handle;
}

export function closeDb(): void {
  try {
    db?.close();
  } catch {
    /* already closed */
  }
  db = null;
}

function migrate(handle: DatabaseSync): void {
  handle.exec(`
    CREATE TABLE IF NOT EXISTS schema_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id            TEXT PRIMARY KEY,
      name          TEXT NOT NULL,
      rating        INTEGER NOT NULL DEFAULT ${RATING.initial},
      games_played  INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      last_seen_at  INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      nonce_hash  TEXT PRIMARY KEY,
      user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at  INTEGER NOT NULL,
      last_used_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

    CREATE TABLE IF NOT EXISTS rooms (
      id            TEXT PRIMARY KEY,
      code          TEXT NOT NULL,
      mode          TEXT NOT NULL,
      host_user_id  TEXT NOT NULL,
      settings_json TEXT NOT NULL,
      password_hash TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      closed_at     INTEGER
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rooms_code ON rooms(code);
    CREATE INDEX IF NOT EXISTS idx_rooms_mode ON rooms(mode);

    CREATE TABLE IF NOT EXISTS room_bans (
      room_id    TEXT NOT NULL,
      user_id    TEXT NOT NULL,
      name       TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (room_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS games (
      id                  TEXT PRIMARY KEY,
      room_id             TEXT NOT NULL,
      white_user_id       TEXT,
      black_user_id       TEXT,
      result              TEXT NOT NULL,
      reason              TEXT NOT NULL,
      pgn                 TEXT NOT NULL,
      final_fen           TEXT NOT NULL,
      rated               INTEGER NOT NULL DEFAULT 0,
      white_rating_before INTEGER,
      black_rating_before INTEGER,
      white_rating_after  INTEGER,
      black_rating_after  INTEGER,
      started_at          INTEGER,
      ended_at            INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_games_room ON games(room_id);
    CREATE INDEX IF NOT EXISTS idx_games_white ON games(white_user_id);
    CREATE INDEX IF NOT EXISTS idx_games_black ON games(black_user_id);
  `);
  handle
    .prepare(`INSERT INTO schema_meta (key, value) VALUES ('version', '1') ON CONFLICT(key) DO NOTHING`)
    .run();
}

// --- Users ------------------------------------------------------------------

export function createUser(name: string): UserRow {
  const now = Date.now();
  const id = generateUserId();
  getDb()
    .prepare(
      `INSERT INTO users (id, name, rating, games_played, created_at, last_seen_at)
       VALUES (?, ?, ?, 0, ?, ?)`,
    )
    .run(id, name, RATING.initial, now, now);
  return { id, name, rating: RATING.initial, games_played: 0, created_at: now, last_seen_at: now };
}

export function findUser(id: string): UserRow | null {
  const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(id);
  return (row as UserRow | undefined) ?? null;
}

export function touchUser(id: string, name?: string): void {
  const now = Date.now();
  if (name) {
    getDb().prepare('UPDATE users SET last_seen_at = ?, name = ? WHERE id = ?').run(now, name, id);
  } else {
    getDb().prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, id);
  }
}

export function updateRating(id: string, rating: number, gamesPlayed: number): void {
  getDb().prepare('UPDATE users SET rating = ?, games_played = ? WHERE id = ?').run(rating, gamesPlayed, id);
}

// --- Sessions ---------------------------------------------------------------

export function recordSession(userId: string, nonce: string): void {
  const now = Date.now();
  getDb()
    .prepare(
      `INSERT INTO sessions (nonce_hash, user_id, created_at, last_used_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(nonce_hash) DO UPDATE SET last_used_at = excluded.last_used_at`,
    )
    .run(hashNonce(nonce), userId, now, now);
}

export function sessionIsValid(userId: string, nonce: string): boolean {
  const row = getDb()
    .prepare('SELECT user_id FROM sessions WHERE nonce_hash = ?')
    .get(hashNonce(nonce)) as { user_id: string } | undefined;
  if (!row || row.user_id !== userId) return false;
  getDb().prepare('UPDATE sessions SET last_used_at = ? WHERE nonce_hash = ?').run(Date.now(), hashNonce(nonce));
  return true;
}

export function revokeSession(nonce: string): void {
  getDb().prepare('DELETE FROM sessions WHERE nonce_hash = ?').run(hashNonce(nonce));
}

/** Drops sessions untouched for longer than `maxAgeMs`. */
export function pruneSessions(maxAgeMs: number): number {
  const cutoff = Date.now() - maxAgeMs;
  const info = getDb().prepare('DELETE FROM sessions WHERE last_used_at < ?').run(cutoff);
  return Number(info.changes);
}

// --- Rooms ------------------------------------------------------------------

export function persistRoom(row: Omit<RoomRow, 'closed_at'> & { closed_at?: number | null }): void {
  getDb()
    .prepare(
      `INSERT INTO rooms (id, code, mode, host_user_id, settings_json, password_hash, created_at, updated_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         code = excluded.code,
         mode = excluded.mode,
         host_user_id = excluded.host_user_id,
         settings_json = excluded.settings_json,
         password_hash = excluded.password_hash,
         updated_at = excluded.updated_at,
         closed_at = excluded.closed_at`,
    )
    .run(
      row.id,
      row.code,
      row.mode,
      row.host_user_id,
      row.settings_json,
      row.password_hash,
      row.created_at,
      row.updated_at,
      row.closed_at ?? null,
    );
}

export function closeRoomRow(roomId: string): void {
  getDb().prepare('UPDATE rooms SET closed_at = ? WHERE id = ?').run(Date.now(), roomId);
}

export function deleteRoomRow(roomId: string): void {
  getDb().prepare('DELETE FROM rooms WHERE id = ?').run(roomId);
}

export function findRoomRow(id: string): RoomRow | null {
  return (getDb().prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined) ?? null;
}

export function findRoomRowByCode(code: string): RoomRow | null {
  return (
    (getDb().prepare('SELECT * FROM rooms WHERE code = ?').get(code) as RoomRow | undefined) ?? null
  );
}

export function listOpenRoomRows(): RoomRow[] {
  return getDb().prepare('SELECT * FROM rooms WHERE closed_at IS NULL').all() as unknown as RoomRow[];
}

/** True when the code is already taken by a live room. */
export function codeExists(code: string): boolean {
  const row = getDb().prepare('SELECT 1 AS x FROM rooms WHERE code = ?').get(code);
  return row !== undefined;
}

// --- Bans -------------------------------------------------------------------

export function addBan(roomId: string, userId: string, name: string): void {
  getDb()
    .prepare(
      `INSERT INTO room_bans (room_id, user_id, name, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, user_id) DO NOTHING`,
    )
    .run(roomId, userId, name, Date.now());
}

export function removeBan(roomId: string, userId: string): void {
  getDb().prepare('DELETE FROM room_bans WHERE room_id = ? AND user_id = ?').run(roomId, userId);
}

export function isBanned(roomId: string, userId: string): boolean {
  return getDb().prepare('SELECT 1 AS x FROM room_bans WHERE room_id = ? AND user_id = ?').get(roomId, userId) !== undefined;
}

export function listBans(roomId: string): BanRow[] {
  return getDb()
    .prepare('SELECT * FROM room_bans WHERE room_id = ? ORDER BY created_at DESC')
    .all(roomId) as unknown as BanRow[];
}

export function clearBans(roomId: string): void {
  getDb().prepare('DELETE FROM room_bans WHERE room_id = ?').run(roomId);
}

// --- Games ------------------------------------------------------------------

export function recordGame(row: GameRow): void {
  getDb()
    .prepare(
      `INSERT INTO games (
         id, room_id, white_user_id, black_user_id, result, reason, pgn, final_fen, rated,
         white_rating_before, black_rating_before, white_rating_after, black_rating_after,
         started_at, ended_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.room_id,
      row.white_user_id,
      row.black_user_id,
      row.result,
      row.reason,
      row.pgn,
      row.final_fen,
      row.rated,
      row.white_rating_before,
      row.black_rating_before,
      row.white_rating_after,
      row.black_rating_after,
      row.started_at,
      row.ended_at,
    );
}

export function recentGamesForUser(userId: string, limit = 20): GameRow[] {
  return getDb()
    .prepare(
      `SELECT * FROM games WHERE white_user_id = ? OR black_user_id = ?
       ORDER BY ended_at DESC LIMIT ?`,
    )
    .all(userId, userId, limit) as unknown as GameRow[];
}

export function countGames(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM games').get() as { n: number };
  return row.n;
}
