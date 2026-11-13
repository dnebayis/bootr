import { NextResponse, type NextRequest } from 'next/server';
import { erc20Abi, multicall3Abi, type Address } from 'viem';
import { base } from 'viem/chains';
import { builderDataSuffix } from '@/lib/attribution';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { serverPublicClient } from '@/lib/server/chain';
import { clientIp, RateLimiter } from '@/lib/server/ipfs';
import { rateLimitMessage } from '@/lib/server/refusals';
import { permit2Abi, SWAP_CONTRACTS, type Allowances } from '@/lib/swap/core';
import { SwapFailure } from '@/lib/swap/errors';
import { MOCK_COIN_BALANCE, MOCK_ETH_BALANCE, MOCK_PAIRED_BALANCE, mockEthViaPairedQuote, mockQuote } from '@/lib/swap/mock';
import { panelRefusal, parseSwapRequest, planSwap, prepareSwap, SWAP_REFUSALS, swapPrepareLimits, type SwapCoinRow, type SwapPlan, type SwapRefusal, type WalletState } from '@/lib/swap/prepare';
import { quoteEthViaPaired, quoteSwap, type SwapQuote } from '@/lib/swap/quote';

const HEADERS = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' };
/** A request is a handful of short fields. */
const MAX_BODY_BYTES = 2048;
// Per address, as the claim route's (SWAP_PREPARE_PER_MIN in lib/swap/prepare.ts; the catalog states it).
const limiter = new RateLimiter(20, 60_000);
// Over all callers: the address a limit counts by is only as good as the proxy in front. One key, so one counter.
let everyone: { limit: number; limiter: RateLimiter } | null = null;

function overAll(limit: number): number {
  if (!everyone || everyone.limit !== limit) everyone = { limit, limiter: new RateLimiter(limit, 60_000) };
  return everyone.limiter.hit('all');
}

function refuse(r: SwapRefusal) {
  return NextResponse.json(
    { error: r.error, message: r.message, ...(r.field ? { field: r.field } : {}) },
    { status: r.status, headers: { ...HEADERS, ...(r.retryAfter ? { 'Retry-After': String(r.retryAfter) } : {}) } },
  );
}

const COIN_FIELDS = ['id symbol poolId source pairedToken launchedAt antiSnipe', 'id symbol poolId pairedToken launchedAt'];

/**
 * The coin's row from the indexer, by its address, or null when no Bootr coin has it. An indexer that does not know
 * the newer fields is asked again without them (the coin is then read as an older one). Throws when it cannot answer.
 */
async function findCoin(token: Address): Promise<SwapCoinRow | null> {
  for (const [i, fields] of COIN_FIELDS.entries()) {
    const res = await fetch(`${env.indexerUrl}/graphql`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: `query SwapCoin($id: String!) { token(id: $id) { ${fields} } }`, variables: { id: token.toLowerCase() } }),
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json().catch(() => null)) as { data?: { token: SwapCoinRow | null }; errors?: { message: string }[] } | null;
    const message = body?.errors?.map((e) => e.message).join('; ') ?? '';
    if (i === 0 && /Cannot query field "(source|antiSnipe)"/.test(message)) continue;
    if (!res.ok || !body || message || !body.data) throw new Error('indexer');
    return body.data.token ?? null;
  }
  throw new Error('indexer');
}

/** The wallet's ETH, and for a swap that spends an ERC-20 its balance of it and both allowances, in one multicall. */
async function readWallet(chainId: 8453, wallet: Address, plan: SwapPlan): Promise<WalletState> {
  const client = serverPublicClient(chainId);
  const eth = { address: base.contracts.multicall3.address, abi: multicall3Abi, functionName: 'getEthBalance', args: [wallet] } as const;
  if (!plan.spent) {
    const [balance] = await client.multicall({ allowFailure: false, contracts: [eth] });
    return { eth: balance, spent: null, allowances: null };
  }
  const [balance, spent, tokenAllowance, permit2] = await client.multicall({
    allowFailure: false,
    contracts: [
      eth,
      { address: plan.spent, abi: erc20Abi, functionName: 'balanceOf', args: [wallet] },
      { address: plan.spent, abi: erc20Abi, functionName: 'allowance', args: [wallet, SWAP_CONTRACTS.permit2] },
      { address: SWAP_CONTRACTS.permit2, abi: permit2Abi, functionName: 'allowance', args: [wallet, plan.spent, SWAP_CONTRACTS.universalRouter] },
    ],
  });
  const allowances: Allowances = { token: tokenAllowance, permit2Amount: permit2[0], permit2Expiration: permit2[1] };
  return { eth: balance, spent, allowances };
}

/** The preflight of a browser on another site: the route takes a JSON body, which a page may only send after asking. */
export function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: { ...HEADERS, 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Max-Age': '600' } });
}

/**
 * POST /api/agent/swap {token, side, amount, wallet, payWith?, slippagePct?}
 * A buy or a sell of one Bootr coin, prepared for a person as unsigned transactions: the trade panel's own steps
 * (lib/swap/core.ts), with the approvals as separate steps for the exact amount, the minimum received written into
 * the swap and a deadline 20 minutes ahead. No key and no signature, and nothing is sent: the wallet named in the
 * request sends the steps if its owner decides to, and what the swap pays goes to the wallet that sends it. Any
 * origin may call it. 20 calls a minute per IP and 240 a minute over all callers, since each call reads the indexer
 * and the chain. lib/swap/prepare.ts holds every check and every refusal; this file reads and answers.
 */
export async function POST(req: NextRequest) {
  const limits = swapPrepareLimits();
  if (!limits.enabled) return refuse(SWAP_REFUSALS.switchedOff());
  const mine = limiter.hit(clientIp(req.headers));
  if (mine) return refuse({ status: 429, error: 'rate_limited', message: rateLimitMessage(limits.perMinute, mine), retryAfter: mine });
  const all = overAll(limits.perMinuteAll);
  if (all) return refuse({ status: 429, error: 'rate_limited', message: `This route is taking more requests than it serves, ${limits.perMinuteAll} a minute over all callers. Retry in ${all} seconds.`, retryAfter: all });

  if (Number(req.headers.get('content-length') ?? 0) > MAX_BODY_BYTES) return refuse(SWAP_REFUSALS.bodyTooLarge());
  const text = await req.text().catch(() => '');
  if (text.length > MAX_BODY_BYTES) return refuse(SWAP_REFUSALS.bodyTooLarge());
  let body: unknown = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* refused below, as a body that is not an object */
  }
  const parsed = parseSwapRequest(body);
  if (!parsed.ok) return refuse(parsed.refusal);
  const { request } = parsed;
  const now = Math.floor(Date.now() / 1000);

  if (env.useMock) {
    const token = mock.token(request.token);
    if (!token) return refuse(SWAP_REFUSALS.unknownCoin());
    const planned = planSwap(token, request, now, { unverified: true });
    if (!planned.ok) return refuse(planned.refusal);
    const { plan } = planned;
    let quote: SwapQuote;
    try {
      quote = plan.route === 'eth-via-paired' ? mockEthViaPairedQuote(token, plan.amountIn) : mockQuote(token, request.side, plan.amountIn);
    } catch (e) {
      return refuse(panelRefusal(SwapFailure.from(e).code));
    }
    const wallet: WalletState = plan.spent
      ? { eth: MOCK_ETH_BALANCE, spent: request.side === 'sell' ? MOCK_COIN_BALANCE : MOCK_PAIRED_BALANCE, allowances: { token: 0n, permit2Amount: 0n, permit2Expiration: 0 } }
      : { eth: MOCK_ETH_BALANCE, spent: null, allowances: null };
    const answer = prepareSwap({ coin: token, request, plan, quote, wallet, now, maxFeePct: limits.maxFeePct, dataSuffix: builderDataSuffix });
    return answer.ok ? NextResponse.json({ ...answer.prepared, mock: true }, { headers: HEADERS }) : refuse(answer.refusal);
  }

  // The steps are for Base's router and pools: a site on another chain prepares none.
  if (env.chainId !== SWAP_CONTRACTS.chainId) return refuse(SWAP_REFUSALS.wrongChain());

  let coin: SwapCoinRow | null;
  try {
    coin = await findCoin(request.token);
  } catch {
    return refuse(SWAP_REFUSALS.indexerDown());
  }
  if (!coin) return refuse(SWAP_REFUSALS.unknownCoin());
  const planned = planSwap(coin, request, now);
  if (!planned.ok) return refuse(planned.refusal);
  const { plan } = planned;

  const client = serverPublicClient(env.chainId);
  let quote: SwapQuote;
  let wallet: WalletState;
  try {
    [quote, wallet] = await Promise.all([
      plan.route === 'eth-via-paired' ? quoteEthViaPaired(client, { key: plan.key, amountIn: plan.amountIn }) : quoteSwap(client, { key: plan.key, side: request.side, amountIn: plan.amountIn, now }),
      readWallet(env.chainId, request.wallet, plan),
    ]);
  } catch (e) {
    // The panel's own reading of a failed quote; a read that fails for another reason is the network's.
    return refuse(panelRefusal(e instanceof SwapFailure ? e.code : 'network'));
  }

  const answer = prepareSwap({ coin, request, plan, quote, wallet, now, maxFeePct: limits.maxFeePct, dataSuffix: builderDataSuffix });
  return answer.ok ? NextResponse.json(answer.prepared, { headers: HEADERS }) : refuse(answer.refusal);
}
