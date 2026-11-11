/**
 * The indexer side of the Clanker v5 token settings (docs/design/clanker-v5-token-settings.md, section 5's indexer row):
 * the settings event and the settings on the token row, USDC-quoted pools, fee slots by recipient and admin with a slot
 * admin's changes, burn and dividends per trade, and the creator's metadata edits. Pure helpers only, like the other
 * handler tests: every handler is a thin wrapper around these.
 */
import { decodeEventLog, encodeAbiParameters, encodeEventTopics, toEventSelector, type Abi, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { BootrClankerLauncherV5Abi, ClankerV5LaunchedEvent, ClankerV5MetadataEvents } from '../../abis/BootrClankerLauncherV5';
import { ClankerV5FactoryAbi, ClankerV5HookAbi, ClankerV5TokenAbi, PoolManagerLaunchAbi } from '../../abis/ClankerV5';
import {
  CLANKER_V5_SUPPLY,
  CLANKER_V5_TOPICS,
  clankerV5LaunchFacts,
  clankerV5PoolKey,
  clankerV5Settings,
  clankerV5Slots,
  decodeClankerV5Launched,
  decodeLauncherMetadataEdit,
  decodeQuoteAllowed,
  decodeV5HookCredit,
  decodeV5SlotUpdate,
  dividendPatch,
  metadataEditPatch,
  pickV5Slot,
  slotUpdatePatch,
} from './clanker';
import { bpsByKind, classifyV5Slots, DEAD_ADDRESS, settingsSlotWeights, swapFeeUsd, v5SideTaxPips } from './fees';
import { poolIdOf } from './pool';
import { coinPriceInQuote, liquidityUsd, positionAmounts } from './price';
import { marketFields, quoteAsset, quoteUsd, quoteValueUsd } from './quote';

const NATIVE: Address = '0x0000000000000000000000000000000000000000';
const WETH: Address = '0x4200000000000000000000000000000000000006';
const USDC: Address = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const ADDRS = { weth: WETH, usdc: USDC };
/** Below USDC: the coin is currency0 of a USDC pool. */
const COIN: Address = '0x0123000000000000000000000000000000000ccc';
const HOOK: Address = '0x5e320ea6278107968c119942e57d876c5f922acc';
const ESCROW: Address = '0x5dd237d1f716c65426ccd2fae82b95109825fa61';
const FACTORY: Address = '0x572e88d3cd7f23e4241eb6cedd96667271bf09a0';
const PM: Address = '0x498581ff718922c3f8e6a244956af099b2652b2b';
const LAUNCHER: Address = '0x00000000000000000000000000000000000000e5';
const TRACKER: Address = '0x00000000000000000000000000000000000000d1';
const CLANKER_FEES: Address = '0x7a2e54e3aa9c4d02f6c9b950dcd33054d2043829';
const kernel: Address = '0x00000000000000000000000000000000000000a1';
const creator: Address = '0x00000000000000000000000000000000000000c1';
const platformRecipient: Address = '0x00000000000000000000000000000000000000f1';
const friend: Address = '0x00000000000000000000000000000000000000b2';
const friendAdmin: Address = '0x00000000000000000000000000000000000000b3';
const dao: Address = '0x00000000000000000000000000000000000000b4';

type Item = { type: string; name?: string; inputs?: readonly { name: string; type: string; indexed?: boolean }[] };
const fragment = (abi: readonly unknown[], eventName: string) => (abi as readonly Item[]).find((i) => i.type === 'event' && i.name === eventName)!;
const log = (address: string, abi: readonly unknown[], eventName: string, args: Record<string, unknown>) => {
  const ev = fragment(abi, eventName);
  const topics = encodeEventTopics({ abi: [ev] as Abi, eventName, args: args as never }) as Hex[];
  const plain = ev.inputs!.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain as never, plain.map((i) => args[i.name]) as never);
  return { address, topics, data };
};
/** Encode then decode, as Ponder hands a handler its `event.args`. */
const argsOf = (abi: readonly unknown[], eventName: string, args: Record<string, unknown>) => {
  const l = log(HOOK, abi, eventName, args);
  return decodeEventLog({ abi: [fragment(abi, eventName)] as Abi, data: l.data, topics: l.topics as [Hex, ...Hex[]] }).args as unknown as Record<string, unknown>;
};

const key = clankerV5PoolKey(COIN, USDC, HOOK, 200);
const poolId = poolIdOf(key);

// A USDC launch: buy 2%, sell 3%, burn 10% and dividends 20% of the post-Clanker pool, the creator's row and two extra
// rows (35% left for creator funds: 5 / 30 / 35 / 10 / 20), sniper tax off, editable metadata on.
// The slot pool is agent + platform + creator funds = 7000: weights ceil(500 × 10000 / 7000) = 715, floor(3000 × 10000 /
// 7000) = 4285, the rows 5000 split 50 / 30 / 20 by the creator.
const slotsIn = [
  { recipient: kernel, admin: LAUNCHER, weightBps: 715 },
  { recipient: platformRecipient, admin: LAUNCHER, weightBps: 4285 },
  { recipient: creator, admin: creator, weightBps: 2500 },
  { recipient: friend, admin: friendAdmin, weightBps: 1500 },
  { recipient: dao, admin: dao, weightBps: 1000 },
];
const receipt = [
  log(PM, PoolManagerLaunchAbi, 'Initialize', { id: poolId, currency0: COIN, currency1: USDC, fee: 0, tickSpacing: 200, hooks: HOOK, sqrtPriceX96: 1n, tick: -400_600 }),
  ...slotsIn.map((s, i) => log(HOOK, ClankerV5HookAbi, 'FeeSlotCreated', { poolId, slotIndex: BigInt(i), ...s, isCreator: false })),
  log(COIN, ClankerV5TokenAbi, 'ExtraMetadataUpdated', { updater: FACTORY, metadataKey: 'image', metadataValue: 'ipfs://img' }),
  log(COIN, ClankerV5TokenAbi, 'ExtraMetadataUpdated', { updater: FACTORY, metadataKey: 'metadata', metadataValue: '{"description":"a coin"}' }),
  log(COIN, ClankerV5TokenAbi, 'DividendInitialized', { dividendContract: TRACKER }),
  log(FACTORY, ClankerV5FactoryAbi, 'LaunchTaxConfigured', {
    poolId,
    token: COIN,
    configVersion: 23n,
    admittedPolicy: {
      taxFeeBounds: { minimumBuyTaxRate: 1_000_000, maximumBuyTaxRate: 10_000_000, minimumSellTaxRate: 1_000_000, maximumSellTaxRate: 10_000_000 },
      protocolFeeConfiguration: { protocolTaxShare: 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000, protocolFeeRecipient: CLANKER_FEES },
      antiSnipeConfiguration: { startTotalFeeRate: 99_000_000, windowSeconds: 20 },
      minimumDividendHoldingRequirement: 10n ** 22n,
    },
    taxConfiguration: {
      buyTaxRate: 2_000_000,
      sellTaxRate: 3_000_000,
      creatorAllocationShare: 70_000_000,
      burnAllocationShare: 10_000_000,
      dividendAllocationShare: 20_000_000,
      integratorAllocationShare: 0,
      minimumDividendHolding: 10n ** 22n,
    },
    integratorFeeRecipient: NATIVE,
    antiSnipeEnabled: false,
  }),
  log(FACTORY, ClankerV5FactoryAbi, 'Launched', { token: COIN, poolId, originalCreator: LAUNCHER, quoteToken: USDC, launchSupply: CLANKER_V5_SUPPLY, tickSpacing: 200 }),
  log(LAUNCHER, [ClankerV5LaunchedEvent], 'ClankerV5Launched', {
    token: COIN,
    poolId,
    hook: HOOK,
    feeEscrow: ESCROW,
    quoteToken: USDC,
    tickSpacing: 200,
    buyTaxBps: 20_000,
    sellTaxBps: 30_000,
    burnBps: 1000,
    dividendBps: 2000,
    antiSnipe: false,
    metadataEditable: true,
  }),
];
const defaults = { lpFeeBps: 20_000, agentBps: 500, burnBps: 1000, platformBps: 3000, platformRecipient };
const facts = clankerV5LaunchFacts(receipt, { token: COIN, launcher: LAUNCHER, poolManager: PM, factory: FACTORY });

describe('the token-settings launch event and the settings on the token row', () => {
  it('pins the topics: the expected launcher events and the verified Clanker events the indexer now reads', () => {
    expect(CLANKER_V5_TOPICS).toMatchObject({
      ClankerV5Launched: toEventSelector('ClankerV5Launched(address,bytes32,address,address,address,int24,uint24,uint24,uint16,uint16,bool,bool)'),
      CoinImageUpdated: toEventSelector('CoinImageUpdated(address,string)'),
      CoinMetadataUpdated: toEventSelector('CoinMetadataUpdated(address,string)'),
      CoinMetadataLocked: toEventSelector('CoinMetadataLocked(address)'),
      QuoteAllowedUpdated: toEventSelector('QuoteAllowedUpdated(uint8,address,bool)'),
      DividendTaxCredited: toEventSelector('DividendTaxCredited(bytes32,address,address,uint256)'),
      DividendTaxRedirected: toEventSelector('DividendTaxRedirected(bytes32,address,address,uint256)'),
      FeeSlotRecipientUpdated: toEventSelector('FeeSlotRecipientUpdated(bytes32,uint256,address,address)'),
      FeeSlotAdminUpdated: toEventSelector('FeeSlotAdminUpdated(bytes32,uint256,address,address)'),
      ExtraMetadataUpdated: toEventSelector('ExtraMetadataUpdated(address,string,string)'),
      DividendInitialized: toEventSelector('DividendInitialized(address)'),
    });
  });

  it('the security-reviewed launcher ABI keeps every event the indexer follows; only Rescued is new', () => {
    const events = BootrClankerLauncherV5Abi.filter((e) => e.type === 'event').map((e) => toEventSelector(e as never));
    for (const sig of [
      'AgentLaunched(address,address,address,address,uint256,(uint24,uint16,uint16,uint16,uint16,address,uint256,uint32),bytes32,string,string,address)',
      'ClankerV5Launched(address,bytes32,address,address,address,int24,uint24,uint24,uint16,uint16,bool,bool)',
      'LaunchContext(address,string)',
      'LaunchFeePaid(address,address,uint256)',
      'CoinImageUpdated(address,string)',
      'CoinMetadataUpdated(address,string)',
      'CoinMetadataLocked(address)',
      'QuoteAllowedUpdated(uint8,address,bool)',
      'Rescued(address,address,uint256)',
    ]) {
      expect(events, sig).toContain(toEventSelector(sig));
    }
    // The five pins at the end of TokenSettings (what the web signs), and the stored tick spacing.
    const launch = BootrClankerLauncherV5Abi.find((e) => e.type === 'function' && e.name === 'launch') as { inputs: readonly { components?: readonly { name: string }[] }[] };
    expect(launch.inputs[1]!.components!.slice(-5).map((c) => c.name)).toEqual(['minDevBuyOut', 'expectedConfigVersion', 'maxLaunchFeeWei', 'expectedAgentShareBps', 'expectedPlatformShareBps']);
    expect(BootrClankerLauncherV5Abi.some((e) => e.type === 'function' && e.name === 'tickSpacingOf')).toBe(true);
  });

  it('decodes the settings event and reads the rest of the receipt: Clanker’s shares, the genesis metadata, the tracker', () => {
    expect(facts.launched).toEqual({
      token: COIN,
      poolId,
      hook: HOOK,
      feeEscrow: ESCROW,
      quoteToken: USDC,
      tickSpacing: 200,
      taxBps: 20_000,
      buyTaxBps: 20_000,
      sellTaxBps: 30_000,
      burnBps: 1000,
      dividendBps: 2000,
      antiSnipe: false,
      metadataEditable: true,
      layout: 'settings',
    });
    expect(facts.taxRate).toBe(2_000_000);
    expect(facts.sellTaxRate).toBe(3_000_000);
    expect(facts.burnBps).toBe(1000);
    expect(facts.dividendBps).toBe(2000);
    expect(facts.minDividendHolding).toBe(10n ** 22n);
    expect(facts.antiSnipe).toBe(false);
    expect(facts.quoteToken).toBe(USDC);
    expect(facts.extraMetadata).toEqual({ image: 'ipfs://img', metadata: '{"description":"a coin"}' });
    expect(facts.dividendContract).toBe(TRACKER);
    expect(facts.slots.map((s) => [s.recipient, s.admin])).toEqual(slotsIn.map((s) => [s.recipient, s.admin]));
    // Another log shape from the launcher is not a launch.
    expect(decodeClankerV5Launched(log(LAUNCHER, ClankerV5MetadataEvents, 'CoinMetadataLocked', { token: COIN }))).toBeNull();
  });

  it('decides the settings: the launcher’s event first, Clanker’s LaunchTaxConfigured next, the defaults last', () => {
    expect(clankerV5Settings({ ...facts, launched: facts.launched! }, defaults)).toEqual({
      buyTaxBps: 20_000,
      sellTaxBps: 30_000,
      burnBps: 1000,
      dividendBps: 2000,
      minDividendHolding: 10n ** 22n,
      antiSnipe: false,
      metadataEditable: true,
      quoteToken: USDC,
      layout: 'settings',
    });
    // The fixed launcher carried one tax and no burn / dividend / editable fields: Clanker's event fills the sides.
    const fixed = { ...facts.launched!, buyTaxBps: 0, sellTaxBps: 0, taxBps: 0, burnBps: null, dividendBps: null, metadataEditable: null, layout: 'fixed' as const };
    const s = clankerV5Settings({ ...facts, launched: fixed }, defaults);
    expect([s.buyTaxBps, s.sellTaxBps, s.burnBps, s.dividendBps, s.metadataEditable]).toEqual([20_000, 30_000, 1000, 2000, false]);
    // Nothing but the defaults: one tax both sides, no dividends.
    const bare = clankerV5Settings(
      { launched: fixed, taxRate: null, sellTaxRate: null, burnBps: null, dividendBps: null, minDividendHolding: null, antiSnipe: null, quoteToken: null },
      { lpFeeBps: 15_000, burnBps: 0 },
    );
    expect([bare.buyTaxBps, bare.sellTaxBps, bare.burnBps, bare.dividendBps, bare.minDividendHolding]).toEqual([15_000, 15_000, 0, 0, null]);
  });
});

describe('fee slots by recipient and admin', () => {
  it('classifies the settings layout: launcher-admin agent and platform, then the creator’s row, then extra rows', () => {
    const settings = clankerV5Settings({ ...facts, launched: facts.launched! }, defaults);
    const { rewards, kinds, protocolBps, dividendBps, burnSlot } = clankerV5Slots(facts, {
      launcher: LAUNCHER,
      kernel,
      creator,
      taxBps: settings.buyTaxBps,
      burnBps: settings.burnBps,
      dividendBps: settings.dividendBps,
      layout: settings.layout,
      defaults,
    });
    expect(kinds).toEqual(['agent', 'platform', 'creator', 'recipient', 'recipient', 'burn']);
    expect(burnSlot).toBe(5);
    expect(rewards.map((r) => r.admin)).toEqual([LAUNCHER, LAUNCHER, creator, friendAdmin, dao, LAUNCHER]);
    // Clanker keeps 0.5% of a 2% trade: 2500 bps of the tax; the rest is 7500.
    expect(protocolBps).toBe(2500);
    const bps = bpsByKind(rewards, kinds);
    expect(bps.burn).toBe(750);
    expect(dividendBps).toBe(1500);
    expect(bps.agent + bps.creator + bps.recipient + bps.burn + bps.platform + dividendBps + protocolBps).toBe(10_000);
    // The agent never below its 5% of the post-Clanker pool, the platform never above its 30%; the rounding gap lands on
    // the last row, where Clanker puts its wei remainder.
    expect(rewards.map((r) => r.bps)).toEqual([375, 2249, 1312, 787, 527, 750]);
    expect(bps.agent).toBe(Math.floor(7500 * 0.05));
    expect(bps.platform).toBeLessThanOrEqual(7500 * 0.3);
    expect(bps.recipient).toBe(rewards[3]!.bps + rewards[4]!.bps);
  });

  it('a creator row that pays someone else is still the creator’s; a launcher-admin stranger is unclassified', () => {
    const t = { launcher: LAUNCHER, kernel, creator, platformRecipient };
    expect(
      classifyV5Slots(
        [
          { recipient: kernel, admin: LAUNCHER },
          { recipient: platformRecipient, admin: LAUNCHER },
          { recipient: friend, admin: creator },
          { recipient: '0x00000000000000000000000000000000000000ee', admin: LAUNCHER },
        ],
        t,
        'settings',
      ),
    ).toEqual(['agent', 'platform', 'creator', null]);
    // The platform launching its own coin (creator == platform recipient): the admin tells the two slots apart.
    expect(
      classifyV5Slots(
        [
          { recipient: kernel, admin: LAUNCHER },
          { recipient: platformRecipient, admin: LAUNCHER },
          { recipient: platformRecipient, admin: platformRecipient },
        ],
        { ...t, creator: platformRecipient },
        'settings',
      ),
    ).toEqual(['agent', 'platform', 'creator']);
    // No creator funds (burn + dividends take the rest): only the two locked slots.
    expect(classifyV5Slots(slotsIn.slice(0, 2), t, 'settings')).toEqual(['agent', 'platform']);
  });

  it('falls back to the launcher’s weights when the hook’s slots are out of reach (design note 2.2 examples)', () => {
    expect(settingsSlotWeights({ agentBps: 500, platformBps: 3000, burnBps: 0, dividendBps: 0 })).toEqual([500, 3000, 6500]);
    expect(settingsSlotWeights({ agentBps: 500, platformBps: 3000, burnBps: 3000, dividendBps: 3500 })).toEqual([1429, 8571]);
    const s = clankerV5Slots(
      { slots: [], policy: null },
      { launcher: LAUNCHER, kernel, creator, taxBps: 15_000, burnBps: 0, dividendBps: 0, layout: 'settings', defaults },
    );
    expect(s.kinds).toEqual(['agent', 'platform', 'creator']);
    expect(s.rewards.map((r) => r.recipient)).toEqual([kernel, platformRecipient, creator]);
  });

  it('follows a slot admin’s change: the row takes the new recipient and the hook’s next credit lands on that slot', () => {
    const u = decodeV5SlotUpdate('FeeSlotRecipientUpdated', argsOf(ClankerV5HookAbi, 'FeeSlotRecipientUpdated', { poolId, slotIndex: 3n, oldRecipient: friend, newRecipient: dao }))!;
    expect(u).toEqual({ poolId, slot: 3, field: 'recipient', from: friend, to: dao });
    const rows = [
      { slot: 0, recipient: kernel, admin: LAUNCHER, recipientKind: 'agent' },
      { slot: 2, recipient: creator, admin: creator, recipientKind: 'creator' },
      { slot: 3, recipient: friend, admin: friendAdmin, recipientKind: 'recipient' },
    ];
    const { patch, stale } = slotUpdatePatch(rows[2]!, u);
    expect(patch).toEqual({ recipient: dao });
    expect(stale).toBe(false);
    const moved = rows.map((r) => (r.slot === 3 ? { ...r, ...patch } : r));
    expect(pickV5Slot(moved, dao, 0)?.slot).toBe(3);
    expect(pickV5Slot(moved, friend, 0)).toBeNull();
    // An admin handover changes the admin only; a row that did not hold `from` is stale but still follows the hook.
    const a = decodeV5SlotUpdate('FeeSlotAdminUpdated', argsOf(ClankerV5HookAbi, 'FeeSlotAdminUpdated', { poolId, slotIndex: 2n, oldAdmin: friendAdmin, newAdmin: dao }))!;
    expect(slotUpdatePatch(rows[1]!, a)).toEqual({ patch: { admin: dao }, stale: true });
    expect(decodeV5SlotUpdate('FeeSlotCreated', {})).toBeNull();
  });
});

describe('USDC-quoted pools', () => {
  it('knows the paired assets: ETH and WETH at ETH/USD with 18 decimals, USDC at $1 with 6', () => {
    expect(quoteAsset(NATIVE, ADDRS)).toEqual({ symbol: 'ETH', decimals: 18 });
    expect(quoteAsset(WETH.toUpperCase().replace('0X', '0x'), ADDRS)).toEqual({ symbol: 'WETH', decimals: 18 });
    expect(quoteAsset(USDC, ADDRS)).toEqual({ symbol: 'USDC', decimals: 6 });
    expect(quoteAsset('0x00000000000000000000000000000000000000aa', ADDRS)).toEqual({ symbol: '?', decimals: 18 });
    expect([quoteUsd('ETH', 3000), quoteUsd('WETH', 3000), quoteUsd('USDC', 3000), quoteUsd('?', 3000)]).toEqual([3000, 3000, 1, 0]);
    expect(quoteValueUsd({ pairedSymbol: 'USDC', pairedDecimals: 6 }, 12_345_678n, 3000)).toBe(12.345678);
    expect(quoteValueUsd({ pairedSymbol: 'ETH', pairedDecimals: 18 }, 10n ** 17n, 3000)).toBe(300);
  });

  it('prices a coin at Clanker’s USDC start tick at about $4,000 of market cap, from either side of the pool', () => {
    const at = (tick: number) => BigInt(Math.floor(Math.sqrt(1.0001 ** tick) * 2 ** 96));
    const base = { totalSupply: CLANKER_V5_SUPPLY, positionLiquidity: 0n, poolLiquidity: 0n, tickLower: -400_600, tickUpper: 887_200, pairedSymbol: 'USDC', pairedDecimals: 6 };
    const token0 = marketFields({ ...base, sqrtPriceX96: at(-400_600), coinIsToken0: true }, 3000);
    const token1 = marketFields({ ...base, sqrtPriceX96: at(400_600), coinIsToken0: false }, 3000);
    for (const m of [token0, token1]) {
      expect(m.marketCapUsd).toBeGreaterThan(3900);
      expect(m.marketCapUsd).toBeLessThan(4100);
      expect(m.priceUsd).toBeCloseTo(m.priceQuote, 12);
      expect(m.priceWeth).toBeCloseTo(m.priceUsd / 3000, 14);
    }
    expect(token0.priceUsd).toBeCloseTo(token1.priceUsd, 10);
    // The raw pool price is 1e12 off without the decimals: the same tick read as an 18-decimal quote.
    expect(coinPriceInQuote(at(-400_600), true, 6) / coinPriceInQuote(at(-400_600), true, 18)).toBeCloseTo(1e12, -3);
    // ETH pools are unchanged: price in WETH = price in the quote.
    const eth = marketFields({ ...base, pairedSymbol: 'ETH', pairedDecimals: 18, sqrtPriceX96: at(-201_000), coinIsToken0: true }, 2125);
    expect(eth.priceWeth).toBe(eth.priceQuote);
    expect(eth.marketCapUsd).toBeGreaterThan(3800);
    expect(eth.marketCapUsd).toBeLessThan(4100);
  });

  it('values the quote side of the liquidity in its own decimals', () => {
    const L = 10n ** 15n;
    const sqrt = BigInt(Math.floor(Math.sqrt(1.0001 ** -390_000) * 2 ** 96));
    // Price above the range: the coin (token0) is all sold, the position holds only USDC.
    const { amount1 } = positionAmounts(L, sqrt, -400_600, -395_000);
    const v = liquidityUsd({ liquidity: L, sqrtPriceX96: sqrt, tickLower: -400_600, tickUpper: -395_000, coinIsToken0: true, ethUsd: 1, quoteDecimals: 6 });
    expect(v).toBeCloseTo(amount1 / 1e6, 4);
  });

  it('charges each side its own tax: a v5 buy at the buy tax, a sell at the sell tax', () => {
    const t = { lpFeeBps: 20_000, buyTaxBps: 20_000, sellTaxBps: 30_000 };
    expect(v5SideTaxPips(t, 'buy')).toBe(20_000);
    expect(v5SideTaxPips(t, 'sell')).toBe(30_000);
    expect(swapFeeUsd('clanker-v5', 1000, 0, v5SideTaxPips(t, 'sell'))).toBe(30);
    // Coins without side rates (other paths, the fixed launcher) pay `lpFeeBps`.
    expect(v5SideTaxPips({ lpFeeBps: 15_000, buyTaxBps: null, sellTaxBps: null }, 'sell')).toBe(15_000);
  });
});

describe('burn and dividends per trade', () => {
  const credit = (eventName: string, args: Record<string, unknown>) => decodeV5HookCredit(eventName, argsOf(ClankerV5HookAbi, eventName, args));

  it('decodes the four hook credits once for the handlers and the launch replay', () => {
    expect(credit('CreatorTaxCredited', { poolId, recipient: kernel, currency: USDC, amount: 7n })).toEqual({ kind: 'slot', poolId, recipient: kernel, asset: USDC, amount: 7n });
    expect(credit('BurnTaxCredited', { poolId, token: COIN, sink: DEAD_ADDRESS, amount: 9n })).toEqual({ kind: 'burn', poolId, recipient: DEAD_ADDRESS, asset: COIN, amount: 9n });
    expect(credit('DividendTaxCredited', { poolId, dividend: TRACKER, currency: USDC, amount: 11n })).toEqual({ kind: 'dividend', poolId, recipient: TRACKER, asset: USDC, amount: 11n });
    expect(credit('DividendTaxRedirected', { poolId, recipient: CLANKER_FEES, currency: USDC, amount: 13n })).toEqual({
      kind: 'dividendRedirected',
      poolId,
      recipient: CLANKER_FEES,
      asset: USDC,
      amount: 13n,
    });
    expect(decodeV5HookCredit('Trade', {})).toBeNull();
  });

  it('a buy and a sell in one transaction each credit the burn, in the coin, to the dead address', () => {
    const buy = credit('BurnTaxCredited', { poolId, token: COIN, sink: DEAD_ADDRESS, amount: 100n })!;
    const sell = credit('BurnTaxCredited', { poolId, token: COIN, sink: DEAD_ADDRESS, amount: 150n })!;
    expect([buy.kind, sell.kind]).toEqual(['burn', 'burn']);
    expect(buy.asset).toBe(COIN);
    expect(buy.amount + sell.amount).toBe(250n);
  });

  it('adds the tracker’s share to the coin’s dividend total and the redirected share apart; names the tracker once', () => {
    const t = { dividendContract: null, dividendsTotalUsd: 1.5, dividendsRedirectedUsd: 0 };
    expect(dividendPatch(t, { kind: 'dividend', recipient: TRACKER as Address }, 0.25)).toEqual({ dividendsTotalUsd: 1.75, dividendContract: TRACKER });
    expect(dividendPatch({ ...t, dividendContract: TRACKER }, { kind: 'dividend', recipient: TRACKER as Address }, 0.25)).toEqual({ dividendsTotalUsd: 1.75 });
    expect(dividendPatch(t, { kind: 'dividendRedirected', recipient: CLANKER_FEES as Address }, 0.5)).toEqual({ dividendsRedirectedUsd: 0.5 });
  });
});

describe('metadata edits through the launcher', () => {
  const edit = (eventName: string, args: Record<string, unknown>) => decodeLauncherMetadataEdit(eventName, argsOf(ClankerV5MetadataEvents, eventName, args));

  it('serves the edited image and metadata, and a lock ends editing for good', () => {
    const img = edit('CoinImageUpdated', { token: COIN, image: 'ipfs://new' })!;
    expect(img).toEqual({ token: COIN, field: 'image', value: 'ipfs://new' });
    expect(metadataEditPatch(img, 1_000)).toEqual({ image: 'ipfs://new', metadataUpdatedAt: 1_000 });
    const meta = edit('CoinMetadataUpdated', { token: COIN, metadata: '{"description":"new"}' })!;
    expect(metadataEditPatch(meta, 1_001)).toEqual({ metadata: '{"description":"new"}', metadataUpdatedAt: 1_001 });
    const lock = edit('CoinMetadataLocked', { token: COIN })!;
    expect(metadataEditPatch(lock, 1_002)).toEqual({ metadataLocked: true, metadataEditable: false, metadataUpdatedAt: 1_002 });
    expect(decodeLauncherMetadataEdit('LaunchContext', {})).toBeNull();
    // The fragments are the compiled contract's (regenerated from forge).
    expect(ClankerV5MetadataEvents.map((e) => e.name)).toEqual(['CoinImageUpdated', 'CoinMetadataUpdated', 'CoinMetadataLocked']);
  });

  it('records the owner’s paired-asset allow-list per launch kind', () => {
    const a = argsOf(BootrClankerLauncherV5Abi, 'QuoteAllowedUpdated', { kind: 0, quote: USDC, allowed: true });
    expect(decodeQuoteAllowed(LAUNCHER, a)).toEqual({ id: `${LAUNCHER}-agent-${USDC}`, launcher: LAUNCHER, kind: 'agent', quote: USDC, allowed: true });
    expect(decodeQuoteAllowed(LAUNCHER, { kind: 1, quote: NATIVE, allowed: false }).kind).toBe('plain');
    expect(decodeQuoteAllowed(LAUNCHER, { kind: 7, quote: NATIVE, allowed: false }).kind).toBe('7');
  });
});
