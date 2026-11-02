import { expect, test } from '@playwright/test';

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';

test('/api/x/status validates the subject and returns a fake handle in mock mode', async ({ request }) => {
  // A launch draft uuid or a live agent id; anything else is rejected.
  const bad = await request.get('/api/x/status?agentId=not-an-id');
  expect(bad.status()).toBe(400);
  expect((await request.get('/api/x/status?agentId=10388')).status()).toBe(200);

  const res = await request.get(`/api/x/status?agentId=${DRAFT}`);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  expect(await res.json()).toEqual({ connected: true, handle: 'mock_agent' });
});

test('/api/x/start validates input and does not redirect in mock mode', async ({ request }) => {
  expect((await request.get(`/api/x/start?agentId=${DRAFT}`, { maxRedirects: 0 })).status()).toBe(400);
  expect((await request.get(`/api/x/start?agentId=not-an-id&state=abc`, { maxRedirects: 0 })).status()).toBe(400);
  expect((await request.get(`/api/x/start?agentId=10388&state=abc`, { maxRedirects: 0 })).status()).toBe(200); // a live agent id, claimed by its creator
  expect((await request.get(`/api/x/start?agentId=${DRAFT}&state=${'a'.repeat(129)}`, { maxRedirects: 0 })).status()).toBe(400);

  const res = await request.get(`/api/x/start?agentId=${DRAFT}&state=s-1`, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ mock: true, agentId: DRAFT });
});

test('/api/x/draft registers a draft (mock mode) and rejects bad ids', async ({ request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const bad = await request.post('/api/x/draft', { data: { agentId: '10388' }, headers: { origin } });
  expect(bad.status()).toBe(403); // the e2e build's site origin is the default https://bootr.fun
  const good = await request.post('/api/x/draft', { data: { agentId: DRAFT }, headers: { origin: 'https://bootr.fun' } });
  expect(good.status()).toBe(200);
  expect(await good.json()).toEqual({ ok: true, mock: true });
  const invalid = await request.post('/api/x/draft', { data: { agentId: '10388' }, headers: { origin: 'https://bootr.fun' } });
  expect(invalid.status()).toBe(400);
});
