/**
 * One coin's locked fee split, in plain percentages. A coin's trades pay into that coin's own slots, so these figures
 * say nothing about any other coin or about Bootr as a whole.
 *
 * Two users: the `coinFees` section of every agent's first observation (its own coin) and `read_coin` (any coin). Null
 * when a needed figure is missing: an agent without the number does not state it, and never states a split its coin
 * does not have.
 *
 * Sources:
 * - the indexer's token fields (`source`, `lpFeeBps`, `agentBps`, `creatorBps`, `burnBps`, `platformBps`, `protocolBps`;
 *   apps/indexer/src/lib/fees.ts has the math), from the market snapshot the tick already read or `read_coin`'s row;
 * - for its own Clanker v5 coin, the creator's token settings read from the launch receipt at registration
 *   (`config.clankerV5.settings`, onboarding.ts `decodeClankerV5Launch`): the chain's own record, preferred to the indexer.
 *
 * - bootr (RWAGMI): a trade pays the swap fee; RWAGMI's `protocolBps` slot is inside it, the coin's slots share the rest.
 * - clanker: the coin's slots share the whole swap fee; Clanker's `protocolBps` comes on top, so a trade pays more.
 * - clanker-v5 (docs/design/clanker-v5-token-settings.md sections 1 and 2): every buy pays the buy tax and every sell
 *   the sell tax; Clanker's cut is taken from it first (`clamp(tax × 10%, 0.5%, 1%)` of the trade under today's policy)
 *   and the rest is split by the creator's settings: the agent and platform slots, the creator's own row, any extra
 *   reward rows ("other recipients", never named), the holder dividends and the burn (taken in the coin). Fees are paid
 *   in the coin's paired asset (ETH or USDC). From the indexer a v5 row must carry `buyTaxBps`, `sellTaxBps`,
 *   `dividendsBps` and `recipientBps` (the settings launcher's fields); a row without them gets no split.
 */
import type { AgentConfig } from '@bootr/agent-core';
import { getAddresses } from '@bootr/shared/addresses';
import { CLANKER_V5_DEFAULT_POLICY, type ClankerV5LaunchDetails, type ClankerV5ProtocolPolicy, type ClankerV5TokenSettings } from './launch-source.js';

const BPS = 10_000;
/** `lpFeeBps` is 1e6-based: 10000 is 1%. */
const LP_FEE_PER_PCT = 10_000;
/** Clanker v5's 1e8 scale (1e8 = 100%); a tax in hundredths of a bip is a hundredth of it. */
const V5_SCALE = 100_000_000;
const V5_TAX_MULTIPLIER = 100;
/** One coin is 1e18 raw units. */
const COIN = 10n ** 18n;

export type FeeRecipient = 'agent' | 'creator' | 'otherRecipients' | 'holderDividends' | 'burn' | 'platform';

export interface CoinFeeSplit {
  launchedThrough: 'RWAGMI' | 'Clanker' | 'Clanker v5';
  /** Of each trade's value (on Clanker v5: of each buy). */
  traderPaysPct: number;
  /** Of each trade's value: the launcher's part of `traderPaysPct`. */
  launcherTakesPct: number;
  /**
   * Of what reaches the coin's recipients. These are the shares the creator picked at launch. `agent`, `creator`, `burn`
   * and `platform` always; `otherRecipients` (extra reward rows) and `holderDividends` only on a coin that has them.
   */
  recipientsPct: Partial<Record<FeeRecipient, number>>;
  /** Of each trade's value (on Clanker v5: of each buy), with the same keys as `recipientsPct`. */
  ofEachTradePct: Partial<Record<FeeRecipient, number>>;
  /** False when the creator did not choose a burn at launch. */
  hasBurn: boolean;
  /** Clanker v5 only: the buy tax, the percentage of a buy (= `traderPaysPct`). */
  taxPct?: number;
  /** Clanker v5 only: the sell tax, Clanker's part of it and what each recipient gets of a sell. */
  sellTaxPct?: number;
  launcherTakesOnSellPct?: number;
  ofEachSellPct?: Partial<Record<FeeRecipient, number>>;
  /** Clanker v5 only: what every fee is paid in. */
  pairedAsset?: 'ETH' | 'USDC' | 'other';
  /** Clanker v5 only: how many extra reward rows share `otherRecipients` (unknown from the indexer: null). */
  otherRecipientRows?: number | null;
  /** Clanker v5 coins with holder dividends: the least a holder must hold to earn them, in coins (null when unknown). */
  holderMinimumCoins?: number | null;
}

const BASE_RECIPIENTS: readonly FeeRecipient[] = ['agent', 'creator', 'burn', 'platform'];
/** The order in which recipients are listed. */
const ORDER: readonly FeeRecipient[] = ['agent', 'creator', 'otherRecipients', 'holderDividends', 'burn', 'platform'];
const LABEL: Record<FeeRecipient, string> = { agent: 'agent', creator: 'creator', otherRecipients: 'other recipients', holderDividends: 'holder dividends', burn: 'burn', platform: 'platform' };

const count = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v !== '' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : null;
};
const pct = (x: number): number => Math.round(x * 1000) / 1000;

/** Every chain's USDC we run on, lowercase: a v5 row's `pairedToken` is matched against them. */
const USDC_ADDRESSES = new Set([8453, 84532].map((id) => getAddresses(id).usdc.toLowerCase()));

/**
 * Clanker's cut of a v5 trade as a percentage of the trade, for a tax in hundredths of a bip: `protocolTaxShare` of the
 * tax, at least `minimumProtocolFeeRate` and at most `maximumProtocolFeeRate` of the trade, never more than the tax
 * (TaxFeeMath on the factory's verified sources).
 */
export function clankerV5CutPct(taxPips: number, policy: ClankerV5ProtocolPolicy = CLANKER_V5_DEFAULT_POLICY): number {
  const rate = taxPips * V5_TAX_MULTIPLIER;
  const cut = Math.min(rate, Math.max(policy.minimumProtocolFeeRate, Math.min(policy.maximumProtocolFeeRate, Math.floor((rate * policy.protocolTaxShare) / V5_SCALE))));
  return (cut * 100) / V5_SCALE;
}

/** The normalized inputs of a v5 split, from either source. Shares are any non-negative weights; only their ratios count. */
interface V5Inputs {
  buyTaxPips: number;
  sellTaxPips: number;
  shares: Record<FeeRecipient, number>;
  policy: ClankerV5ProtocolPolicy;
  /** Clanker's cut of a buy in bps of the buy tax, when the indexer gave it (`protocolBps`); else from `policy`. */
  buyCutBps: number | null;
  pairedAsset: 'ETH' | 'USDC' | 'other' | null;
  otherRecipientRows: number | null;
  holderMinimumCoins: number | null;
}

function v5Split(i: V5Inputs): CoinFeeSplit | null {
  const total = ORDER.reduce((n, k) => n + i.shares[k], 0);
  if (!i.buyTaxPips || !i.sellTaxPips || total <= 0) return null;
  const keys = ORDER.filter((k) => BASE_RECIPIENTS.includes(k) || i.shares[k] > 0);
  const each = <T>(value: (k: FeeRecipient) => T) => Object.fromEntries(keys.map((k) => [k, value(k)])) as Partial<Record<FeeRecipient, T>>;
  const buyTax = i.buyTaxPips / LP_FEE_PER_PCT;
  const sellTax = i.sellTaxPips / LP_FEE_PER_PCT;
  const buyCut = i.buyCutBps !== null ? (buyTax * i.buyCutBps) / BPS : clankerV5CutPct(i.buyTaxPips, i.policy);
  const sellCut = i.sellTaxPips === i.buyTaxPips ? buyCut : clankerV5CutPct(i.sellTaxPips, i.policy);
  const share = (k: FeeRecipient) => i.shares[k] / total;
  return {
    launchedThrough: 'Clanker v5',
    traderPaysPct: pct(buyTax),
    launcherTakesPct: pct(buyCut),
    recipientsPct: each((k) => pct(share(k) * 100)),
    ofEachTradePct: each((k) => pct((buyTax - buyCut) * share(k))),
    hasBurn: i.shares.burn > 0,
    taxPct: pct(buyTax),
    sellTaxPct: pct(sellTax),
    launcherTakesOnSellPct: pct(sellCut),
    ofEachSellPct: each((k) => pct((sellTax - sellCut) * share(k))),
    pairedAsset: i.pairedAsset ?? 'ETH',
    otherRecipientRows: i.otherRecipientRows,
    ...(i.shares.holderDividends > 0 ? { holderMinimumCoins: i.holderMinimumCoins } : {}),
  };
}

/** A v5 row's `pairedToken` as an asset: `0x0` is native ETH, either chain's USDC is USDC, a missing one is unknown. */
function pairedFromRow(v: unknown): V5Inputs['pairedAsset'] {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(v)) return null;
  if (/^0x0{40}$/.test(v)) return 'ETH';
  return USDC_ADDRESSES.has(v.toLowerCase()) ? 'USDC' : 'other';
}

/** The v5 split from an indexer row of the settings launcher; null when it lacks any of the settings fields. */
function v5FromRow(row: Record<string, unknown>): CoinFeeSplit | null {
  const buy = count(row.buyTaxBps);
  const sell = count(row.sellTaxBps);
  const shares = {
    agent: count(row.agentBps),
    creator: count(row.creatorBps),
    otherRecipients: count(row.recipientBps),
    holderDividends: count(row.dividendsBps),
    burn: count(row.burnBps),
    platform: count(row.platformBps),
  };
  if (buy === null || sell === null || ORDER.some((k) => shares[k] === null)) return null;
  const minHolding = count(row.minDividendHolding);
  return v5Split({
    buyTaxPips: buy,
    sellTaxPips: sell,
    shares: shares as Record<FeeRecipient, number>,
    policy: CLANKER_V5_DEFAULT_POLICY,
    buyCutBps: count(row.protocolBps),
    pairedAsset: pairedFromRow(row.pairedToken),
    otherRecipientRows: null,
    holderMinimumCoins: minHolding === null ? null : minHolding / 1e18,
  });
}

/** The v5 split of the agent's own coin from the settings its launch receipt carried (launch-source.ts). */
export function clankerV5SplitFromSettings(settings: ClankerV5TokenSettings, pairedAsset: 'ETH' | 'USDC' | 'other'): CoinFeeSplit | null {
  // The slots share the slot pool, `10_000 - burn - dividends` of the tax after Clanker's cut, by their weights.
  const pool = BPS - settings.burnBps - settings.dividendBps;
  if (pool < 0) return null;
  const weight = (role: string) => settings.slots.filter((s) => s.role === role).reduce((n, s) => n + s.weightBps, 0);
  const slotWeights = settings.slots.reduce((n, s) => n + s.weightBps, 0);
  if (slotWeights <= 0 && pool > 0) return null;
  const ofPool = (role: string) => (slotWeights > 0 ? (pool * weight(role)) / slotWeights : 0);
  const min = settings.minDividendHolding;
  return v5Split({
    buyTaxPips: settings.buyTaxBps,
    sellTaxPips: settings.sellTaxBps,
    shares: { agent: ofPool('agent'), creator: ofPool('creator'), otherRecipients: ofPool('other'), holderDividends: settings.dividendBps, burn: settings.burnBps, platform: ofPool('platform') },
    policy: settings.protocolPolicy,
    buyCutBps: null,
    pairedAsset,
    otherRecipientRows: settings.slots.filter((s) => s.role === 'other').length,
    holderMinimumCoins: min === null ? null : Number(BigInt(min) / COIN) + Number(BigInt(min) % COIN) / 1e18,
  });
}

/** The split of an indexer token row or market snapshot, or null when it does not carry one. */
export function coinFeeSplit(row: Record<string, unknown> | null | undefined): CoinFeeSplit | null {
  if (!row) return null;
  if (row.source === 'clanker-v5') return v5FromRow(row);
  const lpFee = count(row.lpFeeBps);
  const protocol = count(row.protocolBps);
  const slots = { agent: count(row.agentBps), creator: count(row.creatorBps), burn: count(row.burnBps), platform: count(row.platformBps) };
  if (!lpFee || protocol === null || BASE_RECIPIENTS.some((k) => slots[k as keyof typeof slots] === null)) return null;
  const bps = slots as Record<'agent' | 'creator' | 'burn' | 'platform', number>;
  const total = bps.agent + bps.creator + bps.burn + bps.platform;
  if (total <= 0) return null;
  const clanker = row.source === 'clanker';
  // RWAGMI: the launcher's share is inside the fee. Clanker v4: on top of it.
  const swapFee = lpFee / LP_FEE_PER_PCT;
  const launcher = (swapFee * protocol) / BPS;
  const each = <T>(value: (k: 'agent' | 'creator' | 'burn' | 'platform') => T) => Object.fromEntries(BASE_RECIPIENTS.map((k) => [k, value(k as 'agent')])) as Partial<Record<FeeRecipient, T>>;
  return {
    launchedThrough: clanker ? 'Clanker' : 'RWAGMI',
    traderPaysPct: pct(clanker ? swapFee + launcher : swapFee),
    launcherTakesPct: pct(launcher),
    recipientsPct: each((k) => pct((bps[k] / total) * 100)),
    ofEachTradePct: each((k) => pct((swapFee * bps[k]) / BPS)),
    hasBurn: bps.burn > 0,
  };
}

const ASSET_WORDS: Record<'ETH' | 'USDC' | 'other', string> = { ETH: 'ETH', USDC: 'USDC', other: 'the asset it is paired with' };

/** The `read_coin` line. */
export function feeSplitLine(split: CoinFeeSplit): string {
  const keys = ORDER.filter((k) => (split.recipientsPct[k] ?? 0) > 0);
  const shares = keys.map((k) => `${LABEL[k]} ${split.recipientsPct[k]}%`);
  const tail = ` The rest goes to ${shares.join(', ')}.${split.hasBurn ? '' : ' No burn on this coin.'}`;
  if (split.taxPct !== undefined) {
    const asset = split.pairedAsset ?? 'ETH';
    const sell = split.sellTaxPct ?? split.taxPct;
    const sellCut = split.launcherTakesOnSellPct ?? split.launcherTakesPct;
    const taxes =
      sell === split.taxPct
        ? `every buy and every sell pays a ${split.taxPct}% tax, of which Clanker takes ${split.launcherTakesPct}% of the trade`
        : `every buy pays a ${split.taxPct}% tax and every sell a ${sell}% tax, of which Clanker takes ${split.launcherTakesPct === sellCut ? `${sellCut}% of the trade` : `${split.launcherTakesPct}% of a buy and ${sellCut}% of a sell`}`;
    const dividends =
      (split.recipientsPct.holderDividends ?? 0) > 0
        ? ` Holder dividends are paid in ${ASSET_WORDS[asset]} to every holder of ${split.holderMinimumCoins ? `at least ${split.holderMinimumCoins.toLocaleString('en-US')} coins` : 'enough coins'}, held by Clanker until they claim.`
        : '';
    return `Fee split (locked at launch, this coin's trades only): launched through Clanker v5 and paired with ${ASSET_WORDS[asset]}, ${taxes}. Fees are paid in ${ASSET_WORDS[asset]}${split.hasBurn ? ', the burn in the coin' : ''}.${tail}${dividends}`;
  }
  return `Fee split (locked at launch, this coin's trades only): a trade pays ${split.traderPaysPct}%, of which ${split.launchedThrough} takes ${split.launcherTakesPct}%.${tail}`;
}

export const COIN_FEES_MEANING =
  "How a trade of your own coin pays its fee, locked at launch and true of this coin's trades only: traderPaysPct, launcherTakesPct and ofEachTradePct are percentages of a trade's value, recipientsPct is each recipient's share of what reaches them. Other coins have their own splits and some have no burn; read_coin shows them.";

/** The meaning of a Clanker v5 coin's section (the creator's own settings): what the extra fields are and what not to say. */
export const COIN_FEES_V5_MEANING =
  "How a trade of your own coin pays its fee, set by your creator at launch, locked, and true of this coin's trades only. It was launched through Clanker v5: every buy pays taxPct and every sell sellTaxPct of its value as a tax, Clanker's share (launcherTakesPct of a buy, launcherTakesOnSellPct of a sell) is inside it, and every fee is paid in pairedAsset. recipientsPct is each recipient's share of what is left; ofEachTradePct is of a buy, ofEachSellPct of a sell. otherRecipients are extra recipients your creator added: say \"other recipients\", never who they are. holderDividends go to holders of holderMinimumCoins or more. Only the recipients listed exist on this coin: never mention one that is not there. Other coins have their own splits; read_coin shows them.";

/**
 * The `coinFees` section of the first observation; empty when there is no split (an unreachable indexer, or a v5 coin
 * known by neither its stored settings nor a settings-launcher indexer row). A v5 agent's own coin is described from
 * the settings its launch receipt carried when they are stored (`launch`), else from the market snapshot.
 */
export function coinFeesSection(
  config: Pick<AgentConfig, 'token'>,
  market: Record<string, unknown> | null | undefined,
  launch: { details: ClankerV5LaunchDetails | null; pairedAsset: 'ETH' | 'USDC' | 'other' } | null = null,
): Record<string, unknown> {
  const own = launch?.details?.settings ? clankerV5SplitFromSettings(launch.details.settings, launch.pairedAsset) : null;
  const split = own ?? coinFeeSplit(market);
  return split ? { coinFees: { instructionAuthority: false, meaning: split.taxPct !== undefined ? COIN_FEES_V5_MEANING : COIN_FEES_MEANING, coin: config.token.symbol, ...split } } : {};
}
