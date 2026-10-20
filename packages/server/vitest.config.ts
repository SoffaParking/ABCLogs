import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { defineConfig } from 'vitest/config';

// The database tests read TEST_DATABASE_URL from the environment, or from the
// repository's .env (see .env.example). Without it they are skipped.
const envFile = new URL('../../.env', import.meta.url);
const fileEnv = existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {};
const testDatabaseUrl = process.env.TEST_DATABASE_URL ?? fileEnv.TEST_DATABASE_URL;

// Tests run in Vite's server (SSR) environment, which resolves packages with
// its own condition list, separate from the client one. Both get `source`, so
// a workspace dependency is read from its TypeScript source and tests never
// need a prior build.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: {
    include: ['test/**/*.test.ts'],
    env: testDatabaseUrl ? { TEST_DATABASE_URL: testDatabaseUrl } : {},
  },
});
