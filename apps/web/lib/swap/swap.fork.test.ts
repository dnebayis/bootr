/**
 * Real buys and sells on a Base mainnet fork, with the exact calldata the panel sends, for a real Clanker coin ($BOOTR)
 * and a real RWAGMI coin (OWL). Skipped unless SWAP_FORK_RPC points at a fork. RWAGMI coins are B20 tokens, so the fork
 * has to be `base-anvil`:
 *
 *   base-anvil --fork-url <Base RPC> --port 8646
 *   SWAP_FORK_RPC=http://127.0.0.1:8646 pnpm --filter web exec vitest run lib/swap/swap.fork.test.ts
 *
 * Only anvil's own test key signs here. Nothing reaches a live chain.
 */
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, formatEther, http, keccak256, parseEther, toHex, type Address, type Hash, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import * as Attribution from 'ox/erc8021/Attribution';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clankerLauncherAbi } from '../abi/launcher';
import { approvalCalls, buildBuyTx, buildSellTx, launchWindowActive, minReceived, permit2Abi, poolIdOf, SWAP_CONTRACTS, verifiedPoolKey, type PoolKey, type SwapSide, type SwapTx } from './core';
import { classifySwapError } from './errors';
import { quoteSwap } from './quote';

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
   * A coin launched on the fork, seconds old: what the panel reads from the hook and the quoter, second by second, and
   * what a real swap does at those moments.
   */
  it('reads Clanker\'s launch fee on a brand-new coin', async () => {
    const launcher = '0x387f1B0aC128D534E822c344D829645336BDAbbB' as Address;
    const hash = await wallet.writeContract({
      address: launcher,
      abi: clankerLauncherAbi,
      functionName: 'launch',
      value: parseEther('0.0005'),
      args: [launchArgs('07')],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const launched = await client.getContractEvents({ address: launcher, abi: clankerLauncherAbi, eventName: 'ClankerLaunched', fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const token = launched[0]!.args.token!;
    const key = verifiedPoolKey(token, 'clanker', launched[0]!.args.poolId!)!;
    expect(key).not.toBeNull();
    const launchedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);

    const amountIn = parseEther('0.001');
    const atSecond = async (after: number) => {
      await test.setNextBlockTimestamp({ timestamp: BigInt(launchedAt + after) });
      await test.mine({ blocks: 1 });
    };
    const rows: string[] = [];
    for (const after of [0, 2, 4, 8, 12, 16, 20, 30]) {
      if (after > 0) await atSecond(after);
      const clock = Number((await client.getBlock()).timestamp);
      const q = await quote(key, 'buy', amountIn).then(
        (r) => `fee ${r.feePct}%, hook window ${launchWindowActive(r.launchWindow, clock)}`,
        (e: { code?: string }) => `no quote: ${e.code}`,
      );
      rows.push(`t+${clock - launchedAt}s: ${q}`);
    }
    console.log(`launch fee on a new Clanker coin\n${rows.join('\n')}`);
    expect(rows[0]).toContain('no quote: launch_window');
    expect(rows[1]).toContain('no quote: launch_window');
    expect(rows.at(-1)).toContain('fee 1.19');
  }, 120_000);

  it('a real buy reverts in the first seconds, and pays the launch fee right after', async () => {
    const launcher = '0x387f1B0aC128D534E822c344D829645336BDAbbB' as Address;
    const hash = await wallet.writeContract({
      address: launcher,
      abi: clankerLauncherAbi,
      functionName: 'launch',
      value: parseEther('0.0005'),
      args: [launchArgs('08')],
    });
    const receipt = await client.waitForTransactionReceipt({ hash });
    const launched = await client.getContractEvents({ address: launcher, abi: clankerLauncherAbi, eventName: 'ClankerLaunched', fromBlock: receipt.blockNumber, toBlock: receipt.blockNumber });
    const token = launched[0]!.args.token!;
    const key = verifiedPoolKey(token, 'clanker', launched[0]!.args.poolId!)!;
    const launchedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const amountIn = parseEther('0.001');
    const deadline = BigInt(launchedAt + 1200);

    const window = { armed: true, endsAt: launchedAt + 120 };
    const early = await expectRevert(buildBuyTx({ key, coin: token, amountIn, minOut: 1n, deadline }));
    expect(classifySwapError(early, { launchWindow: window, now: launchedAt })).toBe('launch_window');

    // Base makes a block every 2 seconds, and the module counts blocks as well as seconds.
    for (const after of [2, 4, 6]) {
      await test.setNextBlockTimestamp({ timestamp: BigInt(launchedAt + after) });
      await test.mine({ blocks: 1 });
    }
    const q = await quote(key, 'buy', amountIn);
    const tx = buildBuyTx({ key, coin: token, amountIn, minOut: minReceived(q.amountOut, 100), deadline });
    await test.setNextBlockTimestamp({ timestamp: BigInt(launchedAt + 8) });
    await send(tx);
    const received = await coinBalance(token);
    console.log(`buy at t+8s on a new Clanker coin: ${formatEther(amountIn)} ETH -> ${formatEther(received)} coin; the quote at t+6s said ${formatEther(q.amountOut)} with a fee of ${q.feePct}%`);
    expect(received).toBeGreaterThanOrEqual(minReceived(q.amountOut, 100));
  }, 120_000);
});
