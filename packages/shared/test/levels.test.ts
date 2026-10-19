import { describe, expect, it } from 'vitest';
import { LEVEL, levelForStatus, levelName, normalizeLevel } from '../src/index.js';

describe('normalizeLevel', () => {
  it.each([
    [10, 10],
    [20, 20],
    [30, 30],
    [40, 40],
    [50, 50],
    [60, 60],
    [5, 10],
    [35, 40],
    [99, 60],
    ['30', 30],
    [' 50 ', 50],
  ])('maps the number %s onto the pino band %s', (input, expected) => {
    expect(normalizeLevel(input)).toBe(expected);
  });

  it.each([
    ['warning', LEVEL.warn],
    ['WARN', LEVEL.warn],
    ['Information', LEVEL.info],
    ['err', LEVEL.error],
    ['critical', LEVEL.fatal],
    ['verbose', LEVEL.trace],
    [' debug ', LEVEL.debug],
  ])('maps the name %s', (input, expected) => {
    expect(normalizeLevel(input)).toBe(expected);
  });

  it.each([['loud'], [''], [null], [undefined], [Number.NaN], [{}]])(
    'returns undefined for %s, leaving the default to the caller',
    (input) => {
      expect(normalizeLevel(input)).toBeUndefined();
    },
  );
});

describe('levelForStatus', () => {
  it('reads 5xx as error, 4xx as warn and the rest as info', () => {
    expect(levelForStatus(503)).toBe(LEVEL.error);
    expect(levelForStatus(404)).toBe(LEVEL.warn);
    expect(levelForStatus(302)).toBe(LEVEL.info);
    expect(levelForStatus(200)).toBe(LEVEL.info);
  });
});

describe('levelName', () => {
  it('names each stored number', () => {
    expect([10, 20, 30, 40, 50, 60].map(levelName)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
  });
});
