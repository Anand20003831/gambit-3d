import type { ClockState, PieceColor, TimeControl } from '@gambit3d/shared';

/**
 * Authoritative game clock.
 *
 * The server is the only place time is deducted. Clients receive periodic
 * snapshots plus the server timestamp they were taken at, and interpolate
 * locally purely for display - a client that lies about elapsed time changes
 * nothing.
 */
export class GameClock {
  private readonly initialMs: number;
  private readonly incrementMs: number;
  private remaining: { w: number; b: number };
  private running: PieceColor | null = null;
  private lastTickAt: number;
  private readonly untimed: boolean;

  constructor(tc: TimeControl, now = Date.now()) {
    this.untimed = tc.kind === 'untimed' || tc.initialSeconds <= 0;
    this.initialMs = Math.max(0, tc.initialSeconds) * 1000;
    this.incrementMs = Math.max(0, tc.incrementSeconds) * 1000;
    this.remaining = { w: this.initialMs, b: this.initialMs };
    this.lastTickAt = now;
  }

  get isUntimed(): boolean {
    return this.untimed;
  }

  /** Starts (or resumes) the given side's clock. */
  start(color: PieceColor, now = Date.now()): void {
    if (this.untimed) return;
    this.settle(now);
    this.running = color;
    this.lastTickAt = now;
  }

  /** Stops both clocks without awarding increment. */
  pause(now = Date.now()): void {
    if (this.untimed) return;
    this.settle(now);
    this.running = null;
  }

  /**
   * Applies a completed move by `color`: deducts their elapsed time, adds the
   * Fischer increment, then hands the clock to the opponent.
   *
   * @returns milliseconds the mover spent on the move.
   */
  commitMove(color: PieceColor, now = Date.now()): number {
    if (this.untimed) return 0;
    const spent = this.settle(now);
    // Increment is only awarded when the mover still had time on the clock.
    if (this.remaining[color] > 0) {
      this.remaining[color] += this.incrementMs;
    }
    this.running = color === 'w' ? 'b' : 'w';
    this.lastTickAt = now;
    return spent;
  }

  /**
   * Rolls back the clock for an undone move: removes the increment and returns
   * the time that was spent. Used by takebacks so a takeback cannot be farmed
   * for extra increment.
   */
  revertMove(color: PieceColor, spentMs: number, hadIncrement: boolean, now = Date.now()): void {
    if (this.untimed) return;
    this.settle(now);
    if (hadIncrement) this.remaining[color] -= this.incrementMs;
    this.remaining[color] += spentMs;
    this.remaining[color] = Math.min(this.remaining[color], this.initialMs + this.incrementMs * 200);
    this.running = color;
    this.lastTickAt = now;
  }

  /** Folds elapsed wall-clock time into the running side's remaining time. */
  private settle(now: number): number {
    if (this.untimed || this.running === null) {
      this.lastTickAt = now;
      return 0;
    }
    const elapsed = Math.max(0, now - this.lastTickAt);
    this.remaining[this.running] = Math.max(0, this.remaining[this.running] - elapsed);
    this.lastTickAt = now;
    return elapsed;
  }

  /** The side whose flag has fallen, or null. Does not mutate state. */
  flagged(now = Date.now()): PieceColor | null {
    if (this.untimed) return null;
    const snap = this.peek(now);
    if (snap.w <= 0) return 'w';
    if (snap.b <= 0) return 'b';
    return null;
  }

  /** Non-mutating view of the current remaining time. */
  peek(now = Date.now()): { w: number; b: number } {
    if (this.untimed || this.running === null) return { ...this.remaining };
    const elapsed = Math.max(0, now - this.lastTickAt);
    const out = { ...this.remaining };
    out[this.running] = Math.max(0, out[this.running] - elapsed);
    return out;
  }

  state(now = Date.now()): ClockState | null {
    if (this.untimed) return null;
    const snap = this.peek(now);
    return { w: snap.w, b: snap.b, running: this.running, updatedAt: now };
  }

  /** Milliseconds until the running side flags, or Infinity. */
  msUntilFlag(now = Date.now()): number {
    if (this.untimed || this.running === null) return Number.POSITIVE_INFINITY;
    return Math.max(0, this.peek(now)[this.running]);
  }

  reset(now = Date.now()): void {
    this.remaining = { w: this.initialMs, b: this.initialMs };
    this.running = null;
    this.lastTickAt = now;
  }

  /** Restores a persisted clock (used after a server restart). */
  restore(state: { w: number; b: number; running: PieceColor | null }, now = Date.now()): void {
    if (this.untimed) return;
    this.remaining = { w: Math.max(0, state.w), b: Math.max(0, state.b) };
    this.running = state.running;
    this.lastTickAt = now;
  }

  get incrementMilliseconds(): number {
    return this.incrementMs;
  }
}
