/** Server settings, read once from the environment. */
export interface Config {
  port: number;
  host: string;
  databaseUrl: string | undefined;
  logLevel: string;
  /** Where the built dashboard lives; the server serves it at `/`. */
  publicDir: string;
  /**
   * The address people open the dashboard at. When it is https, the server
   * adds HSTS and `upgrade-insecure-requests` and marks cookies Secure; over
   * plain http (localhost, a LAN IP) those would break the page, so they stay
   * off.
   */
  publicUrl: string | undefined;
  /** Trust `X-Forwarded-*` from a reverse proxy in front of the server. */
  trustProxy: boolean;
  /** Days of raw events and per-minute rollups kept. */
  retentionDays: number;
  /**
   * The code that unlocks first-run setup. Random and printed in the server
   * log when unset.
   */
  setupCode: string | undefined;
  ingest: {
    /** Sustained events per second per key; bursts up to five seconds' worth. */
    eventsPerSecond: number;
    /** Batches written at once; more wait, and past a queue they get 503. */
    concurrency: number;
    /** Distinct routes per project before new ones are counted as `other`. */
    maxRoutes: number;
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: intSetting(env, 'PORT', 8080, 1, 65535),
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    logLevel: env.LOG_LEVEL ?? 'info',
    publicDir: env.PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname,
    publicUrl: env.PUBLIC_URL?.replace(/\/+$/, '') || undefined,
    trustProxy: ['1', 'true', 'yes'].includes((env.TRUST_PROXY ?? '').toLowerCase()),
    retentionDays: intSetting(env, 'RETENTION_DAYS', 14, 1, 3650),
    setupCode: env.SETUP_CODE || undefined,
    ingest: {
      eventsPerSecond: intSetting(env, 'INGEST_EVENTS_PER_SECOND', 10000, 1, 10_000_000),
      concurrency: intSetting(env, 'INGEST_CONCURRENCY', 4, 1, 64),
      maxRoutes: intSetting(env, 'MAX_ROUTES_PER_PROJECT', 1000, 10, 100_000),
    },
  };
}

function intSetting(
  env: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}, got "${raw}"`);
  }
  return value;
}
