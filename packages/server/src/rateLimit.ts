/**
 * Token-bucket rate limiting.
 *
 * Buckets are keyed by `<action>:<subject>` where the subject is a user id for
 * socket actions and an IP for HTTP and room creation. Buckets refill
 * continuously, so a client that stays under the sustained rate never trips the
 * limiter even after a short burst.
 */

export interface BucketConfig {
  /** Sustained rate, in operations per minute. */
  perMinute: number;
  /** Maximum burst size. Defaults to `ceil(perMinute / 4)`, minimum 3. */
  burst?: number;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
}

export interface LimitDecision {
  allowed: boolean;
  /** Milliseconds until one more token is available. */
  retryAfterMs: number;
  remaining: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly configs = new Map<string, Required<BucketConfig>>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(configs: Record<string, BucketConfig>) {
    for (const [action, cfg] of Object.entries(configs)) {
      this.configs.set(action, {
        perMinute: cfg.perMinute,
        burst: cfg.burst ?? Math.max(3, Math.ceil(cfg.perMinute / 4)),
      });
    }
  }

  /** Consumes one token for `action` by `subject`. */
  check(action: string, subject: string, now = Date.now()): LimitDecision {
    const cfg = this.configs.get(action);
    if (!cfg) return { allowed: true, retryAfterMs: 0, remaining: Number.POSITIVE_INFINITY };

    const key = `${action}:${subject}`;
    let bucket = this.buckets.get(key);
    if (!bucket) {
      bucket = {
        tokens: cfg.burst,
        lastRefill: now,
        capacity: cfg.burst,
        refillPerMs: cfg.perMinute / 60_000,
      };
      this.buckets.set(key, bucket);
    }

    const elapsed = Math.max(0, now - bucket.lastRefill);
    bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs);
    bucket.lastRefill = now;

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { allowed: true, retryAfterMs: 0, remaining: Math.floor(bucket.tokens) };
    }

    const deficit = 1 - bucket.tokens;
    return {
      allowed: false,
      retryAfterMs: Math.ceil(deficit / bucket.refillPerMs),
      remaining: 0,
    };
  }

  /** Drops a subject's buckets, e.g. when they disconnect. */
  forget(subject: string): void {
    const suffix = `:${subject}`;
    for (const key of this.buckets.keys()) {
      if (key.endsWith(suffix)) this.buckets.delete(key);
    }
  }

  /** Removes buckets that have been idle long enough to be fully refilled. */
  sweep(now = Date.now(), idleMs = 10 * 60_000): number {
    let removed = 0;
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.lastRefill > idleMs) {
        this.buckets.delete(key);
        removed += 1;
      }
    }
    return removed;
  }

  startSweeping(intervalMs = 5 * 60_000): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), intervalMs);
    this.sweepTimer.unref?.();
  }

  stopSweeping(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
  }

  get size(): number {
    return this.buckets.size;
  }
}

/**
 * A simple sliding-window counter, used where a hard hourly cap is wanted
 * rather than a refilling bucket (room creation per IP).
 */
export class SlidingWindowCounter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  check(subject: string, now = Date.now()): LimitDecision {
    const cutoff = now - this.windowMs;
    const list = (this.hits.get(subject) ?? []).filter((t) => t > cutoff);

    if (list.length >= this.limit) {
      const oldest = list[0] ?? now;
      this.hits.set(subject, list);
      return { allowed: false, retryAfterMs: Math.max(0, oldest + this.windowMs - now), remaining: 0 };
    }

    list.push(now);
    this.hits.set(subject, list);
    return { allowed: true, retryAfterMs: 0, remaining: this.limit - list.length };
  }

  sweep(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [subject, list] of this.hits) {
      const kept = list.filter((t) => t > cutoff);
      if (kept.length === 0) this.hits.delete(subject);
      else this.hits.set(subject, kept);
    }
  }

  forget(subject: string): void {
    this.hits.delete(subject);
  }
}
