// Runs the browser tests against the built server: makes a fresh database,
// starts the server on it, runs Playwright, then cleans up. Needs `pnpm build`
// first and E2E_DATABASE_URL (or TEST_DATABASE_URL): a Postgres user that may
// create databases. Extra arguments go to `playwright test`.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import pg from 'pg';

const root = new URL('..', import.meta.url).pathname;
const envFile = `${root}.env`;
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const admin =
  process.env.E2E_DATABASE_URL ?? process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;
if (!admin) {
  console.error(
    'e2e: set E2E_DATABASE_URL (or TEST_DATABASE_URL) to a Postgres user that may create databases',
  );
  process.exit(2);
}
if (
  !existsSync(`${root}packages/server/dist/index.js`) ||
  !existsSync(`${root}packages/ui/dist/index.html`)
) {
  console.error('e2e: run `pnpm build` first');
  process.exit(2);
}

const name = `apiloupe_e2e_${randomBytes(4).toString('hex')}`;
const port = process.env.E2E_PORT ?? '8095';
const adminDb = async (sql) => {
  const client = new pg.Client({ connectionString: admin });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
};
await adminDb(`CREATE DATABASE ${name}`);
const url = new URL(admin);
url.pathname = `/${name}`;

const server = spawn(process.execPath, [`${root}packages/server/dist/index.js`], {
  env: {
    ...process.env,
    DATABASE_URL: url.toString(),
    PORT: port,
    HOST: '127.0.0.1',
    PUBLIC_DIR: `${root}packages/ui/dist`,
    SETUP_CODE: 'E2E0-SETUP-CODE',
    LOG_LEVEL: 'warn',
  },
  stdio: ['ignore', 'inherit', 'inherit'],
});

let code;
try {
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try {
      if ((await fetch(`${base}/readyz`)).ok) break;
    } catch {
      // not up yet
    }
    if (i > 60) throw new Error('the server did not become ready');
    await new Promise((r) => setTimeout(r, 500));
  }
  code = await new Promise((resolve) => {
    const here = new URL('.', import.meta.url).pathname;
    const tests = spawn(`${here}node_modules/.bin/playwright`, ['test', ...process.argv.slice(2)], {
      cwd: here,
      env: { ...process.env, E2E_BASE_URL: base, E2E_SETUP_CODE: 'E2E0-SETUP-CODE' },
      stdio: 'inherit',
    });
    tests.on('exit', (c) => resolve(c ?? 1));
  });
} finally {
  server.kill('SIGTERM');
  await new Promise((r) => server.once('exit', r));
  await adminDb(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
}
process.exit(code);
