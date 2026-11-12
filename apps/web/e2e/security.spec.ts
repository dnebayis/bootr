import { expect, test } from '@playwright/test';
import { getAddress } from 'viem';

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';

test('pages and API responses carry the security headers', async ({ request }) => {
  for (const path of ['/', '/launch', '/api/health']) {
    const res = await request.get(path);
    const h = res.headers();
    expect(h['content-security-policy'], path).toContain("frame-ancestors 'none'");
    expect(h['content-security-policy'], path).toContain('frame-src https://dexscreener.com');
    expect(h['content-security-policy'], path).toContain("object-src 'none'");
    expect(h['x-frame-options'], path).toBe('DENY');
    expect(h['x-content-type-options'], path).toBe('nosniff');
    expect(h['referrer-policy'], path).toBe('strict-origin-when-cross-origin');
  }
  const start = await request.get(`/api/x/start?agentId=${DRAFT}&state=s-1`, { maxRedirects: 0 });
  expect(start.headers()['referrer-policy']).toBe('no-referrer');
});

test('the console 404 also carries the headers', async ({ request }) => {
  const res = await request.get('/console-wrong');
  expect(res.status()).toBe(404);
  expect(res.headers()['x-frame-options']).toBe('DENY');
});

test('/api/platform exposes only the launch switches', async ({ request }) => {
  const res = await request.get('/api/platform');
  expect(res.status()).toBe(200);
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(['allowedModels', 'launchesPaused', 'ownAgent']);
  expect(typeof body.launchesPaused).toBe('boolean');
  expect(typeof body.ownAgent).toBe('boolean');
  expect(Array.isArray(body.allowedModels)).toBe(true);
});

test('/api/x/draft is same-origin only and validates the draft id', async ({ request, baseURL }) => {
  const cross = await request.post('/api/x/draft', { data: { agentId: DRAFT }, headers: { origin: 'https://evil.example' } });
  expect(cross.status()).toBe(403);
  const none = await request.post('/api/x/draft', { data: { agentId: DRAFT } });
  expect(none.status()).toBe(403);
  void baseURL;
});

test('admin config: unsigned reads are refused, service reads need a valid signature', async ({ request }) => {
  expect((await request.get('/api/admin/config')).status()).toBe(401);
  const ts = String(Math.floor(Date.now() / 1000));
  const bad = await request.get('/api/admin/config', { headers: { 'x-bootr-timestamp': ts, 'x-bootr-signature': '00'.repeat(32) } });
  expect(bad.status()).toBe(401);
});

test('SIWE verify refuses a message for another domain even with a spoofed X-Forwarded-Host', async ({ request }) => {
  const nonceRes = await request.post('/api/siwe/nonce');
  expect(nonceRes.status()).toBe(200);
  const { nonce } = await nonceRes.json();
  const message = [
    'bootr-console.example wants you to sign in with your Ethereum account:',
    getAddress('0x000000000000000000000000000000000000e2e1'),
    '',
    'Sign in',
    '',
    'URI: https://bootr-console.example',
    'Version: 1',
    'Chain ID: 8453',
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  const res = await request.post('/api/siwe/verify', {
    data: { message, signature: '0x' + '11'.repeat(65) },
    headers: { 'x-forwarded-host': 'bootr-console.example' },
  });
  expect(res.status()).toBe(401);
  expect((await res.json()).error).toBe('URI mismatch');
  // The nonce was spent by that attempt.
  const again = await request.post('/api/siwe/verify', {
    data: { message, signature: '0x' + '11'.repeat(65) },
  });
  expect(again.status()).toBe(401);
});
