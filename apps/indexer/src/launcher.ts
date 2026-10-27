import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import { decodeEventLog, getAddress, type Address, type Hex, type Log } from 'viem';

import { BootrLauncherAbi } from '../abis/BootrLauncher';
import { ClankerAbi } from '../abis/Clanker';
import { ClankerTokenAbi } from '../abis/ClankerToken';
import { Erc20Abi } from '../abis/Erc20';
import { PoolManagerAbi } from '../abis/PoolManager';
import { enabledSources, indexerEnv } from './lib/env';
import { applySwap, applyTransfer } from './lib/market';
import { isCoinToken0, poolIdOf, poolKeyFor, positionTicks, STARTING_TICK } from './lib/pool';
import { oneSidedLiquidity, toUnits, usd } from './lib/price';
import { bumpDaily, bumpPlatform, getPlatformConfig, lc, ZERO_ADDRESS } from './lib/store';

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

if (enabledSources().BootrLauncher) {
  ponder.on('BootrLauncher:AgentLaunched', async ({ event, context }) => {
    const env = indexerEnv();
    const a = event.args;
    const token = lc(a.token);
    const kernel = lc(a.kernel);
    const creator = lc(a.creator);
    const burner = a.burner === ZERO_ADDRESS ? null : lc(a.burner);
    const weth = lc(env.addresses.weth);
    const ts = Number(event.block.timestamp);
    const d = a.defaults;

    // The launch tx receipt carries Clanker's TokenCreated (metadata, pool id), the dev-buy swap
    // and the initial transfers, all emitted before AgentLaunched.
    const receipt = await context.client.getTransactionReceipt({ hash: event.transaction.hash });
    const logs = receipt.logs.filter((l) => l.logIndex < event.log.logIndex);

    let meta: { name: string; symbol: string; image: string; metadata: string; poolId: Hex; extensionsSupply: bigint } | null = null;
    for (const l of logs) {
      if (lc(l.address) !== lc(env.addresses.clanker)) continue;
      const ev = tryDecode(ClankerAbi, l);
      if (ev?.eventName === 'TokenCreated' && lc(ev.args.tokenAddress as string) === token) {
        meta = {
          name: ev.args.tokenName as string,
          symbol: ev.args.tokenSymbol as string,
          image: ev.args.tokenImage as string,
          metadata: ev.args.tokenMetadata as string,
          poolId: lc(ev.args.poolId as Hex),
          extensionsSupply: (ev.args.extensionsSupply as bigint | undefined) ?? 0n,
        };
      }
    }
    if (!meta) {
      const [name, symbol, image] = await Promise.all([
        context.client.readContract({ abi: ClankerTokenAbi, address: a.token, functionName: 'name' }),
        context.client.readContract({ abi: ClankerTokenAbi, address: a.token, functionName: 'symbol' }),
        context.client.readContract({ abi: ClankerTokenAbi, address: a.token, functionName: 'imageUrl' }).catch(() => ''),
      ]);
      const hook = await context.client.readContract({
        abi: BootrLauncherAbi,
        address: event.log.address,
        functionName: 'staticHook',
      });
      meta = {
        name,
        symbol,
        image,
        metadata: '',
        poolId: lc(poolIdOf(poolKeyFor(a.token, getAddress(weth), hook))),
        extensionsSupply: 0n,
      };
    }

    const totalSupply = await context.client.readContract({
      abi: ClankerTokenAbi,
      address: a.token,
      functionName: 'totalSupply',
    });
    const coinIsToken0 = isCoinToken0(a.token, getAddress(weth));
    const { tickLower, tickUpper } = positionTicks(coinIsToken0);
    const startTick = coinIsToken0 ? STARTING_TICK : -STARTING_TICK;
    const startSqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** startTick) * 2 ** 96));
    const positionLiquidity = oneSidedLiquidity(totalSupply - meta.extensionsSupply, tickLower, tickUpper, coinIsToken0);

    await context.db.insert(schema.token).values({
      id: token,
      chainId: context.chain.id,
      name: meta.name,
      symbol: meta.symbol,
      image: meta.image,
      metadata: meta.metadata,
      creator,
      kernel,
      burner,
      agentId: a.agentId,
      poolId: meta.poolId,
      pairedToken: weth,
      coinIsToken0,
      lpFeeBps: d.lpFeeBps,
      agentBps: d.agentBps,
      creatorBps: d.creatorBps,
      burnBps: d.burnBps,
      platformBps: d.platformBps,
      platformRecipient: lc(d.platformRecipient),
      workerHash: a.workerHash,
      model: a.model,
      agentUri: a.agentURI,
      supervisorSessionKey: lc(a.supervisorSessionKey),
      xHandle: null,
      launchedAt: ts,
      launchBlock: event.block.number,
      launchTx: event.transaction.hash,
      totalSupply,
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
    await context.db.insert(schema.pool).values({ id: meta.poolId, token, coinIsToken0, tickLower, tickUpper });
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
    for (const r of [kernel, creator, burner, lc(d.platformRecipient)]) {
      if (r) await context.db.insert(schema.feeRecipient).values({ id: r, firstToken: token }).onConflictDoNothing();
    }
    if (burner) {
      await context.db
        .insert(schema.burner)
        .values({ id: burner, token, lastSwapTx: null, lastSwapWeth: 0n, burnedTotal: 0n })
        .onConflictDoNothing();
    }

    // Replay the launch tx: transfers (holders, fuel) and the dev-buy swap.
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
      } else if (addr === poolManager && l.topics[1] && lc(l.topics[1]) === meta.poolId) {
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
