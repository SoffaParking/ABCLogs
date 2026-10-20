import { expect, SLUG, test } from './fixtures.js';

const RANGE = 'range=6h';

test('overview: numbers, charts, severity filter, top issues and routes', async ({ page }) => {
  await page.goto(`/p/${SLUG}?${RANGE}`);
  await expect(page.getByText('Requests', { exact: true }).first()).toBeVisible();
  await expect(page.locator('.stat-value').first()).not.toHaveText('0');
  await expect(page.locator('.chart svg')).toHaveCount(3);
  await expect(page.getByRole('heading', { name: 'Top issues' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Top routes' })).toBeVisible();
  await expect(page.getByRole('cell', { name: /\/api\/users\/:id/ })).toBeVisible();

  // The verbosity control hides everything below the chosen level.
  await page.getByRole('radio', { name: 'error+' }).click();
  await expect(page).toHaveURL(/minLevel=error/);
  await expect(page.locator('.level-total.hidden')).toHaveCount(4);

  // A level total opens Logs at that level.
  await page.locator('.level-total', { hasText: 'fatal' }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/logs.*minLevel=fatal`));
  await expect(page.getByRole('cell', { name: /uncaughtException/ })).toBeVisible();
});

test('issues: list, detail with stack trace, resolve and reopen', async ({ page }) => {
  await page.goto(`/p/${SLUG}/issues?${RANGE}`);
  await expect(page.locator('.issues-table tbody tr')).not.toHaveCount(0);
  await expect(page.locator('.sparkline').first()).toBeVisible();

  await page.getByRole('link', { name: /TypeError: Cannot read properties of null/ }).click();
  await expect(page.locator('.stacktrace .frame.in-app').first()).toContainText('closeSession');
  await expect(page.getByText('closeSession (services/sessionService.js)').first()).toBeVisible();
  await page.getByText('Why these events are grouped together').click();
  await expect(page.locator('.grouping pre')).toContainText(
    'at closeSession (services/sessionService.js)',
  );

  await page.getByRole('button', { name: 'Resolve' }).click();
  await expect(page.locator('.issue-header .badge', { hasText: 'resolved' })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen' }).click();
  await expect(page.getByRole('button', { name: 'Resolve' })).toBeVisible();

  // An issue linked to requests says where it happens.
  await page.goto(`/p/${SLUG}/issues?${RANGE}`);
  await page.getByRole('link', { name: /camera did not answer/ }).click();
  await expect(page.getByRole('cell', { name: /\/api\/gates\/:id\/open/ })).toBeVisible();
});

test('requests: filters, detail drawer and the logs of a request', async ({ page }) => {
  await page.goto(`/p/${SLUG}/requests?${RANGE}`);
  await page.getByLabel('Status').selectOption('5xx');
  await expect(page).toHaveURL(/status=5xx/);
  const rows = page.locator('table tbody tr');
  // The old rows stay, dimmed, until the filtered ones arrive.
  await expect
    .poll(async () => {
      const badges = await page.locator('table tbody .badge[class*="status-"]').allTextContents();
      return badges.length > 0 && badges.every((badge) => Number(badge) >= 500);
    })
    .toBe(true);
  await expect(page.locator('.card.stale')).toHaveCount(0);
  await rows.first().click();
  const drawer = page.getByRole('dialog');
  await expect(drawer.getByText('Logs written for this request')).toBeVisible();
  const errorLine = drawer.locator('.log-line', { hasText: 'Request error' });
  await expect(errorLine).toBeVisible();

  // From the request's log line to the log drawer, then to its issue.
  await errorLine.click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/logs`));
  await page.getByRole('link', { name: /Open the issue this error belongs to/ }).click();
  await expect(page).toHaveURL(new RegExp(`/p/${SLUG}/issues/\\d+`));
  await page.keyboard.press('Escape');
});

test('logs: level filter, search, and the request id link', async ({ page }) => {
  await page.goto(`/p/${SLUG}/logs?${RANGE}`);
  await page.getByRole('radio', { name: 'warn+' }).click();
  await expect
    .poll(async () => {
      const levels = await page.locator('table tbody .badge[class*="level-"]').allTextContents();
      return (
        levels.length > 0 && levels.every((level) => ['warn', 'error', 'fatal'].includes(level))
      );
    })
    .toBe(true);
  await page.getByLabel('Search messages').fill('slow query');
  await page.getByLabel('Search messages').press('Enter');
  await expect(page).toHaveURL(/q=slow/);
  await expect(page.locator('table tbody tr').first()).toContainText('slow query');
  // Some slow queries belong to a request: its id links to all of its lines.
  const withRequest = page
    .locator('table tbody tr')
    .filter({ has: page.locator('button.link') })
    .first();
  await withRequest.locator('button.link').click();
  await expect(page).toHaveURL(/requestId=/);
  await expect(page.locator('table tbody tr')).not.toHaveCount(0);
});

test('settings: projects, keys and the account page', async ({ page }) => {
  await page.goto('/settings/projects');
  await expect(page.getByRole('cell', { name: 'parking-backend' })).toBeVisible();
  await page.getByRole('link', { name: 'Parking backend' }).click();
  await expect(page.getByRole('heading', { name: 'Send data' })).toBeVisible();
  await expect(page.getByText('--cloudwatch --log-group')).toBeVisible();
  await page.getByRole('link', { name: 'Your account' }).click();
  await expect(page.getByRole('heading', { name: 'Change password' })).toBeVisible();
});
