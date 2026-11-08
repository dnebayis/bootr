import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { mock, mockStore } from '@/lib/mock';
import { launchIdOfContractUri, LINKS_STATEMENT, PUT } from './route';

const ORIGIN = 'http://localhost:3000';

function put(kernel: string, body: unknown, headers: Record<string, string> = {}) {
  const req = new NextRequest(`${ORIGIN}/api/agent/${kernel}/links`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': '203.0.113.7', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return PUT(req, { params: Promise.resolve({ kernel }) } as unknown as RouteContext<'/api/agent/[kernel]/links'>);
}

describe('PUT /api/agent/[kernel]/links (mock mode)', () => {
  // Unit tests run without an indexer URL, which is mock mode: the signature is skipped and the mock store is written.
  const coin = mockStore().tokens.find((t) => t.xHandle && !mockStore().links.has(t.metadata))!;

  it('reads the statement and the launch id the way the route does', () => {
    const m = LINKS_STATEMENT.exec('Update the links of Bootr coin $BOOTR (#1153600, 0x1111111111111111111111111111111111111111).');
    expect(m?.slice(1)).toEqual(['BOOTR', '1153600', '0x1111111111111111111111111111111111111111']);
    expect(LINKS_STATEMENT.test('Update the agent of Bootr coin $BOOTR (#1, 0x1111111111111111111111111111111111111111).')).toBe(false);
    expect(launchIdOfContractUri(`${env.siteUrl}/tokens/8b7d05c6-a4b4-415c-93cf-46f36b679889.json`)).toBe('8b7d05c6-a4b4-415c-93cf-46f36b679889');
    expect(launchIdOfContractUri('https://elsewhere.example/tokens/8b7d05c6-a4b4-415c-93cf-46f36b679889.json')).toBeNull();
    expect(launchIdOfContractUri('ipfs://bafy')).toBeNull();
    expect(launchIdOfContractUri(null)).toBeNull();
  });

  it('refuses other origins, a bad kernel, bad JSON and a body without links', async () => {
    expect(env.useMock).toBe(true);
    expect((await put(coin.kernel, { links: {} }, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await put('nope', { links: {} })).status).toBe(400);
    expect((await put(coin.kernel, '{')).status).toBe(400);
    const noLinks = await put(coin.kernel, { message: '', signature: '0x' });
    expect(noLinks.status).toBe(400);
    expect(((await noLinks.json()) as { message: string }).message).toMatch(/links must be an object/);
  });

  it('refuses a browser on another site, sandboxed pages included, and takes a program with no Origin', async () => {
    for (const origin of ['https://evil.example', 'null', 'https://bootr.fun.evil.example', '']) {
      const refused = await put(coin.kernel, { links: { x: '@bootrfun' } }, { origin });
      expect(refused.status, origin).toBe(403);
      expect(((await refused.json()) as { error: string }).error).toBe('forbidden');
    }
    const none = new NextRequest(`${ORIGIN}/api/agent/${coin.kernel}/links`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.8' },
      body: JSON.stringify({ links: { telegram: 'https://telegram.org/x' } }),
    });
    expect(none.headers.get('origin')).toBeNull();
    // Past the Origin check: the link rules answer, not the 403.
    const res = await PUT(none, { params: Promise.resolve({ kernel: coin.kernel }) } as unknown as RouteContext<'/api/agent/[kernel]/links'>);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { field: string }).field).toBe('telegram');
  });

  it('validates each link with the launch form rules and names the field', async () => {
    const res = await put(coin.kernel, { links: { website: 'https://quiet.engine', telegram: 'https://telegram.org/x' } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_request', message: 'Telegram must be an https://t.me/ link.', field: 'telegram' });
    expect(mock.coinLinks(coin.metadata)).toEqual({ website: null, x: null, telegram: null, discord: null });
    // The agent's own account is accepted as the coin's X: whatever the creator enters is shown.
    const own = await put(coin.kernel, { links: { x: `@${coin.xHandle}` } });
    expect(own.status).toBe(200);
    expect(await own.json()).toEqual({ website: null, x: `https://x.com/${coin.xHandle}`, telegram: null, discord: null });
    expect(mock.coinLinks(coin.metadata).x).toBe(`https://x.com/${coin.xHandle}`);
  });

  it('answers 404 for a treasury no coin has', async () => {
    const res = await put('0x00000000000000000000000000000000000000aa', { links: { x: '@bootrfun' } });
    expect(res.status).toBe(404);
  });

  it('stores the normalised links and answers with them', async () => {
    const res = await put(coin.kernel, { message: '0x00000000000000000000000000000000000e2e01', signature: '0x', links: { website: ' https://quiet.engine ', x: '@bootrfun', telegram: '', discord: null } });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const links = { website: 'https://quiet.engine', x: 'https://x.com/bootrfun', telegram: null, discord: null };
    expect(await res.json()).toEqual(links);
    expect(mock.coinLinks(coin.metadata)).toEqual(links);
    // Clearing a field removes the link.
    const cleared = await put(coin.kernel, { links: { x: 'https://x.com/bootrfun' } });
    expect(await cleared.json()).toEqual({ website: null, x: 'https://x.com/bootrfun', telegram: null, discord: null });
    expect(mock.coinLinks(coin.metadata).website).toBeNull();
  });
});
