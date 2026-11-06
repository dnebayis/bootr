/**
 * Real buys and sells on a Base mainnet fork, with the exact calldata the panel sends, for a real Clanker coin ($BOOTR)
 * and a real RWAGMI coin (OWL). Skipped unless SWAP_FORK_RPC points at a fork. RWAGMI coins are B20 tokens, so the fork
 * has to be `base-anvil`:
 *
 *   base-anvil --fork-url <Base RPC> --port 8646
 *   SWAP_FORK_RPC=http://127.0.0.1:8646 pnpm --filter web exec vitest run lib/swap/swap.fork.test.ts --testTimeout=120000
 *
 * The launch fee tests mine each block themselves, at Base's five blocks a second with five in a row on one timestamp, so
 * this fork runs without `--block-time`.
 *
 * What a base-anvil fork proves for Denim (base-anvil 1.6.0-v1.1.0, built 2026-06-15, before Denim went live; measured
 * 2026-11-06): with `--block-time 0.2` it mines five blocks a second, and about five in a row share one whole-second
 * timestamp, as on Base; `evm_setNextBlockTimestamp` may repeat a timestamp, so a test can place a block exactly. The contracts
 * and state are the real ones at the fork block. It does not prove Denim's own rules: no BaseTime predeploy, no millisecond RPC
 * timestamps (`timestampMs`), no sequencer ordering or real base fee under load, and Denim's B20 changes (transfers to a
 * token's own address, transfer executor policy) may be missing from a build this old. Test those on Base itself.
 *
 * Only anvil's own test key signs here. Nothing reaches a live chain.
 */
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, formatEther, http, keccak256, parseEther, toHex, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import * as Attribution from 'ox/erc8021/Attribution';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clankerLauncherAbi } from '../abi/launcher';
import { approvalCalls, buildBuyTx, buildSellTx, idealOut, launchWindowActive, minReceived, permit2Abi, poolIdOf, shortfallPct, SWAP_CONTRACTS, verifiedPoolKey, zeroForOne, type PoolKey, type SwapSide, type SwapTx } from './core';
import { classifySwapError } from './errors';
import { quoteSwap, stateViewAbi } from './quote';

const RPC = process.env.SWAP_FORK_RPC ?? '';

const COINS = [
  {
    name: '$BOOTR (Clanker)',
    token: '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c' as Address,
    source: 'clanker' as const,
    poolId: null as string | null,
    nominalFeePct: 2.4,
  },
  {
    name: 'OWL (RWAGMI)',
    token: '0xb2000000000000000000004481c175669cbc8edb' as Address,
    source: 'bootr' as const,
    poolId: null as string | null,
    nominalFeePct: 1,
  },
];

// anvil's first default account: a public test key.
const account = privateKeyToAccount('0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80');
const dataSuffix = Attribution.toDataSuffix({ codes: ['bc_bootrtest'] });

// Unique per run: the factory refuses a salt twice and a fork can outlive a test run.
const launchArgs = (salt: string) => ({
  name: 'Fork Coin',
  symbol: 'FORK',
  image: 'https://bootr.fun/x.png',
  metadata: '{}',
  context: '{}',
  salt: keccak256(toHex(`${salt}-${Date.now()}`)),
  buybackBurn: false,
  fuelUsdc: 0n,
  devBuyWei: 0n,
  workerHash: `0x${'01'.repeat(32)}` as Hex,
  model: 'x',
  agentURI: 'https://bootr.fun/x.json',
  supervisorSessionKey: account.address,
});

describe.skipIf(!RPC)('swap on a Base fork', () => {
  const chain = { ...base, rpcUrls: { default: { http: [RPC] } } };
  const client = createPublicClient({ chain, transport: http(RPC || 'http://127.0.0.1:8646') });
  const wallet = createWalletClient({ account, chain, transport: http(RPC || 'http://127.0.0.1:8646') });
  const test = createTestClient({ chain, mode: 'anvil', transport: http(RPC || 'http://127.0.0.1:8646') });

  const now = async () => Number((await client.getBlock()).timestamp);
  const deadlineAfter = async (seconds: number) => BigInt((await now()) + seconds);
  const send = async (tx: SwapTx): Promise<Hash> => {
    const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return hash;
  };
  const coinBalance = (token: Address) => client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [account.address] });
  const quote = (key: PoolKey, side: SwapSide, amountIn: bigint) => quoteSwap(client, { key, side, amountIn });
  const allowancesOf = async (token: Address) => {
    const [tokenAllowance, permit2] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [account.address, SWAP_CONTRACTS.permit2] }),
      client.readContract({ address: SWAP_CONTRACTS.permit2, abi: permit2Abi, functionName: 'allowance', args: [account.address, token, SWAP_CONTRACTS.universalRouter] }),
    ]);
    return { token: tokenAllowance, permit2Amount: permit2[0], permit2Expiration: permit2[1] };
  };
  const expectRevert = async (tx: SwapTx) => {
    const err = await client.call({ account: account.address, to: tx.to, data: tx.data, value: tx.value }).then(() => null, (e: unknown) => e);
    expect(err, 'the transaction should revert').not.toBeNull();
    return err;
  };

  beforeAll(async () => {
    await test.setBalance({ address: account.address, value: parseEther('100') });
    // On Base this public key has an EIP-7702 delegation to a contract that forwards any ETH it receives; on the fork it
    // is a plain wallet again.
    await test.setCode({ address: account.address, bytecode: '0x' });
    // Pool ids as the launchers state them on chain, standing in for the indexer's.
    for (const coin of COINS) {
      const launcher = (coin.source === 'clanker' ? '0x387f1B0aC128D534E822c344D829645336BDAbbB' : '0x62c038dA8A409ad1CD811df980A6F9867cd453fd') as Address;
      const onChain = await client.readContract({
        address: launcher,
        abi: [
          {
            type: 'function',
            name: 'poolKeyFor',
            stateMutability: 'view',
            inputs: [{ name: 'token', type: 'address' }],
            outputs: [
              {
                type: 'tuple',
                components: [
                  { name: 'currency0', type: 'address' },
                  { name: 'currency1', type: 'address' },
                  { name: 'fee', type: 'uint24' },
                  { name: 'tickSpacing', type: 'int24' },
                  { name: 'hooks', type: 'address' },
                ],
              },
            ],
          },
        ] as const,
        functionName: 'poolKeyFor',
        args: [coin.token],
      });
      coin.poolId = poolIdOf(onChain);
    }
  });

  beforeEach(async () => {
    // Quotes and calldata deadlines follow the fork's clock.
    await test.mine({ blocks: 1 });
  });

  describe.each(COINS)('$name', (coin) => {
    const keyOf = () => {
      const key = verifiedPoolKey(coin.token, coin.source, coin.poolId!);
      expect(key, 'pool key hashes to the launcher\'s pool id').not.toBeNull();
      return key!;
    };

    it('buys with ETH, at or above the minimum, with the builder code on the calldata', async () => {
      const key = keyOf();
      const amountIn = parseEther('0.01');
      const q = await quote(key, 'buy', amountIn);
      const minOut = minReceived(q.amountOut, 100);
      const tx = buildBuyTx({ key, coin: coin.token, amountIn, minOut, deadline: await deadlineAfter(1200), dataSuffix });
      expect(tx.data.endsWith(dataSuffix.slice(2))).toBe(true);
      const [ethBefore, coinBefore] = await Promise.all([client.getBalance({ address: account.address }), coinBalance(coin.token)]);
      const hash = await send(tx);
      const receipt = await client.getTransactionReceipt({ hash });
      const [ethAfter, coinAfter] = await Promise.all([client.getBalance({ address: account.address }), coinBalance(coin.token)]);
      const received = coinAfter - coinBefore;
      const gas = receipt.gasUsed * receipt.effectiveGasPrice;
      console.log(
        `${coin.name} buy: ${formatEther(amountIn)} ETH -> ${formatEther(received)} coin (quote ${formatEther(q.amountOut)}, min ${formatEther(minOut)}), fee ${q.feePct}%, impact ${q.impactPct}%, gas used ${receipt.gasUsed}`,
      );
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(ethBefore - ethAfter - gas).toBe(amountIn);
      expect(q.feePct).toBeCloseTo(coin.nominalFeePct, 0);
      // Nothing stays in the router.
      expect(await client.readContract({ address: SWAP_CONTRACTS.weth, abi: erc20Abi, functionName: 'balanceOf', args: [SWAP_CONTRACTS.universalRouter] })).toBe(0n);
      expect(await coinBalance(coin.token)).toBeGreaterThan(0n);
    });

    it('a buy reverts on chain when the floor is above what the pool gives', async () => {
      const key = keyOf();
      const amountIn = parseEther('0.01');
      const q = await quote(key, 'buy', amountIn);
      const tx = buildBuyTx({ key, coin: coin.token, amountIn, minOut: q.amountOut + q.amountOut / 100n, deadline: await deadlineAfter(1200) });
      const err = await expectRevert(tx);
      expect(classifySwapError(err)).toBe('slippage');
      const coinBefore = await coinBalance(coin.token);
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: 1_500_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('reverted');
      expect(await coinBalance(coin.token)).toBe(coinBefore);
      console.log(`${coin.name} buy with a floor 1% above the quote: reverted on chain, coin balance unchanged`);
    });

    it('a sell without approvals reverts and reads as a missing approval', async () => {
      const key = keyOf();
      const amountIn = (await coinBalance(coin.token)) / 2n;
      const q = await quote(key, 'sell', amountIn);
      const tx = buildSellTx({ key, coin: coin.token, amountIn, minOut: minReceived(q.amountOut, 100), deadline: await deadlineAfter(1200) });
      const err = await expectRevert(tx);
      expect(classifySwapError(err)).toBe('approval');
    });

    it('sells for ETH through exact Permit2 approvals that end at zero', async () => {
      const key = keyOf();
      const balance = await coinBalance(coin.token);
      const amountIn = balance / 2n;
      const q = await quote(key, 'sell', amountIn);
      const minOut = minReceived(q.amountOut, 100);

      const calls = approvalCalls({ coin: coin.token, amount: amountIn, allowances: await allowancesOf(coin.token), now: await now(), dataSuffix });
      expect(calls.map((c) => c.kind)).toEqual(['token', 'permit2']);
      for (const call of calls) await send(call);
      const approved = await allowancesOf(coin.token);
      expect(approved.token).toBe(amountIn);
      expect(approved.permit2Amount).toBe(amountIn);

      // Same floor, a floor too high: the guard reverts and the coin stays put.
      const tooHigh = buildSellTx({ key, coin: coin.token, amountIn, minOut: q.amountOut + q.amountOut / 100n, deadline: await deadlineAfter(1200) });
      expect(classifySwapError(await expectRevert(tooHigh))).toBe('slippage');

      const tx = buildSellTx({ key, coin: coin.token, amountIn, minOut, deadline: await deadlineAfter(1200), dataSuffix });
      const ethBefore = await client.getBalance({ address: account.address });
      const hash = await send(tx);
      const receipt = await client.getTransactionReceipt({ hash });
      const ethAfter = await client.getBalance({ address: account.address });
      const received = ethAfter - ethBefore + receipt.gasUsed * receipt.effectiveGasPrice;
      console.log(
        `${coin.name} sell: ${formatEther(amountIn)} coin -> ${formatEther(received)} ETH (quote ${formatEther(q.amountOut)}, min ${formatEther(minOut)}), fee ${q.feePct}%, impact ${q.impactPct}%, gas used ${receipt.gasUsed}`,
      );
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(await coinBalance(coin.token)).toBe(balance - amountIn);
      expect(q.feePct).toBeCloseTo(coin.nominalFeePct, 0);

      const after = await allowancesOf(coin.token);
      expect(after.token).toBe(0n);
      expect(after.permit2Amount).toBe(0n);
    });

    it('a deadline in the past reverts and reads as expired', async () => {
      const key = keyOf();
      const tx = buildBuyTx({ key, coin: coin.token, amountIn: parseEther('0.001'), minOut: 1n, deadline: BigInt((await now()) - 60) });
      expect(classifySwapError(await expectRevert(tx))).toBe('expired');
    });

    it('an amount larger than the pool can fill does not quote as a normal swap', async () => {
      const key = keyOf();
      const err = await quote(key, 'buy', parseEther('5000000')).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      expect((err as { code?: string }).code).toBe('no_liquidity');
    });
  });

  /**
   * A coin launched on the fork, block by block as on Base since Denim: a block every 200 ms, five in a row sharing one
   * whole-second timestamp. Each row is a real buy mined at that block, from the state right after the launch. What this
   * proves: what the deployed Clanker contracts do given those block numbers and timestamps. What it does not: anvil mines
   * on request, so the sequencer's real ordering, priority fees and flashblocks are not in it, and a launch can sit at any
   * of the five places in its second, which is why every place is measured.
   */
  describe('Clanker launch fee at 200 ms blocks', () => {
    const LAUNCHER = '0x387f1B0aC128D534E822c344D829645336BDAbbB' as Address;
    const BLOCKS_PER_SECOND = 5;
    const amountIn = parseEther('0.0001');

    /** One launch, with `place` blocks of its second already gone. */
    const launchAt = async (place: number, salt: string) => {
      const hash = await wallet.writeContract({ address: LAUNCHER, abi: clankerLauncherAbi, functionName: 'launch', value: parseEther('0.0005'), args: [launchArgs(salt)] });
      const receipt = await client.waitForTransactionReceipt({ hash });
      expect(receipt.status).toBe('success');
      const launched = await client.getContractEvents({ address: LAUNCHER, abi: clankerLauncherAbi, eventName: 'ClankerLaunched', fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
      const token = launched[0]!.args.token!;
      const key = verifiedPoolKey(token, 'clanker', launched[0]!.args.poolId!)!;
      const launchedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
      /** The timestamp of the block `k` blocks after the launch. */
      const tsOf = (k: number) => launchedAt + Math.floor((place + k) / BLOCKS_PER_SECOND);
      return { token, key, launchedAt, tsOf };
    };

    /** A real buy mined exactly `k` blocks after the launch: reverted, or what it paid against the pool's own rate. */
    const buyAtBlock = async (launch: Awaited<ReturnType<typeof launchAt>>, k: number) => {
      const { token, key, launchedAt, tsOf } = launch;
      for (let i = 1; i < k; i++) {
        await test.setNextBlockTimestamp({ timestamp: BigInt(tsOf(i)) });
        await test.mine({ blocks: 1 });
      }
      const [sqrtPriceX96] = await client.readContract({ address: SWAP_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(key)] });
      const before = await coinBalance(token);
      await test.setNextBlockTimestamp({ timestamp: BigInt(tsOf(k)) });
      const tx = buildBuyTx({ key, coin: token, amountIn, minOut: 1n, deadline: BigInt(launchedAt + 1200) });
      // A fixed gas limit: gas estimation would stop a revert before it is mined at that block.
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: 3_000_000n });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') return { k, at: tsOf(k) - launchedAt, reverted: true as const, feePct: null };
      const received = (await coinBalance(token)) - before;
      const feePct = shortfallPct(received, idealOut(amountIn, sqrtPriceX96, zeroForOne(key, 'buy')));
      return { k, at: tsOf(k) - launchedAt, reverted: false as const, feePct };
    };

    /** The same measurement at each block of `ks`, each from the state right after the launch. */
    const curve = async (place: number, ks: readonly number[]) => {
      const launch = await launchAt(place, `curve-${place}`);
      const rows: Awaited<ReturnType<typeof buyAtBlock>>[] = [];
      for (const k of ks) {
        const id = await test.snapshot();
        rows.push(await buyAtBlock(launch, k));
        await test.revert({ id });
      }
      return rows;
    };

    const show = (r: { k: number; at: number; reverted: boolean; feePct: number | null }) => `block +${r.k} (${(r.k * 0.2).toFixed(1)} s, timestamp +${r.at} s): ${r.reverted ? 'reverted' : `paid ${r.feePct!.toFixed(2)}%`}`;

    it('measures the curve from the places a launch can have in its second', async () => {
      // +1 and +2 are the blocks Clanker holds back; then every few seconds to past the end of the fall.
      const ks = [1, 2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50, 60, 70, 74, 75, 76, 77, 78, 79, 80, 81, 85, 90, 100];
      for (const place of [0, 2, 4]) {
        const rows = await curve(place, ks);
        console.log(`launch fee, launch at place ${place} of its second:\n${rows.map(show).join('\n')}`);
        expect(rows[0]!.reverted).toBe(true);
        expect(rows[1]!.reverted).toBe(true);
        const first = rows[2]!;
        expect(first.reverted).toBe(false);
        // The fall goes by the timestamp: +0 s where the launch was early in its second, +1 s where it was late.
        expect(first.feePct!).toBeCloseTo(first.at === 0 ? 70.6 : 62.96, 0);
        const byAt = (at: number) => rows.filter((r) => r.at === at).map((r) => r.feePct!);
        for (const fee of byAt(6)) expect(fee).toBeCloseTo(30.39, 0);
        for (const fee of byAt(15)) expect(fee).toBeCloseTo(4.96, 0);
        for (const r of rows.filter((x) => x.at >= 16)) expect(r.feePct!).toBeCloseTo(1.2, 1);
        // 16 by the clock, not by a block count: blocks +76 to +80 by the place in the second.
        const normalFrom = rows.find((r) => r.at >= 16)!;
        expect(normalFrom.k).toBeGreaterThanOrEqual(76);
        expect(normalFrom.k).toBeLessThanOrEqual(80);
      }
    }, 600_000);

    it('the panel reads it: blocked, then the raised fee, then the normal one', async () => {
      const launch = await launchAt(0, 'panel');
      const { key, launchedAt, tsOf } = launch;
      const windowOf = { armed: true, startedAt: launchedAt, endsAt: launchedAt + 120 };
      const buy = buildBuyTx({ key, coin: launch.token, amountIn, minOut: 1n, deadline: BigInt(launchedAt + 1200) });
      const early = await expectRevert(buy);
      expect(classifySwapError(early, { launchWindow: windowOf, now: launchedAt })).toBe('launch_window');

      const rows: string[] = [];
      let at = 0;
      const toBlock = async (k: number) => {
        for (at += 1; at <= k; at++) {
          await test.setNextBlockTimestamp({ timestamp: BigInt(tsOf(at)) });
          await test.mine({ blocks: 1 });
        }
        at = k;
      };
      for (const k of [0, 1, 2, 3, 4, 5, 10, 30, 75, 80, 85]) {
        if (k > 0) await toBlock(k);
        const clock = Number((await client.getBlock()).timestamp);
        // This fork's clock is not the wall clock the panel goes by on Base.
        const q = await quoteSwap(client, { key, side: 'buy', amountIn, now: clock }).then(
          (r) => `fee ${r.feePct?.toFixed(2)}%, window running ${launchWindowActive(r.launchWindow, clock)}`,
          (e: { code?: string }) => `no quote: ${e.code}`,
        );
        rows.push(`block +${k} (timestamp +${clock - launchedAt} s): ${q}`);
      }
      console.log(`what the panel reads on a new Clanker coin at 200 ms blocks\n${rows.join('\n')}`);
      // Blocks +0 to +2 are held back; a read at the latest block sees what that block would do.
      for (const row of rows.slice(0, 3)) expect(row).toContain('no quote: launch_window');
      expect(rows[3]).toContain('fee 70.60%');
      expect(rows.at(-1)).toContain('fee 1.20%');
    }, 300_000);

    it('a buy with the panel\'s calldata and minimum goes through right after the blocked blocks', async () => {
      const launch = await launchAt(0, 'buy');
      const { token, key, launchedAt, tsOf } = launch;
      for (const k of [1, 2, 3]) {
        await test.setNextBlockTimestamp({ timestamp: BigInt(tsOf(k)) });
        await test.mine({ blocks: 1 });
      }
      const size = parseEther('0.001');
      const q = await quote(key, 'buy', size);
      const tx = buildBuyTx({ key, coin: token, amountIn: size, minOut: minReceived(q.amountOut, 100), deadline: BigInt(launchedAt + 1200) });
      await test.setNextBlockTimestamp({ timestamp: BigInt(tsOf(4)) });
      await send(tx);
      const received = await coinBalance(token);
      console.log(`buy at block +4 on a new Clanker coin: ${formatEther(size)} ETH -> ${formatEther(received)} coin; the quote at block +3 said ${formatEther(q.amountOut)} with a fee of ${q.feePct}%`);
      expect(received).toBeGreaterThanOrEqual(minReceived(q.amountOut, 100));
    }, 120_000);
  });
});
