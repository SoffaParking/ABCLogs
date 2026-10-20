import { describe, expect, it } from 'vitest';
import { checkEvent } from '../src/ingest/validate.js';

const now = Date.UTC(2026, 9, 20, 12);
const window = { oldest: now - 14 * 86_400_000, newest: now + 3_600_000 };

describe('checkEvent', () => {
  it('fills in level and route for a request', () => {
    const result = checkEvent(
      { type: 'request', time: now, method: 'post', path: '/orders/77?x=1', status: 503 },
      window,
    );
    expect(result).toMatchObject({
      ok: true,
      event: {
        kind: 'request',
        method: 'POST',
        path: '/orders/77',
        route: '/orders/:id',
        level: 50,
        durationMs: null,
      },
    });
  });

  it('keeps a given route and level', () => {
    const result = checkEvent(
      {
        type: 'request',
        time: now,
        method: 'GET',
        path: '/a/1',
        route: '/a/:n',
        status: 200,
        level: 'debug',
      },
      window,
    );
    expect(result).toMatchObject({ ok: true, event: { route: '/a/:n', level: 20 } });
  });

  it('derives a stable id from the content when none is given', () => {
    const event = { type: 'log', time: now, level: 30, message: 'm' };
    const a = checkEvent(event, window);
    const b = checkEvent({ ...event }, window);
    const c = checkEvent({ ...event, message: 'n' }, window);
    expect(a.ok && b.ok && a.event.id === b.event.id).toBe(true);
    expect(a.ok && c.ok && a.event.id !== c.event.id).toBe(true);
  });

  it('cuts oversized fields instead of refusing the event', () => {
    const result = checkEvent(
      {
        type: 'log',
        time: now,
        level: 50,
        message: 'x'.repeat(20_000),
        error: { stack: 's'.repeat(100_000) },
        attrs: {
          blob: 'y'.repeat(1000),
          more: Array.from({ length: 100 }, () => 'z'.repeat(1000)),
        },
      },
      window,
    );
    expect(result.ok).toBe(true);
    if (result.ok && result.event.kind === 'log') {
      expect(result.event.message).toHaveLength(8192);
      expect(result.event.errorStack).toHaveLength(32768);
      expect(JSON.parse(result.event.attrs!)).toMatchObject({ _truncated: true });
    }
  });

  it.each([
    [
      { type: 'log', time: now, level: 'loud', message: 'm' },
      'level is missing or not a known level',
    ],
    [{ type: 'log', time: now, level: 30 }, 'message must be a string'],
    [
      { type: 'log', time: 'yesterday', level: 30, message: 'm' },
      'time is missing or not a valid timestamp',
    ],
    [
      { type: 'request', time: now, method: 'GET', path: '/', status: 200, durationMs: -1 },
      'durationMs must be a non-negative number',
    ],
    [
      { type: 'request', time: now, method: 'GET!', path: '/', status: 200 },
      'method must be an HTTP method',
    ],
    [{ type: 'request', time: now, method: 'GET', status: 200 }, 'path is required'],
    [{ type: 'log', time: now, level: 30, message: 'm', attrs: [1] }, 'attrs must be an object'],
    [
      { type: 'log', time: now, level: 30, message: 'm', id: 7 },
      'id must be a string of 1 to 128 characters',
    ],
  ])('refuses %j', (event, reason) => {
    expect(checkEvent(event, window)).toEqual({ ok: false, reason });
  });
});
