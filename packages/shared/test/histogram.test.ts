import { describe, expect, it } from 'vitest';
import {
  addHistograms,
  emptyHistogram,
  HISTOGRAM_BOUNDS_MS,
  HISTOGRAM_BUCKETS,
  histogramBucket,
  histogramQuantile,
} from '../src/index.js';

function histogramOf(durations: number[]): number[] {
  const hist = emptyHistogram();
  for (const d of durations) hist[histogramBucket(d)]! += 1;
  return hist;
}

function exactQuantile(durations: number[], q: number): number {
  const sorted = [...durations].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)]!;
}

describe('histogram', () => {
  it('has 24 buckets, the last one open-ended', () => {
    expect(HISTOGRAM_BUCKETS).toBe(24);
    expect(histogramBucket(0)).toBe(0);
    expect(histogramBucket(1)).toBe(0);
    expect(histogramBucket(1.01)).toBe(1);
    expect(histogramBucket(30000)).toBe(22);
    expect(histogramBucket(30001)).toBe(23);
  });

  it('adds histograms bucket by bucket', () => {
    const a = histogramOf([1, 50, 50]);
    addHistograms(a, histogramOf([50, 9000]));
    expect(a.reduce((s, n) => s + n, 0)).toBe(5);
    expect(a[histogramBucket(50)]).toBe(3);
  });

  it('returns null for an empty histogram', () => {
    expect(histogramQuantile(emptyHistogram(), 0.5)).toBeNull();
  });

  it('estimates percentiles within one bucket of the exact value', () => {
    // A skewed, deterministic latency sample: mostly fast, a slow tail.
    const durations: number[] = [];
    let seed = 7;
    for (let i = 0; i < 5000; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const u = seed / 2 ** 31;
      durations.push(u < 0.9 ? 5 + u * 100 : 200 + (u - 0.9) * 40000);
    }
    const hist = histogramOf(durations);
    const max = Math.max(...durations);
    for (const q of [0.5, 0.9, 0.95, 0.99]) {
      const exact = exactQuantile(durations, q);
      const estimate = histogramQuantile(hist, q, max)!;
      const bucket = histogramBucket(exact);
      const lower = bucket === 0 ? 0 : HISTOGRAM_BOUNDS_MS[bucket - 1]!;
      const upper = HISTOGRAM_BOUNDS_MS[bucket] ?? max;
      expect(estimate).toBeGreaterThanOrEqual(lower);
      expect(estimate).toBeLessThanOrEqual(upper);
    }
  });

  it('bounds the open-ended bucket by the largest duration seen', () => {
    const hist = histogramOf([45000, 50000]);
    expect(histogramQuantile(hist, 1, 50000)).toBe(50000);
    expect(histogramQuantile(hist, 0.5, 50000)).toBeLessThanOrEqual(50000);
  });
});
