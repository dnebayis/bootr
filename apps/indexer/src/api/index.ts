import { db } from 'ponder:api';
import schema from 'ponder:schema';
import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { and, desc, eq, graphql, gt, gte, ilike, inArray, lte, or, sql } from 'ponder';
import { TRENDING_WINDOW_HOURS, trendingScore, type TrendingWallet } from '@bootr/shared/trending';
import { isAddress, type Address } from 'viem';

import { B20TokenAbi } from '../../abis/B20Token';
import { ClankerFeeLockerAbi } from '../../abis/ClankerFeeLocker';
import { ClankerV5FeeEscrowAbi } from '../../abis/ClankerV5';
import { Erc20Abi } from '../../abis/Erc20';
import { MULTICALL3_ADDRESS, Multicall3Abi } from '../../abis/Multicall3';
import { RwagmiLpLockerV3Abi } from '../../abis/RwagmiLpLockerV3';
import { safeMessage } from '../../rpc-budget';
import { corsMiddleware } from '../lib/cors';
import { indexerEnv } from '../lib/env';
import { DEAD_ADDRESS, parseLaunchSource, RECIPIENT_KINDS, type LaunchSource, type RecipientKind } from '../lib/fees';
import { verifyRequest } from '../lib/hmac';
import { toUnits, usd } from '../lib/price';
import { quoteUsd } from '../lib/quote';
import { rpcClient } from '../lib/rpc';
import { parseSocialPatch, socialStore, type AgentSocial } from '../lib/social-store';
import {
  BOARDS,
  BOARD_DEFAULT,
  BOARD_MAX,
  boardPeriod,
  isBoardId,
  knownPostCount,
  pageOf,
  parsePage,
  parseTokenFilters,
  parseTokenList,
  percentOfSupply,
  periodStart,
  rankRows,
  type BoardId,
  type BoardPeriod,
  type TokenFilters,
  type TokenSort,
} from './lists';
import { FEED_LIMIT, composePlatformFeed, feedNameRefs, feedWindow } from './platform-feed';
import { composePlatformFees } from './platform-fees';
import { publish, subscribe } from './stream';
import {
  claimThresholds,
  composeClaimedByKind,
  composeCreatorFees,
  distinctRecipients,
    splitWalletClaims,
  walletsHoldingSeveralKinds,
  type CreditWindow,
  type WalletClaim,
  type WalletClaimSplit,
  type WalletSlots,
} from './wallet-slots';

const env = indexerEnv();
const app = new Hono();

// ------------------------------------------------------------------ CORS

console.info(
  `[indexer] CORS origins (${env.cors.source}): ${env.cors.origins.join(', ')}${env.cors.allowLocalhost ? ' + localhost (NODE_ENV is not production)' : ''}`,
);
if (env.cors.origins.includes('*')) {
  console.warn('[indexer] INDEXER_CORS_ORIGIN=* : CORS allows any origin.');
}
// Ponder's server already answers preflights with `*`; this narrows the actual responses.
app.use('*', corsMiddleware(env.cors));

// ------------------------------------------------------------------ Ponder built-ins

// GraphQL only. Ponder's SQL-over-HTTP client (`/sql/*`, with up to 1000 live queries per server) is not mounted:
// no Bootr client used it, and it let anyone run arbitrary read queries against the database. Ponder's own
// `/health`, `/ready`, `/metrics` and `/status` are registered by Ponder in front of this app and cannot be removed
// or guarded here; `/metrics` and `/status` carry operational counters and the chain head, no secrets.
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
    // the model in force now (the creator can change it from the coin page); the row keeps the launch-time one
    model: social.get(t.kernel)?.model ?? t.model,
    agent: byId.get(t.kernel) ?? null,
  }));
}

/** Splits one wallet's claims on one coin over the slots it holds, from `feeCredit` (see `wallet-slots.ts`). */
async function splitClaimsOf(pair: WalletSlots): Promise<WalletClaimSplit> {
  const rows = await db
    .select({
      id: schema.feeClaim.id,
      asset: schema.feeClaim.asset,
      blockNumber: schema.feeClaim.blockNumber,
      logIndex: schema.feeClaim.logIndex,
      amount: schema.feeClaim.amount,
      amountUsd: schema.feeClaim.amountUsd,
    })
    .from(schema.feeClaim)
    .where(and(eq(schema.feeClaim.token, pair.token as Address), eq(schema.feeClaim.recipient, pair.recipient as Address)));
  const claims: WalletClaim[] = rows.map((r) => ({
    asset: r.asset,
    blockNumber: BigInt(r.blockNumber),
    logIndex: r.logIndex,
    amount: BigInt(r.amount),
    amountUsd: r.amountUsd,
  }));
  const windows: CreditWindow[] = [];
  for (const asset of new Set(claims.map((c) => c.asset))) {
    // `chainOrder` in SQL. Postgres counts the windows, so the read stays one row per (claim, slot) however many collections a coin has.
    const order = sql`(${schema.feeCredit.blockNumber}::bigint * 1000000 + ${schema.feeCredit.logIndex}::bigint)`;
    const thresholds = sql.raw(`array[${claimThresholds(claims.filter((c) => c.asset === asset)).join(',')}]::bigint[]`);
    const credited = await db
      .select({
        window: sql<number>`width_bucket(${order}, ${thresholds})`,
        slot: schema.feeCredit.slot,
        amount: sql<string>`sum(${schema.feeCredit.amount})`,
      })
      .from(schema.feeCredit)
      .where(and(eq(schema.feeCredit.token, pair.token as Address), eq(schema.feeCredit.recipient, pair.recipient as Address), eq(schema.feeCredit.asset, asset as Address)))
      .groupBy(sql`1`, schema.feeCredit.slot);
    for (const c of credited) windows.push({ asset, window: Number(c.window), slot: c.slot, amount: BigInt(c.amount) });
  }
  return splitWalletClaims(pair.slotKinds, claims, windows);
}

/** The wallets holding slots of more than one kind on `ids` (every coin when omitted), with their claims split. */
async function walletsWithSeveralSlots(ids?: readonly Address[]) {
  if (ids && ids.length === 0) return [];
  const slots = await db
    .select({ token: schema.feeSlot.token, recipient: schema.feeSlot.recipient, slot: schema.feeSlot.slot, recipientKind: schema.feeSlot.recipientKind })
    .from(schema.feeSlot)
    .where(ids ? inArray(schema.feeSlot.token, [...ids]) : undefined);
  const pairs = walletsHoldingSeveralKinds(slots);
  return Promise.all(pairs.map(async (pair) => ({ token: pair.token, recipient: pair.recipient, split: await splitClaimsOf(pair) })));
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

/**
 * The home grid in bump order (pump.fun style): a buy or a sell moves the coin to the front, and a coin that
 * has not traded yet sits by its launch time. `coalesce(lastTradeAt, launchedAt)` cannot be expressed in
 * Ponder's GraphQL `orderBy` (one column, NULLs first on desc), hence this route. API code is not part of
 * Ponder's build id, so adding it needs no new DATABASE_SCHEMA. Offset cursor: the order moves between
 * pages, so the client dedupes by id. `{items, pageInfo: {endCursor, hasNextPage}}`, like the GraphQL list.
 */
app.get('/tokens/bumped', async (c) => {
  const limit = Math.min(100, Math.max(1, Number(c.req.query('limit')) || 48));
  const offset = Math.max(0, Math.floor(Number(c.req.query('after')) || 0));
  const bumpedAt = sql`coalesce(${schema.token.lastTradeAt}, ${schema.token.launchedAt})`;
  const rows = await db
    .select()
    .from(schema.token)
    .orderBy(desc(bumpedAt), desc(schema.token.launchedAt), desc(schema.token.id))
    .limit(limit + 1)
    .offset(offset);
  const hasNextPage = rows.length > limit;
  const items = await withAgent(rows.slice(0, limit));
  return c.json(j({ items, pageInfo: { endCursor: hasNextPage ? String(offset + limit) : null, hasNextPage } }));
});

// ------------------------------------------------------------------ public lists

const nowS = () => Math.floor(Date.now() / 1000);

/** When the market figures were last refreshed (the snapshot handler), null before the first one. */
async function indexedAt(): Promise<number | null> {
  const [s] = await db.select({ at: schema.platformStats.updatedAt }).from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1);
  return s?.at ?? null;
}

function tokenConditions(f: TokenFilters) {
  return [
    ...(f.creator ? [eq(schema.token.creator, f.creator as Address)] : []),
    ...(f.source ? [eq(schema.token.source, f.source)] : []),
    ...(f.from !== undefined ? [gte(schema.token.launchedAt, f.from)] : []),
    ...(f.to !== undefined ? [lte(schema.token.launchedAt, f.to)] : []),
    ...(f.hasAgent === true ? [sql`${schema.token.kernel} is not null`] : []),
    ...(f.hasAgent === false ? [sql`${schema.token.kernel} is null`] : []),
    ...(f.graduated !== undefined ? [eq(schema.token.graduated, f.graduated)] : []),
    ...(f.agentStatus ? [eq(schema.token.agentStatus, f.agentStatus)] : []),
  ];
}

const TOKEN_ORDER: Record<TokenSort, () => ReturnType<typeof desc>[]> = {
  bumped: () => [desc(sql`coalesce(${schema.token.lastTradeAt}, ${schema.token.launchedAt})`), desc(schema.token.launchedAt)],
  launched: () => [desc(schema.token.launchedAt)],
  mcap: () => [desc(schema.token.marketCapUsd)],
  volume24h: () => [desc(schema.token.volume24hUsd)],
  holders: () => [desc(schema.token.holders)],
  graduated: () => [sql`${schema.token.graduatedAt} desc nulls last`],
};

/**
 * Coins with filters and a sort, for the tokens page and for programs: `creator`, `source` (`bootr` | `clanker` | `clanker-v5`),
 * `from` / `to` (launch time, unix s), `hasAgent`, `graduated`, `agentStatus`; `sort` = `bumped` (default) | `launched`
 * | `mcap` | `volume24h` | `holders` | `graduated`. Offset cursor in `after`, like `/tokens/bumped`.
 */
app.get('/tokens/list', async (c) => {
  const q = parseTokenList(c.req.query());
  if (typeof q === 'string') return c.json({ error: 'invalid_request', message: q }, 400);
  const conds = tokenConditions(q.filters);
  const rows = await db
    .select()
    .from(schema.token)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(...TOKEN_ORDER[q.sort](), desc(schema.token.id))
    .limit(q.limit + 1)
    .offset(q.offset);
  const hasNextPage = rows.length > q.limit;
  const items = await withAgent(rows.slice(0, q.limit));
  return c.json(j({ items, pageInfo: { endCursor: hasNextPage ? String(q.offset + q.limit) : null, hasNextPage }, readAt: nowS() }));
});

/** A read that is the same for everyone, kept for a few seconds: these routes are public and aggregate whole tables. */
const LIST_TTL_MS = 15_000;
const listCache = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, read: () => Promise<T>): Promise<T> {
  const hit = listCache.get(key);
  if (hit && Date.now() - hit.at < LIST_TTL_MS) return hit.value as Promise<T>;
  const value = read();
  listCache.set(key, { at: Date.now(), value });
  value.catch(() => listCache.delete(key));
  return value;
}

type TrendingEntry = { score: number; volumeUsd: number; trades: number; traders: number };

/** Every coin traded inside the window with its score (`@bootr/shared/trending`), read per (coin, wallet). */
function trendingScores(): Promise<{ readAt: number; scores: Map<string, TrendingEntry> }> {
  return cached('trending', async () => {
    const readAt = nowS();
    const rows = await db
      .select({
        token: schema.trade.token,
        volumeUsd: sql<number>`coalesce(sum(${schema.trade.valueUsd}), 0)`,
        trades: sql<number>`count(*)`,
      })
      .from(schema.trade)
      .where(gte(schema.trade.timestamp, readAt - TRENDING_WINDOW_HOURS * 3600))
      .groupBy(schema.trade.token, schema.trade.trader);
    const perCoin = new Map<string, TrendingWallet[]>();
    for (const r of rows) {
      const wallet = { volumeUsd: Number(r.volumeUsd), trades: Number(r.trades) };
      const list = perCoin.get(r.token);
      if (list) list.push(wallet);
      else perCoin.set(r.token, [wallet]);
    }
    const scores = new Map<string, TrendingEntry>();
    for (const [token, wallets] of perCoin) {
      scores.set(token, {
        score: trendingScore(wallets),
        volumeUsd: usd(wallets.reduce((s, w) => s + w.volumeUsd, 0)),
        trades: wallets.reduce((s, w) => s + w.trades, 0),
        traders: wallets.length,
      });
    }
    return { readAt, scores };
  });
}

/**
 * Coins by trending score, highest first: recent trades counted per wallet with caps, so one wallet cannot lift a coin
 * (`packages/shared/src/trending.ts`). Takes the filters of `/tokens/list`. A coin with no trade in the window is not listed.
 * Each item is a token row plus `trending: {score, volumeUsd, trades, traders}` over the window.
 */
app.get('/tokens/trending', async (c) => {
  const query = c.req.query();
  const filters = parseTokenFilters(query);
  if (typeof filters === 'string') return c.json({ error: 'invalid_request', message: filters }, 400);
  const { limit, offset } = parsePage(query);
  const { readAt, scores } = await trendingScores();
  const ids = [...scores.keys()] as Address[];
  const rows = ids.length
    ? await db
        .select()
        .from(schema.token)
        .where(and(inArray(schema.token.id, ids), ...tokenConditions(filters)))
    : [];
  const ranked = rows
    .map((t) => ({ t, trending: scores.get(t.id)! }))
    .sort((a, b) => b.trending.score - a.trending.score || b.trending.traders - a.trending.traders || a.t.id.localeCompare(b.t.id));
  const page = pageOf(ranked, offset, limit);
  const withAgents = await withAgent(page.items.map((r) => r.t));
  return c.json(
    j({
      items: withAgents.map((t, i) => ({ ...t, trending: page.items[i]!.trending })),
      pageInfo: page.pageInfo,
      windowHours: TRENDING_WINDOW_HOURS,
      readAt,
    }),
  );
});

/** What a board row says about its coin; the coin's own page has the rest. */
const boardToken = (t: TokenRow) => ({
  id: t.id,
  name: t.name,
  symbol: t.symbol,
  image: t.image,
  creator: t.creator,
  kernel: t.kernel as string | null,
  agentId: t.agentId as bigint | null,
  source: t.source,
  xHandle: t.xHandle,
  launchedAt: t.launchedAt,
});

type BoardRow = { token: ReturnType<typeof boardToken>; value: number | null; detail?: Record<string, unknown> };

async function readBoard(board: BoardId, period: BoardPeriod, now: number): Promise<BoardRow[]> {
  const since = periodStart(period, now);
  const tokens = await db.select().from(schema.token);
  const of = (t: TokenRow, value: number | null, detail?: Record<string, unknown>): BoardRow => ({ token: boardToken(t), value, ...(detail ? { detail } : {}) });

  if (board === 'volume') {
    const pick = (t: TokenRow) => (period === '24h' ? t.volume24hUsd : period === '7d' ? t.volume7dUsd : t.volumeTotalUsd);
    return tokens.map((t) => of(t, pick(t)));
  }
  if (board === 'holders') return tokens.map((t) => of(t, t.holders));
  if (board === 'agent-activity') {
    const social = await socialMap();
    return tokens
      .filter((t) => (t.kernel as string | null) !== null)
      .map((t) => {
        const report = social.get(t.kernel);
        return of(t, knownPostCount(report, now), { lastPostAt: report?.lastPostAt ?? null });
      });
  }
  if (board === 'agent-fees') {
    const rows = await db
      .select({ token: schema.feeAccrual.token, usd: sql<number>`coalesce(sum(${schema.feeAccrual.amountUsd}), 0)` })
      .from(schema.feeAccrual)
      .where(and(eq(schema.feeAccrual.recipientKind, 'agent'), ...(since !== null ? [gte(schema.feeAccrual.timestamp, since)] : [])))
      .groupBy(schema.feeAccrual.token);
    const byToken = new Map(tokens.map((t) => [t.id as string, t]));
    return rows.flatMap((r) => {
      const t = byToken.get(r.token);
      return t ? [of(t, usd(Number(r.usd)))] : [];
    });
  }
  // burned: a share of supply compares coins of any size, which a count of coins or a dollar figure at burn time does not.
  if (since === null) {
    return tokens.filter((t) => t.burnedTotal > 0n).map((t) => of(t, percentOfSupply(t.burnedTotal, t.totalSupply), { amountToken: t.burnedTotal }));
  }
  const rows = await db
    .select({ token: schema.burn.token, amount: sql<string>`coalesce(sum(${schema.burn.amountToken}), 0)` })
    .from(schema.burn)
    .where(gte(schema.burn.timestamp, since))
    .groupBy(schema.burn.token);
  const byToken = new Map(tokens.map((t) => [t.id as string, t]));
  return rows.flatMap((r) => {
    const t = byToken.get(r.token);
    if (!t) return [];
    const amount = BigInt(String(r.amount).split('.')[0]!);
    return [of(t, percentOfSupply(amount, t.totalSupply), { amountToken: amount })];
  });
}

/**
 * One leaderboard: `agent-fees` (USD accrued to the agent slot; Clanker coins count once the fees are collected),
 * `agent-activity` (posts in the last 24 h as the supervisor reported them; no fresh report = unknown, counted in `unknown`
 * and never ranked), `volume`, `holders`, `burned` (percent of supply). `period` is limited to what the data can answer;
 * see `periods` in the answer. `readAt` is when this was read, `indexedAt` when market figures were last refreshed.
 * Rows without a value are left out rather than filled.
 */
app.get('/leaderboards/:board', async (c) => {
  const board = c.req.param('board');
  if (!isBoardId(board)) return c.json({ error: 'not_found', message: `Boards: ${Object.keys(BOARDS).join(', ')}.` }, 404);
  const period = boardPeriod(board, c.req.query('period'));
  const { periods, unit } = BOARDS[board];
  if (!period) return c.json({ error: 'invalid_request', message: `period must be one of ${periods.join(', ')}` }, 400);
  const limit = Math.min(BOARD_MAX, Math.max(1, Math.floor(Number(c.req.query('limit'))) || BOARD_DEFAULT));
  const { readAt, rows, at } = await cached(`board:${board}:${period}`, async () => {
    const now = nowS();
    const [read, at] = await Promise.all([readBoard(board, period, now), indexedAt()]);
    return { readAt: now, rows: read, at };
  });
  const { items, ranked, unknown } = rankRows(rows, limit);
  const kernels = items.flatMap((r) => (r.token.kernel ? [r.token.kernel as Address] : []));
  const agents = kernels.length ? await db.select({ id: schema.agent.id, status: schema.agent.status }).from(schema.agent).where(inArray(schema.agent.id, kernels)) : [];
  const statusOf = new Map(agents.map((a) => [a.id as string, a]));
  return c.json(
    j({
      board,
      period,
      periods,
      unit,
      readAt,
      indexedAt: at,
      ranked,
      unknown,
      items: items.map((r) => ({ ...r, agent: r.token.kernel ? (statusOf.get(r.token.kernel) ?? null) : null })),
    }),
  );
});

/**
 * One creator's public record, no wallet connection needed: `coins` (token rows plus `creatorFees`, newest first, at most
 * 200) and `totals`. Fees are what the indexer booked for this coin's creator slot; Clanker coins count once the fees are
 * collected. `creatorFees`: `{earnedUsd, claimedUsd, earnedWeth, claimedWeth, otherShares}`. When the wallet also holds
 * another slot of a coin its claims pay both at once: `claimedUsd` is the creator share alone, the other shares are in
 * `otherShares: [{kind, earnedUsd, claimedUsd}]`, and `claimedUsd` is null if the two cannot be told apart exactly.
 * Dollars are at the ETH price of each event, so claimed can read above earned; the WETH figures cannot. An address with
 * no coins answers empty lists, not 404.
 */
app.get('/creator/:address', async (c) => {
  const address = c.req.param('address');
  if (!isAddr(address)) return c.json({ error: 'invalid address' }, 400);
  const creator = lc(address) as Address;
  const rows = await db.select().from(schema.token).where(eq(schema.token.creator, creator)).orderBy(desc(schema.token.launchedAt)).limit(200);
  const ids = rows.map((t) => t.id);
  const weth = lc(env.addresses.weth);
  const [coins, earned, claimed, several, at] = await Promise.all([
    withAgent(rows),
    ids.length
      ? db
          .select({
            token: schema.feeAccrual.token,
            usd: sql<number>`coalesce(sum(${schema.feeAccrual.amountUsd}), 0)`,
            weth: sql<string>`coalesce(sum(${schema.feeAccrual.amount}) filter (where ${schema.feeAccrual.asset} = ${weth}), 0)`,
          })
          .from(schema.feeAccrual)
          .where(and(inArray(schema.feeAccrual.token, ids), eq(schema.feeAccrual.recipientKind, 'creator')))
          .groupBy(schema.feeAccrual.token)
      : [],
    ids.length
      ? db
          .select({
            token: schema.feeClaim.token,
            usd: sql<number>`coalesce(sum(${schema.feeClaim.amountUsd}), 0)`,
            weth: sql<string>`coalesce(sum(${schema.feeClaim.amount}) filter (where ${schema.feeClaim.asset} = ${weth}), 0)`,
          })
          .from(schema.feeClaim)
          .where(and(inArray(schema.feeClaim.token, ids), eq(schema.feeClaim.recipientKind, 'creator')))
          .groupBy(schema.feeClaim.token)
      : [],
    walletsWithSeveralSlots(ids),
    indexedAt(),
  ]);
  const mine = several.filter((w) => w.recipient === creator);
  const sharedIds = mine.map((w) => w.token as Address);
  const earnedOfWallet = sharedIds.length
    ? await db
        .select({
          token: schema.feeAccrual.token,
          kind: schema.feeAccrual.recipientKind,
          usd: sql<number>`coalesce(sum(${schema.feeAccrual.amountUsd}), 0)`,
        })
        .from(schema.feeAccrual)
        .where(and(inArray(schema.feeAccrual.token, sharedIds), eq(schema.feeAccrual.recipient, creator)))
        .groupBy(schema.feeAccrual.token, schema.feeAccrual.recipientKind)
    : [];
  const earnedByKind = new Map<string, Partial<Record<RecipientKind, number>>>();
  for (const r of earnedOfWallet) earnedByKind.set(r.token, { ...earnedByKind.get(r.token), [r.kind]: usd(Number(r.usd)) });
  const booked = (list: readonly { token: string; usd: number; weth: string }[]) =>
    new Map(list.map((r) => [r.token as string, { usd: usd(Number(r.usd)), weth: BigInt(r.weth) }]));
  const fees = composeCreatorFees({
    ids,
    earned: booked(earned),
    claimed: booked(claimed),
    splits: new Map(mine.map((w) => [w.token, w.split])),
    earnedByKind,
  });
  return c.json(
    j({
      address: creator,
      readAt: nowS(),
      indexedAt: at,
      totals: {
        coins: rows.length,
        agents: coins.filter((t) => !!t.agent).length,
        ...fees.totals,
      },
      coins: coins.map((t) => ({ ...t, creatorFees: fees.coins.get(t.id)! })),
    }),
  );
});

/**
 * `{source, lpFeeBps, byKind: {agent|creator|burn|platform|recipient: {accruedUsd, claimedUsd}}, sharedWallets}` for one
 * coin (`recipient`: the extra reward rows of a Clanker v5 coin with token settings), plus the paired asset, each side's
 * tax and `dividends: {contract, minHolding, accruedUsd, redirectedUsd}` (Clanker v5 holder dividends; zeros elsewhere).
 * A wallet holding two slots of the coin has its claims told apart per kind (`claimedUsd` null when that cannot be done
 * exactly); `sharedWallets: [{recipient, kinds, claimedUsd, toldApart}]` names such wallets and what they claimed together.
 */
app.get('/token/:id/fees', async (c) => {
  const id = c.req.param('id');
  if (!isAddr(id)) return c.json({ error: 'invalid token address' }, 400);
  const token = lc(id) as Address;
  const [t, acc, cl, several] = await Promise.all([
    findToken(token),
    db
      .select({ kind: schema.feeAccrual.recipientKind, usd: sql<number>`coalesce(sum(${schema.feeAccrual.amountUsd}), 0)` })
      .from(schema.feeAccrual)
      .where(eq(schema.feeAccrual.token, token))
      .groupBy(schema.feeAccrual.recipientKind),
    db
      .select({
        kind: schema.feeClaim.recipientKind,
        recipient: schema.feeClaim.recipient,
        usd: sql<number>`coalesce(sum(${schema.feeClaim.amountUsd}), 0)`,
      })
      .from(schema.feeClaim)
      .where(eq(schema.feeClaim.token, token))
      .groupBy(schema.feeClaim.recipientKind, schema.feeClaim.recipient),
    walletsWithSeveralSlots([token]),
  ]);
  const { claimed, sharedWallets } = composeClaimedByKind(
    cl.map((r) => ({ kind: r.kind, recipient: r.recipient, usd: Number(r.usd) })),
    several,
  );
  const byKind = Object.fromEntries(RECIPIENT_KINDS.map((k) => [k, { accruedUsd: 0, claimedUsd: claimed[k] }])) as Record<
    RecipientKind,
    { accruedUsd: number; claimedUsd: number | null }
  >;
  for (const r of acc) if (r.kind in byKind) byKind[r.kind as RecipientKind].accruedUsd = usd(Number(r.usd));
  return c.json(
    j({
      token,
      source: t?.source ?? null,
      lpFeeBps: t?.lpFeeBps ?? null,
      protocolBps: t?.protocolBps ?? null,
      // extra (Clanker v5 token settings): the paired asset fees are paid in, each side's tax, the extra rows' share
      pairedToken: t?.pairedToken ?? null,
      pairedSymbol: t?.pairedSymbol ?? null,
      buyTaxBps: t?.buyTaxBps ?? null,
      sellTaxBps: t?.sellTaxBps ?? null,
      rewardsBps: t?.rewardsBps ?? 0,
      dividendBps: t?.dividendBps ?? 0,
      byKind,
      /** Holder dividends (no slot, no claims here: each holder withdraws from the tracker). */
      dividends: {
        contract: t?.dividendContract ?? null,
        minHolding: t?.minDividendHolding ?? null,
        accruedUsd: t?.dividendsTotalUsd ?? 0,
        redirectedUsd: t?.dividendsRedirectedUsd ?? 0,
      },
      sharedWallets,
    }),
  );
});

/**
 * Platform fee totals per launch path (`sourceStats`): `{total, bySource: {bootr, clanker, 'clanker-v5'}}`, each with `tokens`,
 * `volumeTotalUsd`, `feesTotalUsd` (gross, what traders paid), `byKind` (accrued to agent / creator / burn /
 * platform), `feesClaimedUsd`, `feesPlatformClaimedUsd`, `feesPlatformClaimedExact`, `updatedAt`. The stored rollup
 * counts claims by the kind they were booked under; the platform share of a wallet holding two slots is added here.
 */
app.get('/platform/fees', async (c) => {
  const [rows, several] = await Promise.all([db.select().from(schema.sourceStats), walletsWithSeveralSlots()]);
  const sources = several.length
    ? await db
        .select({ id: schema.token.id, source: schema.token.source })
        .from(schema.token)
        .where(inArray(schema.token.id, several.map((w) => w.token as Address)))
    : [];
  const sourceOf = new Map(sources.map((t) => [t.id as string, t.source]));
  return c.json(
    j(
      composePlatformFees(
        rows,
        several.map((w) => ({ source: parseLaunchSource(sourceOf.get(w.token)), split: w.split })),
      ),
    ),
  );
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
    .orderBy(desc(schema.trade.blockNumber), desc(schema.trade.logIndex))
    .limit(10);
  const stats = await db.select().from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1);
  return c.json(
    j({
      token: t.id,
      kernel: t.kernel,
      symbol: t.symbol,
      name: t.name,
      source: t.source,
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
      agentBps: t.agentBps,
      creatorBps: t.creatorBps,
      burnBps: t.burnBps,
      platformBps: t.platformBps,
      protocolBps: t.protocolBps,
      // extra (Clanker v5 token settings; null / 0 / false on the other paths)
      pairedToken: t.pairedToken,
      pairedSymbol: t.pairedSymbol,
      pairedDecimals: t.pairedDecimals,
      priceQuote: t.priceQuote,
      buyTaxBps: t.buyTaxBps,
      sellTaxBps: t.sellTaxBps,
      rewardsBps: t.rewardsBps,
      dividendBps: t.dividendBps,
      antiSnipe: t.antiSnipe,
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
 * values), the agent's x402 spender and its USDC float (`spenderUsdc`, not part of `balances.usdc`
 * but counted in `treasuryUsd`) and claimable fees per recipient from the RWAGMI v3 LP locker:
 * `amount = pending + settled`, with `pending = pendingQuote(poolId, recipient)` (this coin's
 * unsettled share) and `settled = claimableQuote(recipient, WETH)` (already credited, claimable now).
 * Fees are WETH only, so `claimable` has one WETH row per recipient (the coin-asset rows are gone).
 * Note: `settled` is per recipient across every RWAGMI pool it is paid from (creator / platform
 * balances aggregate all their coins).
 * Clanker coins (`source: 'clanker'`): `settled = ClankerFeeLocker.availableFees(recipient, WETH)` (the burn
 * slot: `availableFees(0x…dEaD, coin)`, in the coin), `pending` is 0 (fees still inside the LP position have no
 * cheap view; they move to the fee locker on the next `collectRewards`).
 * Clanker v5 coins (`source: 'clanker-v5'`): one row per fee slot recipient as the slots stand now (agent, platform, the
 * creator's row, the extra reward rows as `recipient`, the burn), `settled = FeeEscrow.owed(recipient, quote)` in the
 * pool's paired asset (native ETH `0x0`, `symbol` `ETH`, or USDC with 6 decimals; the burn slot: `owed(0x…dEaD,
 * coin)`, in the coin), `pending` 0 (the hook credits the escrow on every swap).
 */

app.get('/treasury/:kernel', async (c) => {
  const id = c.req.param('kernel');
  if (!isAddr(id)) return c.json({ error: 'invalid address' }, 400);
  const t = await findToken(id);
  if (!t) return c.json({ error: 'not_found' }, 404);
  const [a] = await db.select().from(schema.agent).where(eq(schema.agent.id, t.kernel)).limit(1);
  if (!a) return c.json({ error: 'not_found' }, 404);
  const [[stats], social] = await Promise.all([
    db.select().from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1),
    socialMap(),
  ]);
  const ethUsd = stats?.ethPriceUsd ?? 0;
  const s = social.get(a.id);
  const spender = ((s ? s.spender : a.spender) ?? null) as Address | null;
  const kernel = t.kernel as Address;
  const weth = env.addresses.weth;
  const coin = t.id as Address;
  const launchSource: LaunchSource = parseLaunchSource(t.source);
  // Clanker v5: the coin's fee slots as they stand now (a row's admin may have moved its recipient; the extra reward
  // rows are `recipient`), in slot order. Other paths: the token row's parties.
  const v5Slots =
    launchSource === 'clanker-v5'
      ? (await db.select().from(schema.feeSlot).where(eq(schema.feeSlot.token, t.id)))
          .sort((x, y) => x.slot - y.slot)
          .filter((r) => r.recipientKind !== 'protocol')
          .map((r) => ({ recipient: r.recipient as Address, recipientKind: r.recipientKind as RecipientKind }))
      : [];
  // One row per wallet: a wallet holding two slots has one balance, shown once (`alsoKinds` names its other slots).
  const recipients = distinctRecipients<{ recipient: Address; recipientKind: RecipientKind }>(
    v5Slots.length
      ? v5Slots
      : [
          { recipient: kernel, recipientKind: 'agent' },
          { recipient: t.creator as Address, recipientKind: 'creator' },
          ...(t.burner ? [{ recipient: t.burner as Address, recipientKind: 'burn' as const }] : []),
          { recipient: t.platformRecipient as Address, recipientKind: 'platform' },
        ],
  );
  // The locker to ask: the RWAGMI LP locker (pending + claimable) or the Clanker fee locker (available).
  const locker = launchSource === 'bootr' ? (env.rwagmi?.locker ?? null) : null;
  const feeLocker = launchSource === 'clanker' ? (env.clanker?.feeLocker ?? null) : null;
  const feeEscrow = launchSource === 'clanker-v5' ? (env.clankerV5?.feeEscrow ?? null) : null;
  const poolId = t.poolId as `0x${string}`;
  /**
   * Asset a recipient is paid in: WETH; on v5 the pool's quote (native ETH `0x0`, or USDC); the Clanker burn slot
   * receives the coin itself.
   */
  const assetOf = (r: { recipient: Address; recipientKind: RecipientKind }): Address =>
    launchSource !== 'bootr' && r.recipientKind === 'burn' && lc(r.recipient) === DEAD_ADDRESS
      ? coin
      : launchSource === 'clanker-v5'
        ? (t.pairedToken as Address)
        : weth;

  let balances = {
    usdc: a.treasuryUsdc,
    weth: a.treasuryWeth,
    eth: a.treasuryEth,
    ownToken: a.treasuryOwnToken,
  };
  let spenderUsdc = spender && spender === a.spender ? a.spenderUsdc : 0n;
  let source: 'live' | 'indexed' = 'indexed';
  const claimable: {
    recipient: Address;
    recipientKind: RecipientKind;
    /** extra: the wallet's other slots on this coin, when it holds several: this balance pays them too. */
    alsoKinds?: RecipientKind[];
    asset: Address;
    symbol: string;
    amount: bigint;
    amountUsd: number;
    /** extra: unsettled share of this coin's pool (`pendingQuote`). */
    pending: bigint;
    /** extra: settled balance claimable now (`claimableQuote`, across all the recipient's pools). */
    settled: bigint;
  }[] = [];
  try {
    const calls = [
      { abi: Erc20Abi, address: env.addresses.usdc, functionName: 'balanceOf', args: [kernel] },
      { abi: Erc20Abi, address: weth, functionName: 'balanceOf', args: [kernel] },
      { abi: Multicall3Abi, address: MULTICALL3_ADDRESS, functionName: 'getEthBalance', args: [kernel] },
      { abi: B20TokenAbi, address: coin, functionName: 'balanceOf', args: [kernel] },
      ...(locker
        ? recipients.flatMap((r) => [
            { abi: RwagmiLpLockerV3Abi, address: locker, functionName: 'pendingQuote', args: [poolId, r.recipient] },
            { abi: RwagmiLpLockerV3Abi, address: locker, functionName: 'claimableQuote', args: [r.recipient, weth] },
          ])
        : []),
      ...(feeLocker
        ? recipients.map((r) => ({ abi: ClankerFeeLockerAbi, address: feeLocker, functionName: 'availableFees', args: [r.recipient, assetOf(r)] }))
        : []),
      ...(feeEscrow
        ? recipients.map((r) => ({ abi: ClankerV5FeeEscrowAbi, address: feeEscrow, functionName: 'owed', args: [r.recipient, assetOf(r)] }))
        : []),
      ...(spender ? [{ abi: Erc20Abi, address: env.addresses.usdc, functionName: 'balanceOf', args: [spender] }] : []),
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
    if (locker) {
      for (const r of recipients) {
        const pending = val(i++) ?? 0n;
        const settled = val(i++) ?? 0n;
        const amount = pending + settled;
        claimable.push({
          ...r,
          asset: weth,
          symbol: 'WETH',
          amount,
          amountUsd: usd(toUnits(amount, 18) * ethUsd),
          pending,
          settled,
        });
      }
    }
    if (feeLocker) {
      for (const r of recipients) {
        const settled = val(i++) ?? 0n;
        const asset = assetOf(r);
        const isCoin = asset === coin;
        claimable.push({
          ...r,
          asset,
          symbol: isCoin ? t.symbol : 'WETH',
          amount: settled,
          amountUsd: usd(toUnits(settled, 18) * (isCoin ? t.priceUsd : ethUsd)),
          pending: 0n,
          settled,
        });
      }
    }
    if (feeEscrow) {
      for (const r of recipients) {
        const settled = val(i++) ?? 0n;
        const asset = assetOf(r);
        const isCoin = asset === coin;
        claimable.push({
          ...r,
          asset,
          symbol: isCoin ? t.symbol : t.pairedSymbol,
          amount: settled,
          amountUsd: usd(toUnits(settled, isCoin ? 18 : t.pairedDecimals) * (isCoin ? t.priceUsd : quoteUsd(t.pairedSymbol, ethUsd))),
          pending: 0n,
          settled,
        });
      }
    }
    if (spender) spenderUsdc = val(i) ?? spenderUsdc;
  } catch (err) {
    console.warn(`[indexer] /treasury live read failed: ${safeMessage(err)}`);
  }
  const treasuryUsd = usd(
    toUnits(balances.usdc + spenderUsdc, 6) +
      (toUnits(balances.weth, 18) + toUnits(balances.eth, 18)) * ethUsd +
      toUnits(balances.ownToken, 18) * t.priceUsd,
  );
  const own = claimable.filter((x) => x.recipientKind === 'agent');
  return c.json(
    j({
      kernel,
      token: t.id,
      symbol: t.symbol,
      source: launchSource,
      lpFeeBps: t.lpFeeBps,
      /** extra: the asset the coin's fee slots are paid in (Clanker v5: `0x0` native ETH or USDC). */
      pairedToken: t.pairedToken,
      pairedSymbol: t.pairedSymbol,
      agentId: a.agentId,
      status: a.status,
      paused: a.paused,
      lastActivityAt: a.lastActivityAt,
      dormancyPeriod: a.dormancyPeriod,
      dormantSince: a.dormantSince,
      balances,
      balancesSource: source,
      spender,
      spenderUsdc,
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

/**
 * What happened on Bootr since `since` (unix s, clamped to the last 7 days), for the platform agent's
 * "Bootr today" observation (`apps/supervisor/src/platform-feed.ts`). Newest first, each list capped at
 * 50 rows; the supervisor renders and truncates it. Launches come from `token`, wake/sleep changes from
 * `agent.statusChangedAt`, posts and first posts from the social store, claims from `feeClaim` (agent slot
 * only), milestones (first trade, holder counts, 24 h volume) from `milestone`, totals from `platformStats`
 * plus the sum of every coin's rolling 7-day volume. Launch items carry `source` (`bootr` | `clanker`) and the
 * coin's `lpFeeBps`. The body is composed in api/platform-feed.ts. No prices or market caps.
 */
app.get('/platform/feed', async (c) => {
  const { now, since } = feedWindow(Math.floor(Date.now() / 1000), c.req.query('since'));
  const [[stats], social, launches, changes, claims, milestones, [vol]] = await Promise.all([
    db.select().from(schema.platformStats).where(eq(schema.platformStats.id, 'global')).limit(1),
    socialMap(),
    db
      .select({
        token: schema.token.id,
        kernel: schema.token.kernel,
        name: schema.token.name,
        symbol: schema.token.symbol,
        creator: schema.token.creator,
        launchedAt: schema.token.launchedAt,
        xHandle: schema.token.xHandle,
        source: schema.token.source,
        lpFeeBps: schema.token.lpFeeBps,
      })
      .from(schema.token)
      .where(gte(schema.token.launchedAt, since))
      .orderBy(desc(schema.token.launchedAt))
      .limit(50),
    db
      .select({ kernel: schema.agent.id, token: schema.agent.token, status: schema.agent.status, at: schema.agent.statusChangedAt })
      .from(schema.agent)
      .where(gte(schema.agent.statusChangedAt, since))
      .orderBy(desc(schema.agent.statusChangedAt))
      .limit(50),
    db
      .select({
        token: schema.feeClaim.token,
        recipient: schema.feeClaim.recipient,
        amountUsd: schema.feeClaim.amountUsd,
        at: schema.feeClaim.timestamp,
        txHash: schema.feeClaim.txHash,
      })
      .from(schema.feeClaim)
      .where(and(gte(schema.feeClaim.timestamp, since), eq(schema.feeClaim.recipientKind, 'agent')))
      .orderBy(desc(schema.feeClaim.timestamp))
      .limit(FEED_LIMIT),
    db.select().from(schema.milestone).where(gte(schema.milestone.timestamp, since)).orderBy(desc(schema.milestone.timestamp), desc(schema.milestone.id)).limit(FEED_LIMIT),
    db.select({ usd: sql<number>`coalesce(sum(${schema.token.volume7dUsd}), 0)` }).from(schema.token),
  ]);
  // Symbols for the rows that only carry an address.
  const refs = feedNameRefs({ statusChanges: changes, claims, milestones, social, since });
  const kernels = refs.kernels as Address[];
  const tokenIds = refs.tokenIds as Address[];
  const named =
    kernels.length || tokenIds.length
      ? await db
          .select({ id: schema.token.id, kernel: schema.token.kernel, symbol: schema.token.symbol, xHandle: schema.token.xHandle })
          .from(schema.token)
          .where(or(...(kernels.length ? [inArray(schema.token.kernel, kernels)] : []), ...(tokenIds.length ? [inArray(schema.token.id, tokenIds)] : [])))
      : [];
  return c.json(
    j(
      composePlatformFeed({
        now,
        since,
        stats,
        volume7dUsd: Number(vol?.usd ?? 0),
        social,
        launches,
        statusChanges: changes,
        claims,
        milestones,
        named,
      }),
    ),
  );
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
