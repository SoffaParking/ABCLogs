import pg from 'pg';

// Counts come back as bigint (int8). They never get near 2^53, so read them as
// numbers instead of pg's default strings.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => Number(value));

/** A connection pool, or null when no DATABASE_URL is configured. */
export function createPool(databaseUrl: string | undefined): pg.Pool | null {
  if (!databaseUrl) return null;
  return new pg.Pool({ connectionString: databaseUrl, max: 10 });
}

/** True when the database answers a trivial query within the timeout. */
export async function pingDatabase(pool: pg.Pool, timeoutMs = 2000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('database ping timed out')), timeoutMs);
    });
    await Promise.race([pool.query('SELECT 1'), timeout]);
    return true;
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Runs `fn` in a transaction, committing on success and rolling back on any error. */
export async function withTransaction<T>(
  pool: pg.Pool,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
