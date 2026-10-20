import { describe, expect, it } from 'vitest';
import { mapLogLine, parseTime, unwrapLine } from '../src/index.js';
import { eventIdForLine } from '../src/node.js';

const T = '2026-10-19T12:00:00.000Z';
const ms = Date.parse(T);

function map(obj: unknown, options = {}) {
  return mapLogLine(JSON.stringify(obj), options);
}

describe('mapLogLine: requests', () => {
  it('reads a flat access-log line (the Soffa shape)', () => {
    const result = map({
      level: 40,
      time: T,
      service: 'parking-backend',
      requestId: 'r-1',
      method: 'get',
      path: '/api/users/42?x=1',
      status: 404,
      durationMs: 12,
      companyId: 3,
      query: { x: '1' },
      body: { password: 'x' },
      msg: 'request',
    });
    expect(result).toEqual({
      ok: true,
      event: {
        type: 'request',
        time: ms,
        service: 'parking-backend',
        requestId: 'r-1',
        level: 40,
        method: 'GET',
        path: '/api/users/42',
        status: 404,
        durationMs: 12,
        attrs: { companyId: 3 },
      },
    });
  });

  it('reads a pino-http line', () => {
    const result = map({
      level: 30,
      time: ms,
      req: { id: 7, method: 'POST', url: '/orders?draft=1', headers: { authorization: 'x' } },
      res: { statusCode: 201 },
      responseTime: 33.5,
      msg: 'request completed',
    });
    expect(result.ok && result.event).toMatchObject({
      type: 'request',
      requestId: '7',
      method: 'POST',
      path: '/orders',
      status: 201,
      durationMs: 33.5,
    });
    expect(result.ok && result.event.attrs).toBeUndefined();
  });

  it('defaults the level from the status', () => {
    const result = map({ time: T, method: 'GET', path: '/', status: 503 });
    expect(result.ok && result.event.level).toBe(50);
  });

  it('keeps bodies only when asked, and redacts them', () => {
    const line = {
      time: T,
      method: 'POST',
      url: '/login',
      status: 200,
      body: { email: 'a', password: 'b' },
    };
    const result = map(line, { includeBodies: true });
    expect(result.ok && result.event.attrs).toEqual({
      body: { email: 'a', password: '[redacted]' },
    });
  });
});

describe('mapLogLine: logs', () => {
  it('reads a pino error with a serialised err', () => {
    const result = map({
      level: 50,
      time: T,
      reqId: 'r-9',
      err: {
        type: 'TypeError',
        message: 'x is undefined',
        stack: 'TypeError: x is undefined\n    at f (a.js:1:1)',
      },
      msg: 'handler failed',
    });
    expect(result).toEqual({
      ok: true,
      event: {
        type: 'log',
        time: ms,
        requestId: 'r-9',
        level: 50,
        message: 'handler failed',
        error: {
          type: 'TypeError',
          message: 'x is undefined',
          stack: 'TypeError: x is undefined\n    at f (a.js:1:1)',
        },
      },
    });
  });

  it('reads an error given as a string plus a separate stack (the Soffa shape)', () => {
    const result = map({
      level: 50,
      time: T,
      err: 'connect ETIMEDOUT',
      stack: 'Error: connect ETIMEDOUT\n    at x',
      path: '/api/parking',
      status: 500,
      requestId: 'r-2',
      msg: 'Request error',
    });
    expect(result.ok && result.event).toMatchObject({
      type: 'log',
      message: 'Request error',
      requestId: 'r-2',
      error: {
        type: 'Error',
        message: 'connect ETIMEDOUT',
        stack: 'Error: connect ETIMEDOUT\n    at x',
      },
      // A path and status alone do not make the line the request itself.
      attrs: { path: '/api/parking', status: 500 },
    });
  });

  it('maps level names and defaults to info', () => {
    expect(mapLogLine(`{"time":"${T}","level":"WARNING","msg":"m"}`)).toMatchObject({
      event: { level: 40 },
    });
    expect(mapLogLine(`{"time":"${T}","msg":"m"}`)).toMatchObject({ event: { level: 30 } });
  });

  it('drops logger bookkeeping and takes the service from pino name', () => {
    const result = map({ level: 30, time: T, pid: 1, hostname: 'h', v: 1, name: 'api', msg: 'hi' });
    expect(result).toEqual({
      ok: true,
      event: { type: 'log', time: ms, service: 'api', level: 30, message: 'hi' },
    });
  });

  it('uses the error message when the line has none', () => {
    const result = map({ level: 50, time: T, err: { message: 'boom' } });
    expect(result.ok && result.event.type === 'log' && result.event.message).toBe('boom');
  });
});

describe('mapLogLine: what it skips', () => {
  it('skips blank lines, plain text and lines without a time', () => {
    expect(mapLogLine('   ')).toEqual({ ok: false, reason: 'blank' });
    expect(mapLogLine('Server started')).toEqual({ ok: false, reason: 'not-json' });
    expect(mapLogLine('[1,2]')).toEqual({ ok: false, reason: 'not-json' });
    expect(mapLogLine('{"msg":"x"}')).toEqual({ ok: false, reason: 'no-time' });
  });

  it('imports plain text as info logs when asked', () => {
    expect(
      mapLogLine('DB init failed', { plainText: true, fallbackTime: ms, service: 's' }),
    ).toEqual({
      ok: true,
      event: { type: 'log', time: ms, level: 30, message: 'DB init failed', service: 's' },
    });
  });

  it('the service option fills in only when the line names none', () => {
    expect(map({ time: T, msg: 'x' }, { service: 'fallback' })).toMatchObject({
      event: { service: 'fallback' },
    });
    expect(map({ time: T, msg: 'x', service: 'own' }, { service: 'fallback' })).toMatchObject({
      event: { service: 'own' },
    });
  });
});

describe('parseTime', () => {
  it('reads ISO strings, epoch seconds and epoch milliseconds', () => {
    expect(parseTime(T)).toBe(ms);
    expect(parseTime(ms)).toBe(ms);
    expect(parseTime(ms / 1000)).toBe(ms);
    expect(parseTime(String(ms))).toBe(ms);
    expect(parseTime('not a time')).toBeUndefined();
    expect(parseTime(undefined)).toBeUndefined();
  });
});

describe('eventIdForLine', () => {
  it('is stable, ignores surrounding whitespace, and differs per line', () => {
    const line = `{"time":"${T}","msg":"a"}`;
    expect(eventIdForLine(line)).toBe(eventIdForLine(`  ${line}\n`));
    expect(eventIdForLine(line)).toMatch(/^[0-9a-f]{32}$/);
    expect(eventIdForLine(line)).not.toBe(eventIdForLine(`{"time":"${T}","msg":"b"}`));
  });
});

describe('unwrapLine', () => {
  const app = '{"level":30,"time":"2026-10-19T12:00:00.000Z","msg":"hi"}';

  it("takes the app's line out of Docker and FireLens envelopes", () => {
    expect(
      unwrapLine(
        JSON.stringify({ log: `${app}\n`, stream: 'stdout', time: '2026-10-19T12:00:00.1Z' }),
      ),
    ).toBe(app);
    expect(
      unwrapLine(
        JSON.stringify({
          container_id: 'abc',
          container_name: '/api',
          source: 'stdout',
          log: app,
          ecs_cluster: 'c',
        }),
      ),
    ).toBe(app);
  });

  it('leaves everything else alone, including app lines that have a log field', () => {
    expect(unwrapLine(app)).toBe(app);
    expect(unwrapLine('plain text with "log" in it')).toBe('plain text with "log" in it');
    const own = JSON.stringify({ level: 30, log: 'audit', msg: 'x' });
    expect(unwrapLine(own)).toBe(own);
    expect(unwrapLine(JSON.stringify({ log: 5 }))).toBe(JSON.stringify({ log: 5 }));
  });
});
