/**
 * Clanker v5 coins launched through the LIVE `BootrClankerLauncherV5` on a Base mainnet fork, the way the launch form
 * prepares them, then traded and claimed with the exact calldata the trade panel and the fee panels send: an ETH coin
 * without the sniper tax, an ETH coin with it, and a USDC coin. Skipped unless V5_SWAP_FORK_RPC points at a fork:
 *
 *   anvil --fork-url <Base RPC> --port 8661
 *   V5_SWAP_FORK_RPC=http://127.0.0.1:8661 pnpm --filter web exec vitest run lib/swap/swap-v5.fork.test.ts --testTimeout=300000
 *
 * The launcher, gate, Clanker v5 factory, hook and fee escrow are the deployed ones at the fork block; nothing is
 * deployed or impersonated. Plain `anvil` is enough (no B20 tokens here). Every coin is a fresh launch, so the file
 * can run again on the same fork.
 *
 * Only anvil's own public test keys sign here. Nothing reaches a live chain.
 */
import {
  concat,
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeFunctionData,
  erc20Abi,
  formatEther,
  formatUnits,
  http,
  keccak256,
  numberToHex,
  parseEther,
  parseEventLogs,
  toFunctionSelector,
  toHex,
  zeroAddress,
  type Address,
  type Hash,
  type Hex,
  type Log,
  type PrivateKeyAccount,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { base } from 'viem/chains';
import * as Attribution from 'ox/erc8021/Attribution';
import { beforeAll, describe, expect, it } from 'vitest';
import { addresses } from '@bootr/shared/addresses';
import { ClankerV5HookAbi } from '../../../indexer/abis/ClankerV5';
import { clankerV5LaunchFacts, clankerV5PoolKey, clankerV5Settings, clankerV5Slots } from '../../../indexer/src/lib/clanker';
import { bpsByKind } from '../../../indexer/src/lib/fees';
import { clankerLauncherV5Abi } from '../abi/clankerLauncherV5.abi';
import { feeEscrowAbi, NATIVE_ETH as ESCROW_ETH } from '../abi/feeEscrow';
import { mineLaunchSalt, type V5LaunchParams } from '../clanker-v5';
import { buildClaims } from '../server/claim';
import { defaultTokenSettings, pairedAssetByAddress, rowsFromSlots, toContractSettings, v5SettingsOf, clankerV5HookSlotsAbi, type ContractTokenSettings } from '../token-settings';
import { launchValue, pinsOf, readLaunchTerms, usdcBalanceSlot } from '../v5-launch';
import {
  approvalCalls,
  buildBuyTx,
  buildEthViaPairedBuyTx,
  buildSellTx,
  CLANKER_V5_ANTI_SNIPE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  idealOut,
  isErc20Paired,
  isNativePool,
  minReceived,
  NATIVE_ETH,
  permit2Abi,
  poolIdOf,
  shortfallPct,
  SWAP_CONTRACTS,
  SWAP_DEADLINE_SECONDS,
  v5TradingOpensIn,
  verifiedPoolKey,
  zeroForOne,
  type PoolKey,
  type SwapTx,
} from './core';
import { classifySwapError } from './errors';
import { quoteEthViaPaired, quoteSwap, stateViewAbi } from './quote';

const RPC = process.env.V5_SWAP_FORK_RPC ?? '';
const A = addresses[8453];
const V5 = A.clankerV5!;
const LAUNCHER = A.bootr.clankerLauncherV5 as Address;
const USDC = A.usdc as Address;
const ROUTER = SWAP_CONTRACTS.universalRouter;

// anvil's second and third default accounts: public test keys.
const creator = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const trader = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a');
const dataSuffix = Attribution.toDataSuffix({ codes: ['bc_bootrtest'] });

const chain = { ...base, rpcUrls: { default: { http: [RPC || 'http://127.0.0.1:8661'] } } };
const transport = http(RPC || 'http://127.0.0.1:8661');
const client = createPublicClient({ chain, transport });
const test = createTestClient({ chain, mode: 'anvil', transport });
const walletOf = (account: PrivateKeyAccount) => createWalletClient({ account, chain, transport });

type Launched = {
  token: Address;
  kernel: Address;
  poolId: Hex;
  key: PoolKey;
  launchedAt: number;
  platformRecipient: Address;
  settings: ContractTokenSettings;
  /** Ticks between the pool's opening price and its seeded band, on the side a buy moves toward; 0 when they meet. */
  openingGapTicks: number;
};

/**
 * What the quote calls the fee on a coin's first buy: the tax, and the price jump from the opening tick to the seeded
 * band, which the first trade crosses with no liquidity (a reference swap pays it as much as the full one).
 */
const firstTradeFeePct = (c: Launched) => 100 * (1 - (1 - c.settings.buyTaxBps / 1_000_000) * 1.0001 ** -c.openingGapTicks);

/** The hook's credits of one receipt for one pool, by event: what the trade paid in tax and to whom. */
function hookCredits(logs: readonly Log[], poolId: Hex) {
  const parsed = parseEventLogs({ abi: ClankerV5HookAbi, logs: logs.filter((l) => l.address.toLowerCase() === V5.hook.toLowerCase()) as Log[] });
  const out = { creatorSlots: [] as { recipient: Address; currency: Address; amount: bigint }[], protocol: 0n, antiSnipe: 0n };
  for (const ev of parsed) {
    const args = ev.args as { poolId?: Hex; recipient?: Address; currency?: Address; amount?: bigint };
    if (args.poolId?.toLowerCase() !== poolId.toLowerCase()) continue;
    if (ev.eventName === 'CreatorTaxCredited') out.creatorSlots.push({ recipient: args.recipient!, currency: args.currency!, amount: args.amount! });
    if (ev.eventName === 'ProtocolFeeCredited') out.protocol += args.amount!;
    if (ev.eventName === 'AntiSnipeFeeCredited') out.antiSnipe += args.amount!;
  }
  const slots = out.creatorSlots.reduce((s, c) => s + c.amount, 0n);
  return { ...out, slots, total: slots + out.protocol + out.antiSnipe };
}

const pct = (part: bigint, whole: bigint) => (whole === 0n ? 0 : Number((part * 1_000_000n) / whole) / 10_000);

describe.skipIf(!RPC)('Clanker v5 coins from the live launcher on a Base fork: launch, trade and claim as the web does', () => {
  const now = async () => Number((await client.getBlock()).timestamp);
  const deadline = async () => BigInt((await now()) + SWAP_DEADLINE_SECONDS);
  const send = async (account: PrivateKeyAccount, tx: SwapTx) => {
    const hash = await walletOf(account).sendTransaction({ to: tx.to, data: tx.data, value: tx.value });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error(`reverted: ${hash}`);
    return receipt;
  };
  const gasOf = (r: { gasUsed: bigint; effectiveGasPrice: bigint }) => r.gasUsed * r.effectiveGasPrice;
  const balanceOf = (token: Address, owner: Address) =>
    BigInt(token) === 0n ? client.getBalance({ address: owner }) : client.readContract({ address: token, abi: erc20Abi, functionName: 'balanceOf', args: [owner] });
  const owed = (recipient: Address, currency: Address) => client.readContract({ address: V5.feeEscrow as Address, abi: feeEscrowAbi, functionName: 'owed', args: [recipient, currency] });
  const allowancesOf = async (owner: Address, token: Address) => {
    const [tokenAllowance, permit2] = await Promise.all([
      client.readContract({ address: token, abi: erc20Abi, functionName: 'allowance', args: [owner, SWAP_CONTRACTS.permit2] }),
      client.readContract({ address: SWAP_CONTRACTS.permit2, abi: permit2Abi, functionName: 'allowance', args: [owner, token, ROUTER] }),
    ]);
    return { token: tokenAllowance, permit2Amount: permit2[0], permit2Expiration: permit2[1] };
  };
  const revertOf = async (account: Address, tx: SwapTx) => {
    const err = await client.call({ account, to: tx.to, data: tx.data, value: tx.value }).then(() => null, (e: unknown) => e);
    expect(err, 'the transaction should revert').not.toBeNull();
    return err;
  };
  /** What the router holds of ETH, WETH and USDC: a swap must leave it as it was. */
  const routerHoldings = () => Promise.all([balanceOf(NATIVE_ETH, ROUTER), balanceOf(SWAP_CONTRACTS.weth, ROUTER), balanceOf(USDC, ROUTER)]);
  const sqrtPriceOf = async (key: PoolKey) => (await client.readContract({ address: SWAP_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(key)] }))[0];
  const feeRates = (poolId: Hex, isBuy: boolean) => client.readContract({ address: V5.hook as Address, abi: ClankerV5HookAbi, functionName: 'effectiveFeeRates', args: [poolId, isBuy] });

  /** The trader's approvals as the panel makes them (exact, through Permit2), checked and sent. */
  const approve = async (spent: Address, amount: bigint) => {
    const calls = approvalCalls({ coin: spent, amount, allowances: await allowancesOf(trader.address, spent), now: await now(), dataSuffix });
    expect(calls.map((c) => c.kind)).toEqual(['token', 'permit2']);
    for (const call of calls) await send(trader, call);
    const approved = await allowancesOf(trader.address, spent);
    expect(approved.token).toBe(amount);
    expect(approved.permit2Amount).toBe(amount);
  };
  const expectApprovalsSpent = async (spent: Address) => {
    const after = await allowancesOf(trader.address, spent);
    expect(after.token).toBe(0n);
    expect(after.permit2Amount).toBe(0n);
  };

  /**
   * A launch as the form prepares it: the live terms, the recommended settings with `pairedAsset` and `sniperTax`,
   * the creator's pins, the mined salt; then the launch from the creator, and every fact the indexer and the web read
   * back checked against the launcher's own views.
   */
  async function launch(pairedAsset: 'ETH' | 'USDC', sniperTax: boolean): Promise<Launched> {
    const terms = await readLaunchTerms(client, LAUNCHER, V5.factory as Address);
    const draftId = crypto.randomUUID();
    const settings = toContractSettings({ ...defaultTokenSettings(creator.address), pairedAsset, sniperTax }, `https://bootr.fun/tokens/${draftId}.json`, terms.bounds, pinsOf(terms, 0n));
    const params: V5LaunchParams = {
      name: `Fork ${pairedAsset} ${sniperTax ? 'On' : 'Off'}`,
      symbol: 'FIVE',
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
    const mined = await mineLaunchSalt({ client, launcher: LAUNCHER, tokenDeployer: V5.tokenDeployer as Address, creator: creator.address, params, settings });
    params.salt = mined.salt;
    if (params.fuelUsdc > 0n) {
      await test.setStorageAt({ address: USDC, index: usdcBalanceSlot(creator.address), value: numberToHex(params.fuelUsdc, { size: 32 }) });
      const hash = await walletOf(creator).writeContract({ address: USDC, abi: erc20Abi, functionName: 'approve', args: [LAUNCHER, params.fuelUsdc] });
      await client.waitForTransactionReceipt({ hash });
    }
    const hash = await walletOf(creator).writeContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'launch', args: [params, settings], value: launchValue(0n, terms) });
    const receipt = await client.waitForTransactionReceipt({ hash });
    expect(receipt.status).toBe('success');

    const events = parseEventLogs({ abi: clankerLauncherV5Abi, logs: receipt.logs.filter((l) => l.address.toLowerCase() === LAUNCHER.toLowerCase()) });
    const agent = events.find((e) => e.eventName === 'AgentLaunched')!.args as { token: Address; kernel: Address; creator: Address; defaults: { lpFeeBps: number; agentBps: number; burnBps: number; platformBps: number; platformRecipient: Address } };
    const v5 = events.find((e) => e.eventName === 'ClankerV5Launched')!.args as { token: Address; poolId: Hex; quoteToken: Address; antiSnipe: boolean; buyTaxBps: number; sellTaxBps: number };
    const token = agent.token;
    expect(token).toBe(mined.token);
    expect(agent.creator).toBe(creator.address);
    expect(v5.token).toBe(token);
    expect(v5.quoteToken).toBe(settings.quoteToken);
    expect(v5.antiSnipe).toBe(sniperTax);

    // The pool key the panel trades on is the one the launcher states, and it hashes to the launch's pool id.
    const onChainKey = await client.readContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'poolKeyFor', args: [token] });
    const paired = pairedAsset === 'ETH' ? null : USDC;
    const key = verifiedPoolKey(token, 'clanker-v5', v5.poolId, paired);
    expect(key, 'the web\'s v5 key hashes to the launch\'s pool id').not.toBeNull();
    expect(key).toEqual(onChainKey);
    expect(poolIdOf(onChainKey)).toBe(v5.poolId);
    expect(isNativePool(key!)).toBe(pairedAsset === 'ETH');
    expect(isErc20Paired(key!)).toBe(pairedAsset === 'USDC');

    // The indexer's own reading of the receipt (apps/indexer src/launcher.ts launchClankerV5).
    const facts = clankerV5LaunchFacts(receipt.logs, { token, launcher: LAUNCHER, poolManager: A.uniswap.poolManager as Address, factory: V5.factory as Address });
    expect(facts.launched).not.toBeNull();
    const ixSettings = clankerV5Settings({ ...facts, launched: facts.launched! }, { lpFeeBps: agent.defaults.lpFeeBps, burnBps: agent.defaults.burnBps });
    expect(ixSettings).toMatchObject({ buyTaxBps: settings.buyTaxBps, sellTaxBps: settings.sellTaxBps, burnBps: 0, dividendBps: 0, antiSnipe: sniperTax, metadataEditable: true, layout: 'settings' });
    expect(ixSettings.quoteToken.toLowerCase()).toBe(settings.quoteToken.toLowerCase());
    const ixKey = clankerV5PoolKey(token, ixSettings.quoteToken, facts.launched!.hook, facts.launched!.tickSpacing);
    expect(poolIdOf(ixKey)).toBe(v5.poolId);
    const { rewards, kinds, protocolBps, dividendBps } = clankerV5Slots(facts, {
      launcher: LAUNCHER,
      kernel: agent.kernel,
      creator: creator.address,
      taxBps: ixSettings.buyTaxBps,
      burnBps: ixSettings.burnBps,
      dividendBps: ixSettings.dividendBps,
      layout: ixSettings.layout,
      defaults: agent.defaults,
    });
    expect(kinds).toEqual(['agent', 'platform', 'creator']);
    expect(rewards[0]!.recipient).toBe(agent.kernel.toLowerCase());
    expect(rewards[2]!.recipient).toBe(creator.address.toLowerCase());
    const bps = bpsByKind(rewards, kinds);

    // The web's reading of the token row the indexer writes from those (lib/token-settings v5SettingsOf).
    const row = {
      source: 'clanker-v5',
      buyTaxBps: ixSettings.buyTaxBps,
      sellTaxBps: ixSettings.sellTaxBps,
      agentBps: bps.agent,
      creatorBps: bps.creator,
      platformBps: bps.platform,
      rewardsBps: bps.recipient,
      burnBps: bps.burn,
      dividendBps,
      protocolBps,
      minDividendHolding: null,
      antiSnipe: ixSettings.antiSnipe,
      metadataEditable: ixSettings.metadataEditable,
      metadataLocked: false,
    } as unknown as Parameters<typeof v5SettingsOf>[0];
    const web = v5SettingsOf(row)!;
    expect(web).toMatchObject({ buyTaxBps: settings.buyTaxBps, sellTaxBps: settings.sellTaxBps, splitKnown: true, antiSnipe: sniperTax });
    // The row keeps whole bps of the tax after Clanker's third (6,667), so a share comes back within 1 bps of the pool
    // share it was launched with (at 1.5%: the agent's 333 of 6,667 reads as 4.99%, creator funds as 65.01%).
    expect(Math.abs(web.agentShareBps - terms.bounds.agentShareBps)).toBeLessThanOrEqual(1);
    expect(Math.abs(web.platformShareBps - terms.bounds.platformShareBps)).toBeLessThanOrEqual(1);
    expect(Math.abs(web.creatorFundsBps - (10_000 - terms.bounds.agentShareBps - terms.bounds.platformShareBps))).toBeLessThanOrEqual(1);
    expect(web.agentShareBps + web.platformShareBps + web.creatorFundsBps).toBe(10_000);
    // The creator-funds rows the coin page reads from the hook's slots: one row, the creator's, all of creator funds.
    const slots = await client.readContract({ address: V5.hook as Address, abi: clankerV5HookSlotsAbi, functionName: 'poolFeeSlots', args: [v5.poolId] });
    expect(rowsFromSlots(slots)).toEqual([{ recipient: creator.address, admin: creator.address, bps: 10_000 }]);
    expect(await client.readContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'quoteOf', args: [token] })).toBe(settings.quoteToken);

    const launchedAt = Number((await client.getBlock({ blockNumber: receipt.blockNumber })).timestamp);
    console.log(
      `launched ${pairedAsset} coin, sniper tax ${sniperTax ? 'on' : 'off'}: ${token} (pool ${v5.poolId}), tax ${settings.buyTaxBps / 10_000}%/${settings.sellTaxBps / 10_000}%, ` +
        `row bps agent ${bps.agent} platform ${bps.platform} creator ${bps.creator} Clanker ${protocolBps}, gas ${receipt.gasUsed}; ` +
        `coin is currency${key!.currency0 === token ? 0 : 1}, opening tick ${facts.startingTick}, seeded ${facts.position?.tickLower}..${facts.position?.tickUpper}`,
    );
    const coinIsToken0 = key!.currency0 === token;
    const openingGapTicks = Math.max(0, coinIsToken0 ? facts.position!.tickLower - facts.startingTick! : facts.startingTick! - facts.position!.tickUpper);
    return { token, kernel: agent.kernel, poolId: v5.poolId, key: key!, launchedAt, platformRecipient: agent.defaults.platformRecipient, settings, openingGapTicks };
  }

  /** The creator's claim as the fee panel (`useClankerFees`) and the agent API (`buildClaims`) build it, sent by the creator. */
  async function claimAsCreator(currency: Address) {
    const amount = await owed(creator.address, currency);
    expect(amount).toBeGreaterThan(0n);
    // The fee panel: `claimFor(owner, currency)` with the builder suffix, `currency` from the coin's paired asset.
    const asset = pairedAssetByAddress(currency);
    expect(asset).not.toBeNull();
    const panelData = concat([encodeFunctionData({ abi: feeEscrowAbi, functionName: 'claimFor', args: [creator.address, BigInt(currency) === 0n ? ESCROW_ETH : asset!.address] }), dataSuffix]);
    // The agent API: the same call.
    const claims = buildClaims({
      owner: creator.address,
      weth: SWAP_CONTRACTS.weth,
      lpLocker: null,
      clankerFeeLocker: null,
      clankerFeeEscrow: V5.feeEscrow as Address,
      settled: 0n,
      unsettled: [],
      clankerAvailable: 0n,
      ...(BigInt(currency) === 0n
        ? { clankerV5Owed: amount }
        : { clankerV5Owed: 0n, clankerV5OwedOther: [{ asset: currency, symbol: asset!.symbol, decimals: asset!.decimals, amount }] }),
      dataSuffix,
    });
    expect(claims).toHaveLength(1);
    const claim = claims[0]!;
    expect(claim).toMatchObject({ path: 'clanker-v5', target: V5.feeEscrow, asset: currency, amountWei: amount.toString(), sendFrom: null });
    expect(claim.data).toBe(panelData);

    const before = await balanceOf(currency, creator.address);
    const receipt = await send(creator, { to: claim.target, data: claim.data, value: 0n });
    const after = await balanceOf(currency, creator.address);
    const received = BigInt(currency) === 0n ? after - before + gasOf(receipt) : after - before;
    expect(received).toBe(amount);
    expect(await owed(creator.address, currency)).toBe(0n);
    // Nothing left: the API offers no claim, and a claim sent anyway reverts.
    expect(buildClaims({ owner: creator.address, weth: SWAP_CONTRACTS.weth, lpLocker: null, clankerFeeLocker: null, clankerFeeEscrow: V5.feeEscrow as Address, settled: 0n, unsettled: [], clankerAvailable: 0n, clankerV5Owed: 0n })).toHaveLength(0);
    const again = await client.call({ account: creator.address, to: claim.target, data: claim.data }).then(() => null, (e: unknown) => e);
    expect(String(again)).toContain(toFunctionSelector('NothingToClaim()'));
    return amount;
  }

  /** What the escrow owes the coin's slots in `currency`. */
  const slotBalances = (c: Launched, currency: Address) => Promise.all([owed(creator.address, currency), owed(c.kernel, currency), owed(c.platformRecipient, currency)]);

  beforeAll(async () => {
    for (const a of [creator, trader]) {
      await test.setBalance({ address: a.address, value: parseEther('100') });
      // On Base these public keys may carry EIP-7702 delegations; on the fork they are plain wallets again.
      await test.setCode({ address: a.address, bytecode: '0x' });
    }
    expect(await client.readContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'paused' })).toBe(false);
    expect((await client.readContract({ address: LAUNCHER, abi: clankerLauncherV5Abi, functionName: 'feeEscrow' })).toLowerCase()).toBe(V5.feeEscrow.toLowerCase());
  });

  describe('ETH-paired, sniper tax off', () => {
    let c: Launched;
    beforeAll(async () => {
      c = await launch('ETH', false);
    });

    it('opens for trading at once: no surcharge, no wait', async () => {
      const [rates, exactOutRestricted] = await feeRates(c.poolId, true);
      expect(rates.surchargeRate).toBe(0n);
      expect(exactOutRestricted).toBe(false);
    });

    it('buys with ETH at or above the panel\'s minimum, and the tax lands in the escrow for the creator, the agent and the platform', async () => {
      const amountIn = parseEther('0.01');
      const q = await quoteSwap(client, { key: c.key, side: 'buy', amountIn });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      const tx = buildBuyTx({ key: c.key, coin: c.token, amountIn, minOut, deadline: await deadline(), dataSuffix });
      expect(tx.value).toBe(amountIn);
      const [ethBefore, coinBefore, owedBefore, router] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(c.token, trader.address), slotBalances(c, NATIVE_ETH), routerHoldings()]);
      const receipt = await send(trader, tx);
      const [ethAfter, coinAfter, owedAfter] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(c.token, trader.address), slotBalances(c, NATIVE_ETH)]);
      const received = coinAfter - coinBefore;
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(ethBefore - ethAfter - gasOf(receipt)).toBe(amountIn);
      expect(await routerHoldings()).toEqual(router);
      expect(q.feePct!).toBeCloseTo(c.settings.buyTaxBps / 10_000, 1);

      const credits = hookCredits(receipt.logs, c.poolId);
      const [dCreator, dAgent, dPlatform] = owedAfter.map((v, i) => v - owedBefore[i]!) as [bigint, bigint, bigint];
      expect(dCreator).toBeGreaterThan(0n);
      expect(dAgent).toBeGreaterThan(0n);
      expect(dPlatform).toBeGreaterThan(0n);
      expect(credits.creatorSlots.every((s) => BigInt(s.currency) === 0n)).toBe(true);
      expect(dCreator + dAgent + dPlatform).toBe(credits.slots);
      // The slots share what Clanker leaves as 65 : 5 : 30.
      expect(Number(dCreator) / Number(dAgent)).toBeCloseTo(13, 1);
      expect(Number(dPlatform) / Number(dAgent)).toBeCloseTo(6, 1);
      expect(credits.antiSnipe).toBe(0n);
      // The whole tax is the coin's buy tax on the ETH in.
      expect(pct(credits.total, amountIn)).toBeCloseTo(c.settings.buyTaxBps / 10_000, 2);
      console.log(
        `ETH coin buy: ${formatEther(amountIn)} ETH -> ${formatEther(received)} coin (quote ${formatEther(q.amountOut)}, min ${formatEther(minOut)}), fee ${q.feePct}%, impact ${q.impactPct}%, ` +
          `tax ${formatEther(credits.total)} ETH (${pct(credits.total, amountIn)}%): creator ${formatEther(dCreator)}, agent ${formatEther(dAgent)}, platform ${formatEther(dPlatform)}, Clanker ${formatEther(credits.protocol)}; gas ${receipt.gasUsed}`,
      );
    });

    it('a buy reverts when the floor is above what the pool gives, and reads as slippage', async () => {
      const amountIn = parseEther('0.01');
      const q = await quoteSwap(client, { key: c.key, side: 'buy', amountIn });
      const tx = buildBuyTx({ key: c.key, coin: c.token, amountIn, minOut: q.amountOut + q.amountOut / 100n, deadline: await deadline() });
      expect(classifySwapError(await revertOf(trader.address, tx))).toBe('slippage');
    });

    it('a sell without approvals reverts and reads as a missing approval', async () => {
      const amountIn = (await balanceOf(c.token, trader.address)) / 2n;
      const q = await quoteSwap(client, { key: c.key, side: 'sell', amountIn });
      const tx = buildSellTx({ key: c.key, coin: c.token, amountIn, minOut: minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS), deadline: await deadline() });
      expect(classifySwapError(await revertOf(trader.address, tx))).toBe('approval');
    });

    it('sells for ETH through the panel\'s exact Permit2 approvals, which end at zero', async () => {
      const balance = await balanceOf(c.token, trader.address);
      const amountIn = balance / 2n;
      const q = await quoteSwap(client, { key: c.key, side: 'sell', amountIn });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      await approve(c.token, amountIn);

      const tooHigh = buildSellTx({ key: c.key, coin: c.token, amountIn, minOut: q.amountOut + q.amountOut / 100n, deadline: await deadline() });
      expect(classifySwapError(await revertOf(trader.address, tooHigh))).toBe('slippage');

      const tx = buildSellTx({ key: c.key, coin: c.token, amountIn, minOut, deadline: await deadline(), dataSuffix });
      expect(tx.value).toBe(0n);
      const [ethBefore, owedBefore, router] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), slotBalances(c, NATIVE_ETH), routerHoldings()]);
      const receipt = await send(trader, tx);
      const [ethAfter, owedAfter] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), slotBalances(c, NATIVE_ETH)]);
      const received = ethAfter - ethBefore + gasOf(receipt);
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(await balanceOf(c.token, trader.address)).toBe(balance - amountIn);
      expect(await routerHoldings()).toEqual(router);
      expect(q.feePct!).toBeCloseTo(c.settings.sellTaxBps / 10_000, 1);
      await expectApprovalsSpent(c.token);

      const credits = hookCredits(receipt.logs, c.poolId);
      expect(owedAfter[0]! - owedBefore[0]!).toBeGreaterThan(0n);
      expect(owedAfter[1]! - owedBefore[1]!).toBeGreaterThan(0n);
      // The sell tax comes out of the ETH the pool pays.
      expect(pct(credits.total, received + credits.total)).toBeCloseTo(c.settings.sellTaxBps / 10_000, 2);
      console.log(
        `ETH coin sell: ${formatEther(amountIn)} coin -> ${formatEther(received)} ETH (quote ${formatEther(q.amountOut)}, min ${formatEther(minOut)}), fee ${q.feePct}%, ` +
          `tax ${formatEther(credits.total)} ETH (${pct(credits.total, received + credits.total)}% of the gross), creator +${formatEther(owedAfter[0]! - owedBefore[0]!)}; gas ${receipt.gasUsed}`,
      );
    });

    it('the creator claims through the web\'s claim calldata and receives ETH', async () => {
      const agentOwed = await owed(c.kernel, NATIVE_ETH);
      expect(agentOwed).toBeGreaterThan(0n);
      const amount = await claimAsCreator(NATIVE_ETH);
      console.log(`ETH coin: creator claimed ${formatEther(amount)} ETH; the agent's kernel has ${formatEther(agentOwed)} ETH waiting`);
    });
  });

  describe('ETH-paired, sniper tax on', () => {
    let c: Launched;
    const amountIn = parseEther('0.001');
    beforeAll(async () => {
      c = await launch('ETH', true);
    });

    /** A buy mined exactly `at` seconds after the launch, from the state right after it: what it got and paid. */
    const buyAt = async (at: number) => {
      const id = await test.snapshot();
      try {
        const sqrtPriceX96 = await sqrtPriceOf(c.key);
        const before = await balanceOf(c.token, trader.address);
        await test.setNextBlockTimestamp({ timestamp: BigInt(c.launchedAt + at) });
        const tx = buildBuyTx({ key: c.key, coin: c.token, amountIn, minOut: 1n, deadline: BigInt(c.launchedAt + SWAP_DEADLINE_SECONDS) });
        // A fixed gas limit: estimating gas runs at another timestamp.
        const hash: Hash = await walletOf(trader).sendTransaction({ to: tx.to, data: tx.data, value: tx.value, gas: 1_500_000n });
        const receipt = await client.waitForTransactionReceipt({ hash });
        expect(receipt.status).toBe('success');
        const received = (await balanceOf(c.token, trader.address)) - before;
        const credits = hookCredits(receipt.logs, c.poolId);
        return { at, received, totalPct: pct(credits.total, amountIn), antiSnipePct: pct(credits.antiSnipe, amountIn), shortfall: shortfallPct(received, idealOut(amountIn, sqrtPriceX96, zeroForOne(c.key, 'buy'))) };
      } finally {
        await test.revert({ id });
      }
    };

    it('right after the launch the panel says trading opens in 20 s, and the hook agrees', async () => {
      const latest = await now();
      expect(latest).toBe(c.launchedAt);
      expect(v5TradingOpensIn(c.launchedAt, latest)).toBe(CLANKER_V5_ANTI_SNIPE_SECONDS);
      const [rates, exactOutRestricted] = await feeRates(c.poolId, true);
      expect(rates.surchargeRate).toBeGreaterThan(0n);
      expect(exactOutRestricted).toBe(true);
      const q = await quoteSwap(client, { key: c.key, side: 'buy', amountIn });
      console.log(`sniper coin at launch: opens in ${v5TradingOpensIn(c.launchedAt, latest)} s; the quote reads a fee of ${q.feePct}%; hook surcharge rate ${rates.surchargeRate}`);
      expect(q.feePct!).toBeGreaterThan(50);
      expect(v5TradingOpensIn(c.launchedAt, c.launchedAt + CLANKER_V5_ANTI_SNIPE_SECONDS)).toBe(0);
    });

    it('a buy inside the 20 s pays far more tax than after, and the panel\'s wait ends where the surcharge does', async () => {
      const rows: Awaited<ReturnType<typeof buyAt>>[] = [];
      for (const at of [1, 2, 10, 19, 20, 21, 30]) rows.push(await buyAt(at));
      console.log(
        `sniper coin, ${formatEther(amountIn)} ETH buys from the state right after launch:\n` +
          rows.map((r) => `  +${r.at} s: tax ${r.totalPct}% (surcharge ${r.antiSnipePct}%), short of the pool price by ${r.shortfall.toFixed(2)}%, got ${formatEther(r.received)} coin`).join('\n'),
      );
      const byAt = (at: number) => rows.find((r) => r.at === at)!;
      const tax = c.settings.buyTaxBps / 10_000;
      expect(byAt(2).totalPct).toBeGreaterThan(80);
      expect(byAt(2).received * 5n).toBeLessThan(byAt(21).received);
      // Falls with time, and the panel's first allowed second (20 s after launch) already pays only the tax.
      expect(byAt(1).totalPct).toBeGreaterThan(byAt(10).totalPct);
      expect(byAt(10).totalPct).toBeGreaterThan(byAt(19).totalPct);
      expect(byAt(19).antiSnipePct).toBeGreaterThan(0);
      for (const at of [20, 21, 30]) {
        expect(byAt(at).antiSnipePct).toBe(0);
        expect(byAt(at).totalPct).toBeCloseTo(tax, 2);
      }
    });

    it('after the window, a buy with the panel\'s calldata goes through at the minimum', async () => {
      await test.setNextBlockTimestamp({ timestamp: BigInt(c.launchedAt + CLANKER_V5_ANTI_SNIPE_SECONDS + 1) });
      await test.mine({ blocks: 1 });
      expect(v5TradingOpensIn(c.launchedAt, await now())).toBe(0);
      const [rates, exactOutRestricted] = await feeRates(c.poolId, true);
      expect(rates.surchargeRate).toBe(0n);
      expect(exactOutRestricted).toBe(false);
      const size = parseEther('0.01');
      const q = await quoteSwap(client, { key: c.key, side: 'buy', amountIn: size });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      const before = await balanceOf(c.token, trader.address);
      const receipt = await send(trader, buildBuyTx({ key: c.key, coin: c.token, amountIn: size, minOut, deadline: await deadline(), dataSuffix }));
      const received = (await balanceOf(c.token, trader.address)) - before;
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(q.feePct!).toBeCloseTo(c.settings.buyTaxBps / 10_000, 1);
      expect(hookCredits(receipt.logs, c.poolId).antiSnipe).toBe(0n);
      console.log(`sniper coin after the window: ${formatEther(size)} ETH -> ${formatEther(received)} coin (min ${formatEther(minOut)}), fee ${q.feePct}%`);
    });
  });

  describe('USDC-paired', () => {
    let c: Launched;
    beforeAll(async () => {
      c = await launch('USDC', true);
      // Past the sniper window: these tests are about the route, not the surcharge.
      await test.setNextBlockTimestamp({ timestamp: BigInt(c.launchedAt + CLANKER_V5_ANTI_SNIPE_SECONDS + 1) });
      await test.mine({ blocks: 1 });
      await test.setStorageAt({ address: USDC, index: usdcBalanceSlot(trader.address), value: numberToHex(10_000_000_000n, { size: 32 }) });
      expect(await balanceOf(USDC, trader.address)).toBe(10_000_000_000n);
    });

    it('buys with USDC through exact Permit2 approvals, at or above the minimum, and the tax lands in USDC', async () => {
      const amountIn = 25_000_000n; // 25 USDC
      const q = await quoteSwap(client, { key: c.key, side: 'buy', amountIn });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      await approve(USDC, amountIn);
      const tx = buildBuyTx({ key: c.key, coin: c.token, amountIn, minOut, deadline: await deadline(), dataSuffix });
      expect(tx.value).toBe(0n);
      const [usdcBefore, coinBefore, owedBefore, owedEthBefore, router] = await Promise.all([
        balanceOf(USDC, trader.address),
        balanceOf(c.token, trader.address),
        slotBalances(c, USDC),
        slotBalances(c, NATIVE_ETH),
        routerHoldings(),
      ]);
      const receipt = await send(trader, tx);
      const received = (await balanceOf(c.token, trader.address)) - coinBefore;
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(usdcBefore - (await balanceOf(USDC, trader.address))).toBe(amountIn);
      expect(await routerHoldings()).toEqual(router);
      await expectApprovalsSpent(USDC);
      // The first buy also lifts the price from the opening tick to the seeded band, which the quote counts as fee.
      expect(q.feePct!).toBeCloseTo(firstTradeFeePct(c), 1);

      const credits = hookCredits(receipt.logs, c.poolId);
      expect(credits.creatorSlots.every((s) => s.currency.toLowerCase() === USDC.toLowerCase())).toBe(true);
      const owedAfter = await slotBalances(c, USDC);
      expect(owedAfter[0]! - owedBefore[0]!).toBeGreaterThan(0n);
      expect(owedAfter[1]! - owedBefore[1]!).toBeGreaterThan(0n);
      expect(await slotBalances(c, NATIVE_ETH)).toEqual(owedEthBefore);
      expect(pct(credits.total, amountIn)).toBeCloseTo(c.settings.buyTaxBps / 10_000, 1);
      console.log(
        `USDC coin buy: ${formatUnits(amountIn, 6)} USDC -> ${formatEther(received)} coin (min ${formatEther(minOut)}), fee ${q.feePct}%, impact ${q.impactPct}%, ` +
          `tax ${formatUnits(credits.total, 6)} USDC, creator +${formatUnits(owedAfter[0]! - owedBefore[0]!, 6)} USDC; gas ${receipt.gasUsed}`,
      );
    });

    it('buys with ETH through USDC in one transaction (WETH to USDC on v3, then the coin\'s pool), at or above the minimum', async () => {
      const amountIn = parseEther('0.01');
      const q = await quoteEthViaPaired(client, { key: c.key, amountIn });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      expect(q.feePct!).toBeCloseTo(c.settings.buyTaxBps / 10_000, 1);
      const tooHigh = buildEthViaPairedBuyTx({ key: c.key, coin: c.token, amountIn, minOut: q.amountOut + q.amountOut / 20n, deadline: await deadline() });
      expect(classifySwapError(await revertOf(trader.address, tooHigh))).toBe('slippage');

      const tx = buildEthViaPairedBuyTx({ key: c.key, coin: c.token, amountIn, minOut, deadline: await deadline(), dataSuffix });
      expect(tx.value).toBe(amountIn);
      const [ethBefore, usdcBefore, coinBefore, router] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(USDC, trader.address), balanceOf(c.token, trader.address), routerHoldings()]);
      const receipt = await send(trader, tx);
      const [ethAfter, usdcAfter, coinAfter] = await Promise.all([balanceOf(NATIVE_ETH, trader.address), balanceOf(USDC, trader.address), balanceOf(c.token, trader.address)]);
      const received = coinAfter - coinBefore;
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(ethBefore - ethAfter - gasOf(receipt)).toBe(amountIn);
      expect(usdcAfter).toBe(usdcBefore);
      expect(await routerHoldings()).toEqual(router);
      const credits = hookCredits(receipt.logs, c.poolId);
      expect(credits.creatorSlots.length).toBeGreaterThan(0);
      expect(credits.creatorSlots.every((s) => s.currency.toLowerCase() === USDC.toLowerCase())).toBe(true);
      console.log(
        `USDC coin buy with ETH: ${formatEther(amountIn)} ETH -> ~${formatUnits(q.viaPaired, 6)} USDC estimated -> ${formatEther(received)} coin ` +
          `(quote ${formatEther(q.amountOut)}, ${((Number(received) / Number(q.amountOut) - 1) * 100).toFixed(5)}% off it, min ${formatEther(minOut)}), fee ${q.feePct}%, impact ${q.impactPct}%, tax ${formatUnits(credits.total, 6)} USDC; gas ${receipt.gasUsed}`,
      );
    });

    it('sells to USDC through the panel\'s approvals, which end at zero', async () => {
      const balance = await balanceOf(c.token, trader.address);
      const amountIn = balance / 2n;
      const q = await quoteSwap(client, { key: c.key, side: 'sell', amountIn });
      const minOut = minReceived(q.amountOut, DEFAULT_SLIPPAGE_BPS);
      await approve(c.token, amountIn);
      const tooHigh = buildSellTx({ key: c.key, coin: c.token, amountIn, minOut: q.amountOut + q.amountOut / 100n, deadline: await deadline() });
      expect(classifySwapError(await revertOf(trader.address, tooHigh))).toBe('slippage');

      const tx = buildSellTx({ key: c.key, coin: c.token, amountIn, minOut, deadline: await deadline(), dataSuffix });
      const [usdcBefore, router] = await Promise.all([balanceOf(USDC, trader.address), routerHoldings()]);
      const receipt = await send(trader, tx);
      const received = (await balanceOf(USDC, trader.address)) - usdcBefore;
      expect(received).toBe(q.amountOut);
      expect(received).toBeGreaterThanOrEqual(minOut);
      expect(await balanceOf(c.token, trader.address)).toBe(balance - amountIn);
      expect(await routerHoldings()).toEqual(router);
      await expectApprovalsSpent(c.token);
      const credits = hookCredits(receipt.logs, c.poolId);
      expect(pct(credits.total, received + credits.total)).toBeCloseTo(c.settings.sellTaxBps / 10_000, 1);
      console.log(`USDC coin sell: ${formatEther(amountIn)} coin -> ${formatUnits(received, 6)} USDC (quote ${formatUnits(q.amountOut, 6)}, min ${formatUnits(minOut, 6)}), fee ${q.feePct}%, tax ${formatUnits(credits.total, 6)} USDC; gas ${receipt.gasUsed}`);
    });

    it('the creator claims through the web\'s claim calldata and receives USDC', async () => {
      const agentOwed = await owed(c.kernel, USDC);
      expect(agentOwed).toBeGreaterThan(0n);
      const amount = await claimAsCreator(USDC);
      console.log(`USDC coin: creator claimed ${formatUnits(amount, 6)} USDC; the agent's kernel has ${formatUnits(agentOwed, 6)} USDC waiting`);
    });
  });
});
