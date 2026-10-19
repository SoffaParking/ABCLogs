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
   * adds HSTS and `upgrade-insecure-requests`; over plain http (localhost, a
   * LAN IP) those would break the page, so they stay off.
   */
  publicUrl: string | undefined;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = Number(env.PORT ?? 8080);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`PORT must be a TCP port, got "${env.PORT}"`);
  }
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    databaseUrl: env.DATABASE_URL || undefined,
    logLevel: env.LOG_LEVEL ?? 'info',
    publicDir: env.PUBLIC_DIR ?? new URL('../public', import.meta.url).pathname,
    publicUrl: env.PUBLIC_URL || undefined,
  };
}
