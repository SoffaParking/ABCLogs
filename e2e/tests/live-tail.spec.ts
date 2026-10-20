import { expect, ingestKey, SLUG, test } from './fixtures.js';

test('live tail shows a new log line within seconds of it arriving', async ({ page, baseURL }) => {
  await page.goto(`/p/${SLUG}/logs`);
  await page.getByRole('button', { name: /Live tail/ }).click();
  await expect(page.getByText('Live tail', { exact: true })).toBeVisible();

  const marker = `tail marker ${Date.now()}`;
  const res = await fetch(`${baseURL}/ingest/v1/events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${ingestKey()}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      events: [{ type: 'log', time: Date.now(), level: 'warn', message: marker }],
    }),
  });
  expect(res.status).toBe(202);
  await expect(page.getByRole('cell', { name: marker })).toBeVisible({ timeout: 8000 });

  await page.getByRole('button', { name: 'Pause' }).click();
  await expect(page.getByText('Live tail paused')).toBeVisible();
  await page.getByRole('button', { name: /Stop live tail/ }).click();
  await expect(page).not.toHaveURL(/live=1/);
});
