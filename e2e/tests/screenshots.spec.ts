import { expect, SLUG, test } from './fixtures.js';

// `pnpm --filter @apiloupe/e2e screenshots` regenerates the README's
// images from the synthetic demo data (never real logs).
const OUT = '../docs/screenshots';

test.describe('@screenshots', () => {
  test.use({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });

  test('overview, light and dark', async ({ page }) => {
    await page.goto(`/p/${SLUG}?range=6h`);
    await expect(page.getByRole('heading', { name: 'Top routes' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${OUT}/overview.png` });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: `${OUT}/overview-dark.png` });
  });

  test('issues and an issue', async ({ page }) => {
    await page.goto(`/p/${SLUG}/issues?range=6h`);
    await expect(page.locator('.issues-table tbody tr').first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/issues.png` });
    await page.getByRole('link', { name: /TypeError: Cannot read properties of null/ }).click();
    await expect(page.locator('.stacktrace')).toBeVisible();
    await page.waitForLoadState('networkidle');
    await page.screenshot({ path: `${OUT}/issue.png`, fullPage: true });
  });

  test('a failed request with its logs', async ({ page }) => {
    await page.goto(`/p/${SLUG}/requests?range=6h&status=5xx`);
    await page.locator('table tbody tr').first().click();
    await expect(page.getByRole('dialog').locator('.log-line').first()).toBeVisible();
    await page.screenshot({ path: `${OUT}/request.png` });
  });
});
