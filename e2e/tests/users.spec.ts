import { ADMIN, expect, SLUG, test } from './fixtures.js';

test('invite a member, who can read and triage but not administer', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/settings/users');
  await page.getByLabel('Email').fill('member@example.com');
  await page.getByLabel('Role', { exact: true }).selectOption('member');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = (await page.locator('.new-key code').textContent())!.trim();
  expect(link).toContain('/invite/');

  // The member accepts in a browser of their own.
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const member = await context.newPage();
  await member.goto(link);
  await expect(member.getByText('member@example.com')).toBeVisible();
  await member.getByLabel('Your name').fill('Member');
  await member.getByLabel('Password').fill('another long password');
  await member.getByRole('button', { name: 'Create account' }).click();
  await expect(member.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await member.goto('/settings');
  await expect(member.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await member.goto(`/p/${SLUG}/issues`);
  await member
    .locator('.issues-table tbody tr')
    .first()
    .getByRole('button', { name: 'Ignore' })
    .click();
  await member.getByRole('radio', { name: /Ignored/ }).click();
  await expect(member.locator('.issues-table tbody tr')).toHaveCount(1);

  // The invite link works once.
  await member.getByRole('button', { name: 'Sign out' }).click();
  await member.goto(link);
  await expect(member.getByRole('heading', { name: 'Invite not valid' })).toBeVisible();
  await context.close();
});

test('invite a viewer, who can read everything but change nothing', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/settings/users');
  await page.getByLabel('Email').fill('viewer@example.com');
  // Viewer is the default: the least access.
  await expect(page.getByLabel('Role', { exact: true })).toHaveValue('viewer');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  const link = (await page.locator('.new-key code').textContent())!.trim();

  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const viewer = await context.newPage();
  await viewer.goto(link);
  await viewer.getByLabel('Your name').fill('Viewer');
  await viewer.getByLabel('Password').fill('a viewer password here');
  await viewer.getByRole('button', { name: 'Create account' }).click();
  await expect(viewer.getByRole('heading', { name: 'Overview' })).toBeVisible();

  await viewer.goto(`/p/${SLUG}/issues`);
  const rows = viewer.locator('.issues-table tbody tr');
  await expect(rows.first()).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^(Resolve|Ignore|Reopen)$/ })).toHaveCount(0);
  await rows.first().locator('.issue-title').click();
  await expect(viewer.locator('.stats')).toBeVisible();
  await expect(viewer.getByRole('button', { name: /^(Resolve|Ignore|Reopen)$/ })).toHaveCount(0);

  await viewer.goto('/settings');
  await expect(viewer.getByRole('link', { name: 'Users' })).toHaveCount(0);
  await viewer.getByRole('link', { name: 'Your account' }).click();
  await expect(viewer.getByText(/viewer@example\.com · viewer/)).toBeVisible();
  await context.close();
});

test('sign out, a wrong password, and signing back in', async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, storageState: { cookies: [], origins: [] } });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill('not the password');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('wrong email or password');
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  await context.close();
});
