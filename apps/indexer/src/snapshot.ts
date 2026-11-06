import { and, eq, sum } from 'ponder';
import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import { getAbiItem, type Address, type Hex } from 'viem';

import { B20TokenAbi } from '../abis/B20Token';
import { Erc20Abi } from '../abis/Erc20';
import { MULTICALL3_ADDRESS, Multicall3Abi } from '../abis/Multicall3';
import { PoolManagerAbi } from '../abis/PoolManager';
import { safeMessage } from '../rpc-budget';
import { fetchAdminConfig } from './lib/admin-config';
import { decodeAgentBalances, type AgentBalances } from './lib/balances';
import { snapshotSpacingSec } from './lib/blocks';
import { indexerEnv, snapshotBlockSources } from './lib/env';
import { decodeLiquidity, decodeSlot0, poolLiquiditySlot, poolStateSlot } from './lib/pool';
import { toUnits, usd } from './lib/price';
import { rpcClient } from './lib/rpc';
import { socialStore, type AgentSocial } from './lib/social-store';
import { deriveStatus, dormantSince, type AgentStatus } from './lib/status';
import {
  getBuckets,
  getEthUsd,
  getPlatformConfig,
  graduationFields,
  lc,
  marketFields,
  setPlatform,
  windowFields,
  type AgentRow,
  type Ctx,
  type TokenRow,
} from './lib/store';
import { dayId, dayStart, historicalSnapshotDue } from './lib/time';

/**
 * Periodic snapshot, every 60 s of chain time: 300 of today's 200 ms blocks (`INDEXER_SNAPSHOT_INTERVAL`), and 30 of the
 * 2 s blocks before Denim, each era its own Ponder source (`snapshotSources`, lib/blocks.ts).
 *
 * Near the chain tip ("live": block younger than 15 min) it also refreshes ETH/USD, pool state
 * (PoolManager.extsload), kernel balances plus each agent's spender USDC float (one multicall), the
 * admin config and the supervisor's social data (which carries the spender address). During historical backfill those RPC/HTTP reads are skipped (they would only
 * describe the past and be overwritten at the tip), and the rest runs once per UTC hour instead of once per
 * snapshot (`historicalSnapshotDue`): time-based fields (windows, status), the fuel scan and the daily rollup stay
 * coherent at that grain, and the first live snapshot brings everything up to date. Every snapshot rewrites each
 * coin and agent, so at the full rate this handler took about 84% of a backfill (702 s of 840 s, 1.5 million
 * swaps took 21 s). Trades, fees, claims and graduation come from their own events and are not thinned.
 */
const LIVE_WINDOW_SEC = 15 * 60;
const KERNELS_PER_GETLOGS = 100;
const usdcTransfer = getAbiItem({ abi: Erc20Abi, name: 'Transfer' });

/** `spenders`: kernel -> x402 spender EOA (null / missing = none known). */
async function readChainState(context: Ctx, tokens: TokenRow[], agents: AgentRow[], spenders: Map<string, string | null>) {
  const env = indexerEnv();
  const pm = env.addresses.uniswap.poolManager;
  const calls = [
    ...tokens.map((t) => ({
      abi: PoolManagerAbi,
      address: pm,
      functionName: 'extsload' as const,
      args: [[poolStateSlot(t.poolId), poolLiquiditySlot(t.poolId)]] as const,
    })),
    ...agents.flatMap((a) => {
      const t = tokens.find((x) => x.id === a.token);
      const spender = spenders.get(a.id);
      return [
        { abi: Erc20Abi, address: env.addresses.usdc, functionName: 'balanceOf' as const, args: [a.id] as const },
        { abi: Erc20Abi, address: env.addresses.weth, functionName: 'balanceOf' as const, args: [a.id] as const },
        { abi: Multicall3Abi, address: MULTICALL3_ADDRESS, functionName: 'getEthBalance' as const, args: [a.id] as const },
        {
          abi: B20TokenAbi,
          address: (t?.id ?? a.token) as Address,
          functionName: 'balanceOf' as const,
          args: [a.id] as const,
        },
        ...(spender
          ? [{ abi: Erc20Abi, address: env.addresses.usdc, functionName: 'balanceOf' as const, args: [spender as Address] as const }]
          : []),
      ];
    }),
  ];
  const pools = new Map<string, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>();
  if (calls.length === 0) return { pools, balances: new Map<string, AgentBalances>() };
  const res = await context.client.multicall({
    contracts: calls as never,
    multicallAddress: MULTICALL3_ADDRESS,
    allowFailure: true,
    batchSize: 16_384,
  });
  tokens.forEach((t, i) => {
    const r = res[i] as { status: string; result?: readonly Hex[] };
    if (r?.status !== 'success' || !r.result || r.result.length < 2) return;
    const slot0 = decodeSlot0(r.result[0]!);
    if (slot0.sqrtPriceX96 === 0n) return;
    pools.set(t.id, { sqrtPriceX96: slot0.sqrtPriceX96, tick: slot0.tick, liquidity: decodeLiquidity(r.result[1]!) });
  });
  const balances = decodeAgentBalances(res as readonly { status: string; result?: unknown }[], tokens.length, agents, spenders);
  return { pools, balances };
}

/**
 * USDC Transfer logs into known kernels since the last scan. Ponder log filters cannot match a
 * dynamic set of `to` addresses, so this uses eth_getLogs with an OR-list of kernel topics.
 */
async function scanFuel(
  context: Ctx,
  agents: AgentRow[],
  fromCursor: bigint,
  toBlock: bigint,
): Promise<{ scannedTo: bigint; perKernel: Map<string, bigint> }> {
  const env = indexerEnv();
  const perKernel = new Map<string, bigint>();
  if (agents.length === 0 || fromCursor > toBlock) return { scannedTo: toBlock, perKernel };
  const kernels = agents.map((a) => a.id as Address);
  const tokenOf = new Map(agents.map((a) => [a.id, a.token]));
  const range = BigInt(env.fuelScanMaxRange);
  let cursor = fromCursor;
  try {
    while (cursor <= toBlock) {
      const end = cursor + range - 1n < toBlock ? cursor + range - 1n : toBlock;
      for (let i = 0; i < kernels.length; i += KERNELS_PER_GETLOGS) {
        const logs = await rpcClient().getLogs({
          address: env.addresses.usdc,
          event: usdcTransfer,
          args: { to: kernels.slice(i, i + KERNELS_PER_GETLOGS) },
          fromBlock: cursor,
          toBlock: end,
        });
        const blockTs = new Map<bigint, number>();
        for (const l of logs) {
          const kernel = lc(l.args.to as Address);
          const value = l.args.value as bigint;
          if (!value || !tokenOf.has(kernel) || l.blockNumber === null || l.transactionHash === null) continue;
          if (await context.db.find(schema.fuel, { id: `${l.transactionHash}-${l.logIndex}` })) continue;
          const bt = (l as { blockTimestamp?: Hex | bigint }).blockTimestamp;
          let ts = bt !== undefined && bt !== null ? Number(bt) : blockTs.get(l.blockNumber);
          if (ts === undefined) {
            ts = Number((await rpcClient().getBlock({ blockNumber: l.blockNumber })).timestamp);
            blockTs.set(l.blockNumber, ts);
          }
          const inserted = await context.db
            .insert(schema.fuel)
            .values({
              id: `${l.transactionHash}-${l.logIndex}`,
              from: lc(l.args.from as Address),
              kernel,
              token: tokenOf.get(kernel)!,
              amount: value,
              amountUsd: usd(toUnits(value, 6)),
              timestamp: ts,
              blockNumber: l.blockNumber,
              txHash: l.transactionHash,
            })
            .onConflictDoNothing();
          if (inserted) perKernel.set(kernel, (perKernel.get(kernel) ?? 0n) + value);
        }
      }
      cursor = end + 1n;
    }
  } catch (err) {
    console.warn(`[indexer] USDC fuel scan failed at block ${cursor}: ${safeMessage(err)}`);
  }
  return { scannedTo: cursor - 1n, perKernel };
}

async function snapshot({ event, context }: { event: { block: { timestamp: bigint; number: bigint } }; context: Ctx }) {
  const env = indexerEnv();
  const now = Number(event.block.timestamp);
  const bn = event.block.number;
  const live = now >= Math.floor(Date.now() / 1000) - LIVE_WINDOW_SEC;
  if (!live && !historicalSnapshotDue(now, snapshotSpacingSec(env.chainId, bn, env.snapshotInterval))) return;

  const ethUsd = await getEthUsd(context, bn, live);

  // ---- platform config (admin overrides, env fallback)
  let cfg = await getPlatformConfig(context);
  if (live) {
    const remote = await fetchAdminConfig();
    const patch: Partial<typeof cfg> = {};
    if (remote?.graduationThresholdUsd !== undefined && remote.graduationThresholdUsd !== cfg.graduationThresholdUsd) {
      patch.graduationThresholdUsd = remote.graduationThresholdUsd;
    }
    const boot = remote?.bootToken !== undefined ? remote.bootToken : env.bootToken;
    if (boot !== undefined && (boot ? lc(boot) : null) !== cfg.bootToken) patch.bootToken = boot ? lc(boot) : null;
    if (Object.keys(patch).length) {
      cfg = await context.db
        .update(schema.platformConfig, { id: cfg.id })
        .set({ ...patch, source: remote ? 'admin' : 'env', updatedAt: now });
    }
  }

  const tokens = await context.db.sql.select().from(schema.token);
  const agents = await context.db.sql.select().from(schema.agent);

  // ---- live reads
  let pools = new Map<string, { sqrtPriceX96: bigint; tick: number; liquidity: bigint }>();
  let balances = new Map<string, AgentBalances>();
  let social: Map<string, AgentSocial> | null = null;
  if (live && tokens.length > 0) {
    try {
      social = await socialStore().all();
    } catch (err) {
      console.warn(`[indexer] social store read failed: ${safeMessage(err)}`);
    }
    // spender address: the supervisor's latest push, else the last mirrored value
    const spenders = new Map(agents.map((a) => [a.id, social?.has(a.id) ? social.get(a.id)!.spender : a.spender] as const));
    try {
      ({ pools, balances } = await readChainState(context, tokens, agents, spenders));
    } catch (err) {
      console.warn(`[indexer] snapshot multicall failed at block ${bn}: ${safeMessage(err)}`);
    }
  }

  // ---- USDC fuel (batched during backfill)
  let fuelPerKernel = new Map<string, bigint>();
  if (agents.length > 0) {
    let from = cfg.fuelScannedTo + 1n;
    if (cfg.fuelScannedTo === 0n) from = tokens.reduce((m, t) => (t.launchBlock < m ? t.launchBlock : m), bn);
    if (live || bn - from + 1n >= BigInt(env.fuelScanMaxRange)) {
      const r = await scanFuel(context, agents, from, bn);
      fuelPerKernel = r.perKernel;
      if (r.scannedTo !== cfg.fuelScannedTo) {
        cfg = await context.db.update(schema.platformConfig, { id: cfg.id }).set({ fuelScannedTo: r.scannedTo });
      }
    }
  } else if (cfg.fuelScannedTo !== bn) {
    cfg = await context.db.update(schema.platformConfig, { id: cfg.id }).set({ fuelScannedTo: bn });
  }

  // ---- tokens
  const tokenById = new Map<string, TokenRow>();
  for (const t0 of tokens) {
    const ps = pools.get(t0.id);
    const t: TokenRow = ps ? { ...t0, sqrtPriceX96: ps.sqrtPriceX96, tick: ps.tick, poolLiquidity: ps.liquidity } : t0;
    const market = marketFields(t, ethUsd);
    const buckets = await getBuckets(context, t.id);
    const s = social?.get(t.kernel);
    const next = {
      sqrtPriceX96: t.sqrtPriceX96,
      tick: t.tick,
      poolLiquidity: t.poolLiquidity,
      ...market,
      ...windowFields(buckets, now, market.priceUsd),
      ...graduationFields(t, market.marketCapUsd, cfg.graduationThresholdUsd, now),
      ...(s && s.xHandle !== t.xHandle ? { xHandle: s.xHandle } : {}),
      // the model the creator switched to after launch (social-store `model`); the launch-time value stays until then
      ...(s?.model && s.model !== t.model ? { model: s.model } : {}),
    };
    const updated = await context.db.update(schema.token, { id: t.id }).set(next);
    tokenById.set(t.id, updated);
  }

  // ---- agents
  const statuses = new Map<string, AgentStatus>();
  for (const a of agents) {
    const t = tokenById.get(a.token);
    const b = balances.get(a.id);
    const s = social?.get(a.id);
    const fuelIn = fuelPerKernel.get(a.id) ?? 0n;
    const patch: Partial<typeof schema.agent.$inferInsert> = {};
    if (s && s.spender !== a.spender) patch.spender = s.spender as Hex | null;
    if (b && !a.claimed) {
      // kernel balances; the spender float is kept apart (`spenderUsdc`) but counts in treasuryUsd
      const spenderUsdc = b.spenderUsdc ?? a.spenderUsdc;
      patch.treasuryUsdc = b.usdc;
      patch.treasuryWeth = b.weth;
      patch.treasuryEth = b.eth;
      patch.treasuryOwnToken = b.own;
      patch.spenderUsdc = spenderUsdc;
      patch.treasuryUsd = usd(
        toUnits(b.usdc + spenderUsdc, 6) +
          (toUnits(b.weth, 18) + toUnits(b.eth, 18)) * ethUsd +
          toUnits(b.own, 18) * (t?.priceUsd ?? 0),
      );
      patch.balancesUpdatedAt = now;
    }
    if (fuelIn > 0n) patch.fuelReceivedUsdc = a.fuelReceivedUsdc + fuelIn;
    if (s) {
      patch.lastPostAt = s.lastPostAt;
      patch.postsCount24h = s.postsCount24h;
      patch.supervisorStatus = s.status;
    }
    const merged = { ...a, ...patch } as AgentRow;
    const status = deriveStatus({
      now,
      lastActivityAt: merged.lastActivityAt,
      dormancyPeriod: merged.dormancyPeriod,
      paused: merged.paused,
      claimed: merged.claimed,
      treasuryUsdc: merged.treasuryUsdc,
      spenderUsdc: merged.spenderUsdc,
      supervisorHint: merged.supervisorStatus,
    });
    statuses.set(a.id, status);
    await context.db.update(schema.agent, { id: a.id }).set({
      ...patch,
      status,
      dormantSince: dormantSince(now, merged.lastActivityAt, merged.dormancyPeriod),
      ...(status !== a.status ? { statusChangedAt: now } : {}),
    });
    if (t && t.agentStatus !== status) {
      tokenById.set(t.id, await context.db.update(schema.token, { id: t.id }).set({ agentStatus: status }));
    }
  }

  // ---- platform rollups
  const all = [...tokenById.values()];
  const awake = [...statuses.values()].filter((s) => s === 'awake').length;
  const today = dayStart(now);
  const active = agents.filter((a) => a.lastActivityAt >= today).length;
  let bootFields = {};
  if (cfg.bootToken) {
    const boot = tokenById.get(cfg.bootToken);
    const fees = await context.db.sql
      .select({ v: sum(schema.feeBalance.accruedUsd) })
      .from(schema.feeBalance)
      .where(and(eq(schema.feeBalance.token, cfg.bootToken), eq(schema.feeBalance.recipientKind, 'burn')));
    bootFields = {
      bootToken: cfg.bootToken,
      bootPriceUsd: boot?.priceUsd ?? 0,
      bootMarketCapUsd: boot?.marketCapUsd ?? 0,
      bootChange24hPct: boot?.change24hPct ?? 0,
      bootBurnedTotal: boot?.burnedTotal ?? 0n,
      bootFeesToBurnUsd: usd(Number(fees[0]?.v ?? 0)),
    };
  } else {
    bootFields = { bootToken: null };
  }
  await setPlatform(context, now, {
    tokens: all.length,
    agentsTotal: agents.length,
    agentsAwake: awake,
    volume24hUsd: usd(all.reduce((s, t) => s + t.volume24hUsd, 0)),
    fees24hUsd: usd(all.reduce((s, t) => s + t.fees24hUsd, 0)),
    volumeTotalUsd: usd(all.reduce((s, t) => s + t.volumeTotalUsd, 0)),
    feesTotalUsd: usd(all.reduce((s, t) => s + t.feesTotalUsd, 0)),
    graduationThresholdUsd: cfg.graduationThresholdUsd,
    ethPriceUsd: ethUsd,
    updatedAt: now,
    ...bootFields,
  });
  if (agents.length > 0) {
    await context.db
      .insert(schema.dailyStat)
      .values({
        id: dayId(now),
        timestamp: today,
        launches: 0,
        volumeUsd: 0,
        trades: 0,
        feesUsd: 0,
        feesAgentUsd: 0,
        feesCreatorUsd: 0,
        feesBurnUsd: 0,
        feesPlatformUsd: 0,
        activeAgents: active,
        awakeAgents: awake,
        bootBurnedToken: 0n,
        bootBurnedUsd: 0,
      })
      .onConflictDoUpdate({ activeAgents: active, awakeAgents: awake });
  }
}

ponder.on('BootrSnapshot:block', snapshot);
if (snapshotBlockSources().preDenim) ponder.on('BootrSnapshotPreDenim:block', snapshot);
