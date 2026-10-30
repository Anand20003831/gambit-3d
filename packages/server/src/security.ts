import {
  createHmac,
  randomBytes,
  randomInt,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';
import { config } from './env.js';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
) => Promise<Buffer>;

/**
 * All cryptography here composes Node's standard primitives (scrypt, HMAC-SHA256,
 * the CSPRNG). Nothing bespoke is invented.
 */

// --- Identifiers ------------------------------------------------------------

/** Crockford base32 minus I, L, O, U so codes are unambiguous when read aloud. */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * URL-safe, high-entropy room identifier.
 * 18 bytes -> 24 base64url characters -> 144 bits.
 */
export function generateRoomId(): string {
  return randomBytes(18).toString('base64url');
}

/**
 * Human-typeable join code drawn from the CSPRNG.
 *
 * Public rooms use 6 characters (~30 bits) because they are listed anyway.
 * Private and LAN rooms use 10 characters (~50 bits), which makes guessing a
 * live room infeasible against the join rate limit.
 */
export function generateJoinCode(mode: 'public' | 'private' | 'lan' | 'local'): string {
  const length = mode === 'public' ? 6 : 10;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return out;
}

export function generateUserId(): string {
  return randomBytes(12).toString('base64url');
}

export function generateId(prefix = ''): string {
  return prefix + randomBytes(9).toString('base64url');
}

// --- Session tokens ---------------------------------------------------------

/**
 * Reconnection token: `<userId>.<nonce>.<hmac>`.
 *
 * The HMAC binds the token to this server's secret, so a token cannot be forged
 * client-side. The nonce is also stored (hashed) in the database, letting a
 * token be revoked without rotating the server secret.
 */
export function issueSessionToken(userId: string): { token: string; nonce: string } {
  const nonce = randomBytes(24).toString('base64url');
  const mac = signToken(userId, nonce);
  return { token: `${userId}.${nonce}.${mac}`, nonce };
}

function signToken(userId: string, nonce: string): string {
  return createHmac('sha256', config.sessionSecret).update(`${userId}:${nonce}`).digest('base64url');
}

export interface ParsedToken {
  userId: string;
  nonce: string;
}

/** Returns null when the token is malformed or the signature does not verify. */
export function verifySessionToken(token: string): ParsedToken | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [userId, nonce, mac] = parts as [string, string, string];
  if (!userId || !nonce || !mac) return null;

  const expected = signToken(userId, nonce);
  if (!constantTimeEqual(mac, expected)) return null;
  return { userId, nonce };
}

export function constantTimeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so the failure path is not obviously shorter.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/** One-way digest used to store token nonces at rest. */
export function hashNonce(nonce: string): string {
  return createHmac('sha256', config.sessionSecret).update(`nonce:${nonce}`).digest('base64url');
}

// --- Password hashing -------------------------------------------------------

const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** Returns `scrypt$<saltBase64>$<hashBase64>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
  const salt = Buffer.from(parts[1] as string, 'base64');
  const expected = Buffer.from(parts[2] as string, 'base64');
  if (salt.length === 0 || expected.length !== SCRYPT_KEYLEN) return false;

  const derived = await scrypt(password.normalize('NFKC'), salt, SCRYPT_KEYLEN);
  return timingSafeEqual(derived, expected);
}

// --- Misc -------------------------------------------------------------------

/** Normalises a join target so `abc-def`, `ABCDEF` and `abcdef` all match a code. */
export function normalizeCode(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^0-9A-Z]/gu, '')
    .replace(/I/gu, '1')
    .replace(/L/gu, '1')
    .replace(/O/gu, '0');
}
