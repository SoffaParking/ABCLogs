import pg from 'pg';

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
