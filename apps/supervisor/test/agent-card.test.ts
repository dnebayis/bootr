import { describe, expect, it } from 'vitest';
import { creatorIdentityFromCard, fetchCreatorIdentity } from '../src/agent-card.js';

const CARD = 'https://bootr.fun/agents/0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f.json';
const TEXT = 'A patient onchain analyst for small Base coins.\nShort, plain, no hype.';
const publicHost = async () => [{ address: '93.184.216.34' }];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Scripted fetch: answers by exact URL, records the calls. */
function cardFetch(routes: Record<string, () => Response | Promise<Response>>) {
  const calls: { url: string; headers: Headers; redirect: RequestInit['redirect'] }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    calls.push({ url, headers: new Headers(init?.headers), redirect: init?.redirect });
    const route = routes[url];
    if (!route) return new Response('not found', { status: 404 });
    return route();
  };
  return { fetch: fetchImpl, calls };
}

describe('creatorIdentityFromCard', () => {
  it('takes bootr.identity, normalized, and nothing else', () => {
    expect(creatorIdentityFromCard({ bootr: { identity: `  ${TEXT}\r\n` } })).toBe(TEXT);
    expect(creatorIdentityFromCard({ description: TEXT })).toBe('');
    expect(creatorIdentityFromCard({ bootr: { identity: 42 } })).toBe('');
    expect(creatorIdentityFromCard({ bootr: 'x' })).toBe('');
    expect(creatorIdentityFromCard(null)).toBe('');
    expect(creatorIdentityFromCard('[]')).toBe('');
  });
});

describe('fetchCreatorIdentity', () => {
  it('reads the text from the hosted card with a JSON accept header and manual redirects', async () => {
    const { fetch, calls } = cardFetch({ [CARD]: () => json({ type: 'x', bootr: { identity: TEXT } }) });
    expect(await fetchCreatorIdentity(CARD, { fetch, resolve: publicHost })).toBe(TEXT);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.headers.get('accept')).toBe('application/json');
    expect(calls[0]!.redirect).toBe('manual');
  });

  it('is final ("") when the card has no identity, is not JSON, or answers 4xx', async () => {
    const none = cardFetch({ [CARD]: () => json({ type: 'x', description: 'd' }) });
    expect(await fetchCreatorIdentity(CARD, { fetch: none.fetch, resolve: publicHost })).toBe('');
    const html = cardFetch({ [CARD]: () => new Response('<html>hi</html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
    expect(await fetchCreatorIdentity(CARD, { fetch: html.fetch, resolve: publicHost })).toBe('');
    const missing = cardFetch({});
    expect(await fetchCreatorIdentity(CARD, { fetch: missing.fetch, resolve: publicHost })).toBe('');
    expect(await fetchCreatorIdentity('', { fetch: missing.fetch, resolve: publicHost })).toBe('');
    expect(missing.calls).toHaveLength(1); // the empty URI is never fetched
  });

  it('is null (retry later) on 5xx, 429, network errors and DNS failures', async () => {
    for (const status of [500, 503, 429]) {
      const { fetch } = cardFetch({ [CARD]: () => json({ error: 'x' }, status) });
      expect(await fetchCreatorIdentity(CARD, { fetch, resolve: publicHost })).toBeNull();
    }
    const failing: typeof fetch = async () => {
      throw new TypeError('fetch failed');
    };
    expect(await fetchCreatorIdentity(CARD, { fetch: failing, resolve: publicHost })).toBeNull();
    const noDns = async () => {
      throw new Error('ENOTFOUND');
    };
    const { fetch, calls } = cardFetch({ [CARD]: () => json({}) });
    expect(await fetchCreatorIdentity(CARD, { fetch, resolve: noDns })).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('never fetches http, credentialed or private-host URIs (final "")', async () => {
    const { fetch, calls } = cardFetch({});
    expect(await fetchCreatorIdentity('http://bootr.fun/agents/x.json', { fetch, resolve: publicHost })).toBe('');
    expect(await fetchCreatorIdentity('https://user:pw@bootr.fun/agents/x.json', { fetch, resolve: publicHost })).toBe('');
    expect(await fetchCreatorIdentity('https://localhost/agents/x.json', { fetch, resolve: publicHost })).toBe('');
    expect(await fetchCreatorIdentity('https://10.0.0.5/agents/x.json', { fetch, resolve: publicHost })).toBe('');
    expect(await fetchCreatorIdentity('https://internal.example/agents/x.json', { fetch, resolve: async () => [{ address: '10.1.2.3' }] })).toBe('');
    expect(await fetchCreatorIdentity('not a url', { fetch, resolve: publicHost })).toBe('');
    expect(calls).toHaveLength(0);
  });

  it('follows redirects with the host check and gives up on a private hop or a long chain', async () => {
    const moved = 'https://cdn.bootr.fun/cards/x.json';
    const ok = cardFetch({
      [CARD]: () => new Response(null, { status: 302, headers: { location: moved } }),
      [moved]: () => json({ bootr: { identity: TEXT } }),
    });
    expect(await fetchCreatorIdentity(CARD, { fetch: ok.fetch, resolve: publicHost })).toBe(TEXT);
    expect(ok.calls.map((c) => c.url)).toEqual([CARD, moved]);

    const toPrivate = cardFetch({ [CARD]: () => new Response(null, { status: 302, headers: { location: 'https://127.0.0.1/x.json' } }) });
    expect(await fetchCreatorIdentity(CARD, { fetch: toPrivate.fetch, resolve: publicHost })).toBe('');
    expect(toPrivate.calls).toHaveLength(1);

    const loop = cardFetch({ [CARD]: () => new Response(null, { status: 302, headers: { location: CARD } }) });
    expect(await fetchCreatorIdentity(CARD, { fetch: loop.fetch, resolve: publicHost })).toBe('');
    expect(loop.calls).toHaveLength(4);
  });

  it('bounds the text to 600 plain-text characters', async () => {
    const { fetch } = cardFetch({ [CARD]: () => json({ bootr: { identity: 'x'.repeat(5000) + '\u0000‮' } }) });
    const out = await fetchCreatorIdentity(CARD, { fetch, resolve: publicHost });
    expect(out).toHaveLength(600);
    expect(out).toBe('x'.repeat(600));
  });
});
