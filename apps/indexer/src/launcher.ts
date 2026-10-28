import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import { decodeEventLog, decodeFunctionData, type Address, type Hex, type Log } from 'viem';

import { B20TokenAbi } from '../abis/B20Token';
import { BootrLauncherAbi } from '../abis/BootrLauncher';
import { Erc20Abi } from '../abis/Erc20';
import { PoolManagerAbi } from '../abis/PoolManager';
import { RwagmiHookV3Abi } from '../abis/RwagmiHookV3';
import { RwagmiLauncherV3Abi } from '../abis/RwagmiLauncherV3';
import { RwagmiLpLockerV3Abi } from '../abis/RwagmiLpLockerV3';
import { enabledSources, indexerEnv } from './lib/env';
import { bpsByKind, classifySlots, type RewardSlot } from './lib/fees';
import { applyFeeTaken } from './lib/ledger';
import { applySwap, applyTransfer } from './lib/market';
import { imageFromUri } from './lib/metadata';
import { positionTicks } from './lib/pool';
import { oneSidedLiquidity, toUnits, usd } from './lib/price';
import { bumpDaily, bumpPlatform, getPlatformConfig, lc, ZERO_ADDRESS, type Ctx } from './lib/store';

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

/** `LaunchParams.image` / `.metadata` from the launch calldata, else the B20 `contractURI()`. */
async function launchMetadata(context: Ctx, token: Address, launcher: Address, tx: { to: Address | null; input?: Hex }) {
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
  const uri = await context.client
    .readContract({ abi: B20TokenAbi, address: token, functionName: 'contractURI' })
    .catch(() => '');
  return { image: imageFromUri(uri), metadata: uri };
}

if (enabledSources().BootrLauncher) {
  ponder.on('BootrLauncher:AgentLaunched', async ({ event, context }) => {
    const env = indexerEnv();
    const a = event.args;
    const token = lc(a.token);
    const kernel = lc(a.kernel);
    const creator = lc(a.creator);
    const burner = a.burner === ZERO_ADDRESS ? null : lc(a.burner);
    const platformRecipient = lc(a.defaults.platformRecipient);
    const ts = Number(event.block.timestamp);
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
      console.warn(`[indexer] launchInfo(${token}) failed, using the AgentLaunched defaults: ${(err as Error).message}`);
    }
    if (rewards.length === 0) {
      const admin = lc(event.log.address);
      rewards = [
        { admin, recipient: kernel, bps: d.agentBps },
        { admin, recipient: creator, bps: d.creatorBps },
        ...(burner ? [{ admin, recipient: burner, bps: d.burnBps }] : []),
        { admin, recipient: platformRecipient, bps: d.platformBps },
      ];
    }
    const parties = { kernel, creator, burner, platformRecipient };
    const kinds = classifySlots(rewards, parties);
    const bps = bpsByKind(rewards, kinds);
    const protocolSlot = rewards.find((_, i) => kinds[i] === 'protocol');

    const { image, metadata } = await launchMetadata(context, a.token, event.log.address, event.transaction);
    const startTick = pool.startingTick;
    const startSqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** startTick) * 2 ** 96));

    await context.db.insert(schema.token).values({
      id: token,
      chainId: context.chain.id,
      name: launch.name,
      symbol: launch.symbol,
      image,
      metadata,
      creator,
      kernel,
      burner,
      agentId: a.agentId,
      poolId: pool.id,
      pairedToken: pool.pairedToken,
      coinIsToken0: pool.coinIsToken0,
      lpFeeBps: pool.feeMode === 0 && pool.staticFee > 0 ? pool.staticFee : d.lpFeeBps,
      agentBps: bps.agent,
      creatorBps: bps.creator,
      burnBps: bps.burn,
      platformBps: bps.platform,
      protocolBps: bps.protocol,
      protocolRecipient: protocolSlot?.recipient ?? null,
      platformRecipient,
      workerHash: a.workerHash,
      model: a.model,
      agentUri: a.agentURI,
      supervisorSessionKey: lc(a.supervisorSessionKey),
      xHandle: null,
      launchedAt: ts,
      launchBlock: event.block.number,
      launchTx: event.transaction.hash,
      totalSupply: launch.totalSupply,
      sqrtPriceX96: startSqrt,
      tick: startTick,
      poolLiquidity: 0n,
      positionLiquidity,
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
    await context.db.update(schema.pool, { id: pool.id }).set({ tickLower, tickUpper });
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
    for (let i = 0; i < rewards.length; i++) {
      const r = rewards[i]!;
      const kind = kinds[i];
      if (!kind) continue;
      await context.db.insert(schema.feeSlot).values({
        id: `${token}-${i}`,
        token,
        slot: i,
        recipient: r.recipient,
        admin: r.admin,
        bps: r.bps,
        recipientKind: kind,
      });
      if (kind !== 'protocol') {
        await context.db.insert(schema.feeRecipient).values({ id: r.recipient, firstToken: token }).onConflictDoNothing();
      }
    }
    if (burner) {
      await context.db
        .insert(schema.burner)
        .values({ id: burner, token, lastSwapTx: null, lastSwapWeth: 0n, burnedTotal: 0n })
        .onConflictDoNothing();
    }

    // Replay the launch tx: transfers (holders, fuel), the dev buy's fee and swap.
    const usdc = lc(env.addresses.usdc);
    const poolManager = lc(env.addresses.uniswap.poolManager);
    let fuelIn = 0n;
    for (const l of logs) {
      const addr = lc(l.address);
      if (addr === token) {
        const ev = tryDecode(Erc20Abi, l);
        if (ev?.eventName === 'Transfer') {
          await applyTransfer(context, token, ev.args.from as Address, ev.args.to as Address, ev.args.value as bigint, ts);
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
      } else if (addr === launch.hook) {
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

    await getPlatformConfig(context);
    await bumpDaily(context, ts, { launches: 1 });
    await bumpPlatform(context, ts, { tokens: 1, agentsTotal: 1 });
  });
}
