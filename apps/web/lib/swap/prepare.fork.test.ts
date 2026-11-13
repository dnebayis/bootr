/**
 * `POST /api/agent/swap` on a Base mainnet fork: the route's own answers, sent step by step as a wallet would send
 * them, for a coin of each launch path. The route handler itself is called (not the builders under it), with its
 * chain client pointed at the fork and the indexer's one read answered here from what the launchers state on chain.
 * Skipped unless PREPARE_FORK_RPC points at a fork:
 *
 *   base-anvil --fork-url <Base RPC> --port 8671
 *   PREPARE_FORK_RPC=http://127.0.0.1:8671 pnpm --filter web exec vitest run lib/swap/prepare.fork.test.ts \
 *     --testTimeout=300000 --hookTimeout=300000
 *
 * The coins: a Clanker v5 coin paired with ETH and one paired with USDC, both launched here through the live
 * `BootrClankerLauncherV5` the way the launch form prepares them; $BOOTR, a real Clanker v4 coin; and OWL, a real
 * RWAGMI coin. RWAGMI coins are B20 tokens, so OWL runs only on `base-anvil` (plain `anvil` skips it and runs the
 * rest). The fork's clock must be the wall clock, as a fresh fork's is: the route stamps its deadline with it.
 *
 * Only anvil's own public test keys sign here. Nothing reaches a live chain.
 */
import { createPublicClient, createTestClient, createWalletClient, erc20Abi, formatEther, formatUnits, http, keccak256, numberToHex, parseEther, parseEventLogs, toHex, zeroAddress, type Address, type Hex, type PrivateKeyAccount } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { addresses } from '@bootr/shared/addresses';
import { clankerLauncherV5Abi } from '../abi/clankerLauncherV5.abi';
import { mineLaunchSalt, type V5LaunchParams } from '../clanker-v5';
import { defaultTokenSettings, toContractSettings } from '../token-settings';
import { launchValue, pinsOf, readLaunchTerms, usdcBalanceSlot } from '../v5-launch';
import { CLANKER_V5_ANTI_SNIPE_SECONDS, NATIVE_ETH, permit2Abi, poolIdOf, SWAP_CONTRACTS } from './core';
import type { PreparedSwap, SwapCoinRow, SwapStep } from './prepare';

const RPC = process.env.PREPARE_FORK_RPC ?? '';
const A = addresses[8453];
const V5 = A.clankerV5!;
const LAUNCHER_V5 = A.bootr.clankerLauncherV5 as Address;
const USDC = A.usdc as Address;
const ROUTER = SWAP_CONTRACTS.universalRouter;
const PERMIT2 = SWAP_CONTRACTS.permit2;
const BUILDER_SUFFIX_CODE = 'bc_bootrtest';

// anvil's second, third and fourth default accounts: public test keys.
const creator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const trader = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const other = privateKeyToAccount('0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6');

const chain = { ...base, rpcUrls: { default: { http: [RPC || 'http://127.0.0.1:8671'] } } };
const transport = http(RPC || 'http://127.0.0.1:8671');
const client = createPublicClient({ chain, transport });
const test = createTestClient({ chain, mode: 'anvil', transport });
const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport });

const POOL_KEY_FOR = [
  {
    type: 'function',
    name: 'poolKeyFor',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ type: 'tuple', components: [{ name: 'currency0', type: 'address' }, { name: 'currency1', type: 'address' }, { name: 'fee', type: 'uint24' }, { name: 'tickSpacing', type: 'int24' }, { name: 'hooks', type: 'address' }] }],
  },
] as const;

/** The real coins of the two older paths, with the launcher that states each one's pool. */
const OLDER = {
  clanker: { symbol: 'BOOTR', token: '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c' as Address, launcher: '0x387f1B0aC128D534E822c344D829645336BDAbbB' as Address },
  bootr: { symbol: 'OWL', token: '0xb2000000000000000000004481c175669cbc8edb' as Address, launcher: '0x62c038dA8A409ad1CD811df980A6F9867cd453fd' as Address },
};

describe.skipIf(!RPC)('POST /api/agent/swap on a Base fork: the route’s own steps, sent as a wallet sends them', () => {
  /** What the indexer holds, keyed by the coin's lowercase address: the one read the route makes of it. */
  const indexed = new Map<string, SwapCoinRow>();
  let POST: (req: NextRequest) => Promise<Response>;
  let calls = 0;
  let b20 = false;

  const balanceOf = (token: Address, owner: Address) => (BigInt(token) === 0n ? client.getBalance({ address: owner }) : client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] }));
  const routerHoldings = () => Promise.all([balanceOf(NATIVE_ETH, ROUTER), balanceOf(SWAP_CONTRACTS.weth, ROUTER), balanceOf(USDC, ROUTER)]);
  const allowancesOf = async (owner: Address, token: Address) => {
    const [tokenAllowance, permit2] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, PERMIT2] }),
      client.readContract({ address: PERMIT2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, ROUTER] }),
    ]);
    return { token: tokenAllowance, permit2: permit2[0] };
  };

  /** One call of the route, from an address of its own. */
  async function ask(body: Record<string, unknown>): Promise<{ status: number; body: PreparedSwap & { error?: string; message?: string } }> {
    calls += 1;
    const res = await POST(new NextRequest('http://localhost/api/agent/swap', { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': `198.51.100.${calls}` }, body: JSON.stringify(body) }));
    return { status: res.status, body: (await res.json()) as PreparedSwap & { error?: string; message?: string } };
  }

  /** Sends the steps in order from `account`, each after the one before is mined; the gas they cost in all. */
  async function send(account: PrivateKeyAccount, steps: SwapStep[]): Promise<{ gas: bigint; gasUsed: bigint }> {
    let gas = 0n;
    let gasUsed = 0n;
    for (const step of steps) {
      const hash = await walletOf(account).sendTransaction({ to: step.to, data: step.data, value: BigInt(step.value) });
      const receipt = await client.waitForTransactionReceipt({ hash });
      if (receipt.status !== 'success') throw new Error(`${step.kind} reverted: ${hash}`);
      gas += receipt.gasUsed * receipt.effectiveGasPrice;
      gasUsed += receipt.gasUsed;
    }
    return { gas, gasUsed };
  }

  /** Every step of an answer is for the wallet asked for, to the token spent, Permit2 or the router, with the site's builder code. */
  function expectSteps(p: PreparedSwap, kinds: SwapStep['kind'][], spent: Address | null) {
    expect(p.steps.map((s) => s.kind)).toEqual(kinds);
    for (const s of p.steps) {
      expect(s.sendFrom).toBe(trader.address);
      expect(s.to.toLowerCase()).toBe((s.kind === 'approve_token' ? spent! : s.kind === 'approve_permit2' ? PERMIT2 : ROUTER).toLowerCase());
      expect(s.data.toLowerCase()).not.toContain(trader.address.toLowerCase().slice(2));
      expect(s.data.includes(toHex(BUILDER_SUFFIX_CODE).slice(2)), 'the builder code is on the calldata').toBe(true);
    }
  }

  /** A buy with ETH through the route, sent by the trader: what arrived against the quote and the floor. */
  async function buyWithEth(row: SwapCoinRow, amount: string, extra: Record<string, unknown> = {}) {
    const token = row.id as Address;
    const answer = await ask({ token, side: 'buy', amount, wallet: trader.address, ...extra });
    expect(answer.status, answer.body.message).toBe(200);
    const p = answer.body;
    expectSteps(p, ['swap'], null);
    expect(p.steps[0]!.value).toBe(parseEther(amount).toString());
    const [ethBefore, coinBefore, router] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(token, trader.address), routerHoldings()]);
    const { gas, gasUsed } = await send(trader, p.steps);
    const [ethAfter, coinAfter] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(token, trader.address)]);
    const received = coinAfter - coinBefore;
    expect(received).toBeGreaterThanOrEqual(BigInt(p.minReceived.raw));
    expect(ethBefore - ethAfter - gas).toBe(parseEther(amount));
    expect(await routerHoldings()).toEqual(router);
    return { p, received, gasUsed };
  }

  /** A sell of `amountRaw` of the coin through the route: exact approvals, then the swap; what arrived in `paid`. */
  async function sell(row: SwapCoinRow, amountRaw: bigint, paid: Address) {
    const token = row.id as Address;
    const answer = await ask({ token, side: 'sell', amount: formatEther(amountRaw), wallet: trader.address });
    expect(answer.status, answer.body.message).toBe(200);
    const p = answer.body;
    expectSteps(p, ['approve_token', 'approve_permit2', 'swap'], token);
    expect(p.amountIn.raw).toBe(amountRaw.toString());
    for (const s of p.steps) expect(s.value).toBe('0');
    const [paidBefore, coinBefore, router] = await Promise.all([balanceOf(paid, trader.address), balanceOf(token, trader.address), routerHoldings()]);
    // the two approvals alone move nothing and leave exactly the amount allowed
    const approvals = await send(trader, p.steps.slice(0, 2));
    expect(await allowancesOf(trader.address, token)).toEqual({ token: amountRaw, permit2: amountRaw });
    expect(await balanceOf(token, trader.address)).toBe(coinBefore);
    const swap = await send(trader, p.steps.slice(2));
    const [paidAfter, coinAfter] = await Promise.all([balanceOf(paid, trader.address), balanceOf(token, trader.address)]);
    const received = BigInt(paid) === 0n ? paidAfter - paidBefore + approvals.gas + swap.gas : paidAfter - paidBefore;
    expect(received).toBeGreaterThanOrEqual(BigInt(p.minReceived.raw));
    expect(received).toBe(BigInt(p.quote.amountOut.raw));
    expect(coinBefore - coinAfter).toBe(amountRaw);
    expect(await routerHoldings()).toEqual(router);
    // the swap spent both allowances: nothing stays open
    expect(await allowancesOf(trader.address, token)).toEqual({ token: 0n, permit2: 0n });
    return { p, received, gasUsed: approvals.gasUsed + swap.gasUsed };
  }

  /** A Clanker v5 coin launched through the live launcher as the launch form prepares it, and its row as the indexer writes it. */
  async function launchV5(pairedAsset: 'ETH' | 'USDC', sniperTax: boolean): Promise<SwapCoinRow> {
    const terms = await readLaunchTerms(client, LAUNCHER_V5, V5.factory as Address);
    const draftId = crypto.randomUUID();
    const settings = toContractSettings({ ...defaultTokenSettings(creator.address), pairedAsset, sniperTax }, `https://bootr.fun/tokens/${draftId}.json`, terms.bounds, pinsOf(terms, 0n));
    const params: V5LaunchParams = {
      name: `Prepared ${pairedAsset}`,
      symbol: pairedAsset === 'ETH' ? 'PREPE' : 'PREPU',
      image: 'https://bootr.fun/x.png',
      metadata: '{"description":"fork"}',
      context: JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id: draftId }),
      salt: keccak256(toHex(draftId)),
      buybackBurn: false,
      fuelUsdc: terms.minFuelUsdc,
      devBuyWei: 0n,
      workerHash: keccak256(toHex('community')),
      model: 'openai/gpt-5-mini',
      agentURI: `https://bootr.fun/agents/${draftId}.json`,
      supervisorSessionKey: zeroAddress,
    };
    const mined = await mineLaunchSalt({ client, launcher: LAUNCHER_V5, tokenDeployer: V5.tokenDeployer as Address, creator: creator.address, params, settings });
    params.salt = mined.salt;
    if (params.fuelUsdc > 0n) {
      await test.setStorageAt({ address: USDC, index: usdcBalanceSlot(creator.address), value: numberToHex(params.fuelUsdc, { size: 32 }) });
      await client.waitForTransactionReceipt({ hash: await walletOf(creator).writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [LAUNCHER_V5, params.fuelUsdc] }) });
    }
    const hash = await walletOf(creator).writeContract({ address: LAUNCHER_V5, abi: clankerLauncherV5Abi, functionName: 'launch', args: [params, settings], value: launchValue(0n, terms) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');
    const events = parseEventLogs({ abi: clankerLauncherV5Abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === LAUNCHER_V5.toLowerCase()) });
    const v5 = events.find((e) => e.eventName === 'ClankerV5Launched')!.args as { token: Address; poolId: Hex; quoteToken: Address; antiSnipe: boolean };
    expect(v5.token).toBe(mined.token);
    // The pool id the launch states is the id of the key the launcher states: what the indexer stores.
    expect(poolIdOf(await client.readContract({ address: LAUNCHER_V5, abi: clankerLauncherV5Abi, functionName: 'poolKeyFor', args: [v5.token] }))).toBe(v5.poolId);
    const launchedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    const row: SwapCoinRow = { id: v5.token.toLowerCase(), symbol: params.symbol, poolId: v5.poolId, source: 'clanker-v5', pairedToken: v5.quoteToken.toLowerCase(), launchedAt, antiSnipe: v5.antiSnipe };
    indexed.set(row.id, row);
    return row;
  }

  /** A real older coin's row: its pool id as its launcher states the key on chain. */
  async function older(which: keyof typeof OLDER): Promise<SwapCoinRow> {
    const c = OLDER[which];
    const key = await client.readContract({ address: c.launcher, abi: POOL_KEY_FOR, functionName: 'poolKeyFor', args: [c.token] });
    const row: SwapCoinRow = { id: c.token.toLowerCase(), symbol: c.symbol, poolId: poolIdOf(key), source: which, pairedToken: SWAP_CONTRACTS.weth.toLowerCase(), launchedAt: 1_760_000_000, antiSnipe: null };
    indexed.set(row.id, row);
    return row;
  }

  beforeAll(async () => {
    for (const a of [creator, trader, other]) {
      await test.setBalance({ address: a.address, value: parseEther('100') });
      // On Base these public keys may carry EIP-7702 delegations; on the fork they are plain wallets again.
      await test.setCode({ address: a.address, bytecode: '0x' });
    }
    // RWAGMI coins are B20 tokens: only base-anvil can read one, so a balance that reads says which fork this is.
    b20 = await balanceOf(OLDER.bootr.token, trader.address).then(() => true, () => false);

    // The site as it runs on Base, its chain reads on the fork, and an indexer that answers from `indexed`.
    vi.stubEnv('NEXT_PUBLIC_CHAIN_ID', '8453');
    vi.stubEnv('NEXT_PUBLIC_USE_MOCK', '');
    vi.stubEnv('NEXT_PUBLIC_INDEXER_URL', 'https://indexer.test');
    vi.stubEnv('NEXT_PUBLIC_BUILDER_CODE', BUILDER_SUFFIX_CODE);
    vi.stubEnv('BASE_RPC_URL', RPC);
    const realFetch = globalThis.fetch.bind(globalThis);
    vi.stubGlobal('fetch', (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url instanceof Request ? url.url : url).startsWith('https://indexer.test')) return realFetch(url, init);
      const { variables } = JSON.parse(String(init?.body)) as { variables: { id: string } };
      return Promise.resolve(Response.json({ data: { token: indexed.get(variables.id) ?? null } }));
    });
    vi.resetModules();
    ({ POST } = await import('../../app/api/agent/swap/route'));
  });

  afterAll(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe('a Clanker v5 coin paired with ETH', () => {
    let row: SwapCoinRow;
    beforeAll(async () => {
      row = await launchV5('ETH', false);
    });

    it('buys with ETH in one step and receives exactly the quote, at or above the minimum', async () => {
      const { p, received, gasUsed } = await buyWithEth(row, '0.01');
      expect(p).toMatchObject({ path: 'clanker-v5', pairedAsset: 'ETH', symbol: 'PREPE' });
      expect(received).toBe(BigInt(p.quote.amountOut.raw));
      expect(p.quote.feePct!).toBeCloseTo(1.5, 1);
      console.log(`v5 ETH coin, buy through the route: 0.01 ETH -> ${formatEther(received)} coin (quote ${p.quote.amountOut.formatted}, min ${p.minReceived.formatted}), fee ${p.quote.feePct}%, impact ${p.quote.impactPct}%, gas ${gasUsed}`);
    });

    it('sells through two exact approvals and the swap, receives exactly the quote in ETH, and leaves no allowance', async () => {
      const amount = (await balanceOf(row.id as Address, trader.address)) / 2n;
      const { p, received, gasUsed } = await sell(row, amount, NATIVE_ETH);
      expect(p.quote.amountOut.asset).toBe('ETH');
      console.log(`v5 ETH coin, sell through the route: ${formatEther(amount)} coin -> ${formatEther(received)} ETH (min ${p.minReceived.formatted}), fee ${p.quote.feePct}%, gas ${gasUsed} over 3 transactions`);
    });

    it('pays whoever sends the swap: steps prepared for one wallet and sent by another pay the other, and nothing reaches a third', async () => {
      const token = row.id as Address;
      const answer = await ask({ token, side: 'buy', amount: '0.005', wallet: trader.address });
      expect(answer.status).toBe(200);
      const [traderBefore, otherBefore] = await Promise.all([balanceOf(token, trader.address), balanceOf(token, other.address)]);
      await send(other, answer.body.steps);
      expect(await balanceOf(token, trader.address)).toBe(traderBefore);
      expect((await balanceOf(token, other.address)) - otherBefore).toBeGreaterThanOrEqual(BigInt(answer.body.minReceived.raw));
    });

    it('a step prepared at a price that has since moved against it reverts instead of filling below the minimum', async () => {
      const token = row.id as Address;
      const stale = await ask({ token, side: 'sell', amount: '1000', wallet: trader.address, slippagePct: 0.01 });
      expect(stale.status).toBe(200);
      await send(trader, stale.body.steps.slice(0, 2));
      // another wallet sells first and moves the price down
      const dump = (await balanceOf(token, other.address)) / 2n;
      const first = await ask({ token, side: 'sell', amount: formatEther(dump), wallet: other.address });
      expect(first.status).toBe(200);
      await send(other, first.body.steps);
      const swap = stale.body.steps[2]!;
      const coinBefore = await balanceOf(token, trader.address);
      const hash = await walletOf(trader).sendTransaction({ to: swap.to, data: swap.data, value: 0n, gas: 1_500_000n });
      expect((await client.waitForTransactionReceipt({ hash })).status).toBe('reverted');
      expect(await balanceOf(token, trader.address)).toBe(coinBefore);
    });
  });

  describe('a Clanker v5 coin paired with USDC, launched with the sniper tax', () => {
    let row: SwapCoinRow;
    beforeAll(async () => {
      row = await launchV5('USDC', true);
      await test.setStorageAt({ address: USDC, index: usdcBalanceSlot(trader.address), value: numberToHex(10_000_000_000n, { size: 32 }) });
    });

    it('prepares no buy in the coin’s first 20 seconds, and says when trading opens', async () => {
      expect(row.antiSnipe).toBe(true);
      const early = await ask({ token: row.id, side: 'buy', amount: '25', wallet: trader.address });
      expect(early.status).toBe(409);
      expect(early.body.error).toBe('trading_not_open');
      expect(early.body.message).toMatch(/Trading opens in \d+ seconds?\.$/);
      expect(early.body).not.toHaveProperty('steps');
      // wait the window out on the wall clock, which is the fork's clock and the route's
      const wait = (Number(row.launchedAt) + CLANKER_V5_ANTI_SNIPE_SECONDS + 1) * 1000 - Date.now();
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      await test.mine({ blocks: 1 });
      expect(Number((await client.getBlock()).timestamp)).toBeGreaterThanOrEqual(Number(row.launchedAt) + CLANKER_V5_ANTI_SNIPE_SECONDS);
    }, 120_000);

    it('buys with USDC through exact approvals, spends exactly the amount and receives exactly the quote', async () => {
      const token = row.id as Address;
      const answer = await ask({ token, side: 'buy', amount: '25', wallet: trader.address });
      expect(answer.status, answer.body.message).toBe(200);
      const p = answer.body;
      expect(p).toMatchObject({ path: 'clanker-v5', pairedAsset: 'USDC', amountIn: { raw: '25000000', asset: 'USDC' } });
      expectSteps(p, ['approve_token', 'approve_permit2', 'swap'], USDC);
      for (const s of p.steps) expect(s.value).toBe('0');
      const [usdcBefore, coinBefore, router] = await Promise.all([balanceOf(USDC, trader.address), balanceOf(token, trader.address), routerHoldings()]);
      await send(trader, p.steps.slice(0, 2));
      expect(await allowancesOf(trader.address, USDC)).toEqual({ token: 25_000_000n, permit2: 25_000_000n });
      const { gasUsed } = await send(trader, p.steps.slice(2));
      const received = (await balanceOf(token, trader.address)) - coinBefore;
      expect(received).toBe(BigInt(p.quote.amountOut.raw));
      expect(received).toBeGreaterThanOrEqual(BigInt(p.minReceived.raw));
      expect(usdcBefore - (await balanceOf(USDC, trader.address))).toBe(25_000_000n);
      expect(await routerHoldings()).toEqual(router);
      expect(await allowancesOf(trader.address, USDC)).toEqual({ token: 0n, permit2: 0n });
      console.log(`v5 USDC coin, buy with USDC through the route: 25 USDC -> ${formatEther(received)} coin (min ${p.minReceived.formatted}), fee ${p.quote.feePct}%, impact ${p.quote.impactPct}%, swap gas ${gasUsed}`);
    });

    it('buys with ETH in one transaction of two hops, at or above the minimum, and touches no USDC of the wallet', async () => {
      const usdcBefore = await balanceOf(USDC, trader.address);
      const { p, received, gasUsed } = await buyWithEth(row, '0.01', { payWith: 'ETH' });
      expect(p).toMatchObject({ pairedAsset: 'USDC', amountIn: { asset: 'ETH' } });
      expect(await balanceOf(USDC, trader.address)).toBe(usdcBefore);
      const off = (Number(received) / Number(p.quote.amountOut.raw) - 1) * 100;
      expect(Math.abs(off)).toBeLessThan(0.5);
      console.log(`v5 USDC coin, buy with ETH through the route: 0.01 ETH -> ${formatEther(received)} coin (quote ${p.quote.amountOut.formatted}, ${off.toFixed(4)}% off it, min ${p.minReceived.formatted}), gas ${gasUsed}`);
    });

    it('sells to USDC through exact approvals and receives exactly the quote', async () => {
      const amount = (await balanceOf(row.id as Address, trader.address)) / 2n;
      const { p, received, gasUsed } = await sell(row, amount, USDC);
      expect(p.quote.amountOut.asset).toBe('USDC');
      console.log(`v5 USDC coin, sell through the route: ${formatEther(amount)} coin -> ${formatUnits(received, 6)} USDC (min ${p.minReceived.formatted}), fee ${p.quote.feePct}%, gas ${gasUsed} over 3 transactions`);
    });
  });

  describe('$BOOTR, a real Clanker v4 coin', () => {
    let row: SwapCoinRow;
    beforeAll(async () => {
      row = await older('clanker');
    });

    it('buys with ETH and sells back through the route’s steps, each at exactly the quote', async () => {
      const bought = await buyWithEth(row, '0.01');
      expect(bought.p).toMatchObject({ path: 'clanker', pairedAsset: 'ETH' });
      expect(bought.received).toBe(BigInt(bought.p.quote.amountOut.raw));
      const sold = await sell(row, bought.received / 2n, NATIVE_ETH);
      console.log(
        `$BOOTR (Clanker v4) through the route: 0.01 ETH -> ${formatEther(bought.received)} coin (min ${bought.p.minReceived.formatted}), fee ${bought.p.quote.feePct}%, gas ${bought.gasUsed}; ` +
          `${formatEther(bought.received / 2n)} coin -> ${formatEther(sold.received)} ETH (min ${sold.p.minReceived.formatted}), fee ${sold.p.quote.feePct}%, gas ${sold.gasUsed}`,
      );
    });
  });

  describe('OWL, a real RWAGMI coin (base-anvil only)', () => {
    it('buys with ETH and sells back through the route’s steps, each at exactly the quote', async (ctx) => {
      if (!b20) return ctx.skip();
      const row = await older('bootr');
      const bought = await buyWithEth(row, '0.01');
      expect(bought.p).toMatchObject({ path: 'bootr', pairedAsset: 'ETH' });
      expect(bought.received).toBe(BigInt(bought.p.quote.amountOut.raw));
      const sold = await sell(row, bought.received / 2n, NATIVE_ETH);
      console.log(
        `OWL (RWAGMI) through the route: 0.01 ETH -> ${formatEther(bought.received)} coin (min ${bought.p.minReceived.formatted}), fee ${bought.p.quote.feePct}%, gas ${bought.gasUsed}; ` +
          `${formatEther(bought.received / 2n)} coin -> ${formatEther(sold.received)} ETH (min ${sold.p.minReceived.formatted}), fee ${sold.p.quote.feePct}%, gas ${sold.gasUsed}`,
      );
    });
  });

  describe('what the route refuses on the real chain', () => {
    it('a token that is not a Bootr coin, though it has pools: WETH and USDC', async () => {
      for (const token of [SWAP_CONTRACTS.weth, USDC]) {
        const res = await ask({ token, side: 'buy', amount: '0.01', wallet: trader.address });
        expect(res.status).toBe(404);
        expect(res.body.error).toBe('unknown_coin');
      }
    });

    it('a Bootr coin’s row pointed at another pool, and an amount the wallet does not hold', async () => {
      const real = indexed.get(OLDER.clanker.token.toLowerCase())!;
      const v5 = [...indexed.values()].find((r) => r.source === 'clanker-v5')!;
      indexed.set(real.id, { ...real, poolId: v5.poolId });
      const wrong = await ask({ token: real.id, side: 'buy', amount: '0.01', wallet: trader.address });
      indexed.set(real.id, real);
      expect(wrong.status).toBe(409);
      expect(wrong.body.error).toBe('not_tradable');
      const poor = await ask({ token: real.id, side: 'buy', amount: '1000', wallet: trader.address });
      expect(poor.status).toBe(409);
      expect(poor.body.error).toBe('no_balance');
    });
  });
});
