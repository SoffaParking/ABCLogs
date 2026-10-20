import { describe, expect, it } from 'vitest';
import { inSample, isSampleable, sample, sampleWeight, type EventInput } from '../src/index.js';
import { eventIdForLine } from '../src/node.js';

const request = (status: number): EventInput => ({
  type: 'request',
  time: 1,
  method: 'GET',
  path: '/',
  status,
});
const log = (level: string): EventInput => ({ type: 'log', time: 1, level, message: 'm' });

describe('sampling', () => {
  it('samples only routine events: successful requests and logs below warn', () => {
    expect([200, 302, 404, 500].map((s) => isSampleable(request(s)))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(['debug', 'info', 'warn', 'error'].map((l) => isSampleable(log(l)))).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it('keeps about the given share, the same events every time', () => {
    const ids = Array.from({ length: 20_000 }, (_, i) => eventIdForLine(`line ${i}`));
    const kept = ids.filter((id) => inSample(id, 0.1));
    expect(kept.length / ids.length).toBeGreaterThan(0.09);
    expect(kept.length / ids.length).toBeLessThan(0.11);
    expect(ids.filter((id) => inSample(id, 0.1))).toEqual(kept);
    // A bigger sample contains the smaller one.
    const quarter = new Set(ids.filter((id) => inSample(id, 0.25)));
    expect(kept.every((id) => quarter.has(id))).toBe(true);
  });

  it('marks kept events with their rate and leaves the rest alone', () => {
    const id = eventIdForLine('x');
    const kept = sample(request(200), id, 1 - 1e-9);
    expect(kept).toMatchObject({ sampleRate: 1 - 1e-9 });
    expect(sample(request(500), id, 0.000001)).toEqual(request(500));
    expect(sample(request(200), id, undefined)).toEqual(request(200));
    expect(sample(request(200), '00000000', 0.5)).toMatchObject({ sampleRate: 0.5 });
    expect(sample(request(200), 'ffffffff', 0.5)).toBeNull();
  });

  it('weights a sampled event as 1/rate, within limits', () => {
    expect(sampleWeight(undefined)).toBe(1);
    expect(sampleWeight(0.1)).toBe(10);
    expect(sampleWeight(0.3)).toBe(3);
    expect(sampleWeight(0.00001)).toBe(1000);
    expect(sampleWeight(2)).toBe(1);
  });
});
