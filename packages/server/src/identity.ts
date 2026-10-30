import {
  RATING,
  displayNameSchema,
  err,
  identifyRequestSchema,
  isProvisional,
  ok,
  type IdentityGrant,
  type Result,
} from '@gambit3d/shared';
import * as db from './db.js';
import { issueSessionToken, verifySessionToken } from './security.js';
import type { UserIdentity } from './room.js';

/**
 * Guest identity management.
 *
 * There are no accounts or passwords. A browser gets an opaque, HMAC-signed
 * bearer token on first contact and stores it; presenting that token later
 * reclaims the same identity, rating and - critically - any seat it still holds
 * in a live game. That is what makes reconnection work across a refresh, a
 * crashed tab, or a phone that went to sleep.
 */

export interface ResolvedIdentity {
  identity: UserIdentity;
  grant: IdentityGrant;
  /** True when a brand new identity was minted for this request. */
  isNew: boolean;
}

export function identify(payload: unknown): Result<ResolvedIdentity> {
  const parsed = identifyRequestSchema.safeParse(payload ?? {});
  if (!parsed.success) {
    return err('BAD_REQUEST', 'That name is not usable.', {
      details: parsed.error.flatten().fieldErrors as Record<string, string[]>,
    });
  }

  const { token, name } = parsed.data;

  if (token) {
    const claim = verifySessionToken(token);
    if (claim && db.sessionIsValid(claim.userId, claim.nonce)) {
      const row = db.findUser(claim.userId);
      if (row) {
        const finalName = name ?? row.name;
        db.touchUser(row.id, finalName);
        const identity: UserIdentity = {
          id: row.id,
          name: finalName,
          rating: row.rating,
          gamesPlayed: row.games_played,
        };
        return ok({
          identity,
          grant: {
            userId: row.id,
            name: finalName,
            token, // still valid - do not rotate on every reconnect
            rating: row.rating,
            gamesPlayed: row.games_played,
            provisional: isProvisional(row.games_played),
          },
          isNew: false,
        });
      }
    }
    // A token that does not verify is simply replaced; the client is not told
    // which of "expired", "revoked" or "forged" applied.
  }

  const chosen = name ?? generateGuestName();
  const validated = displayNameSchema.safeParse(chosen);
  const finalName = validated.success ? validated.data : generateGuestName();

  const row = db.createUser(finalName);
  const { token: freshToken, nonce } = issueSessionToken(row.id);
  db.recordSession(row.id, nonce);

  return ok({
    identity: { id: row.id, name: finalName, rating: row.rating, gamesPlayed: row.games_played },
    grant: {
      userId: row.id,
      name: finalName,
      token: freshToken,
      rating: row.rating,
      gamesPlayed: row.games_played,
      provisional: isProvisional(row.games_played),
    },
    isNew: true,
  });
}

/** Looks up a known identity without creating one. */
export function lookupIdentity(userId: string): UserIdentity | null {
  const row = db.findUser(userId);
  if (!row) return null;
  return { id: row.id, name: row.name, rating: row.rating, gamesPlayed: row.games_played };
}

export function renameIdentity(userId: string, name: string): Result<{ name: string }> {
  const validated = displayNameSchema.safeParse(name);
  if (!validated.success) {
    return err('BAD_REQUEST', 'That name is not usable.', {
      details: { name: validated.error.issues.map((i) => i.message) },
    });
  }
  db.touchUser(userId, validated.data);
  return ok({ name: validated.data });
}

/**
 * True when the identity has never finished a rated game, i.e. it is a fresh
 * guest. Hosts can refuse these with the "allow guests" setting.
 */
export function isGuestIdentity(identity: UserIdentity): boolean {
  return identity.gamesPlayed === 0 && identity.rating === RATING.initial;
}

const ADJECTIVES = [
  'Swift', 'Quiet', 'Bright', 'Clever', 'Bold', 'Calm', 'Keen', 'Lucky',
  'Noble', 'Sly', 'Steady', 'Wily', 'Amber', 'Cobalt', 'Crimson', 'Jade',
] as const;

const NOUNS = [
  'Rook', 'Knight', 'Bishop', 'Pawn', 'Gambit', 'Castle', 'Falcon', 'Comet',
  'Lantern', 'Willow', 'Ember', 'Harbor', 'Meridian', 'Cipher', 'Vector', 'Quartz',
] as const;

export function generateGuestName(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)] ?? 'Swift';
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)] ?? 'Pawn';
  const digits = String(Math.floor(Math.random() * 90) + 10);
  return `${a}${n}${digits}`;
}
