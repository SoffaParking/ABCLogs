import { runImport, synthesizeLines } from '@apiloupe/importer';
import { HISTOGRAM_BOUNDS_MS, histogramBucket, levelName, statusClass } from '@apiloupe/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hasDatabase, projectWithKey, setupAdmin, testApp, type TestApp } from './helpers.js';

/**
 * The milestone's acceptance test: synthetic logs go through the real
 * importer over HTTP, and every number the dashboard shows must match what
 * counting the lines directly gives (what `jq` would say).
 */
describe.skipIf(!hasDatabase)('import → dashboard numbers', () => {
  let t: TestApp;
  let cookie: string;
  let slug: string;
  let key: string;
  let endpoint: string;
  const now = Date.now() - 60_000;
  const lines = synthesizeLines({ now, minutes: 90, requestsPerMinute: 30, seed: 7 });

  // The "jq" side: counted straight from the lines.
  const parsed = lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as Record<string, unknown>];
    } catch {
      return [];
    }
  });
  const requests = parsed.filter((o) => o.msg === 'request');
  const logs = parsed.filter((o) => o.msg !== 'request');
  const durations = requests.map((o) => o.durationMs as number).sort((a, b) => a - b);
  const byClass = { '2xx': 0, '3xx': 0, '4xx': 0, '5xx': 0 };
  for (const o of requests) byClass[statusClass(o.status as number)] += 1;
  const byLevel: Record<string, number> = {};
  for (const o of parsed)
    byLevel[levelName(o.level as number)] = (byLevel[levelName(o.level as number)] ?? 0) + 1;

  const range = `from=${now - 92 * 60_000}&to=${now + 60_000}`;
  const get = async <T>(path: string): Promise<T> => {
    const res = await t.app.inject({ url: `/api/v1/projects/${slug}${path}`, headers: { cookie } });
    if (res.statusCode !== 200) throw new Error(`${path}: ${res.statusCode} ${res.body}`);
    return res.json<T>();
  };

  beforeAll(async () => {
    t = await testApp();
    cookie = await setupAdmin(t.app);
    ({ slug, key } = await projectWithKey(t.app, cookie, 'Parking backend'));
    endpoint = await t.app.listen({ port: 0, host: '127.0.0.1' });
  });
  afterAll(async () => {
    await t?.close();
  });

  it('imports every JSON line once and skips the rest', async () => {
    expect(requests.length).toBeGreaterThan(2000);
    const stats = await runImport(lines, { endpoint, key, batchSize: 250, retryBaseMs: 10 });
    expect(stats.skipped).toEqual({ blank: 1, notJson: 1, noTime: 0 });
    expect(stats.events).toBe(parsed.length);
    expect(stats.accepted).toBe(parsed.length);
    expect(stats.rejected).toBe(0);
  });

  it('overview totals match the lines', async () => {
    const overview = await get<{
      totals: { requests: number; status: typeof byClass; p95: number; p50: number };
      series: { '5xx': number }[];
      routes: { route: string; count: number }[];
    }>(`/overview?${range}`);
    expect(overview.totals.requests).toBe(requests.length);
    expect(overview.totals.status).toEqual(byClass);
    expect(overview.series.reduce((sum, p) => sum + p['5xx'], 0)).toBe(byClass['5xx']);
    expect(overview.routes.map((r) => r.route)).toContain('/api/users/:id');

    for (const [q, estimate] of [
      [0.5, overview.totals.p50],
      [0.95, overview.totals.p95],
    ] as const) {
      const exact = durations[Math.ceil(q * durations.length) - 1]!;
      const bucket = histogramBucket(exact);
      const lower = bucket === 0 ? 0 : HISTOGRAM_BOUNDS_MS[bucket - 1]!;
      const upper = HISTOGRAM_BOUNDS_MS[bucket] ?? durations[durations.length - 1]!;
      // Exact to within the bucket the true value falls in.
      expect(estimate).toBeGreaterThanOrEqual(lower);
      expect(estimate).toBeLessThanOrEqual(upper);
    }
  });

  it('severity totals match the lines', async () => {
    const levels = await get<{ totals: Record<string, number> }>(`/levels?${range}`);
    for (const name of ['debug', 'info', 'warn', 'error', 'fatal']) {
      expect(levels.totals[name], name).toBe(byLevel[name] ?? 0);
    }
    const onlyLogs = await get<{ totals: Record<string, number> }>(`/levels?${range}&kind=log`);
    expect(Object.values(onlyLogs.totals).reduce((a, b) => a + b, 0)).toBe(logs.length);
  });

  it('importing the same lines again changes nothing', async () => {
    const stats = await runImport(lines, { endpoint, key, retryBaseMs: 10 });
    expect(stats.accepted).toBe(0);
    expect(stats.duplicates).toBe(parsed.length);
    const overview = await get<{ totals: { requests: number } }>(`/overview?${range}`);
    expect(overview.totals.requests).toBe(requests.length);
  });

  it('lists failed requests page by page, each with the error logged for it', async () => {
    const seen: { ref: string; status: number }[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: { ref: string; status: number }[]; nextCursor: string | null } =
        await get(`/requests?${range}&status=5xx&limit=7${cursor ? `&cursor=${cursor}` : ''}`);
      seen.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(byClass['5xx']);
    expect(new Set(seen.map((r) => r.ref)).size).toBe(seen.length);
    expect(seen.every((r) => r.status >= 500)).toBe(true);

    const detail = await get<{
      logs: { message: string; level: number; errorMessage: string | null }[];
    }>(`/requests/${encodeURIComponent(seen[0]!.ref)}`);
    const error = detail.logs.find((l) => l.message === 'Request error');
    expect(error?.level).toBe(50);
    expect(error?.errorMessage).toBeTruthy();
  });

  it('filters logs by level and text, and shows the crash with its stack', async () => {
    const errors = await get<{ items: { level: number }[]; nextCursor: string | null }>(
      `/logs?${range}&minLevel=error&limit=200`,
    );
    const expectedErrors = logs.filter((o) => (o.level as number) >= 50).length;
    expect(errors.items.length).toBe(Math.min(expectedErrors, 200));
    expect(errors.items.every((l) => l.level >= 50)).toBe(true);

    const fatal = await get<{ items: { ref: string; errorType: string }[] }>(
      `/logs?${range}&minLevel=fatal`,
    );
    expect(fatal.items).toHaveLength(1);
    expect(fatal.items[0]!.errorType).toBe('TypeError');
    const crash = await get<{ log: { errorStack: string } }>(
      `/logs/${encodeURIComponent(fatal.items[0]!.ref)}`,
    );
    expect(crash.log.errorStack).toContain('sessionService.js');

    const lockWaits = await get<{ items: { errorMessage: string }[] }>(
      `/logs?${range}&q=lock_wait&limit=200`,
    );
    const expectedLockWaits = logs.filter((o) => String(o.err).includes('ER_LOCK_WAIT')).length;
    expect(lockWaits.items).toHaveLength(expectedLockWaits);
  });

  it('offers services and routes as filters', async () => {
    const facets = await get<{ services: string[]; routes: { route: string }[] }>(
      `/facets?${range}`,
    );
    expect(facets.services).toEqual(['parking-backend']);
    expect(facets.routes.map((r) => r.route)).toEqual(
      expect.arrayContaining([
        '/api/users/:id',
        '/api/gates/:id/open',
        '/api/companies/:id/members',
      ]),
    );
  });
});
