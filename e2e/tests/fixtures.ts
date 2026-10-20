import { readFileSync } from 'node:fs';
import { expect, test as base } from '@playwright/test';

/** What the setup step leaves for the other specs. */
export const KEY_FILE = '.auth/key.txt';
export const ADMIN = { email: 'admin@example.com', password: 'correct horse battery' };
export const SLUG = 'parking-backend';

export function ingestKey(): string {
  return readFileSync(KEY_FILE, 'utf8').trim();
}

// The browser reports 4xx responses the app expects (a wrong password, an
// invite already used) as console errors; those are not problems.
const EXPECTED = /Failed to load resource: the server responded with a status of 4\d\d/;

/**
 * Every test fails if the page logs an error, throws, or breaks the content
 * security policy: the dashboard must work with nothing loosened.
 */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = [];
      await page.exposeFunction('__reportCspViolation', (detail: string) => {
        problems.push(`CSP violation: ${detail}`);
      });
      await page.addInitScript(() => {
        document.addEventListener('securitypolicyviolation', (e) => {
          const report = (window as unknown as { __reportCspViolation: (d: string) => void })
            .__reportCspViolation;
          report(`${e.violatedDirective} blocked ${e.blockedURI || 'inline'}`);
        });
      });
      page.on('console', (m) => {
        if (m.type() === 'error' && !EXPECTED.test(m.text())) problems.push(`console: ${m.text()}`);
      });
      page.on('pageerror', (e) => problems.push(`uncaught: ${e.message}`));
      await use(problems);
      expect(problems, 'console errors, uncaught exceptions or CSP violations').toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
