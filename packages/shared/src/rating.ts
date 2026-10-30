import { RATING } from './constants.js';

/**
 * A small, real Elo implementation.
 *
 * This is deliberately modest: it is a genuine Elo pool scoped to this server's
 * SQLite database, not a claim of parity with FIDE or any online federation.
 * Ratings only move for rated games where both seats were filled by distinct
 * identities.
 */

export type Score = 0 | 0.5 | 1;

export function expectedScore(ratingA: number, ratingB: number): number {
  return 1 / (1 + 10 ** ((ratingB - ratingA) / 400));
}

export function kFactor(rating: number, gamesPlayed: number): number {
  if (gamesPlayed < RATING.provisionalGames) return RATING.kProvisional;
  if (rating >= RATING.eliteThreshold) return RATING.kElite;
  return RATING.kStandard;
}

export function clampRating(rating: number): number {
  return Math.min(RATING.ceiling, Math.max(RATING.floor, Math.round(rating)));
}

export interface RatedPlayer {
  rating: number;
  gamesPlayed: number;
}

export interface RatingOutcome {
  whiteAfter: number;
  blackAfter: number;
  whiteDelta: number;
  blackDelta: number;
}

/**
 * @param whiteScore 1 for a white win, 0.5 for a draw, 0 for a black win.
 */
export function applyResult(white: RatedPlayer, black: RatedPlayer, whiteScore: Score): RatingOutcome {
  const expWhite = expectedScore(white.rating, black.rating);
  const expBlack = 1 - expWhite;
  const blackScore = (1 - whiteScore) as Score;

  const kW = kFactor(white.rating, white.gamesPlayed);
  const kB = kFactor(black.rating, black.gamesPlayed);

  const whiteAfter = clampRating(white.rating + kW * (whiteScore - expWhite));
  const blackAfter = clampRating(black.rating + kB * (blackScore - expBlack));

  return {
    whiteAfter,
    blackAfter,
    whiteDelta: whiteAfter - white.rating,
    blackDelta: blackAfter - black.rating,
  };
}

export function isProvisional(gamesPlayed: number): boolean {
  return gamesPlayed < RATING.provisionalGames;
}

export function formatRating(rating: number, provisional: boolean): string {
  return provisional ? `${rating}?` : String(rating);
}
