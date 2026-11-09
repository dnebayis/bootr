import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import { decodeEventLog, decodeFunctionData, type Address, type Hex, type Log } from 'viem';

import { safeMessage } from '../rpc-budget';
import { B20TokenAbi } from '../abis/B20Token';
import { BootrClankerLauncherAbi } from '../abis/BootrClankerLauncher';
import { BootrLauncherAbi } from '../abis/BootrLauncher';
import { ClankerAbi } from '../abis/Clanker';
import { ClankerLpLockerFeeConversionAbi } from '../abis/ClankerLpLockerFeeConversion';
import { ClankerTokenAbi } from '../abis/ClankerToken';
import { Erc20Abi } from '../abis/Erc20';
import { PoolManagerAbi } from '../abis/PoolManager';
import { RwagmiHookV3Abi } from '../abis/RwagmiHookV3';
import { RwagmiLauncherV3Abi } from '../abis/RwagmiLauncherV3';
import { RwagmiLpLockerV3Abi } from '../abis/RwagmiLpLockerV3';
import { ClankerV5HookAbi } from '../abis/ClankerV5';
import {
  CLANKER_TOKEN_SUPPLY,
  CLANKER_V5_SUPPLY,
  clankerPoolKey,
  clankerPositionTicks,
  clankerSlots,
  clankerV5LaunchFacts,
  clankerV5PoolKey,
  clankerV5PositionTicks,
  clankerV5Slots,
  type ClankerLaunchedArgs,
  type ClankerRewardInfo,
  type ClankerV5HookSlot,
  type ClankerV5LaunchedArgs,
} from './lib/clanker';
import { enabledSources, indexerEnv } from './lib/env';
import { bpsByKind, classifySlots, CLANKER_PROTOCOL_BPS, DEAD_ADDRESS, type LaunchSource, type RewardSlot, type SlotKind } from './lib/fees';
import { applyClankerV5TaxCredit, applyFeeTaken } from './lib/ledger';
import { applySwap, applyTransfer } from './lib/market';
import { imageFromUri } from './lib/metadata';
import { positionTicks } from './lib/pool';
import { oneSidedLiquidity, toUnits, usd } from './lib/price';
import { bumpDaily, bumpPlatform, bumpSource, getPlatformConfig, lc, ZERO_ADDRESS, type Ctx } from './lib/store';

/** The LP fee assumed when neither the pool nor the launch defaults carry one (1%). */
const DEFAULT_LP_FEE_BPS = 10_000;

/** Decode a receipt log against one ABI, or null. */
function tryDecode<const A extends readonly unknown[]>(abi: A, log: Log) {
  try {
    return decodeEventLog({ abi: abi as never, data: log.data, topics: log.topics }) as unknown as {
      eventName: string;
      args: Record<string, unknown>;
    };
  } catch {
    return null;
  }
}

type LaunchArgs = {
  token: Address;
  name: string;
  symbol: string;
  decimals: number;
  totalSupply: bigint;
  liquiditySupply: bigint;
  extensionSupply: bigint;
  primaryPoolId: Hex;
  poolCount: number;
  hook: Address;
  locker: Address;
  rewardConfigurationHash: Hex;
};

type PoolArgs = {
  token: Address;
  poolId: Hex;
  poolIndex: number;
  key: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  depositedSupply: bigint;
  startingTick: number;
  fee: { mode: number; staticFee: number };
};

type TxMeta = { txHash: Hex; blockNumber: bigint };

/** `AgentLaunched` args (identical on BootrLauncher and BootrClankerLauncher). */
type AgentLaunchedArgs = {
  token: Address;
  kernel: Address;
  creator: Address;
  burner: Address;
  agentId: bigint;
  defaults: {
    lpFeeBps: number;
    agentBps: number;
    creatorBps: number;
    burnBps: number;
    platformBps: number;
    platformRecipient: Address;
    minFuelUsdc: bigint;
    dormancyPeriod: number;
  };
  workerHash: Hex;
  model: string;
  agentURI: string;
  supervisorSessionKey: Address;
};

type LaunchEvent = {
  args: AgentLaunchedArgs;
  log: { address: Address; logIndex: number };
  block: { number: bigint; timestamp: bigint };
  transaction: { hash: Hex; from: Address; to: Address | null; input?: Hex };
};

// ------------------------------------------------------------------ Bootr path: RWAGMI v3 staging

async function stageLaunch(context: Ctx, a: LaunchArgs, m: TxMeta) {
  await context.db
    .insert(schema.rwagmiLaunch)
    .values({
      id: lc(a.token),
      name: a.name,
      symbol: a.symbol,
      decimals: a.decimals,
      totalSupply: a.totalSupply,
      liquiditySupply: a.liquiditySupply,
      extensionSupply: a.extensionSupply,
      primaryPoolId: lc(a.primaryPoolId),
      poolCount: a.poolCount,
      hook: lc(a.hook),
      locker: lc(a.locker),
      rewardConfigurationHash: a.rewardConfigurationHash,
      launchTx: m.txHash,
      blockNumber: m.blockNumber,
    })
    .onConflictDoNothing();
}

/** Pool rows only for launches staged by `stageLaunch` (i.e. made by BootrLauncher). */
async function stagePool(context: Ctx, p: PoolArgs, m: TxMeta) {
  const token = lc(p.token);
  if (!(await context.db.find(schema.rwagmiLaunch, { id: token }))) return;
  const coinIsToken0 = lc(p.key.currency0) === token;
  const { tickLower, tickUpper } = positionTicks(coinIsToken0);
  await context.db
    .insert(schema.pool)
    .values({
      id: lc(p.poolId),
      token,
      coinIsToken0,
      tickLower,
      tickUpper,
      currency0: lc(p.key.currency0),
      currency1: lc(p.key.currency1),
      fee: p.key.fee,
      tickSpacing: p.key.tickSpacing,
      hooks: lc(p.key.hooks),
      pairedToken: coinIsToken0 ? lc(p.key.currency1) : lc(p.key.currency0),
      poolIndex: p.poolIndex,
      feeMode: p.fee.mode,
      staticFee: p.fee.staticFee,
      startingTick: p.startingTick,
      depositedSupply: p.depositedSupply,
      launchTx: m.txHash,
    })
    .onConflictDoNothing();
}

if (enabledSources().RwagmiLauncherV3) {
  // Filtered in ponder.config.ts to `creator == BootrLauncher`. Emitted inside the launch tx before
  // LaunchPoolCreatedV3 and AgentLaunched.
  ponder.on('RwagmiLauncherV3:B20LaunchCreatedV3', async ({ event, context }) => {
    await stageLaunch(context, event.args, { txHash: event.transaction.hash, blockNumber: event.block.number });
  });

  ponder.on('RwagmiLauncherV3:LaunchPoolCreatedV3', async ({ event, context }) => {
    await stagePool(context, event.args, { txHash: event.transaction.hash, blockNumber: event.block.number });
  });
}

// ------------------------------------------------------------------ Clanker path: staging

/** `ClankerLaunched` of the wrapper, plus `TokenCreated` facts when the launch handler has the receipt. */
async function stageClankerLaunch(context: Ctx, a: ClankerLaunchedArgs, m: TxMeta, created: { context: string; extensionsSupply: bigint } | null) {
  const token = lc(a.token);
  const values = {
    id: token,
    version: 4,
    poolId: lc(a.poolId),
    hook: lc(a.hook),
    locker: lc(a.locker),
    mevModule: lc(a.mevModule),
    antiSnipe: false,
    startingTick: Number(a.startingTick),
    lpFeeBps: Number(a.lpFeeBps),
    context: created?.context ?? '',
    extensionsSupply: created?.extensionsSupply ?? 0n,
    launchTx: m.txHash,
    blockNumber: m.blockNumber,
  };
  const row = await context.db.insert(schema.clankerPool).values(values).onConflictDoNothing();
  if (!row && created) {
    await context.db.update(schema.clankerPool, { id: token }).set({ context: created.context, extensionsSupply: created.extensionsSupply });
  }
}

if (enabledSources().BootrClankerLauncher) {
  // Emitted by the wrapper in the launch tx (before or after AgentLaunched: the launch handler replays it from
  // the receipt when it has not been staged yet).
  ponder.on('BootrClankerLauncher:ClankerLaunched', async ({ event, context }) => {
    await stageClankerLaunch(context, event.args, { txHash: event.transaction.hash, blockNumber: event.block.number }, null);
  });
}

// ------------------------------------------------------------------ shared

/** `LaunchParams.image` / `.metadata` from the launch calldata (same selector on both launchers), else `fallback()`. */
async function launchMetadata(launcher: Address, tx: { to: Address | null; input?: Hex }, fallback: () => Promise<{ image: string; metadata: string }>) {
  if (tx.input && tx.to && lc(tx.to) === lc(launcher)) {
    try {
      const call = decodeFunctionData({ abi: BootrLauncherAbi, data: tx.input });
      if (call.functionName === 'launch') {
        const p = call.args[0] as { image: string; metadata: string };
        return { image: p.image, metadata: p.metadata };
      }
    } catch {
      // not a direct launch() call (e.g. a smart-wallet batch): fall through
    }
  }
  return fallback();
}

/** Slots from the launch defaults when the locker cannot be read (fixed launcher order). */
function defaultSlots(a: AgentLaunchedArgs, launcher: Address, burner: Address | null): RewardSlot[] {
  const admin = lc(launcher);
  const d = a.defaults;
  return [
    { admin, recipient: lc(a.kernel), bps: d.agentBps },
    { admin, recipient: lc(a.creator), bps: d.creatorBps },
    ...(burner ? [{ admin, recipient: burner, bps: d.burnBps }] : []),
    { admin, recipient: lc(d.platformRecipient), bps: d.platformBps },
  ];
}

type LaunchRows = {
  source: LaunchSource;
  name: string;
  symbol: string;
  image: string;
  metadata: string;
  pool: { id: Hex; pairedToken: Address; coinIsToken0: boolean; startingTick: number; tickLower: number; tickUpper: number };
  lpFeeBps: number;
  totalSupply: bigint;
  positionLiquidity: bigint;
  rewards: RewardSlot[];
  kinds: (SlotKind | null)[];
  /** The launch protocol's share in bps of the LP fee (RWAGMI's slot, or Clanker's 20% on top). */
  protocolBps: number;
  protocolRecipient: Address | null;
};

/** The token / agent / slot rows every launch gets, then the rollups. */
async function insertLaunch(context: Ctx, event: LaunchEvent, r: LaunchRows) {
  const a = event.args;
  const token = lc(a.token);
  const kernel = lc(a.kernel);
  const creator = lc(a.creator);
  const burner = a.burner === ZERO_ADDRESS ? null : lc(a.burner);
  const platformRecipient = lc(a.defaults.platformRecipient);
  const ts = Number(event.block.timestamp);
  const d = a.defaults;
  const bps = bpsByKind(r.rewards, r.kinds);
  const startSqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** r.pool.startingTick) * 2 ** 96));

  await context.db.insert(schema.token).values({
    id: token,
    chainId: context.chain.id,
    source: r.source,
    name: r.name,
    symbol: r.symbol,
    image: r.image,
    metadata: r.metadata,
    creator,
    kernel,
    burner,
    agentId: a.agentId,
    poolId: r.pool.id,
    pairedToken: r.pool.pairedToken,
    coinIsToken0: r.pool.coinIsToken0,
    tickLower: r.pool.tickLower,
    tickUpper: r.pool.tickUpper,
    lpFeeBps: r.lpFeeBps,
    agentBps: bps.agent,
    creatorBps: bps.creator,
    burnBps: bps.burn,
    platformBps: bps.platform,
    protocolBps: r.protocolBps,
    protocolRecipient: r.protocolRecipient,
    platformRecipient,
    workerHash: a.workerHash,
    model: a.model,
    agentUri: a.agentURI,
    supervisorSessionKey: lc(a.supervisorSessionKey),
    xHandle: null,
    launchedAt: ts,
    launchBlock: event.block.number,
    launchTx: event.transaction.hash,
    totalSupply: r.totalSupply,
    sqrtPriceX96: startSqrt,
    tick: r.pool.startingTick,
    poolLiquidity: 0n,
    positionLiquidity: r.positionLiquidity,
    priceWeth: 0,
    priceUsd: 0,
    marketCapUsd: 0,
    liquidityUsd: 0,
    volume24hUsd: 0,
    volume7dUsd: 0,
    fees24hUsd: 0,
    change24hPct: null,
    trades24h: 0,
    volumeTotalUsd: 0,
    feesTotalUsd: 0,
    burnedTotal: 0n,
    lastTradeAt: null,
    holders: 0,
    graduated: false,
    graduatedAt: null,
    agentStatus: 'awake',
  });
  await context.db.insert(schema.tokenWindow).values({ id: token, buckets: [] });
  await context.db.insert(schema.agentIdentity).values({ id: a.agentId, kernel, token }).onConflictDoNothing();
  await context.db.insert(schema.agent).values({
    id: kernel,
    token,
    agentId: a.agentId,
    creator,
    // `registerAgent` stamps lastActivity = block.timestamp. Fuel was just pulled in.
    status: 'awake',
    statusChangedAt: ts,
    paused: false,
    claimed: false,
    lastActivityAt: ts,
    dormancyPeriod: d.dormancyPeriod,
    dormantSince: null,
    treasuryUsdc: 0n,
    treasuryWeth: 0n,
    treasuryEth: 0n,
    treasuryOwnToken: 0n,
    treasuryUsd: 0,
    spender: null,
    spenderUsdc: 0n,
    balancesUpdatedAt: null,
    fuelReceivedUsdc: 0n,
    feesClaimedUsd: 0,
    reputationScore: null,
    reputationCount: 0,
    reputationSum: 0,
    lastPostAt: null,
    postsCount24h: 0,
    supervisorStatus: null,
  });
  for (let i = 0; i < r.rewards.length; i++) {
    const slot = r.rewards[i]!;
    const kind = r.kinds[i];
    if (!kind) continue;
    await context.db.insert(schema.feeSlot).values({
      id: `${token}-${i}`,
      token,
      slot: i,
      recipient: slot.recipient,
      admin: slot.admin,
      bps: slot.bps,
      recipientKind: kind,
    });
    if (kind !== 'protocol') {
      await context.db.insert(schema.feeRecipient).values({ id: slot.recipient, firstToken: token }).onConflictDoNothing();
    }
  }
  // A BuybackBurner clone has state to follow; the Clanker path's burner is the dead address.
  if (burner && burner !== DEAD_ADDRESS) {
    await context.db
      .insert(schema.burner)
      .values({ id: burner, token, lastSwapTx: null, lastSwapWeth: 0n, burnedTotal: 0n })
      .onConflictDoNothing();
  }
  await getPlatformConfig(context);
  await bumpDaily(context, ts, { launches: 1 });
  await bumpPlatform(context, ts, { tokens: 1, agentsTotal: 1 });
  await bumpSource(context, r.source, ts, { tokens: 1 });
}

/**
 * Replay the launch tx's earlier logs: coin transfers (holders), the USDC fuel transfer, the dev buy's swap and
 * (Bootr path) the hook fee it paid. They precede `AgentLaunched` and therefore the token / pool rows, so the
 * live handlers skip the launch tx and this does their work.
 */
async function replayLaunchTx(
  context: Ctx,
  event: LaunchEvent,
  logs: Log<bigint, number, false>[],
  pool: { id: Hex },
  feeHook: Address | null,
  v5Hook: Address | null = null,
) {
  const env = indexerEnv();
  const a = event.args;
  const token = lc(a.token);
  const kernel = lc(a.kernel);
  const ts = Number(event.block.timestamp);
  const usdc = lc(env.addresses.usdc);
  const poolManager = lc(env.addresses.uniswap.poolManager);
  let fuelIn = 0n;
  for (const l of logs) {
    const addr = lc(l.address);
    if (addr === token) {
      const ev = tryDecode(Erc20Abi, l);
      if (ev?.eventName === 'Transfer') {
        await applyTransfer(context, token, ev.args.from as Address, ev.args.to as Address, ev.args.value as bigint, ts, event.transaction.hash);
      }
    } else if (addr === usdc) {
      const ev = tryDecode(Erc20Abi, l);
      if (ev?.eventName === 'Transfer' && lc(ev.args.to as string) === kernel) {
        const value = ev.args.value as bigint;
        const inserted = await context.db
          .insert(schema.fuel)
          .values({
            id: `${event.transaction.hash}-${l.logIndex}`,
            from: lc(ev.args.from as Address),
            kernel,
            token,
            amount: value,
            amountUsd: usd(toUnits(value, 6)),
            timestamp: ts,
            blockNumber: event.block.number,
            txHash: event.transaction.hash,
          })
          .onConflictDoNothing();
        if (inserted) fuelIn += value;
      }
    } else if (feeHook && addr === feeHook) {
      const ev = tryDecode(RwagmiHookV3Abi, l);
      if (ev?.eventName === 'PoolFeeTakenV3' && lc(ev.args.poolId as Hex) === pool.id) {
        const row = (await context.db.find(schema.token, { id: token }))!;
        await applyFeeTaken(context, row, ev.args.quote as Address, ev.args.amount as bigint, {
          txHash: event.transaction.hash,
          logIndex: l.logIndex,
          blockNumber: event.block.number,
          timestamp: ts,
        });
      }
    } else if (v5Hook && addr === lc(v5Hook)) {
      // Clanker v5: the dev buy's tax credits (one per fee slot in the quote, the burn in the coin).
      const ev = tryDecode(ClankerV5HookAbi, l);
      if ((ev?.eventName === 'CreatorTaxCredited' || ev?.eventName === 'BurnTaxCredited') && lc(ev.args.poolId as Hex) === pool.id) {
        const row = (await context.db.find(schema.token, { id: token }))!;
        const burn = ev.eventName === 'BurnTaxCredited';
        await applyClankerV5TaxCredit(
          context,
          row,
          pool.id,
          {
            burn,
            recipient: (burn ? ev.args.sink : ev.args.recipient) as Address,
            asset: (burn ? ev.args.token : ev.args.currency) as Address,
            amount: ev.args.amount as bigint,
          },
          { txHash: event.transaction.hash, logIndex: l.logIndex, blockNumber: event.block.number, timestamp: ts },
        );
      }
    } else if (addr === poolManager && l.topics[1] && lc(l.topics[1]) === pool.id) {
      const ev = tryDecode(PoolManagerAbi, l);
      if (ev?.eventName === 'Swap') {
        const row = (await context.db.find(schema.token, { id: token }))!;
        await applySwap(
          context,
          row,
          {
            amount0: ev.args.amount0 as bigint,
            amount1: ev.args.amount1 as bigint,
            sqrtPriceX96: ev.args.sqrtPriceX96 as bigint,
            liquidity: ev.args.liquidity as bigint,
            tick: Number(ev.args.tick),
            fee: Number(ev.args.fee),
            sender: ev.args.sender as Address,
          },
          {
            txHash: event.transaction.hash,
            logIndex: l.logIndex,
            blockNumber: event.block.number,
            timestamp: ts,
            from: event.transaction.from,
          },
        );
      }
    }
  }
  if (fuelIn > 0n) {
    await context.db.update(schema.agent, { id: kernel }).set({ fuelReceivedUsdc: fuelIn, treasuryUsdc: fuelIn });
  }
}

// ------------------------------------------------------------------ Bootr path: AgentLaunched

if (enabledSources().BootrLauncher) {
  ponder.on('BootrLauncher:AgentLaunched', async ({ event, context }) => {
    const env = indexerEnv();
    const a = event.args;
    const token = lc(a.token);
    const kernel = lc(a.kernel);
    const creator = lc(a.creator);
    const burner = a.burner === ZERO_ADDRESS ? null : lc(a.burner);
    const platformRecipient = lc(a.defaults.platformRecipient);
    const d = a.defaults;

    // The launch tx receipt carries the RWAGMI launch (B20LaunchCreatedV3, LaunchPoolCreatedV3,
    // LiquidityPlacedV3), the dev buy (PoolFeeTakenV3 + Swap) and the initial transfers, all emitted
    // before AgentLaunched.
    const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
    const logs = receipt.logs.filter((l) => l.logIndex < event.log.logIndex);
    const meta = { txHash: event.transaction.hash, blockNumber: event.block.number };

    // The B20LaunchCreatedV3 / LaunchPoolCreatedV3 handlers normally staged the launch already; replay
    // them from the receipt if not (e.g. the RWAGMI sources start later than this launch).
    let launch = await context.db.find(schema.rwagmiLaunch, { id: token });
    if (!launch) {
      const rwagmiLauncher = lc(env.rwagmi!.launcher);
      for (const l of logs) {
        if (lc(l.address) !== rwagmiLauncher) continue;
        const ev = tryDecode(RwagmiLauncherV3Abi, l);
        if (ev?.eventName === 'B20LaunchCreatedV3' && lc(ev.args.token as string) === token) {
          await stageLaunch(context, ev.args as unknown as LaunchArgs, meta);
        } else if (ev?.eventName === 'LaunchPoolCreatedV3') {
          await stagePool(context, ev.args as unknown as PoolArgs, meta);
        }
      }
      launch = await context.db.find(schema.rwagmiLaunch, { id: token });
    }
    const pool = launch ? await context.db.find(schema.pool, { id: launch.primaryPoolId }) : null;
    if (!launch || !pool) {
      console.warn(`[indexer] AgentLaunched ${token} (${event.transaction.hash}): no RWAGMI v3 launch/pool found; skipping`);
      return;
    }

    // Exact LP position from the locker (one position per Bootr pool).
    let tickLower = pool.tickLower;
    let tickUpper = pool.tickUpper;
    let positionLiquidity = 0n;
    for (const l of logs) {
      if (lc(l.address) !== launch.locker) continue;
      const ev = tryDecode(RwagmiLpLockerV3Abi, l);
      if (ev?.eventName !== 'LiquidityPlacedV3' || lc(ev.args.poolId as Hex) !== pool.id) continue;
      if (positionLiquidity === 0n) {
        tickLower = Number(ev.args.tickLower);
        tickUpper = Number(ev.args.tickUpper);
      }
      positionLiquidity += ev.args.liquidity as bigint;
    }
    if (positionLiquidity === 0n) {
      positionLiquidity = oneSidedLiquidity(pool.depositedSupply, tickLower, tickUpper, pool.coinIsToken0);
    }

    // Locked reward slots (recipients + bps, RWAGMI's slot last).
    let rewards: RewardSlot[] = [];
    try {
      const info = await context.client.readContract({
        abi: RwagmiLpLockerV3Abi,
        address: launch.locker,
        functionName: 'launchInfo',
        args: [a.token],
      });
      rewards = info.rewards.map((r) => ({ admin: lc(r.admin), recipient: lc(r.recipient), bps: Number(r.bps) }));
    } catch (err) {
      console.warn(`[indexer] launchInfo(${token}) failed, using the AgentLaunched defaults: ${safeMessage(err)}`);
    }
    if (rewards.length === 0) rewards = defaultSlots(a, event.log.address, burner);
    const kinds = classifySlots(rewards, { kernel, creator, burner, platformRecipient }, 'bootr');
    const bps = bpsByKind(rewards, kinds);
    const protocolSlot = rewards.find((_, i) => kinds[i] === 'protocol');

    const { image, metadata } = await launchMetadata(event.log.address, event.transaction, async () => {
      const uri = await context.client.readContract({ abi: B20TokenAbi, address: a.token, functionName: 'contractURI' }).catch(() => '');
      return { image: imageFromUri(uri), metadata: uri };
    });

    await insertLaunch(context, event, {
      source: 'bootr',
      name: launch.name,
      symbol: launch.symbol,
      image,
      metadata,
      pool: { id: pool.id, pairedToken: pool.pairedToken, coinIsToken0: pool.coinIsToken0, startingTick: pool.startingTick, tickLower, tickUpper },
      // Per token: the pool's static hook fee, else the launch defaults, else 1%.
      lpFeeBps: (pool.feeMode === 0 && pool.staticFee > 0 ? pool.staticFee : d.lpFeeBps) || DEFAULT_LP_FEE_BPS,
      totalSupply: launch.totalSupply,
      positionLiquidity,
      rewards,
      kinds,
      protocolBps: bps.protocol,
      protocolRecipient: protocolSlot?.recipient ?? null,
    });
    await context.db.update(schema.pool, { id: pool.id }).set({ tickLower, tickUpper });
    await replayLaunchTx(context, event, logs, pool, launch.hook);
  });
}

// ------------------------------------------------------------------ Clanker path: AgentLaunched

if (enabledSources().BootrClankerLauncher) {
  ponder.on('BootrClankerLauncher:AgentLaunched', async ({ event, context }) => {
    const env = indexerEnv();
    const a = event.args;
    const token = lc(a.token);
    const kernel = lc(a.kernel);
    const creator = lc(a.creator);
    const burner = a.burner === ZERO_ADDRESS ? null : lc(a.burner);
    const platformRecipient = lc(a.defaults.platformRecipient);
    const weth = lc(env.addresses.weth);
    const d = a.defaults;
    const meta = { txHash: event.transaction.hash, blockNumber: event.block.number };

    // The launch tx receipt carries Clanker's TokenCreated (name, symbol, image, metadata, context, pool id), the
    // locker's TokenRewardAdded (pool key, slots, position range), the wrapper's ClankerLaunched, the dev-buy swap
    // and the initial transfers.
    const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
    const launcher = lc(event.log.address);
    // One source follows every Clanker launcher: a v5 wrapper's receipt carries `ClankerV5Launched`.
    const v5 = clankerV5LaunchFacts(receipt.logs, {
      token: a.token,
      launcher,
      poolManager: env.addresses.uniswap.poolManager,
      factory: env.clankerV5?.factory ?? null,
    });
    if (v5.launched) {
      await launchClankerV5(context, event, receipt.logs, { ...v5, launched: v5.launched });
      return;
    }
    const clanker = env.clanker;
    if (!clanker) {
      console.warn(`[indexer] AgentLaunched ${token} (${event.transaction.hash}) on the Clanker path: no ClankerV5Launched and no Clanker v4 stack; skipping`);
      return;
    }
    let created: { name: string; symbol: string; image: string; metadata: string; context: string; extensionsSupply: bigint } | null = null;
    let launched: ClankerLaunchedArgs | null = null;
    let info: ClankerRewardInfo | null = null;
    for (const l of receipt.logs) {
      const addr = lc(l.address);
      if (addr === lc(clanker.factory)) {
        const ev = tryDecode(ClankerAbi, l);
        if (ev?.eventName === 'TokenCreated' && lc(ev.args.tokenAddress as string) === token) {
          created = {
            name: ev.args.tokenName as string,
            symbol: ev.args.tokenSymbol as string,
            image: ev.args.tokenImage as string,
            metadata: ev.args.tokenMetadata as string,
            context: ev.args.tokenContext as string,
            extensionsSupply: (ev.args.extensionsSupply as bigint | undefined) ?? 0n,
          };
        }
      } else if (addr === launcher) {
        const ev = tryDecode(BootrClankerLauncherAbi, l);
        if (ev?.eventName === 'ClankerLaunched' && lc(ev.args.token as string) === token) launched = ev.args as unknown as ClankerLaunchedArgs;
      } else if (addr === lc(clanker.locker)) {
        const ev = tryDecode(ClankerLpLockerFeeConversionAbi, l);
        if (ev?.eventName === 'TokenRewardAdded' && lc(ev.args.token as string) === token) info = ev.args as unknown as ClankerRewardInfo;
      }
    }
    if (launched) await stageClankerLaunch(context, launched, meta, created ? { context: created.context, extensionsSupply: created.extensionsSupply } : null);
    const staged = await context.db.find(schema.clankerPool, { id: token });
    if (!staged) {
      console.warn(`[indexer] AgentLaunched ${token} (${event.transaction.hash}) on the Clanker path: no ClankerLaunched found; skipping`);
      return;
    }

    // Name / symbol / image / metadata: TokenCreated, else the token's own views.
    const read = <T>(fn: 'name' | 'symbol' | 'imageUrl' | 'metadata' | 'totalSupply', fallback: T) =>
      context.client.readContract({ abi: ClankerTokenAbi, address: a.token, functionName: fn }).catch(() => fallback) as Promise<T>;
    const name = created?.name ?? (await read('name', ''));
    const symbol = created?.symbol ?? (await read('symbol', ''));
    const { image, metadata } = await launchMetadata(event.log.address, event.transaction, async () => ({
      image: created?.image ?? (await read('imageUrl', '')),
      metadata: created?.metadata ?? (await read('metadata', '')),
    }));
    const totalSupply = await read('totalSupply', CLANKER_TOKEN_SUPPLY);

    // Reward slots: TokenRewardAdded (same receipt), else `tokenRewards(token)`, else the launch defaults.
    if (!info) {
      try {
        const r = await context.client.readContract({ abi: ClankerLpLockerFeeConversionAbi, address: clanker.locker, functionName: 'tokenRewards', args: [a.token] });
        info = { poolKey: r.poolKey, rewardBps: r.rewardBps.map(Number), rewardAdmins: r.rewardAdmins, rewardRecipients: r.rewardRecipients };
      } catch (err) {
        console.warn(`[indexer] tokenRewards(${token}) failed, using the AgentLaunched defaults: ${safeMessage(err)}`);
      }
    }
    // Without locker data the defaults apply; the burn slot (when the preset has one) is the dead address.
    const rewards = info ? clankerSlots(info) : defaultSlots(a, event.log.address, burner);
    const kinds = classifySlots(rewards, { kernel, creator, burner, platformRecipient }, 'clanker');

    // Pool row from the pool key (TokenRewardAdded / tokenRewards), else the key Clanker builds for WETH pairs.
    const key = info?.poolKey ?? clankerPoolKey(a.token, env.addresses.weth, staged.hook as Address);
    const coinIsToken0 = lc(key.currency0) === token;
    const { tickLower, tickUpper } = clankerPositionTicks(info, coinIsToken0, staged.startingTick);
    const startingTick = coinIsToken0 ? staged.startingTick : -staged.startingTick;
    const depositedSupply = info?.poolSupply ?? totalSupply - staged.extensionsSupply;
    const lpFeeBps = staged.lpFeeBps || d.lpFeeBps || DEFAULT_LP_FEE_BPS;
    await context.db
      .insert(schema.pool)
      .values({
        id: staged.poolId,
        token,
        coinIsToken0,
        tickLower,
        tickUpper,
        currency0: lc(key.currency0),
        currency1: lc(key.currency1),
        fee: Number(key.fee),
        tickSpacing: Number(key.tickSpacing),
        hooks: lc(key.hooks),
        pairedToken: coinIsToken0 ? lc(key.currency1) : lc(key.currency0),
        poolIndex: 0,
        feeMode: 0,
        staticFee: lpFeeBps,
        startingTick,
        depositedSupply,
        launchTx: event.transaction.hash,
      })
      .onConflictDoNothing();
    const pairedToken = coinIsToken0 ? lc(key.currency1) : lc(key.currency0);
    if (pairedToken !== weth) console.warn(`[indexer] Clanker coin ${token} is paired with ${pairedToken}, not WETH; USD figures assume WETH`);

    await insertLaunch(context, event, {
      source: 'clanker',
      name,
      symbol,
      image,
      metadata,
      pool: { id: staged.poolId, pairedToken, coinIsToken0, startingTick, tickLower, tickUpper },
      lpFeeBps,
      totalSupply,
      positionLiquidity: oneSidedLiquidity(depositedSupply, tickLower, tickUpper, coinIsToken0),
      rewards,
      kinds,
      protocolBps: CLANKER_PROTOCOL_BPS,
      protocolRecipient: null,
    });
    await replayLaunchTx(context, event, receipt.logs.filter((l) => l.logIndex < event.log.logIndex), { id: staged.poolId }, null);
  });
}

// ------------------------------------------------------------------ Clanker v5: AgentLaunched

/**
 * A `BootrClankerLauncherV5` launch (docs/design/clanker-v5-migration.md section 6). The receipt carries the
 * wrapper's `ClankerV5Launched` (pool id, hook, escrow, quote, tick spacing, tax), the hook's `FeeSlotCreated` per
 * paid slot, the factory's `LaunchTaxConfigured` (the admitted policy and the burn share) and `Launched` (supply),
 * the PoolManager's `Initialize` (opening tick) and `ModifyLiquidity` (the seeded band), the dev buy's swap and tax
 * credits, the transfers and the fuel. Token rows: `source 'clanker-v5'`, `lpFeeBps` = the tax, `protocolBps` =
 * Clanker's share of it, the slot kinds share the rest; `pairedToken` the quote (native ETH = `0x0`).
 */
async function launchClankerV5(
  context: Ctx,
  event: LaunchEvent,
  logs: Log<bigint, number, false>[],
  facts: ReturnType<typeof clankerV5LaunchFacts> & { launched: ClankerV5LaunchedArgs },
) {
  const a = event.args;
  const token = lc(a.token);
  const kernel = lc(a.kernel);
  const creator = lc(a.creator);
  const platformRecipient = lc(a.defaults.platformRecipient);
  const launched = facts.launched;
  const meta = { txHash: event.transaction.hash, blockNumber: event.block.number };

  // Slots: FeeSlotCreated (same receipt), else the hook's `poolFeeSlots(poolId)`, else the preset's weights.
  let slots: ClankerV5HookSlot[] = facts.slots;
  if (slots.length === 0) {
    try {
      const r = await context.client.readContract({ abi: ClankerV5HookAbi, address: launched.hook, functionName: 'poolFeeSlots', args: [launched.poolId] });
      slots = r.map((x, slot) => ({ slot, recipient: lc(x.recipient), admin: lc(x.admin), weightBps: Number(x.weightBps) }));
    } catch (err) {
      console.warn(`[indexer] poolFeeSlots(${launched.poolId}) failed, using the preset's weights: ${safeMessage(err)}`);
    }
  }
  const taxBps = launched.taxBps || a.defaults.lpFeeBps || DEFAULT_LP_FEE_BPS;
  const { rewards, protocolBps } = clankerV5Slots(
    { ...facts, slots },
    { launcher: event.log.address, kernel, creator, taxBps, defaults: a.defaults },
  );
  // The paid slots are [kernel, creator, platform] by construction; the burn slot (if any) is the dead address.
  const kinds: (SlotKind | null)[] = [
    ...classifySlots(rewards.slice(0, slots.length || 3), { kernel, creator, burner: null, platformRecipient }, 'clanker-v5'),
    ...rewards.slice(slots.length || 3).map((r) => (r.recipient === DEAD_ADDRESS ? ('burn' as const) : null)),
  ];

  const key = clankerV5PoolKey(a.token, launched.quoteToken, launched.hook, launched.tickSpacing);
  const coinIsToken0 = lc(key.currency0) === token;
  const pairedToken = coinIsToken0 ? lc(key.currency1) : lc(key.currency0);
  if (pairedToken !== ZERO_ADDRESS) console.warn(`[indexer] Clanker v5 coin ${token} is paired with ${pairedToken}, not native ETH; USD figures assume an 18-decimal ETH quote`);
  // Clanker's native start tick (-201000 in the coin-as-token0 frame) when the receipt has no Initialize.
  const startingTick = facts.startingTick ?? (coinIsToken0 ? -201_000 : 201_000);
  const { tickLower, tickUpper } = facts.position ?? clankerV5PositionTicks(startingTick, coinIsToken0, launched.tickSpacing);

  const read = <T>(fn: 'name' | 'symbol' | 'contractURI' | 'totalSupply', fallback: T) =>
    context.client.readContract({ abi: B20TokenAbi, address: a.token, functionName: fn as never }).catch(() => fallback) as Promise<T>;
  const totalSupply = facts.launchSupply ?? (await read('totalSupply', CLANKER_V5_SUPPLY));
  const name = await read('name', '');
  const symbol = await read('symbol', '');
  const { image, metadata } = await launchMetadata(event.log.address, event.transaction, async () => {
    const uri = await read('contractURI', '');
    return { image: imageFromUri(uri), metadata: uri };
  });
  const positionLiquidity = facts.position?.liquidity || oneSidedLiquidity(totalSupply, tickLower, tickUpper, coinIsToken0);

  await context.db
    .insert(schema.clankerPool)
    .values({
      id: token,
      version: 5,
      poolId: launched.poolId,
      hook: launched.hook,
      locker: launched.feeEscrow,
      mevModule: ZERO_ADDRESS,
      antiSnipe: launched.antiSnipe,
      startingTick,
      lpFeeBps: taxBps,
      context: '',
      extensionsSupply: 0n,
      launchTx: meta.txHash,
      blockNumber: meta.blockNumber,
    })
    .onConflictDoNothing();
  await context.db
    .insert(schema.pool)
    .values({
      id: launched.poolId,
      token,
      coinIsToken0,
      tickLower,
      tickUpper,
      currency0: key.currency0,
      currency1: key.currency1,
      fee: 0,
      tickSpacing: launched.tickSpacing,
      hooks: key.hooks,
      pairedToken,
      poolIndex: 0,
      feeMode: 0,
      staticFee: taxBps,
      startingTick,
      depositedSupply: totalSupply,
      launchTx: meta.txHash,
    })
    .onConflictDoNothing();

  await insertLaunch(context, event, {
    source: 'clanker-v5',
    name,
    symbol,
    image,
    metadata,
    pool: { id: launched.poolId, pairedToken, coinIsToken0, startingTick, tickLower, tickUpper },
    lpFeeBps: taxBps,
    totalSupply,
    positionLiquidity,
    rewards,
    kinds,
    protocolBps,
    protocolRecipient: null,
  });
  await replayLaunchTx(
    context,
    event,
    logs.filter((l) => l.logIndex < event.log.logIndex),
    { id: launched.poolId },
    null,
    launched.hook,
  );
}
