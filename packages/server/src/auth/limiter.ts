/**
 * Counts failures per key in a fixed window: after `max` failures, the key is
 * refused until the window ends. In memory, so it resets on restart and is per
 * process; enough to make online password guessing impractical.
 */
export class FailureLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** Seconds until `key` may try again, or 0 when it may now. */
  retryAfter(key: string, now = Date.now()): number {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) return 0;
    return entry.count >= this.max ? Math.ceil((entry.resetAt - now) / 1000) : 0;
  }

  fail(key: string, now = Date.now()): void {
    const entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
      if (this.hits.size > 10_000) this.sweep(now);
    } else {
      entry.count += 1;
    }
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  private sweep(now: number): void {
    for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
  }
}
