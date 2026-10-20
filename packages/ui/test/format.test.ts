import { describe, expect, it } from 'vitest';
import { niceMax } from '../src/components/charts';
import { formatAgo, formatCount, formatDuration, formatPercent, formatRate } from '../src/format';
import { rangeFor, rangeParams } from '../src/range';

describe('formatting', () => {
  it('durations pick a readable unit', () => {
    expect(formatDuration(null)).toBe('–');
    expect(formatDuration(0.4)).toBe('<1 ms');
    expect(formatDuration(12.6)).toBe('13 ms');
    expect(formatDuration(1500)).toBe('1.50 s');
    expect(formatDuration(25_000)).toBe('25.0 s');
    expect(formatDuration(90_000)).toBe('1.5 min');
  });

  it('percentages keep small rates visible', () => {
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.0004)).toBe('<0.1%');
    expect(formatPercent(0.031)).toBe('3.1%');
    expect(formatPercent(0.5)).toBe('50%');
  });

  it('counts compact only when large', () => {
    expect(formatCount(4840, { compact: true })).toBe(new Intl.NumberFormat().format(4840));
    expect(formatCount(48_400, { compact: true })).toMatch(/48/);
    expect(formatRate(0.05)).toBe('0.05');
    expect(formatRate(3.94)).toBe('3.9');
  });

  it('relative times', () => {
    const now = Date.parse('2026-10-20T12:00:00Z');
    expect(formatAgo(null, now)).toBe('never');
    expect(formatAgo('2026-10-20T11:59:30Z', now)).toBe('just now');
    expect(formatAgo('2026-10-20T11:45:00Z', now)).toBe('15 min ago');
    expect(formatAgo('2026-10-20T09:00:00Z', now)).toBe('3 h ago');
  });
});

describe('charts', () => {
  it('rounds the axis maximum up to 1, 2, 2.5 or 5 times a power of ten', () => {
    expect(niceMax(0)).toBe(1);
    expect(niceMax(7)).toBe(10);
    expect(niceMax(230)).toBe(250);
    expect(niceMax(1100)).toBe(2000);
    expect(niceMax(4200)).toBe(5000);
  });
});

describe('ranges', () => {
  it('falls back to the last hour and ends now', () => {
    expect(rangeFor('nonsense').id).toBe('1h');
    const { from, to } = rangeParams('24h');
    expect(to - from).toBe(24 * 3_600_000);
    expect(Math.abs(Date.now() - to)).toBeLessThan(1000);
  });
});
