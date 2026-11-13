import { decodeFunctionData, erc20Abi, getAddress, parseEther, type Address } from 'viem';
import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mockStore } from '@/lib/mock';
import { minReceived, permit2Abi, poolIdOf, poolKeyOf, SWAP_CONTRACTS } from '@/lib/swap/core';
import type { PreparedSwap, SwapCoinRow } from '@/lib/swap/prepare';

/**
 * `POST /api/agent/swap` as a caller meets it: once on the site's fixtures (mock mode, as `next dev` without an
 * indexer), and once "live" with the indexer and the chain answered here, for the three launch paths, a USDC coin paid
 * both ways, every refusal and the two limits. `lib/swap/prepare.test.ts` decodes the calldata word by word and
 * `lib/swap/prepare.fork.test.ts` sends this route's own answers on a Base fork.
 */

const WALLET = getAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
const USDC = SWAP_CONTRACTS.usdc;
const ROUTER = SWAP_CONTRACTS.universalRouter;
const PERMIT2 = SWAP_CONTRACTS.permit2;

let caller = 0;
/** A request from an address of its own, so one test never uses up another's limit. */
function post(body: unknown, ip = `198.51.100.${(caller += 1)}`, headers: Record<string, string> = {}) {
  return new NextRequest('http://localhost/api/agent/swap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': ip, ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body) });
}

type Refused = { error: string; message: string; field?: string };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.doUnmock('@/lib/server/chain');
  vi.resetModules();
});

describe('on the site’s fixtures', () => {
  const coinOf = (source: string, paired?: Address) => mockStore().tokens.find((t) => (t.source ?? 'bootr') === source && (!paired || t.pairedToken.toLowerCase() === paired.toLowerCase()))!;

  it('prepares a buy and a sell on each launch path, marked as a test answer, readable from any origin', async () => {
    const { POST } = await import('./route');
    for (const source of ['bootr', 'clanker', 'clanker-v5']) {
      const coin = coinOf(source);
      const buy = await POST(post({ token: coin.id, side: 'buy', amount: '0.01', wallet: WALLET }));
      expect(buy.status, source).toBe(200);
      expect(buy.headers.get('access-control-allow-origin')).toBe('*');
      expect(buy.headers.get('cache-control')).toBe('no-store');
      const b = (await buy.json()) as PreparedSwap;
      expect(b, source).toMatchObject({ chainId: 8453, token: getAddress(coin.id), symbol: coin.symbol, side: 'buy', path: source, pairedAsset: 'ETH', mock: true, slippagePct: 1, amountIn: { formatted: '0.01', asset: 'ETH' } });
      expect(b.steps.map((s) => [s.kind, s.to, s.sendFrom, s.value])).toEqual([['swap', ROUTER, WALLET, parseEther('0.01').toString()]]);
      expect(BigInt(b.minReceived.raw)).toBe(minReceived(BigInt(b.quote.amountOut.raw), 100));
      expect(b.note).toMatch(/^Nothing was signed or sent\./);

      const sell = await POST(post({ token: coin.id, side: 'sell', amount: '1000', wallet: WALLET, slippagePct: 2 }));
      const s = (await sell.json()) as PreparedSwap;
      expect(s.steps.map((x) => [x.kind, x.to]), source).toEqual([['approve_token', getAddress(coin.id)], ['approve_permit2', PERMIT2], ['swap', ROUTER]]);
      expect(decodeFunctionData({ abi: erc20Abi, data: s.steps[0]!.data }).args).toEqual([PERMIT2, parseEther('1000')]);
      expect(s).toMatchObject({ side: 'sell', slippagePct: 2, quote: { amountOut: { asset: 'ETH' } } });
    }
  });

  it('a coin paired with USDC is bought with USDC, or with ETH when asked', async () => {
    const { POST } = await import('./route');
    const coin = coinOf('clanker-v5', USDC);
    const usdc = (await (await POST(post({ token: coin.id, side: 'buy', amount: '25', wallet: WALLET }))).json()) as PreparedSwap;
    expect(usdc).toMatchObject({ pairedAsset: 'USDC', amountIn: { raw: '25000000', asset: 'USDC' } });
    expect(usdc.steps.map((s) => [s.kind, s.to, s.value])).toEqual([['approve_token', USDC, '0'], ['approve_permit2', PERMIT2, '0'], ['swap', ROUTER, '0']]);
    const eth = (await (await POST(post({ token: coin.id, side: 'buy', amount: '0.01', wallet: WALLET, payWith: 'ETH' }))).json()) as PreparedSwap;
    expect(eth).toMatchObject({ pairedAsset: 'USDC', amountIn: { asset: 'ETH' } });
    expect(eth.steps.map((s) => [s.kind, s.value])).toEqual([['swap', parseEther('0.01').toString()]]);
  });

  it('refuses what it cannot read, by field, and a coin it does not know', async () => {
    const { POST } = await import('./route');
    const coin = coinOf('bootr');
    const refused = async (body: unknown) => {
      const res = await POST(post(body));
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      return { status: res.status, ...((await res.json()) as Refused) };
    };
    expect(await refused({ token: `0x${'12'.repeat(20)}`, side: 'buy', amount: '1', wallet: WALLET })).toEqual({ status: 404, error: 'unknown_coin', message: 'No Bootr coin has that address.' });
    expect(await refused({ token: coin.id, side: 'buy', amount: '1', wallet: WALLET, recipient: WALLET })).toMatchObject({ status: 400, error: 'invalid_request', field: 'recipient' });
    expect(await refused({ token: coin.id, side: 'buy', amount: 'all', wallet: WALLET })).toMatchObject({ status: 400, error: 'invalid_request', field: 'amount' });
    expect(await refused({ token: coin.id, side: 'buy', amount: '1', wallet: WALLET, payWith: 'USDC' })).toMatchObject({ status: 400, error: 'invalid_request', field: 'payWith' });
    expect(await refused({ token: coin.id, side: 'buy', amount: '1', wallet: WALLET, slippagePct: 25 })).toMatchObject({ status: 400, error: 'invalid_request', field: 'slippagePct' });
    expect(await refused('not json')).toMatchObject({ status: 400, error: 'invalid_request', field: 'body' });
    expect(await refused('[1,2]')).toMatchObject({ status: 400, field: 'body' });
    // more than the fixture wallet holds
    expect(await refused({ token: coin.id, side: 'buy', amount: '5', wallet: WALLET })).toMatchObject({ status: 409, error: 'no_balance' });
    // a body far larger than any request
    expect(await refused(JSON.stringify({ token: coin.id, side: 'buy', amount: '1', wallet: WALLET, pad: 'x'.repeat(4000) }))).toMatchObject({ status: 413, error: 'payload_too_large' });
  });

  it('answers a browser’s preflight from any site', async () => {
    const { OPTIONS } = await import('./route');
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('content-type');
  });

  it('takes 20 calls a minute from one address, and says when to come back', async () => {
    const { POST } = await import('./route');
    const coin = coinOf('bootr');
    const body = { token: coin.id, side: 'buy', amount: '0.01', wallet: WALLET };
    for (let i = 0; i < 20; i++) expect((await POST(post(body, '203.0.113.7'))).status, `call ${i + 1}`).toBe(200);
    const res = await POST(post(body, '203.0.113.7'));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    expect(await res.json()).toMatchObject({ error: 'rate_limited', message: expect.stringMatching(/^This route takes 20 requests per minute per IP\. Retry in \d+ seconds\.$/) });
    // a malformed request counts too, and another address is not held back
    expect((await POST(post({}, '203.0.113.7'))).status).toBe(429);
    expect((await POST(post(body, '203.0.113.8'))).status).toBe(200);
  });

  it('takes a set number of calls a minute over all callers, whatever address each comes from', async () => {
    vi.stubEnv('SWAP_PREPARE_PER_MIN_ALL', '3');
    const { POST } = await import('./route');
    const body = { token: coinOf('bootr').id, side: 'buy', amount: '0.01', wallet: WALLET };
    for (let i = 0; i < 3; i++) expect((await POST(post(body))).status).toBe(200);
    const res = await POST(post(body));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(await res.json()).toMatchObject({ error: 'rate_limited', message: expect.stringMatching(/3 a minute over all callers\. Retry in \d+ seconds\.$/) });
  });

  it('is switched off by a limit of 0, and a fee ceiling from the environment is the one applied', async () => {
    vi.stubEnv('SWAP_PREPARE_PER_MIN_ALL', '0');
    const off = await import('./route');
    const body = { token: coinOf('bootr').id, side: 'buy', amount: '0.01', wallet: WALLET };
    const res = await off.POST(post(body));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: 'not_available', message: 'Preparing swaps is switched off on this site for now. Nothing was prepared.' });

    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv('SWAP_PREPARE_MAX_FEE_PCT', '0.5');
    const strict = await import('./route');
    // the fixture coin's fee is 1%: above a ceiling of 0.5
    const refused = await strict.POST(post(body));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ error: 'fee_too_high', message: 'This trade would pay a fee of 1% right now. Nothing was prepared; ask again in a moment.' });
  });
});

// ---------------------------------------------------------------------------
// Live: the indexer and the chain answered here
// ---------------------------------------------------------------------------

const token = (n: number) => getAddress(`0x${n.toString(16).padStart(2, '0').repeat(20)}`);
const NOW = () => Math.floor(Date.now() / 1000);
const rowOf = (id: Address, source: 'bootr' | 'clanker' | 'clanker-v5', paired: Address | null, extra: Partial<SwapCoinRow> = {}): SwapCoinRow => ({
  id: id.toLowerCase(),
  symbol: 'OWL',
  poolId: poolIdOf(poolKeyOf(id, source, paired)!),
  source,
  pairedToken: source === 'clanker-v5' ? (paired ?? '0x0000000000000000000000000000000000000000') : SWAP_CONTRACTS.weth,
  launchedAt: NOW() - 3600,
  antiSnipe: source === 'clanker-v5' ? true : null,
  ...extra,
});

type Chain = {
  /** The pool's fee in millionths: the quoter gives the amount less this. */
  feePpm: bigint;
  /** The pool's price as sqrtPriceX96; 0 = not initialized. */
  sqrtPriceX96: bigint;
  quoteFails: string | null;
  quoteOut: bigint | null;
  eth: bigint;
  spent: bigint;
  tokenAllowance: bigint;
  permit2: [bigint, number, number];
  launch: { armed: boolean; createdAt: number } | null;
  down: boolean;
  calls: string[];
};

const Q96 = 2n ** 96n;
const freshChain = (over: Partial<Chain> = {}): Chain => ({ feePpm: 15_000n, sqrtPriceX96: Q96, quoteFails: null, quoteOut: null, eth: parseEther('10'), spent: parseEther('1000000'), tokenAllowance: 0n, permit2: [0n, 0, 0], launch: null, down: false, calls: [], ...over });

/** A chain client that answers the route's reads by the function asked for, as viem's `multicall` and `readContract` do. */
function fakeClient(chain: Chain) {
  const one = (c: { address: Address; functionName: string; args?: readonly unknown[] }): unknown => {
    chain.calls.push(c.functionName);
    switch (c.functionName) {
      case 'quoteExactInputSingle': {
        if (chain.quoteFails) throw new Error(chain.quoteFails);
        const amount = (c.args![0] as { exactAmount: bigint }).exactAmount;
        return [chain.quoteOut ?? (amount * (1_000_000n - chain.feePpm)) / 1_000_000n, 150_000n];
      }
      case 'getSlot0':
        return [chain.sqrtPriceX96, 0, 0, 0];
      case 'mevModuleEnabled':
        if (!chain.launch) throw new Error('no window');
        return chain.launch.armed;
      case 'poolCreationTimestamp':
        if (!chain.launch) throw new Error('no window');
        return BigInt(chain.launch.createdAt);
      case 'MAX_MEV_MODULE_DELAY':
        if (!chain.launch) throw new Error('no window');
        return 120n;
      case 'getEthBalance':
        return chain.eth;
      case 'balanceOf':
        return chain.spent;
      case 'allowance':
        return c.address.toLowerCase() === PERMIT2.toLowerCase() ? chain.permit2 : chain.tokenAllowance;
      default:
        throw new Error(`unexpected read ${c.functionName}`);
    }
  };
  return {
    multicall: async ({ contracts, allowFailure }: { contracts: { address: Address; functionName: string; args?: readonly unknown[] }[]; allowFailure?: boolean }) => {
      if (chain.down) throw new Error('fetch failed');
      return contracts.map((c) => {
        if (allowFailure === false) return one(c);
        try {
          return { status: 'success', result: one(c) };
        } catch (error) {
          return { status: 'failure', error };
        }
      });
    },
    // The first hop of an ETH buy of a USDC coin: Uniswap v3's WETH/USDC pool at 3,000 USDC an ETH.
    readContract: async () => {
      if (chain.down) throw new Error('fetch failed');
      chain.calls.push('slot0');
      return [BigInt(Math.floor(Math.sqrt(3e-9) * 2 ** 96)), 0, 0, 0, 0, 0, true];
    },
  };
}

/** The route with an indexer that holds `rows` and a chain that answers as `chain` says. */
async function live(rows: SwapCoinRow[], chain: Chain, indexer: { status?: number; errors?: string; oldSchema?: boolean } = {}) {
  vi.stubEnv('NEXT_PUBLIC_INDEXER_URL', 'https://indexer.test');
  vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '8453');
  vi.stubEnv('NEXT_PUBLIC_USE_MOCK', '');
  const asked: { query: string; id: string }[] = [];
  vi.stubGlobal('fetch', async (url: string, init: { body: string }) => {
    expect(String(url)).toBe('https://indexer.test/graphql');
    const { query, variables } = JSON.parse(init.body) as { query: string; variables: { id: string } };
    asked.push({ query, id: variables.id });
    if (indexer.status) return new Response('down', { status: indexer.status });
    if (indexer.errors) return Response.json({ errors: [{ message: indexer.errors }] });
    if (indexer.oldSchema && /antiSnipe/.test(query)) return Response.json({ errors: [{ message: 'Cannot query field "antiSnipe" on type "token".' }] });
    const row = rows.find((r) => r.id === variables.id) ?? null;
    return Response.json({ data: { token: row && indexer.oldSchema ? { id: row.id, symbol: row.symbol, poolId: row.poolId, pairedToken: row.pairedToken, launchedAt: row.launchedAt } : row } });
  });
  vi.doMock('@/lib/server/chain', () => ({ serverPublicClient: () => fakeClient(chain) }));
  const { POST } = await import('./route');
  const call = async (body: Record<string, unknown>) => {
    const res = await POST(post(body));
    return { status: res.status, retryAfter: res.headers.get('retry-after'), cors: res.headers.get('access-control-allow-origin'), body: (await res.json()) as PreparedSwap & Refused };
  };
  return { call, asked };
}

describe('live, with the indexer and the chain answered here', () => {
  const COINS = { bootr: rowOf(token(0xb2), 'bootr', null), clanker: rowOf(token(0xc4), 'clanker', null), v5Eth: rowOf(token(0xe5), 'clanker-v5', null), v5Usdc: rowOf(token(0xd5), 'clanker-v5', USDC) };
  const all = Object.values(COINS);

  it('prepares a buy and a sell on the three launch paths from the coin’s indexed pool and a live quote', async () => {
    const chain = freshChain();
    const { call, asked } = await live(all, chain);
    for (const coin of [COINS.bootr, COINS.clanker, COINS.v5Eth]) {
      const buy = await call({ token: getAddress(coin.id), side: 'buy', amount: '0.5', wallet: WALLET });
      expect(buy.status, coin.source!).toBe(200);
      expect(buy.cors).toBe('*');
      expect(buy.body).toMatchObject({ chainId: 8453, token: getAddress(coin.id), symbol: 'OWL', side: 'buy', path: coin.source, pairedAsset: 'ETH', amountIn: { raw: parseEther('0.5').toString(), formatted: '0.5', asset: 'ETH' } });
      expect(buy.body).not.toHaveProperty('mock');
      // the fixture pool's price is 1 and its fee 1.5%
      expect(buy.body.quote).toMatchObject({ amountOut: { raw: parseEther('0.4925').toString(), asset: 'OWL' }, feePct: 1.5, impactPct: 0 });
      expect(Math.abs(buy.body.quote.quotedAt - NOW())).toBeLessThan(5);
      expect(buy.body.deadline).toBe(buy.body.quote.quotedAt + 1200);
      expect(buy.body.minReceived.raw).toBe(minReceived(parseEther('0.4925'), 100).toString());
      expect(buy.body.steps.map((s) => [s.kind, s.to, s.value, s.sendFrom])).toEqual([['swap', ROUTER, parseEther('0.5').toString(), WALLET]]);

      const sell = await call({ token: coin.id, side: 'sell', amount: '100', wallet: WALLET });
      expect(sell.body.steps.map((s) => [s.kind, s.to])).toEqual([['approve_token', getAddress(coin.id)], ['approve_permit2', PERMIT2], ['swap', ROUTER]]);
      expect(decodeFunctionData({ abi: permit2Abi, data: sell.body.steps[1]!.data }).args!.slice(0, 3)).toEqual([getAddress(coin.id), ROUTER, parseEther('100')]);
      expect(sell.body).toMatchObject({ side: 'sell', quote: { amountOut: { asset: 'ETH' } }, minReceived: { asset: 'ETH' } });
    }
    // the indexer is asked for the coin by its lowercase address, and for nothing else
    expect(new Set(asked.map((a) => a.id))).toEqual(new Set([COINS.bootr.id, COINS.clanker.id, COINS.v5Eth.id]));
    expect(asked[0]!.query).toContain('token(id: $id) { id symbol poolId source pairedToken launchedAt antiSnipe }');
  });

  it('a USDC coin: paid with USDC through exact approvals, or with ETH in one transaction', async () => {
    const chain = freshChain({ spent: 500_000_000n });
    const { call } = await live(all, chain);
    const usdc = await call({ token: COINS.v5Usdc.id, side: 'buy', amount: '25', wallet: WALLET });
    expect(usdc.body).toMatchObject({ path: 'clanker-v5', pairedAsset: 'USDC', amountIn: { raw: '25000000', formatted: '25', asset: 'USDC' } });
    expect(usdc.body.steps.map((s) => [s.kind, s.to, s.value])).toEqual([['approve_token', USDC, '0'], ['approve_permit2', PERMIT2, '0'], ['swap', ROUTER, '0']]);
    expect(decodeFunctionData({ abi: erc20Abi, data: usdc.body.steps[0]!.data }).args).toEqual([PERMIT2, 25_000_000n]);

    chain.calls.length = 0;
    const eth = await call({ token: COINS.v5Usdc.id, side: 'buy', amount: '0.01', wallet: WALLET, payWith: 'ETH' });
    expect(eth.status).toBe(200);
    expect(eth.body).toMatchObject({ pairedAsset: 'USDC', amountIn: { formatted: '0.01', asset: 'ETH' }, quote: { amountOut: { asset: 'OWL' } } });
    expect(eth.body.steps.map((s) => [s.kind, s.to, s.value])).toEqual([['swap', ROUTER, parseEther('0.01').toString()]]);
    // 0.01 ETH at 3,000 is about 30 USDC less the hop's 0.05%, then the coin pool's 1.5%
    expect(Number(eth.body.quote.amountOut.raw)).toBeGreaterThan(29_000_000);
    expect(Number(eth.body.quote.amountOut.raw)).toBeLessThan(30_000_000);
    // ETH pays: no token balance and no allowance is read
    expect(chain.calls).toContain('slot0');
    expect(chain.calls).not.toContain('allowance');

    // allowances that already cover the amount: the swap alone
    vi.resetModules();
    const again = await live(all, freshChain({ spent: 500_000_000n, tokenAllowance: 25_000_000n, permit2: [25_000_000n, NOW() + 900, 0] }));
    expect((await again.call({ token: COINS.v5Usdc.id, side: 'buy', amount: '25', wallet: WALLET })).body.steps.map((s) => s.kind)).toEqual(['swap']);
  });

  it('unknown_coin: an address the indexer does not hold is not a Bootr coin, and no chain read is made', async () => {
    const chain = freshChain();
    const { call } = await live(all, chain);
    // WETH itself, USDC, and a real coin of someone else: none is prepared
    for (const stranger of [SWAP_CONTRACTS.weth, USDC, token(0x99)]) {
      const res = await call({ token: stranger, side: 'buy', amount: '1', wallet: WALLET });
      expect(res).toMatchObject({ status: 404, cors: '*', body: { error: 'unknown_coin', message: 'No Bootr coin has that address.' } });
      expect(res.body).not.toHaveProperty('steps');
    }
    expect(chain.calls).toEqual([]);
  });

  it('not_tradable: a row whose pool is not the one a Bootr launch makes', async () => {
    const chain = freshChain();
    const bad = [
      { ...COINS.v5Eth, poolId: COINS.clanker.poolId },
      { ...COINS.bootr, poolId: poolIdOf({ ...poolKeyOf(getAddress(COINS.bootr.id), 'bootr'), hooks: token(0x66) }) },
      rowOf(getAddress(COINS.v5Usdc.id), 'clanker-v5', token(0x77)),
    ];
    for (const row of bad) {
      const { call } = await live([row], chain);
      expect(await call({ token: row.id, side: 'buy', amount: '1', wallet: WALLET })).toMatchObject({ status: 409, body: { error: 'not_tradable', message: 'This coin cannot be traded here: its pool does not match a Bootr launch. Nothing was prepared.' } });
      vi.resetModules();
    }
    expect(chain.calls).toEqual([]);
  });

  it('trading_not_open: a Clanker v5 coin in its first 20 seconds, with when to come back', async () => {
    const chain = freshChain();
    const { call } = await live([{ ...COINS.v5Eth, launchedAt: NOW() - 4 }], chain);
    const res = await call({ token: COINS.v5Eth.id, side: 'buy', amount: '0.01', wallet: WALLET });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('trading_not_open');
    expect(res.body.message).toMatch(/^This coin launched moments ago\. For its first 20 seconds Clanker charges buyers up to 99%, so nothing was prepared\. Trading opens in 1[5-7] seconds\.$/);
    expect(Number(res.retryAfter)).toBeGreaterThanOrEqual(15);
    expect(Number(res.retryAfter)).toBeLessThanOrEqual(17);
    expect(chain.calls).toEqual([]);
    // an indexer that does not know the sniper field yet: unknown counts as on
    vi.resetModules();
    const old = await live([{ ...COINS.v5Eth, launchedAt: NOW() - 4 }], chain, { oldSchema: true });
    // the coin is still known by its pool id, and its window still holds
    expect((await old.call({ token: COINS.v5Eth.id, side: 'buy', amount: '0.01', wallet: WALLET })).body.error).toBe('trading_not_open');
    expect(old.asked.map((a) => /antiSnipe/.test(a.query))).toEqual([true, false]);
  });

  it('fee_too_high: the launch fee of a new Clanker coin is not prepared, on a buy or a sell', async () => {
    const chain = freshChain({ feePpm: 706_000n, launch: { armed: true, createdAt: NOW() - 3 } });
    const { call } = await live(all, chain);
    const buy = await call({ token: COINS.clanker.id, side: 'buy', amount: '0.01', wallet: WALLET });
    expect(buy).toMatchObject({ status: 409, retryAfter: '5', body: { error: 'fee_too_high', message: 'This trade would pay a fee of 70.6% right now. Nothing was prepared; ask again in a moment.' } });
    expect((await call({ token: COINS.clanker.id, side: 'sell', amount: '10', wallet: WALLET })).body.error).toBe('fee_too_high');
    // at the ceiling it goes through
    chain.feePpm = 150_000n;
    expect((await call({ token: COINS.clanker.id, side: 'buy', amount: '0.01', wallet: WALLET })).status).toBe(200);
    chain.feePpm = 150_100n;
    expect((await call({ token: COINS.clanker.id, side: 'buy', amount: '0.01', wallet: WALLET })).body.error).toBe('fee_too_high');
  });

  it('the panel’s own refusals: no balance, no liquidity, no pool, the blocked first blocks, the network', async () => {
    const chain = freshChain();
    const { call } = await live(all, chain);
    const buy = { token: COINS.clanker.id, side: 'buy', amount: '0.01', wallet: WALLET };

    chain.eth = parseEther('0.001');
    expect(await call(buy)).toMatchObject({ status: 409, body: { error: 'no_balance', message: 'Your balance is too low for this amount. Nothing was prepared.' } });
    chain.eth = parseEther('10');
    chain.spent = parseEther('5');
    expect((await call({ ...buy, side: 'sell', amount: '6' })).body.error).toBe('no_balance');
    chain.spent = parseEther('1000');

    chain.quoteOut = 0n;
    expect(await call(buy)).toMatchObject({ status: 409, body: { error: 'no_liquidity', message: 'The pool does not have enough liquidity for this amount. Try a smaller amount. Nothing was prepared.' } });
    chain.quoteOut = null;
    chain.quoteFails = 'execution reverted: NotEnoughLiquidity(0x00)';
    expect((await call(buy)).body.error).toBe('no_liquidity');
    chain.quoteFails = null;

    chain.sqrtPriceX96 = 0n;
    expect(await call(buy)).toMatchObject({ status: 409, body: { error: 'no_pool', message: 'This coin has no trading pool yet. Nothing was prepared.' } });
    chain.sqrtPriceX96 = Q96;

    // Clanker v4 holds a new pool's first blocks back: the quoter reverts without a name
    chain.launch = { armed: true, createdAt: NOW() };
    chain.quoteFails = 'execution reverted';
    const blocked = await call(buy);
    expect(blocked).toMatchObject({ status: 409, retryAfter: '5', body: { error: 'launch_window' } });
    expect(blocked.body.message).toMatch(/^This coin launched moments ago\. Clanker blocks swaps .* Nothing was prepared\.$/);
    // the same revert on an old pool has no such reason: no quote, in words of its own
    chain.launch = null;
    expect(await call(buy)).toMatchObject({ status: 409, body: { error: 'no_quote', message: 'The pool gave no quote for this trade just now. Nothing was prepared; ask again in a moment.' } });
    chain.quoteFails = null;

    chain.down = true;
    expect(await call(buy)).toMatchObject({ status: 502, cors: '*', body: { error: 'network', message: 'Could not reach the network. Check your connection and try again. Nothing was prepared.' } });
    expect((await call({ token: COINS.v5Usdc.id, side: 'buy', amount: '0.01', wallet: WALLET, payWith: 'ETH' })).body.error).toBe('network');
  });

  it('an indexer that cannot answer prepares nothing', async () => {
    const down = await live(all, freshChain(), { status: 503 });
    expect(await down.call({ token: COINS.bootr.id, side: 'buy', amount: '1', wallet: WALLET })).toMatchObject({ status: 502, body: { error: 'indexer_unavailable' } });
    vi.resetModules();
    const broken = await live(all, freshChain(), { errors: 'relation "token" does not exist' });
    const res = await broken.call({ token: COINS.bootr.id, side: 'buy', amount: '1', wallet: WALLET });
    expect(res).toMatchObject({ status: 502, body: { error: 'indexer_unavailable' } });
    // the indexer's own words are not passed on
    expect(res.body.message).not.toContain('relation');
  });

  it('a site that is not on Base prepares nothing', async () => {
    const { call } = await live(all, freshChain());
    vi.resetModules();
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '84532');
    const { POST } = await import('./route');
    const res = await POST(post({ token: COINS.bootr.id, side: 'buy', amount: '1', wallet: WALLET }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: 'not_tradable', message: 'Swaps are prepared for Base only, and this site runs on another chain. Nothing was prepared.' });
    void call;
  });

  it('whatever a request says, every step goes to the token spent, Permit2 or the router, from the wallet it named', async () => {
    const hostile = token(0xee);
    const { call } = await live(all, freshChain({ spent: parseEther('1000000') }));
    const requests: Record<string, unknown>[] = [
      { token: COINS.v5Eth.id, side: 'buy', amount: '0.01', wallet: hostile },
      { token: COINS.v5Eth.id, side: 'sell', amount: '10', wallet: hostile },
      { token: COINS.v5Usdc.id, side: 'buy', amount: '25', wallet: hostile },
      { token: COINS.v5Usdc.id, side: 'buy', amount: '0.01', wallet: hostile, payWith: 'ETH' },
      { token: COINS.clanker.id, side: 'sell', amount: '10', wallet: hostile },
      { token: COINS.bootr.id, side: 'sell', amount: '10', wallet: hostile },
    ];
    for (const request of requests) {
      const res = await call(request);
      expect(res.status, JSON.stringify(request)).toBe(200);
      const spent = request.side === 'sell' ? getAddress(String(request.token)) : USDC;
      for (const step of res.body.steps) {
        expect([spent, PERMIT2, ROUTER]).toContain(step.to);
        expect(step.sendFrom).toBe(hostile);
        // the wallet is in no calldata: nothing is paid "to" it by name, only to whoever sends
        expect(step.data.toLowerCase()).not.toContain(hostile.toLowerCase().slice(2));
        if (step.kind === 'approve_token') expect(decodeFunctionData({ abi: erc20Abi, data: step.data }).args![0]).toBe(PERMIT2);
        if (step.kind === 'approve_permit2') expect(decodeFunctionData({ abi: permit2Abi, data: step.data }).args![1]).toBe(ROUTER);
      }
    }
    // and the ways a request could try to steer the money are all refused before anything is read
    for (const extra of [{ recipient: hostile }, { to: hostile }, { router: hostile }, { permit2: hostile }, { minReceived: '0' }, { deadline: 1 }, { poolId: COINS.clanker.poolId }, { hooks: hostile }]) {
      expect((await call({ token: COINS.v5Eth.id, side: 'buy', amount: '0.01', wallet: WALLET, ...extra })).status, JSON.stringify(extra)).toBe(400);
    }
  });
});
