import { ADMIN, expect, SLUG, test } from './fixtures.js';

test('invite a member, who can read and triage but not administer', async ({
  page,
  browser,
  baseURL,
}) => {
  await page.goto('/settings/users');
  await page.getByLabel('Email').fill('member@example.com');
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
