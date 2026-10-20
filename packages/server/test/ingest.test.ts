import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  hasDatabase,
  ORIGIN,
  projectWithKey,
  setupAdmin,
  testApp,
  type TestApp,
} from './helpers.js';

describe.skipIf(!hasDatabase)('ingest', () => {
  let t: TestApp;
  let cookie: string;
  let key: string;
  let slug: string;
  const now = Date.now();

  beforeAll(async () => {
    t = await testApp({
      ingest: { eventsPerSecond: 200, concurrency: 2, maxRoutes: 12 },
    });
    cookie = await setupAdmin(t.app);
    ({ key, slug } = await projectWithKey(t.app, cookie));
  });
  afterAll(async () => {
    await t?.close();
  });

  const send = (events: unknown[], headers: Record<string, string> = {}) =>
    t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      payload: JSON.stringify({ events }),
    });

  const request = (id: string, extra: object = {}) => ({
    type: 'request',
    id,
    time: new Date(now - 60_000).toISOString(),
    method: 'GET',
    path: '/api/users/42',
    status: 200,
    durationMs: 12,
    ...extra,
  });

  it('checks the key', async () => {
    const ok = await t.app.inject({
      url: '/ingest/v1/check',
      headers: { authorization: `Bearer ${key}` },
    });
    expect(ok.json()).toMatchObject({ ok: true, project: { slug } });
    for (const bad of [undefined, 'Bearer nope', `Bearer ${key.slice(0, -1)}x`]) {
      const res = await t.app.inject({
        url: '/ingest/v1/check',
        headers: bad ? { authorization: bad } : {},
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it('stores valid events, refuses invalid ones individually, and reports both', async () => {
    const res = await send([
      request('a1'),
      { type: 'log', id: 'l1', time: now - 30_000, level: 'warning', message: 'disk 91% full' },
      { type: 'request', time: now, method: 'GET', path: '/', status: 99 },
      { type: 'log', time: now - 30 * 86_400_000, level: 'info', message: 'too old' },
      { type: 'log', time: now + 86_400_000, level: 'info', message: 'future' },
      { type: 'what', time: now },
      'not an object',
    ]);
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({
      accepted: 2,
      duplicates: 0,
      rejected: [
        { index: 2, reason: 'status must be an HTTP status code' },
        { index: 3, reason: 'time is older than the retention period' },
        { index: 4, reason: 'time is in the future' },
        { index: 5, reason: 'type must be "request" or "log"' },
        { index: 6, reason: 'event must be an object' },
      ],
    });
    const { rows } = await t.pool.query('SELECT route, level FROM request_events');
    expect(rows).toEqual([{ route: '/api/users/:id', level: 30 }]);
    const logs = await t.pool.query('SELECT level, message FROM log_events');
    expect(logs.rows).toEqual([{ level: 40, message: 'disk 91% full' }]);
  });

  it('a resent batch is stored once and counted once', async () => {
    const batch = [request('dup-1'), request('dup-2', { status: 500 })];
    expect((await send(batch)).json()).toMatchObject({ accepted: 2, duplicates: 0 });
    expect((await send(batch)).json()).toMatchObject({ accepted: 0, duplicates: 2 });
    // Duplicates inside one batch, too.
    expect((await send([request('dup-3'), request('dup-3')])).json()).toMatchObject({
      accepted: 1,
      duplicates: 1,
    });
    const { rows } = await t.pool.query<{ n: number }>(
      `SELECT sum(count)::int AS n FROM rollup_requests_1m`,
    );
    // a1 + dup-1 + dup-2 + dup-3: the rollups count only what was inserted.
    expect(rows[0]!.n).toBe(4);
  });

  it('events without an id are deduplicated by content', async () => {
    const event = { type: 'log', time: now - 5000, level: 50, message: 'no id here' };
    expect((await send([event])).json()).toMatchObject({ accepted: 1 });
    expect((await send([event])).json()).toMatchObject({ accepted: 0, duplicates: 1 });
  });

  it('accepts gzip bodies and refuses broken ones', async () => {
    const body = gzipSync(JSON.stringify({ events: [request('gz-1')] }));
    const res = await t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: body,
    });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toMatchObject({ accepted: 1 });

    const broken = await t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'content-encoding': 'gzip',
      },
      payload: Buffer.from('definitely not gzip'),
    });
    expect(broken.statusCode).toBe(400);

    const brotli = await send([request('br')], { 'content-encoding': 'br' });
    expect(brotli.statusCode).toBe(415);
  });

  it('refuses malformed batches as a whole', async () => {
    expect((await send([])).statusCode).toBe(400);
    const res = await t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: '{"events": 5}',
    });
    expect(res.statusCode).toBe(400);
    const tooMany = await send(Array.from({ length: 1001 }, (_, i) => request(`m${i}`)));
    expect(tooMany.statusCode).toBe(400);
  });

  it('stores text Postgres would refuse (NUL, lone surrogates) instead of failing the batch', async () => {
    const res = await send([
      {
        type: 'log',
        id: 'nul',
        time: now - 1000,
        level: 30,
        message: 'a\u0000b\ud800c',
        attrs: { x: 'y\u0000' },
      },
    ]);
    expect(res.json()).toMatchObject({ accepted: 1 });
    const { rows } = await t.pool.query(`SELECT message, attrs FROM log_events WHERE id = 'nul'`);
    expect(rows[0]).toEqual({ message: 'ab�c', attrs: { x: 'y' } });
  });

  it('redacts secrets in attrs and messages on the way in', async () => {
    await send([
      {
        type: 'log',
        id: 'secret',
        time: now - 1000,
        level: 30,
        message: 'auth header was Bearer abcdefghijklmnop',
        attrs: { password: 'hunter2', user: 'sam' },
      },
    ]);
    const { rows } = await t.pool.query(
      `SELECT message, attrs FROM log_events WHERE id = 'secret'`,
    );
    expect(rows[0]).toEqual({
      message: 'auth header was Bearer [redacted]',
      attrs: { password: '[redacted]', user: 'sam' },
    });
  });

  it('caps distinct routes per project and counts the rest as (other)', async () => {
    const events = Array.from({ length: 20 }, (_, i) =>
      request(`route-${i}`, { route: `/r${i}`, path: `/r${i}` }),
    );
    expect((await send(events)).json()).toMatchObject({ accepted: 20 });
    const { rows } = await t.pool.query<{ n: number }>(
      `SELECT count(DISTINCT route)::int AS n FROM request_events WHERE route LIKE '/r%'`,
    );
    const other = await t.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM request_events WHERE route = '(other)'`,
    );
    // 12 routes allowed in total; /api/users/:id took one already.
    expect(rows[0]!.n).toBe(11);
    expect(other.rows[0]!.n).toBe(9);
  });

  it('rate-limits per key with Retry-After', async () => {
    // 200 events/s with a 1000-event burst; the earlier tests used part of it.
    let res: Awaited<ReturnType<typeof send>> | undefined;
    for (let i = 0; i < 5; i++) {
      res = await send(Array.from({ length: 400 }, (_, j) => request(`rl-${i}-${j}`)));
      if (res.statusCode === 429) break;
    }
    expect(res?.statusCode).toBe(429);
    expect(Number(res?.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('a revoked key stops working at once', async () => {
    const keys = await t.app.inject({ url: `/api/v1/projects/${slug}/keys`, headers: { cookie } });
    const id = keys.json<{ keys: { id: number }[] }>().keys[0]!.id;
    const del = await t.app.inject({
      method: 'DELETE',
      url: `/api/v1/projects/${slug}/keys/${id}`,
      headers: { cookie, origin: ORIGIN },
    });
    expect(del.statusCode).toBe(204);
    expect((await send([request('after-revoke')])).statusCode).toBe(401);
  });
});
