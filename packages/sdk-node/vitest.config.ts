import { defineConfig } from 'vitest/config';

// Tests run in Vite's server (SSR) environment, which resolves packages with
// its own condition list, separate from the client one. Both get `source`, so
// a workspace dependency is read from its TypeScript source and tests never
// need a prior build.
export default defineConfig({
  resolve: { conditions: ['source'] },
  ssr: { resolve: { conditions: ['source'], externalConditions: ['source'] } },
  test: { include: ['test/**/*.test.ts'] },
});
