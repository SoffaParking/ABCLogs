/**
 * Latency histogram with fixed buckets, so histograms from any minute, route
 * or server can be added together and percentiles read from the sum.
 *
 * Bucket `i` counts durations in `(BOUNDS[i-1], BOUNDS[i]]` milliseconds; the
 * last bucket counts everything above the last bound. A percentile read from
 * the histogram is therefore exact to within one bucket.
 */
export const HISTOGRAM_BOUNDS_MS: readonly number[] = [
  1, 2, 5, 10, 15, 25, 40, 60, 80, 100, 150, 200, 300, 400, 500, 750, 1000, 1500, 2000, 3000, 5000,
  10000, 30000,
];

export const HISTOGRAM_BUCKETS = HISTOGRAM_BOUNDS_MS.length + 1;

export function emptyHistogram(): number[] {
  return new Array<number>(HISTOGRAM_BUCKETS).fill(0);
}

/** The bucket a duration falls in. */
export function histogramBucket(durationMs: number): number {
  for (let i = 0; i < HISTOGRAM_BOUNDS_MS.length; i++) {
    if (durationMs <= HISTOGRAM_BOUNDS_MS[i]!) return i;
  }
  return HISTOGRAM_BOUNDS_MS.length;
}

/** Adds `b` into `a` and returns `a`. */
export function addHistograms(a: number[], b: readonly number[]): number[] {
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) a[i] = (a[i] ?? 0) + (b[i] ?? 0);
  return a;
}

/**
 * Estimates the `q` quantile (0.95 for p95) by interpolating inside the bucket
 * where it falls. `maxMs`, the largest duration seen, bounds the open-ended
 * last bucket. Returns null for an empty histogram.
 */
export function histogramQuantile(
  hist: readonly number[],
  q: number,
  maxMs?: number | null,
): number | null {
  const total = hist.reduce((sum, n) => sum + n, 0);
  if (total === 0) return null;
  const rank = Math.min(Math.max(q, 0), 1) * total;
  let seen = 0;
  for (let i = 0; i < HISTOGRAM_BUCKETS; i++) {
    const n = hist[i] ?? 0;
    if (n === 0) continue;
    if (seen + n >= rank) {
      const lower = i === 0 ? 0 : HISTOGRAM_BOUNDS_MS[i - 1]!;
      const last = i === HISTOGRAM_BOUNDS_MS.length;
      let upper = last ? Math.max(maxMs ?? lower * 2, lower) : HISTOGRAM_BOUNDS_MS[i]!;
      if (maxMs != null && maxMs >= lower) upper = Math.min(upper, maxMs);
      const within = (rank - seen) / n;
      return lower + (upper - lower) * within;
    }
    seen += n;
  }
  return maxMs ?? HISTOGRAM_BOUNDS_MS[HISTOGRAM_BOUNDS_MS.length - 1]!;
}
