import { expect, test } from '@playwright/test';

/** Against the production build: the proxy, prerendering and the router's own 404, which unit tests cannot reach. */
test('docs: a page is served as Markdown beside its HTML', async ({ request }) => {
  const md = await request.get('/docs/fees.md');
  expect(md.status()).toBe(200);
  expect(md.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  // The proxy's security headers apply here too, and nothing rewrites the route.
  expect(md.headers()['x-content-type-options']).toBe('nosniff');
  const text = await md.text();
  expect(text.startsWith('# Fee math and claims\n')).toBe(true);

  const overview = await request.get('/docs.md');
  expect(overview.status()).toBe(200);
  const links = await overview.text();
  expect(links).toContain('# Overview');
  expect(links).toContain('/docs/fees.md)');

  const html = await request.get('/docs/fees');
  expect(html.status()).toBe(200);
  expect(html.headers()['content-type']).toContain('text/html');
  const page = await html.text();
  expect(page).toContain('Fee math and claims');
  expect(page).toMatch(/<link[^>]*rel="alternate"[^>]*type="text\/markdown"[^>]*href="[^"]*\/docs\/fees\.md"/);

  const index = await (await request.get('/llms.txt')).text();
  expect(index).toContain('/docs/fees.md)');
});

test('docs: an unknown page is a real 404, as Markdown or HTML', async ({ request }) => {
  for (const path of ['/docs/nope.md', '/docs/nope', '/docs/agent-rules.md', '/docs/fees.md/nope']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});
