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

  it('says own agents are switched off when a deployment lists no own-agent route', async () => {
    const { bootr } = client(() => json({}));
    const said = `Own agents are switched off on ${bootr.siteUrl} for now. Nothing was done, and nothing is wrong with your setup.`;
    await expect(bootr.connectStart()).rejects.toMatchObject({ code: 'not_listed', status: null, message: said });
    await expect(bootr.ownDue({ credential: `bootr_agt_${'a'.repeat(43)}` })).rejects.toMatchObject({ code: 'not_listed', message: said });
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

  it('sends a Clanker v5 launch with its token settings as given', async () => {
    const { bootr, fetchMock } = client(answer({ launchThrough: 'clanker-v5' }));
    const { message } = await bootr.launchMessage(account.address);
    const signature = await account.signMessage({ message });
    const v5 = {
      ...launch,
      launchThrough: 'clanker' as const,
      token: { pairedAsset: 'USDC', buyTaxPct: 2, sellTaxPct: '3', burnPct: 10 },
      devBuySlippagePct: 5,
    };
    await expect(bootr.prepareLaunch({ message, signature, launch: v5 })).resolves.toMatchObject({
      launchThrough: 'clanker-v5',
    });
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({
      message,
      signature,
      launch: v5,
    });
  });

  it('refuses token settings out of the site’s bounds before sending, so the nonce is not spent', async () => {
    const { bootr, fetchMock } = client(answer({}));
    const { message } = await bootr.launchMessage(account.address);
    const signature = await account.signMessage({ message });
    const before = fetchMock.mock.calls.length;
    const err = (await bootr
      .prepareLaunch({
        message,
        signature,
        launch: { ...launch, launchThrough: 'clanker-v5', token: { buyTaxPct: 6 } },
      })
      .catch((e: unknown) => e)) as BootrApiError;
    expect(err).toMatchObject({ code: 'invalid_request', details: { field: 'token.buyTaxPct' } });
    expect(err.message).toBe(
      'Buy tax must be 1% to 5%, in steps of 0.01%. Nothing was sent, so the signed message is still unused.',
    );
    await expect(
      bootr.prepareLaunch({ message, signature, launch: { ...launch, token: {} } }),
    ).rejects.toMatchObject({ details: { field: 'token' } });
    expect(fetchMock.mock.calls.length).toBe(before);
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

describe('preparing a swap', () => {
  const COIN = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';
  const ROUTER = '0x6fF5693b99212Da76ad316178A184AB56D299b43';
  const swapCatalog = { ...catalog, endpoints: [...catalog.endpoints, { method: 'POST', url: `${SITE}/api/agent/swap`, auth: { type: 'none' } }] } as unknown as Catalog;
  const prepared = (over: object = {}) => ({
    chainId: 8453,
    token: COIN,
    symbol: 'BOOTR',
    side: 'buy',
    path: 'clanker',
    pairedAsset: 'ETH',
    amountIn: { raw: '10000000000000000', formatted: '0.01', asset: 'ETH' },
    quote: { amountOut: { raw: '5', formatted: '0.000000000000000005', asset: 'BOOTR' }, feePct: 2.4, impactPct: 0.1, quotedAt: 1 },
    minReceived: { raw: '4', formatted: '0.000000000000000004', asset: 'BOOTR' },
    slippagePct: 1,
    deadline: 1201,
    steps: [{ kind: 'swap', to: ROUTER, data: '0x3593564c', value: '10000000000000000', sendFrom: OWNER, description: 'Buys BOOTR with 0.01 ETH.' }],
    warnings: [],
    note: 'Nothing was signed or sent.',
    ...over,
  });
  function swapClient(answer: (url: string, init: RequestInit) => Response) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => (String(input).endsWith('/api/catalog') ? json(swapCatalog) : answer(String(input), init)));
    return { bootr: createBootr({ siteUrl: SITE, fetch: fetchMock as typeof fetch }), fetchMock };
  }

  it('posts the six fields to the route the catalog names, checksummed, and keeps the answer', async () => {
    const { bootr, fetchMock } = swapClient(() => json(prepared()));
    const answer = await bootr.prepareSwap({ token: COIN.toLowerCase(), side: 'buy', amount: 0.01, wallet: OWNER.toLowerCase(), payWith: 'ETH', slippagePct: 2 });
    expect(answer.steps[0]).toMatchObject({ kind: 'swap', to: ROUTER, sendFrom: OWNER });
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe(`${SITE}/api/agent/swap`);
    expect(init!.method).toBe('POST');
    expect(JSON.parse(String(init!.body))).toEqual({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER, payWith: 'ETH', slippagePct: 2 });
    // the fields left out are left out, and a step is what a wallet library sends
    await bootr.prepareSwap({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER });
    expect(JSON.parse(String(fetchMock.mock.calls.at(-1)![1]!.body))).toEqual({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER });
    expect(toTransaction(answer.steps[0]!)).toEqual({ to: ROUTER, data: '0x3593564c', value: 10_000_000_000_000_000n });
  });

  it('refuses a key, a malformed address, side or amount before any request', async () => {
    const { bootr, fetchMock } = swapClient(() => json(prepared()));
    const base = { token: COIN, side: 'buy' as const, amount: '0.01', wallet: OWNER };
    await expect(bootr.prepareSwap({ ...base, wallet: `0x${'ab'.repeat(32)}` })).rejects.toMatchObject({ code: 'key_refused' });
    await expect(bootr.prepareSwap({ ...base, amount: `0x${'ab'.repeat(32)}` })).rejects.toMatchObject({ code: 'key_refused' });
    await expect(bootr.prepareSwap({ ...base, token: 'BOOTR' })).rejects.toMatchObject({ code: 'invalid_request', details: { field: 'token' } });
    await expect(bootr.prepareSwap({ ...base, side: 'swap' as 'buy' })).rejects.toMatchObject({ code: 'invalid_request', details: { field: 'side' } });
    for (const amount of ['', '-1', '1e5', 'all', '1,5']) await expect(bootr.prepareSwap({ ...base, amount }), amount).rejects.toMatchObject({ code: 'invalid_request', details: { field: 'amount' } });
    expect(fetchMock.mock.calls).toHaveLength(0);
  });

  it('passes the site’s refusal on with its code, its field and when to come back', async () => {
    const closed = swapClient(() => json({ error: 'trading_not_open', message: 'This coin launched moments ago. Trading opens in 12 seconds.' }, 409, { 'retry-after': '12' }));
    await expect(closed.bootr.prepareSwap({ token: COIN, side: 'buy', amount: '1', wallet: OWNER })).rejects.toMatchObject({ code: 'trading_not_open', status: 409, details: { retryAfter: 12 } });
    const unknown = swapClient(() => json({ error: 'unknown_coin', message: 'No Bootr coin has that address.' }, 404));
    await expect(unknown.bootr.prepareSwap({ token: OWNER, side: 'sell', amount: '1', wallet: OWNER })).rejects.toMatchObject({ code: 'unknown_coin', message: 'No Bootr coin has that address.' });
    const field = swapClient(() => json({ error: 'invalid_request', message: 'slippagePct must be a number from 0.01 to 20.', field: 'slippagePct' }, 400));
    await expect(field.bootr.prepareSwap({ token: COIN, side: 'buy', amount: '1', wallet: OWNER, slippagePct: 50 })).rejects.toMatchObject({ code: 'invalid_request', details: { field: 'slippagePct' } });
  });

  it('refuses an answer for another coin, side, chain or wallet, or one without a swap', async () => {
    const ask = (over: object) => swapClient(() => json(prepared(over))).bootr.prepareSwap({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER });
    const step = prepared().steps[0]!;
    const other = '0x90F79bf6EB2c4f870365E785982E1f101E93b906';
    for (const over of [{ token: other }, { side: 'sell' }, { chainId: 1 }, { steps: [] }, { steps: undefined }, { steps: [{ ...step, sendFrom: other }] }, { steps: [{ ...step, kind: 'approve_token' }] }, { steps: [{ ...step, to: 'router' }] }]) {
      await expect(ask(over), JSON.stringify(over)).rejects.toMatchObject({ code: 'mismatch' });
    }
    await expect(ask({})).resolves.toMatchObject({ token: COIN });
  });

  it('says so when the site does not offer it', async () => {
    const { bootr } = client(() => json(prepared()));
    await expect(bootr.prepareSwap({ token: COIN, side: 'buy', amount: '0.01', wallet: OWNER })).rejects.toMatchObject({ code: 'not_listed' });
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
