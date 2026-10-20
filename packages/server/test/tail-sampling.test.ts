import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, projectWithKey, setupAdmin, testApp, type TestApp } from './helpers.js';

describe.skipIf(!hasDatabase)('live tail and sampling', () => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let key: string;
  const now = Date.now();
  const range = `from=${now - 3_600_000}&to=${now + 60_000}`;

  beforeAll(async () => {
    t = await testApp();
    cookie = await setupAdmin(t.app);
    ({ slug, key } = await projectWithKey(t.app, cookie, 'Tail'));
  });
  afterAll(async () => {
    await t?.close();
  });

  const send = async (events: object[]) => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/ingest/v1/events',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ events }),
    });
    return res.json<{ accepted: number; rejected: { reason: string }[] }>();
  };
  const get = async <T>(path: string): Promise<T> => {
    const res = await t.app.inject({ url: `/api/v1/projects/${slug}${path}`, headers: { cookie } });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<T>();
  };
  const log = (id: string, level: string, message: string, minutesAgo = 1) => ({
    type: 'log',
    id,
    time: now - minutesAgo * 60_000,
    level,
    message,
  });
  type Tail = { items: { ref: string; message: string; level: number }[]; cursor: string };

  it('tails logs in arrival order, newest first, from a cursor', async () => {
    await send([log('t1', 'info', 'first'), log('t2', 'error', 'second')]);
    const first = await get<Tail>('/logs/tail');
    expect(first.items.map((i) => i.message)).toEqual(['second', 'first']);

    // Arrival order, not event time: a late line about an hour ago still shows up as new.
    await new Promise((r) => setTimeout(r, 20));
    await send([log('t3', 'warn', 'late arrival', 50)]);
    const next = await get<Tail>(`/logs/tail?since=${encodeURIComponent(first.cursor)}`);
    // The overlap re-sends what was seen; the client drops those by ref.
    const seen = new Set(first.items.map((i) => i.ref));
    expect(next.items.filter((i) => !seen.has(i.ref)).map((i) => i.message)).toEqual([
      'late arrival',
    ]);
    expect(Date.parse(next.cursor)).toBeGreaterThanOrEqual(Date.parse(first.cursor));

    const errors = await get<Tail>('/logs/tail?minLevel=error');
    expect(errors.items.map((i) => i.message)).toEqual(['second']);
    expect(
      (
        await t.app.inject({
          url: `/api/v1/projects/${slug}/logs/tail?since=nope`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(400);
  });

  it('counts a sampled event as many: totals, latency and severity stay right', async () => {
    // 10 kept out of 100 successful requests, plus 3 failures sent in full.
    const events = [
      ...Array.from({ length: 10 }, (_, i) => ({
        type: 'request',
        id: `s${i}`,
        time: now - 120_000,
        method: 'GET',
        path: '/api/items',
        status: 200,
        durationMs: 20,
        sampleRate: 0.1,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        type: 'request',
        id: `f${i}`,
        time: now - 120_000,
        method: 'GET',
        path: '/api/items',
        status: 500,
        durationMs: 900,
      })),
    ];
    expect((await send(events)).accepted).toBe(13);
    const overview = await get<{
      totals: { requests: number; status: Record<string, number>; p50: number };
    }>(`/overview?${range}`);
    expect(overview.totals.requests).toBe(103);
    expect(overview.totals.status).toMatchObject({ '2xx': 100, '5xx': 3 });
    // The median is a 20 ms request, as it is among all 103.
    expect(overview.totals.p50).toBeLessThanOrEqual(25);

    const levels = await get<{ totals: Record<string, number> }>(`/levels?${range}&kind=request`);
    expect(levels.totals).toMatchObject({ info: 100, error: 3 });

    // The list shows the events that were kept, marked with what they stand for.
    const list = await get<{ items: { status: number; weight?: number }[] }>(
      `/requests?${range}&status=2xx&limit=200`,
    );
    expect(list.items).toHaveLength(10);
    expect(list.items.every((i) => i.weight === 10)).toBe(true);
  });

  it('weights issues by their sampled errors and refuses impossible rates', async () => {
    await send([{ ...log('e1', 'error', 'sampled error'), sampleRate: 0.25 }]);
    const issues = await get<{ items: { title: string; count: number; rangeCount: number }[] }>(
      `/issues?${range}`,
    );
    expect(issues.items.find((i) => i.title === 'sampled error')).toMatchObject({
      count: 4,
      rangeCount: 4,
    });

    const bad = await send([
      { ...log('b1', 'info', 'x'), sampleRate: 0 },
      { ...log('b2', 'info', 'x'), sampleRate: 1.5 },
    ]);
    expect(bad.rejected.map((r) => r.reason)).toEqual([
      'sampleRate must be a number above 0 and at most 1',
      'sampleRate must be a number above 0 and at most 1',
    ]);
  });
});
