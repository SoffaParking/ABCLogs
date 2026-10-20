/**
 * Token bucket per ingest key, counted in events: a key may send
 * `ratePerSecond` events per second on average and bursts of up to
 * `burstSeconds` worth. In memory and per process.
 */
export class EventRateLimiter {
  private readonly buckets = new Map<number, { tokens: number; at: number }>();
  private readonly capacity: number;

  constructor(
    private readonly ratePerSecond: number,
    burstSeconds = 5,
  ) {
    this.capacity = ratePerSecond * burstSeconds;
  }

  /** Takes `n` tokens and returns 0, or returns the seconds to wait and takes nothing. */
  take(keyId: number, n: number, now = Date.now()): number {
    const bucket = this.buckets.get(keyId) ?? { tokens: this.capacity, at: now };
    bucket.tokens = Math.min(
      this.capacity,
      bucket.tokens + ((now - bucket.at) / 1000) * this.ratePerSecond,
    );
    bucket.at = now;
    this.buckets.set(keyId, bucket);
    // A batch bigger than the whole burst could never pass; let it through on a full bucket.
    const cost = Math.min(n, this.capacity);
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return 0;
    }
    return Math.max(1, Math.ceil((cost - bucket.tokens) / this.ratePerSecond));
  }
}

/**
 * Bounds how many batches are written at once. Up to `concurrency` run, up to
 * `queue` more wait their turn, and past that callers are told to come back
 * later (503) instead of piling up on the database pool.
 */
export class WriteGate {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(
    private readonly concurrency: number,
    private readonly queue: number,
  ) {}

  /** Runs `fn` under the gate, or returns undefined at once when the queue is full. */
  async run<T>(fn: () => Promise<T>): Promise<{ value: T } | undefined> {
    if (this.running >= this.concurrency) {
      if (this.waiting.length >= this.queue) return undefined;
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.running += 1;
    }
    try {
      return { value: await fn() };
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.running -= 1;
    }
  }
}
