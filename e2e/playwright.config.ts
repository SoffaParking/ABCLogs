import { defineConfig, devices } from '@playwright/test';

// Started by run.mjs, which provides the server. PW_CHANNEL=chrome runs the
// installed Chrome instead of Playwright's own Chromium.
export default defineConfig({
  testDir: 'tests',
  // One server, one database: the specs share state and run in order.
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 60_000,
  grepInvert: process.env.SCREENSHOTS ? undefined : /@screenshots/,
  use: {
    baseURL: process.env.E2E_BASE_URL,
    trace: 'retain-on-failure',
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  projects: [
    // First-run setup, a project and demo data, shared by everything after.
    { name: 'setup', testMatch: /setup\.ts$/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      use: {
        ...devices['Desktop Chrome'],
        viewport: { width: 1360, height: 900 },
        storageState: '.auth/admin.json',
      },
    },
  ],
});
