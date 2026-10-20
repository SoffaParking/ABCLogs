import { mkdirSync, writeFileSync } from 'node:fs';
import { runImport, synthesizeLines } from '@apiloupe/importer';
import { ADMIN, expect, KEY_FILE, SLUG, test } from './fixtures.js';

// First-run setup through the UI, then a project, a key and six hours of
// synthetic traffic: the state every other spec starts from.
test('first-run setup, a project, a key and demo data', async ({ page, baseURL }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Create the first admin' })).toBeVisible();

  // The wrong code is refused.
  await page.getByLabel('Setup code').fill('WRONG-CODE-0000');
  await page.getByLabel('Email').fill(ADMIN.email);
  await page.getByLabel('Password').fill(ADMIN.password);
  await page.getByRole('button', { name: 'Create admin and sign in' }).click();
  await expect(page.getByRole('alert')).toContainText('wrong setup code');

  await page.getByLabel('Setup code').fill(process.env.E2E_SETUP_CODE!);
  await page.getByLabel('Your name').fill('Admin');
  await page.getByRole('button', { name: 'Create admin and sign in' }).click();

  await expect(page.getByRole('heading', { name: 'Create your first project' })).toBeVisible();
  await page.getByLabel('Project name').fill('Parking backend');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByText('Ingest keys')).toBeVisible();
  await page.getByLabel('Key name').fill('e2e');
  await page.getByRole('button', { name: 'Create key' }).click();
  const key = (await page.locator('.new-key code').textContent())!.trim();
  expect(key).toMatch(/^alk_[a-z0-9]{8}_[a-z0-9]{32}$/);
  await expect(page.getByRole('cell', { name: 'e2e', exact: true })).toBeVisible();

  const stats = await runImport(
    synthesizeLines({ minutes: 360, requestsPerMinute: 30, seed: 11 }),
    {
      endpoint: baseURL!,
      key,
    },
  );
  expect(stats.accepted).toBeGreaterThan(5000);

  mkdirSync('.auth', { recursive: true });
  writeFileSync(KEY_FILE, key);
  await page.context().storageState({ path: '.auth/admin.json' });
  await page.goto(`/p/${SLUG}`);
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
});
