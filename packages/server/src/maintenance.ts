import type { FastifyBaseLogger } from 'fastify';
import type pg from 'pg';
import { Partitions, utcDay } from './partitions.js';

const DAY_MS = 86_400_000;
const EVERY_MS = 15 * 60_000;
const MAINTENANCE_LOCK = 727_003;

/**
 * Housekeeping, run at boot and every 15 minutes: pre-creates today's and
 * tomorrow's partitions, drops partitions past the retention period, and
 * deletes expired rollups, sessions and invites. With several server
 * processes, whichever takes the lock does the work.
 */
export async function runMaintenance(
  pool: pg.Pool,
  partitions: Partitions,
  retentionDays: number,
  log: FastifyBaseLogger,
  now = Date.now(),
): Promise<void> {
  const client = await pool.connect();
  let locked = false;
  try {
    const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [
      MAINTENANCE_LOCK,
    ]);
    locked = rows[0]?.ok ?? false;
    if (!locked) return;
    await partitions.ensureFor([utcDay(now), utcDay(now) + DAY_MS]);
    const dropped = await partitions.dropExpired(retentionDays, now);
    const cutoff = new Date(now - retentionDays * DAY_MS);
    const rollups = await client.query<{ n: number }>(
      `WITH a AS (DELETE FROM rollup_requests_1m WHERE bucket < $1 RETURNING 1),
            b AS (DELETE FROM rollup_levels_1m WHERE bucket < $1 RETURNING 1)
       SELECT (SELECT count(*) FROM a) + (SELECT count(*) FROM b) AS n`,
      [cutoff],
    );
    // Ingest stats are tiny; keep them four times as long as events.
    await client.query('DELETE FROM ingest_stats_hourly WHERE hour < $1', [
      new Date(now - 4 * retentionDays * DAY_MS),
    ]);
    await client.query('DELETE FROM sessions WHERE expires_at < now()');
    await client.query(
      `DELETE FROM invites WHERE expires_at < now() - interval '30 days' OR accepted_at < now() - interval '30 days'`,
    );
    if (dropped.length > 0 || Number(rollups.rows[0]?.n) > 0) {
      log.info(
        { dropped, rollupRows: Number(rollups.rows[0]?.n) },
        'retention: removed expired data',
      );
    }
  } finally {
    if (locked)
      await client
        .query('SELECT pg_advisory_unlock($1)', [MAINTENANCE_LOCK])
        .catch(() => undefined);
    client.release();
  }
}

/** Runs maintenance now and on a timer; returns a function that stops it. */
export function scheduleMaintenance(
  pool: pg.Pool,
  partitions: Partitions,
  retentionDays: number,
  log: FastifyBaseLogger,
): () => void {
  const run = () =>
    runMaintenance(pool, partitions, retentionDays, log).catch((err: unknown) =>
      log.error({ err }, 'maintenance failed'),
    );
  void run();
  const timer = setInterval(() => void run(), EVERY_MS);
  timer.unref();
  return () => clearInterval(timer);
}
