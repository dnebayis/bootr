import { expect, test, type Page } from '@playwright/test';

async function firstTokenPage(page: Page) {
  await page.goto('/');
  const href = await page.locator('main a[href^="/token/0x"]').first().getAttribute('href');
  expect(href).toBeTruthy();
  return href!;
}

test('/api/agents/:id/posts proxies posts (mock), 404s unknown agents and validates the id', async ({ request }) => {
  let found = false;
  for (let id = 100; id < 110 && !found; id++) {
    const res = await request.get(`/api/agents/${id}/posts?limit=3`);
    expect(res.status()).toBe(200);
    expect(res.headers()['cache-control']).toContain('max-age=60');
    const body = await res.json();
    if (!body.handle) continue;
    found = true;
    expect(body.items).toHaveLength(3);
    for (const p of body.items) {
      expect(p.url).toBe(`https://x.com/${body.handle}/status/${p.postId}`);
      expect(Object.keys(p).sort()).toEqual(['createdAt', 'id', 'kind', 'postId', 'text', 'url']);
    }
    expect((await (await request.get(`/api/agents/${id}/posts?limit=1`)).json()).items).toHaveLength(1);
  }
  expect(found).toBe(true);
  expect((await request.get('/api/agents/999999/posts')).status()).toBe(404);
  expect((await request.get(`/api/agents/${encodeURIComponent('bad id!')}/posts`)).status()).toBe(400);
});

test('token page lists the latest posts in the Activity tape, linking to X', async ({ page }) => {
  await page.route('**/api/agents/*/posts*', (route) =>
    route.fulfill({
      json: {
        handle: 'quiet_engine',
        items: [
          { id: 'a2', kind: 'post', text: 'Claimed 0.012 WETH in LP fees. Holding.', postId: '1850000000000000002', url: 'https://x.com/quiet_engine/status/1850000000000000002', createdAt: Math.floor(Date.now() / 1000) - 600 },
          { id: 'a1', kind: 'reply', text: 'The split is locked on-chain.', postId: '1850000000000000001', url: 'https://x.com/quiet_engine/status/1850000000000000001', createdAt: Math.floor(Date.now() / 1000) - 7200 },
        ],
      },
    }),
  );
  // The supervisor's own tape is empty here, so the Posts filter shows exactly the sender's two posts.
  await page.route('**/api/agent/*/activity*', (route) => route.fulfill({ json: { items: [] } }));
  await page.goto(await firstTokenPage(page));
  const tape = page.getByTestId('activity-tape');
  await expect(tape.getByRole('link', { name: '@quiet_engine' })).toHaveAttribute('href', 'https://x.com/quiet_engine');
  await page.getByRole('tab', { name: 'Posts' }).click();
  await expect(tape).toHaveAttribute('data-filter', 'posts');
  const rows = tape.getByRole('listitem');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toHaveAttribute('data-kind', 'post');
  await expect(rows.nth(0).getByRole('link')).toHaveAttribute('href', 'https://x.com/quiet_engine/status/1850000000000000002');
  await expect(rows.nth(0)).toContainText('Claimed 0.012 WETH in LP fees. Holding.');
  await expect(rows.nth(1)).toHaveAttribute('data-kind', 'reply');
});

test('token page shows the no-account and empty states in the Posts filter', async ({ page }) => {
  let body: unknown = { handle: null, items: [] };
  await page.route('**/api/agents/*/posts*', (route) => route.fulfill({ json: body }));
  await page.route('**/api/agent/*/activity*', (route) => route.fulfill({ json: { items: [] } }));
  const href = await firstTokenPage(page);
  await page.goto(href);
  const tape = page.getByTestId('activity-tape');
  await page.getByRole('tab', { name: 'Posts' }).click();
  await expect(tape).toContainText('The agent has not connected an X account yet.');

  body = { handle: 'quiet_engine', items: [] };
  await page.reload();
  await page.getByRole('tab', { name: 'Posts' }).click();
  await expect(tape).toContainText('No posts yet.');
});
