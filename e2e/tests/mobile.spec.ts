import { devices } from '@playwright/test';
import { expect, SLUG, test } from './fixtures.js';

test.use({ ...devices['iPhone 13'], defaultBrowserType: 'chromium' });

for (const path of ['', '/issues', '/requests', '/logs']) {
  test(`fits a phone screen: ${path || '/'}`, async ({ page }) => {
    await page.goto(`/p/${SLUG}${path}?range=6h`);
    await expect(page.locator('.page')).toBeVisible();
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
