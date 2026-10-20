import type pg from 'pg';

/** The day-partitioned event tables. */
export const EVENT_TABLES = ['request_events', 'log_events'] as const;

const DAY_MS = 86_400_000;
const PARTITION_LOCK = 727_002;
const PARTITION_NAME = /_p(\d{4})(\d{2})(\d{2})$/;

/** Start of the UTC day containing `ms`. */
export function utcDay(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}

function suffix(day: number): string {
  return new Date(day).toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * Creates the daily partitions events need, on demand: the first event of a
 * new day (or of an old day being backfilled) creates that day's partition
 * for both tables. Remembers what exists so the steady state costs nothing.
 */
export class Partitions {
  private readonly known = new Set<number>();

  constructor(private readonly pool: pg.Pool) {}

  /** Makes sure a partition exists for each UTC day touched by `times`. */
  async ensureFor(times: Iterable<number>): Promise<void> {
    const missing = new Set<number>();
    for (const ms of times) {
      const day = utcDay(ms);
      if (!this.known.has(day)) missing.add(day);
    }
    if (missing.size === 0) return;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // CREATE TABLE IF NOT EXISTS still races with itself; the lock makes
      // concurrent batches take turns.
      await client.query('SELECT pg_advisory_xact_lock($1)', [PARTITION_LOCK]);
      for (const day of [...missing].sort((a, b) => a - b)) {
        const from = new Date(day).toISOString();
        const to = new Date(day + DAY_MS).toISOString();
        for (const table of EVENT_TABLES) {
          await client.query(
            `CREATE TABLE IF NOT EXISTS ${table}_p${suffix(day)} PARTITION OF ${table}
             FOR VALUES FROM ('${from}') TO ('${to}')`,
          );
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
    for (const day of missing) this.known.add(day);
  }

  /**
   * Drops every partition whose whole day is older than the retention window,
   * and returns the dropped table names.
   */
  async dropExpired(retentionDays: number, now = Date.now()): Promise<string[]> {
    const cutoff = utcDay(now - retentionDays * DAY_MS);
    const { rows } = await this.pool.query<{ name: string }>(
      `SELECT c.relname AS name
         FROM pg_inherits i
         JOIN pg_class c ON c.oid = i.inhrelid
         JOIN pg_class p ON p.oid = i.inhparent
        WHERE p.relname = ANY($1)`,
      [EVENT_TABLES],
    );
    const dropped: string[] = [];
    for (const { name } of rows) {
      const match = PARTITION_NAME.exec(name);
      if (!match) continue;
      const day = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
      // The partition holds [day, day + 1); it expires once all of it is
      // older than the cutoff.
      if (day + DAY_MS <= cutoff) {
        await this.pool.query(`DROP TABLE IF EXISTS ${name}`);
        this.known.delete(day);
        dropped.push(name);
      }
    }
    return dropped;
  }
}
