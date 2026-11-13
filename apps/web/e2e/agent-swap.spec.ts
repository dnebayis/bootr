import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';

/**
 * `POST /api/agent/swap` in the built app, on the site's fixtures (mock mode): the route is listed, answers a program
 * and answers a page on another site, which first asks with a preflight. What the steps do on real pools is covered by
 * `lib/swap/prepare.fork.test.ts`; every check and refusal by `lib/swap/prepare.test.ts` and the route's own test.
 */
const WALLET = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';

async function firstCoin(page: import('@playwright/test').Page): Promise<string> {
  await page.goto('/');
  const href = await page.locator('a[href^="/token/0x"]').first().getAttribute('href');
  return href!.replace('/token/', '');
}

test('agent API: a buy and a sell are prepared as unsigned steps, and the catalog lists the route (mock mode)', async ({ page, request }) => {
  const token = await firstCoin(page);
  const catalog = (await (await request.get('/api/catalog')).json()) as { endpoints: { method: string; url: string; cors: string; rateLimit?: { limit: number }; parameters?: { body?: { properties: object } } }[] };
  const listed = catalog.endpoints.find((e) => e.url.endsWith('/api/agent/swap'))!;
  expect(listed).toMatchObject({ method: 'POST', cors: 'any-origin', rateLimit: { limit: 20 } });
  expect(Object.keys(listed.parameters!.body!.properties)).toEqual(['token', 'side', 'amount', 'wallet', 'payWith', 'slippagePct']);

  // Its own client address: the route allows 20 calls a minute per address.
  const headers = { 'x-real-ip': '10.7.1.1' };
  const buy = await request.post('/api/agent/swap', { headers, data: { token, side: 'buy', amount: '0.01', wallet: WALLET } });
  expect(buy.status(), await buy.text()).toBe(200);
  expect(buy.headers()['access-control-allow-origin']).toBe('*');
  expect(buy.headers()['cache-control']).toBe('no-store');
  const b = (await buy.json()) as { mock: boolean; side: string; steps: { kind: string; to: string; value: string; sendFrom: string }[]; minReceived: { raw: string }; quote: { amountOut: { raw: string } }; note: string };
  expect(b).toMatchObject({ mock: true, side: 'buy', slippagePct: 1 });
  expect(b.steps).toHaveLength(1);
  expect(b.steps[0]).toMatchObject({ kind: 'swap', to: ROUTER, value: '10000000000000000', sendFrom: WALLET });
  expect(BigInt(b.minReceived.raw)).toBe((BigInt(b.quote.amountOut.raw) * 9900n) / 10000n);
  expect(b.note).toMatch(/^Nothing was signed or sent\./);

  const sell = await request.post('/api/agent/swap', { headers, data: { token, side: 'sell', amount: '1000', wallet: WALLET, slippagePct: 2 } });
  const s = (await sell.json()) as { steps: { kind: string; to: string; value: string }[] };
  expect(s.steps.map((x) => x.kind)).toEqual(['approve_token', 'approve_permit2', 'swap']);
  expect(s.steps[0]!.to.toLowerCase()).toBe(token.toLowerCase());
  for (const step of s.steps) expect(step.value).toBe('0');

  // what it refuses: a field it does not have, a coin that is not one, an amount that is not one
  const recipient = await request.post('/api/agent/swap', { headers, data: { token, side: 'buy', amount: '0.01', wallet: WALLET, recipient: ROUTER } });
  expect(recipient.status()).toBe(400);
  expect(await recipient.json()).toMatchObject({ error: 'invalid_request', field: 'recipient' });
  const stranger = await request.post('/api/agent/swap', { headers, data: { token: ROUTER, side: 'buy', amount: '0.01', wallet: WALLET } });
  expect(stranger.status()).toBe(404);
  expect(await stranger.json()).toEqual({ error: 'unknown_coin', message: 'No Bootr coin has that address.' });
  const amount = await request.post('/api/agent/swap', { headers, data: { token, side: 'buy', amount: 'all', wallet: WALLET } });
  expect(await amount.json()).toMatchObject({ error: 'invalid_request', field: 'amount' });
  // a GET is not this route
  expect((await request.get('/api/agent/swap')).status()).toBe(405);
});

test('agent API: a page on another site can call the swap route, preflight and all (mock mode)', async ({ page, request, baseURL }) => {
  const token = await firstCoin(page);
  const preflight = await request.fetch('/api/agent/swap', { method: 'OPTIONS', headers: { origin: 'https://wallet.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' } });
  expect(preflight.status()).toBe(204);
  expect(preflight.headers()['access-control-allow-origin']).toBe('*');
  expect(preflight.headers()['access-control-allow-methods']).toContain('POST');
  expect(preflight.headers()['access-control-allow-headers']).toBe('content-type');

  // A real browser on a page of another origin: a JSON POST makes it ask first, and it may read the answer. The
  // other site is a small server of its own on this machine, on another port: this site's own pages carry a policy
  // that keeps them from calling other origins, and Chrome asks for a permission before a page from elsewhere may
  // call this machine at all.
  const other = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><title>Another site</title>');
  });
  await new Promise<void>((resolve) => other.listen(0, '127.0.0.1', resolve));
  const elsewhere = `http://127.0.0.1:${(other.address() as AddressInfo).port}`;
  expect(new URL(elsewhere).origin).not.toBe(new URL(baseURL!).origin);
  await page.goto(elsewhere);
  const asked: string[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/agent/swap')) asked.push(r.method());
  });
  const answer = await page.evaluate(
    async ({ url, body }) => {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      return { status: res.status, body: (await res.json()) as { steps?: { kind: string }[]; error?: string } };
    },
    { url: `${baseURL}/api/agent/swap`, body: { token, side: 'buy', amount: '0.01', wallet: WALLET } },
  );
  expect(answer.status).toBe(200);
  expect(answer.body.steps!.map((s) => s.kind)).toEqual(['swap']);
  expect(asked).toContain('POST');
  other.close();
});
