import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMaintenance } from '../src/maintenance.js';
import { hasDatabase, testApp, type TestApp } from './helpers.js';

const DAY = 86_400_000;

describe.skipIf(!hasDatabase)('retention', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await testApp();
  });
  afterAll(async () => {
    await t?.close();
  });

  async function partitions(): Promise<string[]> {
    const { rows } = await t.pool.query<{ name: string }>(
      `SELECT c.relname AS name FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = 'log_events' ORDER BY 1`,
    );
    return rows.map((r) => r.name);
  }

  it('drops whole days past the retention period and keeps the rest', async () => {
    const now = Date.UTC(2026, 9, 20, 12);
    const ctx = t.app.ctx!;
    await ctx.partitions.ensureFor([now - 5 * DAY, now - 2 * DAY, now - DAY, now]);
    await t.pool.query(
      `INSERT INTO rollup_levels_1m (project_id, bucket, service, kind, level, count)
       VALUES (1, $1, '', 'log', 30, 1), (1, $2, '', 'log', 30, 1)`,
      [new Date(now - 5 * DAY), new Date(now - DAY)],
    );

    await runMaintenance(t.pool, ctx.partitions, 2, t.app.log, now);

    // Keep 2 days: Oct 18 12:00 is the cutoff, so Oct 15 goes and Oct 18
    // (partly inside the window) stays. Tomorrow's partition is pre-created.
    expect(await partitions()).toEqual([
      'log_events_p20261018',
      'log_events_p20261019',
      'log_events_p20261020',
      'log_events_p20261021',
    ]);
    const { rows } = await t.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM rollup_levels_1m',
    );
    expect(rows[0]!.n).toBe(1);
  });
});
