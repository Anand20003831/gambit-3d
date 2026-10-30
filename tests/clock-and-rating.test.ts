import { describe, expect, it } from 'vitest';
import { GameClock } from '../packages/server/src/clock.js';
import { applyResult, classifyTimeControl, expectedScore, kFactor, RATING } from '@gambit3d/shared';

/**
 * The clock is authoritative, so its arithmetic decides real games. Every test
 * here drives it with explicit timestamps rather than real time, so results are
 * deterministic.
 */

const RAPID = { kind: 'rapid' as const, initialSeconds: 600, incrementSeconds: 5 };
const UNTIMED = { kind: 'untimed' as const, initialSeconds: 0, incrementSeconds: 0 };

describe('GameClock', () => {
  it('starts both sides on the full allowance', () => {
    const clock = new GameClock(RAPID, 0);
    const state = clock.state(0);
    expect(state?.w).toBe(600_000);
    expect(state?.b).toBe(600_000);
    expect(state?.running).toBeNull();
  });

  it('only deducts from the side on the clock', () => {
    const clock = new GameClock(RAPID, 0);
    clock.start('w', 0);
    const snap = clock.peek(10_000);
    expect(snap.w).toBe(590_000);
    expect(snap.b).toBe(600_000);
  });

  it('awards the increment on a completed move and passes the turn', () => {
    const clock = new GameClock(RAPID, 0);
    clock.start('w', 0);
    const spent = clock.commitMove('w', 8_000);

    expect(spent).toBe(8_000);
    const snap = clock.peek(8_000);
    // 600 - 8 spent + 5 increment
    expect(snap.w).toBe(597_000);
    expect(clock.state(8_000)?.running).toBe('b');
  });

  it('does not award increment to a side that has already flagged', () => {
    const clock = new GameClock({ kind: 'blitz', initialSeconds: 10, incrementSeconds: 5 }, 0);
    clock.start('w', 0);
    clock.commitMove('w', 20_000);
    expect(clock.peek(20_000).w).toBe(0);
  });

  it('reports a flag fall for the side that ran out', () => {
    const clock = new GameClock({ kind: 'bullet', initialSeconds: 60, incrementSeconds: 0 }, 0);
    clock.start('w', 0);
    expect(clock.flagged(59_000)).toBeNull();
    expect(clock.flagged(61_000)).toBe('w');
  });

  it('never reports a flag in an untimed game', () => {
    const clock = new GameClock(UNTIMED, 0);
    clock.start('w', 0);
    expect(clock.flagged(10_000_000)).toBeNull();
    expect(clock.state(0)).toBeNull();
    expect(clock.isUntimed).toBe(true);
  });

  it('stops deducting while paused', () => {
    const clock = new GameClock(RAPID, 0);
    clock.start('w', 0);
    clock.pause(5_000);
    expect(clock.peek(60_000).w).toBe(595_000);
  });

  it('gives back the time and removes the increment on a takeback', () => {
    const clock = new GameClock(RAPID, 0);
    clock.start('w', 0);
    const spent = clock.commitMove('w', 12_000);
    const afterMove = clock.peek(12_000).w;

    clock.revertMove('w', spent, true, 12_000);
    // The move never happened, so the clock should read the original value.
    expect(clock.peek(12_000).w).toBe(600_000);
    expect(afterMove).toBe(593_000);
  });

  it('reports how long until the running side flags', () => {
    const clock = new GameClock({ kind: 'blitz', initialSeconds: 300, incrementSeconds: 0 }, 0);
    expect(clock.msUntilFlag(0)).toBe(Number.POSITIVE_INFINITY);
    clock.start('w', 0);
    expect(clock.msUntilFlag(100_000)).toBe(200_000);
  });

  it('restores a persisted clock', () => {
    const clock = new GameClock(RAPID, 0);
    clock.restore({ w: 123_000, b: 456_000, running: 'b' }, 0);
    const snap = clock.peek(1_000);
    expect(snap.w).toBe(123_000);
    expect(snap.b).toBe(455_000);
  });

  it('resets both sides to the starting allowance', () => {
    const clock = new GameClock(RAPID, 0);
    clock.start('w', 0);
    clock.commitMove('w', 30_000);
    clock.reset(30_000);
    expect(clock.peek(30_000)).toEqual({ w: 600_000, b: 600_000 });
  });
});

describe('time control classification', () => {
  it.each([
    [0, 0, 'untimed'],
    [60, 0, 'bullet'],
    [120, 1, 'bullet'],
    [180, 0, 'blitz'],
    [300, 3, 'blitz'],
    [600, 0, 'rapid'],
    [900, 10, 'rapid'],
    [1800, 20, 'classical'],
  ])('%is + %is is %s', (initial, increment, expected) => {
    expect(classifyTimeControl(initial, increment)).toBe(expected);
  });
});

describe('Elo', () => {
  it('gives equal players a 0.5 expected score', () => {
    expect(expectedScore(1500, 1500)).toBeCloseTo(0.5, 6);
  });

  it('gives a 400-point favourite roughly a 0.91 expected score', () => {
    expect(expectedScore(1900, 1500)).toBeCloseTo(0.909, 3);
  });

  it('uses a larger K-factor while provisional', () => {
    expect(kFactor(1500, 0)).toBe(RATING.kProvisional);
    expect(kFactor(1500, RATING.provisionalGames)).toBe(RATING.kStandard);
    expect(kFactor(RATING.eliteThreshold, 100)).toBe(RATING.kElite);
  });

  it('moves ratings in opposite directions by the same amount for equal players', () => {
    const established = { rating: 1500, gamesPlayed: 50 };
    const outcome = applyResult(established, { ...established }, 1);
    expect(outcome.whiteDelta).toBe(10);
    expect(outcome.blackDelta).toBe(-10);
    expect(outcome.whiteAfter).toBe(1510);
    expect(outcome.blackAfter).toBe(1490);
  });

  it('barely moves a heavy favourite who wins', () => {
    const favourite = { rating: 2000, gamesPlayed: 50 };
    const underdog = { rating: 1200, gamesPlayed: 50 };
    const outcome = applyResult(favourite, underdog, 1);
    expect(outcome.whiteDelta).toBeGreaterThanOrEqual(0);
    expect(outcome.whiteDelta).toBeLessThanOrEqual(1);
  });

  it('punishes a heavy favourite who loses', () => {
    const favourite = { rating: 2000, gamesPlayed: 50 };
    const underdog = { rating: 1200, gamesPlayed: 50 };
    const outcome = applyResult(favourite, underdog, 0);
    expect(outcome.whiteDelta).toBeLessThan(-15);
    expect(outcome.blackDelta).toBeGreaterThan(15);
  });

  it('rewards the underdog for a draw', () => {
    const favourite = { rating: 1900, gamesPlayed: 50 };
    const underdog = { rating: 1500, gamesPlayed: 50 };
    const outcome = applyResult(favourite, underdog, 0.5);
    expect(outcome.whiteDelta).toBeLessThan(0);
    expect(outcome.blackDelta).toBeGreaterThan(0);
  });

  it('clamps to the rating floor and ceiling', () => {
    const bottom = applyResult({ rating: RATING.floor, gamesPlayed: 0 }, { rating: 2500, gamesPlayed: 50 }, 0);
    expect(bottom.whiteAfter).toBeGreaterThanOrEqual(RATING.floor);

    const top = applyResult({ rating: RATING.ceiling, gamesPlayed: 200 }, { rating: 1000, gamesPlayed: 50 }, 1);
    expect(top.whiteAfter).toBeLessThanOrEqual(RATING.ceiling);
  });
});
