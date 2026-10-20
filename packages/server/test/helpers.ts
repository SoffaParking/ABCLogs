import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { buildApp, type App } from '../src/app.js';
import { loadConfig, type Config } from '../src/config.js';
import { createPool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

/**
 * Integration tests need a Postgres server they may create databases on, e.g.
 *   TEST_DATABASE_URL=postgres://postgres:test@127.0.0.1:55432/postgres
 * Each test file gets its own throwaway database. Without the variable, the
 * integration suites are skipped.
 */
export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = Boolean(TEST_DATABASE_URL);

export const SETUP_CODE = 'TEST-CODE-0001';
export const ORIGIN = 'http://localhost:80';

export interface TestApp {
  app: App;
  pool: pg.Pool;
  close(): Promise<void>;
}

async function admin<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function testApp(overrides: Partial<Config> = {}): Promise<TestApp> {
  const name = `apiloupe_test_${randomBytes(6).toString('hex')}`;
  await admin((c) => c.query(`CREATE DATABASE ${name}`));
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  const config: Config = {
    ...loadConfig({ DATABASE_URL: url.toString(), SETUP_CODE }),
    logLevel: 'silent',
    publicDir: '/nonexistent',
    ...overrides,
  };
  const pool = createPool(config.databaseUrl)!;
  await migrate(pool);
  const app = await buildApp({ config, pool });
  return {
    app,
    pool,
    async close() {
      await app.close();
      await pool.end();
      await admin((c) => c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`));
    },
  };
}

/** The `name=value` part of a Set-Cookie header, for sending back. */
export function cookieFrom(res: { headers: Record<string, unknown> }): string {
  const header = res.headers['set-cookie'];
  const first = Array.isArray(header) ? String(header[0]) : String(header);
  return first.split(';')[0]!;
}

/** Runs first-run setup and returns the admin's session cookie. */
export async function setupAdmin(app: App, email = 'admin@example.com'): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    headers: { origin: ORIGIN },
    payload: { code: SETUP_CODE, email, name: 'Admin', password: 'correct horse battery' },
  });
  if (res.statusCode !== 201) throw new Error(`setup failed: ${res.statusCode} ${res.body}`);
  return cookieFrom(res);
}

/** Creates a project and an ingest key for it. */
export async function projectWithKey(app: App, cookie: string, name = 'Shop API') {
  const project = await app.inject({
    method: 'POST',
    url: '/api/v1/projects',
    headers: { cookie, origin: ORIGIN },
    payload: { name },
  });
  const slug = project.json<{ project: { slug: string } }>().project.slug;
  const key = await app.inject({
    method: 'POST',
    url: `/api/v1/projects/${slug}/keys`,
    headers: { cookie, origin: ORIGIN },
    payload: { name: 'test' },
  });
  return { slug, key: key.json<{ key: string }>().key };
}
