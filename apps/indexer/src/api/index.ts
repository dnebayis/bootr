import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { streamSSE } from 'hono/streaming';
import { and, client, desc, eq, graphql, gt, ilike, inArray, or, sql } from 'ponder';
import { isAddress, type Address } from 'viem';

import { ClankerFeeLockerAbi } from '../../abis/ClankerFeeLocker';
import { ClankerTokenAbi } from '../../abis/ClankerToken';
import { Erc20Abi } from '../../abis/Erc20';
import { MULTICALL3_ADDRESS, Multicall3Abi } from '../../abis/Multicall3';
import { indexerEnv } from '../lib/env';
import { RECIPIENT_KINDS, type RecipientKind } from '../lib/fees';
import { verifyRequest } from '../lib/hmac';
import { toUnits, usd } from '../lib/price';
import { rpcClient } from '../lib/rpc';
import { parseSocialPatch, socialStore, type AgentSocial } from '../lib/social-store';
import { publish, subscribe } from './stream';

const env = indexerEnv();
const app = new Hono();

// ------------------------------------------------------------------ CORS

if (env.webOrigins.length === 0) {
  console.warn('[indexer] NEXT_PUBLIC_WEB_ORIGIN is empty: CORS allows any origin (dev only).');
}
app.use(
  '*',
  cors({
    origin: env.webOrigins.length ? env.webOrigins : '*',
    allowMethods: ['GET', 'POST', 'OPTIONS'],
    allowHeaders: ['content-type', 'authorization'],
    maxAge: 600,
  }),
);

// ------------------------------------------------------------------ Ponder built-ins

app.use('/sql/*', client({ db, schema }));
app.use('/graphql', graphql({ db, schema }));
app.use('/', graphql({ db, schema }));

// ------------------------------------------------------------------ helpers

const lc = (s: string) => s.toLowerCase();
const isAddr = (s: string | undefined): s is string => !!s && isAddress(s, { strict: false });

/** JSON-safe: bigint -> string. */
function j<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)));
}

async function socialMap(): Promise<Map<string, AgentSocial>> {
  try {
    return await socialStore().all();
  } catch {
    return new Map();
  }
}

type TokenRow = typeof schema.token.$inferSelect;

async function withAgent(tokens: TokenRow[]) {
  if (tokens.length === 0) return [];
  const [agents, social] = await Promise.all([
    db
      .select({ id: schema.agent.id, status: schema.agent.status })
      .from(schema.agent)
      .where(inArray(schema.agent.id, tokens.map((t) => t.kernel))),
    socialMap(),
  ]);
  const byId = new Map(agents.map((a) => [a.id, a]));
  return tokens.map((t) => ({
    ...t,
    xHandle: social.get(t.kernel)?.xHandle ?? t.xHandle,
    agent: byId.get(t.kernel) ?? null,
  }));
}

async function findToken(idOrKernel: string): Promise<TokenRow | undefined> {
  const id = lc(idOrKernel) as Address;
  const rows = await db
    .select()
    .from(schema.token)
    .where(or(eq(schema.token.id, id), eq(schema.token.kernel, id)))
    .limit(1);
  return rows[0];
}

// ------------------------------------------------------------------ REST

/** Tokens by name / symbol / address / kernel / creator / xHandle (ILIKE), limit 20. */
app.get('/search', async (c) => {
  const q = (c.req.query('q') ?? '').trim().slice(0, 64);
  if (!q) return c.json([]);
  const esc = q.replace(/[\\%_]/g, (m) => `\\${m}`);
  const like = `%${esc}%`;
  const handle = esc.replace(/^@/, '');
  const social = await socialMap();
  const socialKernels = [...social.values()]
    .filter((s) => s.xHandle && s.xHandle.toLowerCase().includes(handle.toLowerCase()))
    .map((s) => s.kernel as Address);
  const conds = [
    ilike(schema.token.name, like),
    ilike(schema.token.symbol, like),
    ilike(schema.token.xHandle, `%${handle}%`),
  ];
  if (/^0x[0-9a-fA-F]{1,40}$/.test(q)) {
    const prefix = `${lc(q)}%`;
    conds.push(ilike(schema.token.id, prefix), ilike(schema.token.kernel, prefix), ilike(schema.token.creator, prefix));
  }
  if (socialKernels.length) conds.push(inArray(schema.token.kernel, socialKernels));
  const rows = await db
    .select()
    .from(schema.token)
    .where(or(...conds))
    .orderBy(desc(schema.token.marketCapUsd))
    .limit(20);
  return c.json(j(await withAgent(rows)));
});

/** `{byKind: {agent|creator|burn|platform: {accruedUsd, claimedUsd}}}` for one coin. */
app.get('/token/:id/fees', async (c) => {
  const id = c.req.param('id');
  if (!isAddr(id)) return c.json({ error: 'invalid token address' }, 400);
  const token = lc(id) as Address;
  const [acc, cl] = await Promise.all([
    db
      .select({ kind: schema.feeAccrual.recipientKind, usd: sql<number>`coalesce(sum(${schema.feeAccrual.amountUsd}), 0)` })
      .from(schema.feeAccrual)
      .where(eq(schema.feeAccrual.token, token))
      .groupBy(schema.feeAccrual.recipientKind),
    db
      .select({ kind: schema.feeClaim.recipientKind, usd: sql<number>`coalesce(sum(${schema.feeClaim.amountUsd}), 0)` })
      .from(schema.feeClaim)
      .where(eq(schema.feeClaim.token, token))
      .groupBy(schema.feeClaim.recipientKind),
  ]);
  const byKind = Object.fromEntries(RECIPIENT_KINDS.map((k) => [k, { accruedUsd: 0, claimedUsd: 0 }])) as Record<
    RecipientKind,
    { accruedUsd: number; claimedUsd: number }
  >;
  for (const r of acc) if (r.kind in byKind) byKind[r.kind as RecipientKind].accruedUsd = usd(Number(r.usd));
  for (const r of cl) if (r.kind in byKind) byKind[r.kind as RecipientKind].claimedUsd = usd(Number(r.usd));
  return c.json({ token, byKind });
});

/** Compact market snapshot for the supervisor's `read_market`. Accepts a coin or kernel address. */
app.get('/market/:token', async (c) => {
  const id = c.req.param('token');
  if (!isAddr(id)) return c.json({ error: 'invalid address' }, 400);
  const t = await findToken(id);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const trades = await db
    .select()
    .from(schema.trade)
    .where(eq(schema.trade.token, t.id))
    .orderBy(desc(schema.trade.timestamp), desc(schema.trade.id))
    .limit(10);
  const stats = await db.select().from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1);
  return c.json(
    j({
      token: t.id,
      kernel: t.kernel,
      symbol: t.symbol,
      name: t.name,
      poolId: t.poolId,
      priceUsd: t.priceUsd,
      priceWeth: t.priceWeth,
      marketCapUsd: t.marketCapUsd,
      liquidityUsd: t.liquidityUsd,
      volume24hUsd: t.volume24hUsd,
      volume7dUsd: t.volume7dUsd,
      fees24hUsd: t.fees24hUsd,
      change24hPct: t.change24hPct,
      trades24h: t.trades24h,
      holders: t.holders,
      graduated: t.graduated,
      lpFeeBps: t.lpFeeBps,
      ethPriceUsd: stats[0]?.ethPriceUsd ?? null,
      updatedAt: stats[0]?.updatedAt ?? null,
      trades: trades.map((r) => ({
        side: r.side,
        trader: r.trader,
        amountToken: r.amountToken,
        amountPaired: r.amountPaired,
        priceUsd: r.priceUsd,
        valueUsd: r.valueUsd,
        timestamp: r.timestamp,
        txHash: r.txHash,
      })),
    }),
  );
});

/**
 * Treasury snapshot for `treasury_read`: live kernel balances (falls back to the last indexed
 * values) and claimable fees per recipient and asset from `ClankerFeeLocker.availableFees`.
 * Note: creator/platform FeeLocker balances aggregate every coin they receive fees from.
 */
app.get('/treasury/:kernel', async (c) => {
  const id = c.req.param('kernel');
  if (!isAddr(id)) return c.json({ error: 'invalid address' }, 400);
  const t = await findToken(id);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, t.kernel)).limit(1);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const [stats] = await db.select().from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1);
  const ethUsd = stats?.ethPriceUsd ?? 0;
  const kernel = t.kernel as Address;
  const weth = env.addresses.weth;
  const coin = t.id as Address;
  const recipients: { recipient: Address; recipientKind: RecipientKind }[] = [
    { recipient: kernel, recipientKind: 'agent' },
    { recipient: t.creator as Address, recipientKind: 'creator' },
    ...(t.burner ? [{ recipient: t.burner as Address, recipientKind: 'burn' as const }] : []),
    { recipient: t.platformRecipient as Address, recipientKind: 'platform' },
  ];
  const assets: { asset: Address; symbol: string }[] = [
    { asset: weth, symbol: 'WETH' },
    { asset: coin, symbol: t.symbol },
  ];

  let balances = {
    usdc: a.treasuryUsdc,
    weth: a.treasuryWeth,
    eth: a.treasuryEth,
    ownToken: a.treasuryOwnToken,
  };
  let source: 'live' | 'indexed' = 'indexed';
  const claimable: {
    recipient: Address;
    recipientKind: RecipientKind;
    asset: Address;
    symbol: string;
    amount: bigint;
    amountUsd: number;
  }[] = [];
  try {
    const calls = [
      { abi: Erc20Abi, address: env.addresses.usdc, functionName: 'balanceOf', args: [kernel] },
      { abi: Erc20Abi, address: weth, functionName: 'balanceOf', args: [kernel] },
      { abi: Multicall3Abi, address: MULTICALL3_ADDRESS, functionName: 'getEthBalance', args: [kernel] },
      { abi: ClankerTokenAbi, address: coin, functionName: 'balanceOf', args: [kernel] },
      ...recipients.flatMap((r) =>
        assets.map((x) => ({
          abi: ClankerFeeLockerAbi,
          address: env.addresses.clankerFeeLocker,
          functionName: 'availableFees',
          args: [r.recipient, x.asset],
        })),
      ),
    ];
    const res = await rpcClient().multicall({
      contracts: calls as never,
      multicallAddress: MULTICALL3_ADDRESS,
      allowFailure: true,
    });
    const val = (i: number) => {
      const r = res[i] as { status: string; result?: unknown };
      return r?.status === 'success' && typeof r.result === 'bigint' ? r.result : null;
    };
    const [u, w, e, o] = [val(0), val(1), val(2), val(3)];
    if (u !== null && w !== null && e !== null && o !== null) {
      balances = { usdc: u, weth: w, eth: e, ownToken: o };
      source = 'live';
    }
    let i = 4;
    for (const r of recipients) {
      for (const x of assets) {
        const amount = val(i++) ?? 0n;
        const price = x.asset === weth ? ethUsd : t.priceUsd;
        claimable.push({ ...r, ...x, amount, amountUsd: usd(toUnits(amount, 18) * price) });
      }
    }
  } catch (err) {
    console.warn(`[indexer] /treasury live read failed: ${(err as Error).message}`);
  }
  const treasuryUsd = usd(
    toUnits(balances.usdc, 6) +
      (toUnits(balances.weth, 18) + toUnits(balances.eth, 18)) * ethUsd +
      toUnits(balances.ownToken, 18) * t.priceUsd,
  );
  const own = claimable.filter((x) => x.recipientKind === 'agent');
  return c.json(
    j({
      kernel,
      token: t.id,
      symbol: t.symbol,
      agentId: a.agentId,
      status: a.status,
      paused: a.paused,
      lastActivityAt: a.lastActivityAt,
      dormancyPeriod: a.dormancyPeriod,
      dormantSince: a.dormantSince,
      balances,
      balancesSource: source,
      treasuryUsd,
      fuelReceivedUsdc: a.fuelReceivedUsdc,
      feesClaimedUsd: a.feesClaimedUsd,
      claimable,
      claimableAgentUsd: usd(own.reduce((s, x) => s + x.amountUsd, 0)),
      ethPriceUsd: ethUsd,
    }),
  );
});

/** Bootr coins currently held by an address. */
app.get('/holdings/:owner', async (c) => {
  const owner = c.req.param('owner');
  if (!isAddr(owner)) return c.json({ error: 'invalid address' }, 400);
  const rows = await db
    .select({
      balance: schema.balance.amount,
      id: schema.token.id,
      name: schema.token.name,
      symbol: schema.token.symbol,
      image: schema.token.image,
      priceUsd: schema.token.priceUsd,
      marketCapUsd: schema.token.marketCapUsd,
    })
    .from(schema.balance)
    .innerJoin(schema.token, eq(schema.balance.token, schema.token.id))
    .where(and(eq(schema.balance.holder, lc(owner) as Address), gt(schema.balance.amount, 0n)))
    .limit(500);
  const out = rows
    .map((r) => ({
      token: { id: r.id, name: r.name, symbol: r.symbol, image: r.image, priceUsd: r.priceUsd, marketCapUsd: r.marketCapUsd },
      balance: r.balance,
      valueUsd: usd(toUnits(r.balance, 18) * r.priceUsd),
    }))
    .sort((a, b) => b.valueUsd - a.valueUsd);
  return c.json(j(out));
});

/** USDC transfers from an address into any agent kernel. */
app.get('/fuel/:from', async (c) => {
  const from = c.req.param('from');
  if (!isAddr(from)) return c.json({ error: 'invalid address' }, 400);
  const rows = await db
    .select({
      kernel: schema.fuel.kernel,
      token: schema.fuel.token,
      symbol: schema.token.symbol,
      amount: schema.fuel.amount,
      amountUsd: schema.fuel.amountUsd,
      timestamp: schema.fuel.timestamp,
      txHash: schema.fuel.txHash,
    })
    .from(schema.fuel)
    .leftJoin(schema.token, eq(schema.fuel.token, schema.token.id))
    .where(eq(schema.fuel.from, lc(from) as Address))
    .orderBy(desc(schema.fuel.timestamp))
    .limit(200);
  return c.json(j(rows.map((r) => ({ ...r, symbol: r.symbol ?? '', amountUsdc: r.amount }))));
});

/** SSE hints `{type: 'launch'|'trade'|'agent', tokenId}`. Clients re-fetch; payloads are hints only. */
app.get('/stream', (c) =>
  streamSSE(c, async (stream) => {
    const queue: string[] = [];
    let wake: (() => void) | undefined;
    const off = subscribe((h) => {
      queue.push(JSON.stringify(h));
      wake?.();
    });
    let open = true;
    stream.onAbort(() => {
      open = false;
      off();
      wake?.();
    });
    await stream.writeSSE({ event: 'ready', data: '{}' });
    while (open) {
      while (queue.length) await stream.writeSSE({ data: queue.shift()! });
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 15_000);
      });
      wake = undefined;
      if (open && queue.length === 0) await stream.writeSSE({ event: 'ping', data: String(Date.now()) });
    }
    off();
  }),
);

/** Supervisor -> indexer social data (HMAC, same scheme as apps/sender). */
app.post('/internal/agent/:kernel/social', async (c) => {
  const url = new URL(c.req.url);
  const body = await c.req.text();
  const auth = verifyRequest(
    env.serviceKey,
    c.req.header('authorization'),
    'POST',
    url.pathname + url.search,
    body,
    Math.floor(Date.now() / 1000),
  );
  if (!auth.ok) return c.json({ error: 'unauthorized', reason: auth.reason }, 401);
  const kernel = c.req.param('kernel');
  if (!isAddr(kernel)) return c.json({ error: 'invalid kernel address' }, 400);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return c.json({ error: 'invalid JSON' }, 400);
  }
  const patch = parseSocialPatch(parsed);
  if (typeof patch === 'string') return c.json({ error: patch }, 400);
  const [a] = await db
    .select({ id: schema.agent.id, token: schema.agent.token })
    .from(schema.agent)
    .where(eq(schema.agent.id, lc(kernel) as Address))
    .limit(1);
  if (!a) return c.json({ error: 'unknown_agent' }, 404);
  const social = await socialStore().upsert(a.id, patch);
  publish({ type: 'agent', tokenId: a.token });
  return c.json({ ok: true, social });
});

export default app;
