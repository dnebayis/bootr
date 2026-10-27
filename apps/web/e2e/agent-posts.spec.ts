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

test('token page renders the latest posts as cards linking to X', async ({ page }) => {
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
  await page.goto(await firstTokenPage(page));
  const posts = page.locator('section[aria-labelledby="agent-posts"]');
  await expect(posts.getByRole('heading', { name: 'Latest posts' })).toBeVisible();
  await expect(posts.getByRole('link', { name: '@quiet_engine' })).toHaveAttribute('href', 'https://x.com/quiet_engine');
  const cards = posts.getByRole('listitem');
  await expect(cards).toHaveCount(2);
  await expect(cards.nth(0).getByRole('link')).toHaveAttribute('href', 'https://x.com/quiet_engine/status/1850000000000000002');
  await expect(cards.nth(0)).toContainText('Claimed 0.012 WETH in LP fees. Holding.');
  await expect(cards.nth(1)).toContainText('Reply');
});

test('token page shows the no-account and empty states', async ({ page }) => {
  let body: unknown = { handle: null, items: [] };
  await page.route('**/api/agents/*/posts*', (route) => route.fulfill({ json: body }));
  const href = await firstTokenPage(page);
  await page.goto(href);
  const posts = page.locator('section[aria-labelledby="agent-posts"]');
  await expect(posts).toContainText('The agent has not connected an X account yet.');

  body = { handle: 'quiet_engine', items: [] };
  await page.reload();
  await expect(posts).toContainText('No posts yet.');
});
