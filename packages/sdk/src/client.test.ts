import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { describe, expect, it, vi } from 'vitest';
import { BootrApiError, createBootr, looksLikeKey, toTransaction, type Catalog } from './index.js';

const OWNER = '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC';
const SITE = 'https://site.example';
const INDEXER = 'https://indexer.example';

const catalog = {
  chainId: 8453,
  endpoints: [
    { service: 'indexer', method: 'GET', url: `${INDEXER}/market/{token}`, auth: { type: 'none' } },
    { method: 'GET', url: `${INDEXER}/search`, auth: { type: 'none' } },
    { method: 'GET', url: `${SITE}/api/agents/{id}/posts`, auth: { type: 'none' } },
    { method: 'POST', url: `${SITE}/api/agent/nonce`, auth: { type: 'none' } },
    {
      method: 'POST',
      url: `${SITE}/api/agent/launch`,
      auth: {
        type: 'siwe',
        statement: 'Prepare a Bootr launch.',
        domain: 'site.example',
        uri: SITE,
        chainId: 8453,
        nonceUrl: `${SITE}/api/agent/nonce`,
      },
    },
  ],
} as unknown as Catalog;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

function client(answer: (url: string, init: RequestInit) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    return url.endsWith('/api/catalog') ? json(catalog) : answer(url, init);
  });
  return {
    bootr: createBootr({ siteUrl: `${SITE}/`, fetch: fetchMock as typeof fetch }),
    fetchMock,
  };
}

describe('routes come from the catalog', () => {
  it('calls the origin the catalog names, with path and query parameters filled in', async () => {
    const { bootr, fetchMock } = client(() => json({ handle: null, items: [] }));
    await bootr.agentPosts(12, { limit: 3 });
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`${SITE}/api/agents/12/posts?limit=3`);
    await bootr.market(OWNER);
    expect(fetchMock.mock.calls.at(-1)![0]).toBe(`${INDEXER}/market/${OWNER.toLowerCase()}`);
  });

  it('reads the catalog once', async () => {
    const { bootr, fetchMock } = client(() => json([]));
    await bootr.search('a');
    await bootr.search('b');
    expect(fetchMock.mock.calls.filter(([u]) => String(u).endsWith('/api/catalog'))).toHaveLength(
      1,
    );
  });

  it('says so when a deployment does not list a route', async () => {
    const { bootr } = client(() => json({}));
    await expect(bootr.prepareClaim(OWNER)).rejects.toMatchObject({ code: 'not_listed' });
  });
});

describe('errors', () => {
  it('carries the code, status, field and Retry-After of a refusal', async () => {
    const { bootr } = client(() =>
      json({ error: 'rate_limited', message: 'Wait.', field: 'x' }, 429, { 'retry-after': '7' }),
    );
    const err = await bootr.search('a').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BootrApiError);
    expect(err).toMatchObject({
      code: 'rate_limited',
      status: 429,
      message: 'Wait.',
      details: { field: 'x', retryAfter: 7 },
    });
  });

  it('names a network failure', async () => {
    const bootr = createBootr({
      siteUrl: SITE,
      fetch: (async () => {
        throw new TypeError('failed');
      }) as typeof fetch,
    });
    await expect(bootr.platform()).rejects.toMatchObject({ code: 'unreachable' });
  });

  it('retries the catalog after a failure', async () => {
    let up = false;
    const bootr = createBootr({
      siteUrl: SITE,
      fetch: (async () => {
        if (!up) throw new TypeError('failed');
        return json(catalog);
      }) as typeof fetch,
    });
    await expect(bootr.catalog()).rejects.toMatchObject({ code: 'unreachable' });
    up = true;
    await expect(bootr.catalog()).resolves.toMatchObject({ chainId: 8453 });
  });
});

describe('keys', () => {
  const KEY = `0x${'ab'.repeat(32)}`;

  it('recognizes a key and a seed phrase, not an address or a signature', () => {
    expect(looksLikeKey(KEY)).toBe(true);
    expect(looksLikeKey('ab'.repeat(32))).toBe(true);
    expect(
      looksLikeKey('legal winner thank year wave sausage worth useful legal winner thank yellow'),
    ).toBe(true);
    expect(looksLikeKey(OWNER)).toBe(false);
    expect(looksLikeKey(`0x${'ab'.repeat(65)}`)).toBe(false);
    expect(looksLikeKey('a coin about a small quiet engine')).toBe(false);
  });

  it('refuses one before any request, without repeating it', async () => {
    const { bootr, fetchMock } = client(() => json({}));
    const err = (await bootr.prepareClaim(KEY).catch((e: unknown) => e)) as BootrApiError;
    expect(err.code).toBe('key_refused');
    expect(err.message).not.toContain(KEY);
    await expect(bootr.search(KEY)).rejects.toMatchObject({ code: 'key_refused' });
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/search'))).toHaveLength(0);
  });

  it('refuses a malformed address locally', async () => {
    const { bootr } = client(() => json({}));
    await expect(bootr.market('0x12')).rejects.toMatchObject({
      code: 'invalid_request',
      details: { field: 'address' },
    });
  });
});

describe('launch', () => {
  const account = privateKeyToAccount(
    '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  );
  const answer = (over: object) => (url: string) =>
    url.endsWith('/nonce')
      ? json({ nonce: 'abcdef0123456789', expiresIn: 600 })
      : json({ creator: account.address, chainId: 8453, transactions: [], ...over });
  const launch = {
    name: 'A',
    symbol: 'AA',
    identity: 'x'.repeat(20),
    image: { url: 'https://x/a.png' },
  };

  it('builds the message from the catalog, checksummed, with the site’s nonce', async () => {
    const { bootr } = client(answer({}));
    const { message, statement } = await bootr.launchMessage(account.address.toLowerCase());
    expect(statement).toBe('Prepare a Bootr launch.');
    expect(parseSiweMessage(message)).toMatchObject({
      address: account.address,
      domain: 'site.example',
      uri: SITE,
      chainId: 8453,
      nonce: 'abcdef0123456789',
      statement,
      version: '1',
    });
  });

  it('posts the signed message and keeps the answer', async () => {
    const { bootr, fetchMock } = client(answer({}));
    const { message } = await bootr.launchMessage(account.address);
    const signature = await account.signMessage({ message });
    await expect(bootr.prepareLaunch({ message, signature, launch })).resolves.toMatchObject({
      creator: account.address,
    });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`${SITE}/api/agent/launch`);
    expect(JSON.parse(String(init!.body))).toEqual({ message, signature, launch });
  });

  it('refuses an answer for another wallet or chain', async () => {
    const { bootr } = client(answer({ creator: OWNER }));
    const { message } = await bootr.launchMessage(account.address);
    const signature = await account.signMessage({ message });
    await expect(bootr.prepareLaunch({ message, signature, launch })).rejects.toMatchObject({
      code: 'mismatch',
    });
    const other = client(answer({ chainId: 1 }));
    await expect(other.bootr.prepareLaunch({ message, signature, launch })).rejects.toMatchObject({
      code: 'mismatch',
    });
  });
});

describe('toTransaction', () => {
  it('takes a claim and a launch step alike', () => {
    expect(toTransaction({ target: OWNER, data: '0x12', value: '0' })).toEqual({
      to: OWNER,
      data: '0x12',
      value: 0n,
    });
    expect(toTransaction({ to: OWNER, data: '0x12', value: '5' })).toEqual({
      to: OWNER,
      data: '0x12',
      value: 5n,
    });
  });
});
