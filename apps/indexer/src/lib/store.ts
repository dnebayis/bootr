/**
 * Shared indexing-side helpers (no `ponder.on` registrations here).
 */
import type { Context } from 'ponder:registry';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { ChainlinkAggregatorAbi } from '../../abis/ChainlinkAggregator';
import { indexerEnv } from './env';
import { classifyRecipient, type RecipientKind } from './fees';
import { positionTicks } from './pool';
import { chainlinkToUsd, coinPriceInWeth, liquidityUsd, toUnits, unitPrice, usd } from './price';
import { deriveStatus, dormantSince } from './status';
import { dayId, dayStart } from './time';
import { addTrade, change24hPct, DAY, sumWindow, type Bucket } from './windows';

export type Ctx = Context;
export type TokenRow = typeof schema.token.$inferSelect;
export type AgentRow = typeof schema.agent.$inferSelect;

export const GLOBAL = 'global';
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';
export const DEAD_ADDRESS = '0x000000000000000000000000000000000000dead';
export const DEFAULT_GRADUATION_THRESHOLD_USD = 50_000;
/** Re-read Chainlink at most every N blocks from event handlers (snapshot refreshes more often). */
const ETH_USD_MAX_AGE_BLOCKS = 300n;

export const lc = <T extends string>(a: T) => a.toLowerCase() as T;
export const num = (v: bigint) => Number(v);

// ------------------------------------------------------------------ prices

/** ETH/USD from the cached price row, refreshing from Chainlink when stale. */
export async function getEthUsd(context: Ctx, blockNumber: bigint, force = false): Promise<number> {
  const row = await context.db.find(schema.priceFeed, { id: 'ETH/USD' });
  if (!force && row && row.priceUsd > 0 && blockNumber - row.blockNumber < ETH_USD_MAX_AGE_BLOCKS) {
    return row.priceUsd;
  }
  const feed = indexerEnv().ethUsdFeed;
  try {
    const [, answer, , updatedAt] = await context.client.readContract({
      abi: ChainlinkAggregatorAbi,
      address: feed,
      functionName: 'latestRoundData',
    });
    const priceUsd = usd(chainlinkToUsd(answer, 8));
    if (priceUsd > 0) {
      await context.db
        .insert(schema.priceFeed)
        .values({ id: 'ETH/USD', priceUsd, oracleUpdatedAt: Number(updatedAt), blockNumber })
        .onConflictDoUpdate({ priceUsd, oracleUpdatedAt: Number(updatedAt), blockNumber });
      return priceUsd;
    }
  } catch (err) {
    console.warn(`[indexer] Chainlink ETH/USD read failed at block ${blockNumber}: ${(err as Error).message}`);
  }
  return row?.priceUsd ?? 0;
}

/** USD value of a fee/treasury asset amount: WETH at ETH/USD, the coin at its pool price. */
export function assetUsd(asset: string, amount: bigint, coin: TokenRow, ethUsd: number): number {
  const weth = lc(indexerEnv().addresses.weth);
  if (lc(asset) === weth) return usd(toUnits(amount, 18) * ethUsd);
  if (lc(asset) === lc(coin.id)) return usd(toUnits(amount, 18) * coin.priceUsd);
  return 0;
}

// ------------------------------------------------------------------ singletons

export async function getPlatformConfig(context: Ctx) {
  const row = await context.db.find(schema.platformConfig, { id: GLOBAL });
  if (row) return row;
  const env = indexerEnv();
  return context.db
    .insert(schema.platformConfig)
    .values({
      id: GLOBAL,
      graduationThresholdUsd: DEFAULT_GRADUATION_THRESHOLD_USD,
      bootToken: env.bootToken ? lc(env.bootToken) : null,
      source: env.bootToken ? 'env' : 'default',
      fuelScannedTo: typeof env.startBlock === 'number' ? BigInt(Math.max(0, env.startBlock - 1)) : 0n,
      updatedAt: 0,
    })
    .onConflictDoNothing()
    .then(async (r) => r ?? (await context.db.find(schema.platformConfig, { id: GLOBAL }))!);
}

const emptyPlatformStats = (ts: number) => ({
  id: GLOBAL,
  tokens: 0,
  agentsTotal: 0,
  agentsAwake: 0,
  volume24hUsd: 0,
  volumeTotalUsd: 0,
  fees24hUsd: 0,
  feesTotalUsd: 0,
  bootToken: null,
  bootPriceUsd: 0,
  bootMarketCapUsd: 0,
  bootChange24hPct: 0,
  bootBurnedTotal: 0n,
  bootFeesToBurnUsd: 0,
  graduationThresholdUsd: DEFAULT_GRADUATION_THRESHOLD_USD,
  ethPriceUsd: 0,
  updatedAt: ts,
});

type PlatformDelta = Partial<{
  tokens: number;
  agentsTotal: number;
  volumeTotalUsd: number;
  feesTotalUsd: number;
  bootBurnedTotal: bigint;
  bootFeesToBurnUsd: number;
}>;

export async function bumpPlatform(context: Ctx, ts: number, d: PlatformDelta) {
  await context.db
    .insert(schema.platformStats)
    .values({
      ...emptyPlatformStats(ts),
      tokens: d.tokens ?? 0,
      agentsTotal: d.agentsTotal ?? 0,
      volumeTotalUsd: usd(d.volumeTotalUsd ?? 0),
      feesTotalUsd: usd(d.feesTotalUsd ?? 0),
      bootBurnedTotal: d.bootBurnedTotal ?? 0n,
      bootFeesToBurnUsd: usd(d.bootFeesToBurnUsd ?? 0),
    })
    .onConflictDoUpdate((r) => ({
      tokens: r.tokens + (d.tokens ?? 0),
      agentsTotal: r.agentsTotal + (d.agentsTotal ?? 0),
      volumeTotalUsd: usd(r.volumeTotalUsd + (d.volumeTotalUsd ?? 0)),
      feesTotalUsd: usd(r.feesTotalUsd + (d.feesTotalUsd ?? 0)),
      bootBurnedTotal: r.bootBurnedTotal + (d.bootBurnedTotal ?? 0n),
      bootFeesToBurnUsd: usd(r.bootFeesToBurnUsd + (d.bootFeesToBurnUsd ?? 0)),
    }));
}

export async function setPlatform(context: Ctx, ts: number, values: Partial<typeof schema.platformStats.$inferInsert>) {
  await context.db
    .insert(schema.platformStats)
    .values({ ...emptyPlatformStats(ts), ...values })
    .onConflictDoUpdate(values);
}

type DailyDelta = Partial<{
  launches: number;
  volumeUsd: number;
  trades: number;
  feesUsd: number;
  feesAgentUsd: number;
  feesCreatorUsd: number;
  feesBurnUsd: number;
  feesPlatformUsd: number;
  bootBurnedToken: bigint;
  bootBurnedUsd: number;
}>;

export async function bumpDaily(context: Ctx, ts: number, d: DailyDelta) {
  const add = (a: number, b: number | undefined) => usd(a + (b ?? 0));
  await context.db
    .insert(schema.dailyStat)
    .values({
      id: dayId(ts),
      timestamp: dayStart(ts),
      launches: d.launches ?? 0,
      volumeUsd: add(0, d.volumeUsd),
      trades: d.trades ?? 0,
      feesUsd: add(0, d.feesUsd),
      feesAgentUsd: add(0, d.feesAgentUsd),
      feesCreatorUsd: add(0, d.feesCreatorUsd),
      feesBurnUsd: add(0, d.feesBurnUsd),
      feesPlatformUsd: add(0, d.feesPlatformUsd),
      activeAgents: 0,
      awakeAgents: 0,
      bootBurnedToken: d.bootBurnedToken ?? 0n,
      bootBurnedUsd: add(0, d.bootBurnedUsd),
    })
    .onConflictDoUpdate((r) => ({
      launches: r.launches + (d.launches ?? 0),
      volumeUsd: add(r.volumeUsd, d.volumeUsd),
      trades: r.trades + (d.trades ?? 0),
      feesUsd: add(r.feesUsd, d.feesUsd),
      feesAgentUsd: add(r.feesAgentUsd, d.feesAgentUsd),
      feesCreatorUsd: add(r.feesCreatorUsd, d.feesCreatorUsd),
      feesBurnUsd: add(r.feesBurnUsd, d.feesBurnUsd),
      feesPlatformUsd: add(r.feesPlatformUsd, d.feesPlatformUsd),
      bootBurnedToken: r.bootBurnedToken + (d.bootBurnedToken ?? 0n),
      bootBurnedUsd: add(r.bootBurnedUsd, d.bootBurnedUsd),
    }));
}

export function feeKindDelta(kind: RecipientKind, amountUsd: number): DailyDelta {
  const d: DailyDelta = { feesUsd: amountUsd };
  if (kind === 'agent') d.feesAgentUsd = amountUsd;
  if (kind === 'creator') d.feesCreatorUsd = amountUsd;
  if (kind === 'burn') d.feesBurnUsd = amountUsd;
  if (kind === 'platform') d.feesPlatformUsd = amountUsd;
  return d;
}

export function recipientKindOf(recipient: Address, t: TokenRow): RecipientKind | null {
  return classifyRecipient(recipient, {
    kernel: t.kernel,
    creator: t.creator,
    burner: t.burner,
    platformRecipient: t.platformRecipient,
  });
}

// ------------------------------------------------------------------ token market state

/** Recompute price-derived fields of a token from its pool state. */
export function marketFields(t: TokenRow, ethUsd: number) {
  const priceWeth = coinPriceInWeth(t.sqrtPriceX96, t.coinIsToken0);
  const priceUsd = unitPrice(priceWeth * ethUsd);
  const { tickLower, tickUpper } = positionTicks(t.coinIsToken0);
  return {
    priceWeth,
    priceUsd,
    marketCapUsd: usd(priceUsd * toUnits(t.totalSupply, 18)),
    liquidityUsd: liquidityUsd({
      // The locked position; active liquidity is 0 while the price sits on the range edge.
      liquidity: t.positionLiquidity > t.poolLiquidity ? t.positionLiquidity : t.poolLiquidity,
      sqrtPriceX96: t.sqrtPriceX96,
      tickLower,
      tickUpper,
      coinIsToken0: t.coinIsToken0,
      ethUsd,
    }),
  };
}

/** Rolling-window fields from the token's hourly buckets. */
export function windowFields(buckets: Bucket[], now: number, priceUsd: number) {
  const d1 = sumWindow(buckets, now, DAY);
  const d7 = sumWindow(buckets, now, 7 * DAY);
  return {
    volume24hUsd: usd(d1.volume),
    volume7dUsd: usd(d7.volume),
    fees24hUsd: usd(d1.fees),
    trades24h: d1.trades,
    change24hPct: change24hPct(buckets, now, priceUsd),
  };
}

export function graduationFields(t: TokenRow, marketCapUsd: number, threshold: number, now: number) {
  if (t.graduated) return {};
  if (marketCapUsd >= threshold && threshold > 0) return { graduated: true, graduatedAt: now };
  return {};
}

export async function getBuckets(context: Ctx, token: Hex): Promise<Bucket[]> {
  const row = await context.db.find(schema.tokenWindow, { id: token });
  return ((row?.buckets as Bucket[] | undefined) ?? []).slice();
}

export async function recordTradeBucket(
  context: Ctx,
  token: Hex,
  ts: number,
  volumeUsd: number,
  feeUsd: number,
  priceUsd: number,
): Promise<Bucket[]> {
  const buckets = addTrade(await getBuckets(context, token), ts, volumeUsd, feeUsd, priceUsd);
  await context.db
    .insert(schema.tokenWindow)
    .values({ id: token, buckets })
    .onConflictDoUpdate({ buckets });
  return buckets;
}

// ------------------------------------------------------------------ agent status

export async function updateAgentStatus(
  context: Ctx,
  a: AgentRow,
  now: number,
  patch: Partial<typeof schema.agent.$inferInsert> = {},
) {
  const next = { ...a, ...patch } as AgentRow;
  const status = deriveStatus({
    now,
    lastActivityAt: next.lastActivityAt,
    dormancyPeriod: next.dormancyPeriod,
    paused: next.paused,
    claimed: next.claimed,
    treasuryUsdc: next.treasuryUsdc,
    spenderUsdc: next.spenderUsdc,
    supervisorHint: next.supervisorStatus,
  });
  const changed = status !== a.status;
  await context.db.update(schema.agent, { id: a.id }).set({
    ...patch,
    status,
    dormantSince: dormantSince(now, next.lastActivityAt, next.dormancyPeriod),
    ...(changed ? { statusChangedAt: now } : {}),
  });
  if (changed) {
    await context.db.update(schema.token, { id: a.token }).set({ agentStatus: status });
  }
  return status;
}
