import { readdirSync, readFileSync } from 'node:fs';
import type pg from 'pg';

const MIGRATIONS_DIR = new URL('../migrations/', import.meta.url);

// Any constant works; it only has to be the same for every server process
// sharing a database, so two servers booting at once take turns.
const MIGRATION_LOCK = 727_001;

/**
 * Applies the SQL files in `migrations/` that this database has not seen, in
 * name order, each in its own transaction. Safe to run from several processes
 * at once. Returns the names applied.
 */
export async function migrate(pool: pg.Pool): Promise<string[]> {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort();
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK]);
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name       text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set(
      (await client.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map(
        (row) => row.name,
      ),
    );
    for (const name of files) {
      if (done.has(name)) continue;
      const sql = readFileSync(new URL(name, MIGRATIONS_DIR), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${name} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(name);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK]).catch(() => undefined);
    client.release();
  }
  return applied;
}
