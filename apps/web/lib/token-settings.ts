/**
 * Creator-set token settings for Clanker v5 coins (docs/design/clanker-v5-token-settings.md; the owner's answers in its
 * section 6 are binding). No React, no wagmi, no env: the launch form, the draft store, the agent launch API, the skill,
 * the docs and the tests all read the bounds and the arithmetic from here.
 *
 * Three shapes:
 *
 * - `TokenSettingsInput`: what people and agents set, in percent (the form's fields and the agent API's `launch.token`).
 * - `ContractTokenSettings`: the launcher's `TokenSettings` struct (`lib/abi/clankerLauncherV5.abi.ts`), in the
 *   contract's units: taxes 1e6-based (15_000 = 1.5%), burn, dividends and reward rows in bps.
 * - `V5TokenSettings` (`lib/types.ts`): what the indexer reports for a launched coin.
 *
 * The tax a trader pays is split twice. Clanker takes its cut first (`clankerCutPct`: 10% of the tax, never under 0.5%
 * nor over 1% of the trade). The rest, "the pool", is shared: the agent's 5% and the platform's 30% are locked floors,
 * the creator splits the other 65% between creator funds, holder dividends and the burn, and creator funds are paid to
 * the reward rows (the creator's own row first, up to four more) by their percentages.
 */
import { getAddress, isAddress, zeroAddress, type Address } from 'viem';
import { addresses } from '@bootr/shared/addresses';
import { CLANKER_V5_POLICY, clankerV5ProtocolBps } from './fee-split';
import type { Token, V5TokenSettings } from './types';

// ------------------------------------------------------------------ paired assets

/** Who may launch with an asset: agent coins now, plain tokens (no agent) later (design decision 2). */
export type LaunchKind = 'agent' | 'plain';
/** `LaunchKind` as the launcher's enum numbers it. */
export const LAUNCH_KIND_ID: Record<LaunchKind, number> = { agent: 0, plain: 1 };

/**
 * One asset a v5 coin can be paired with. The list is data: a plain-token path later adds rows (cbBTC, AERO, …) with
 * `kinds: ['plain']`, and the form, the API, the market panel and the trade panel follow without a rewrite.
 */
export type PairedAsset = {
  /** What the agent API takes (`pairedAsset`) and the form's radio value. */
  symbol: string;
  /** Clanker's quote: the zero address for native ETH. */
  address: Address;
  decimals: number;
  /** `quoteConfig(asset).startTickToken0Frame` read on Base on 2026-11-10; the form reads the live one. */
  fallbackStartTick: number;
  /** A dollar stablecoin's price, so Bootr's own arithmetic can value it without an oracle. */
  stableUsd?: number;
  kinds: readonly LaunchKind[];
  /** What pairing with it means for the agent, in one line. */
  note: string;
};

export const PAIRED_ASSETS: readonly PairedAsset[] = [
  {
    symbol: 'ETH',
    address: zeroAddress,
    decimals: 18,
    fallbackStartTick: -201_000,
    kinds: ['agent'],
    note: 'Fees arrive in ETH: the agent’s share pays its gas, and its thinking stays on your USDC fuel.',
  },
  {
    symbol: 'USDC',
    address: addresses[8453].usdc as Address,
    decimals: 6,
    fallbackStartTick: -400_600,
    stableUsd: 1,
    kinds: ['agent'],
    note: 'Fees arrive in USDC: the agent’s thinking is paid from them; gas still comes from you.',
  },
];

export const DEFAULT_PAIRED_ASSET = 'ETH';

/** The assets one launch kind may pair with, in the list's order. */
export function pairedAssetsFor(kind: LaunchKind): PairedAsset[] {
  return PAIRED_ASSETS.filter((a) => a.kinds.includes(kind));
}

/** The asset with this symbol (any case), or null. */
export function pairedAssetBySymbol(symbol: unknown): PairedAsset | null {
  if (typeof symbol !== 'string') return null;
  const s = symbol.trim().toUpperCase();
  return PAIRED_ASSETS.find((a) => a.symbol === s) ?? null;
}

/** The asset at this quote address, or null for one Bootr does not list. */
export function pairedAssetByAddress(address: string | null | undefined): PairedAsset | null {
  if (!address) return null;
  return PAIRED_ASSETS.find((a) => a.address.toLowerCase() === address.toLowerCase()) ?? null;
}

/** Clanker v5 supply (`factory.launchSupply()`): 1 B coins of 18 decimals. */
export const V5_SUPPLY = 1_000_000_000;

/**
 * The opening market cap in the paired asset at a start tick (Clanker's token0 frame: `1.0001^tick` raw quote per raw
 * coin): ETH −201,000 is about 1.87 ETH, USDC −400,600 about 4,000 USDC.
 */
export function openingCapInAsset(startTick: number, assetDecimals: number, supply = V5_SUPPLY): number {
  return Math.pow(1.0001, startTick) * Math.pow(10, 18 - assetDecimals) * supply;
}

// ------------------------------------------------------------------ bounds

/**
 * The launcher's configuration that bounds a launch (design section 2.2, the owner's answers 2, 3 and 5). The live
 * values come from `agentDefaults()`; these are the deploy values and the fallback when it cannot be read.
 */
export type V5Bounds = {
  /** Each side's tax, 1e6-based (10_000 = 1%). */
  minTaxBps: number;
  maxTaxBps: number;
  /** The agent's and the platform's locked shares of the pool, bps. */
  agentShareBps: number;
  platformShareBps: number;
  /** Creator rows: the creator's own plus the extra ones. */
  maxRewardRows: number;
};

export const FALLBACK_V5_BOUNDS: V5Bounds = { minTaxBps: 10_000, maxTaxBps: 50_000, agentShareBps: 500, platformShareBps: 3_000, maxRewardRows: 5 };

/** 1.5% each side (the owner's answer 2). */
export const DEFAULT_TAX_PCT = 1.5;
/** Clanker's policy minimum for holder dividends, in whole coins (`taxPolicy().minimumDividendHolding`). */
export const MIN_DIVIDEND_HOLDING = 10_000;
/** A decimal number written as text ("1.5", "10000"); the bounds are checked afterwards. */
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

/** `agentDefaults()` as viem returns it (a positional tuple) into `V5Bounds`; the platform recipient and fuel aside. */
export function v5BoundsFromTuple(t: readonly [number, number, Address, bigint, number, number, number, number]): V5Bounds {
  return { agentShareBps: t[0], platformShareBps: t[1], minTaxBps: t[5], maxTaxBps: t[6], maxRewardRows: t[7] };
}

/** The share the creator splits (creator funds, dividends, burn), in bps of the pool: 6,500 with the 5% and 30% floors. */
export function creatorPoolBps(b: V5Bounds = FALLBACK_V5_BOUNDS): number {
  return 10_000 - b.agentShareBps - b.platformShareBps;
}

// ------------------------------------------------------------------ the input

export type RewardRowInput = { recipient: Address; admin: Address; pct: number };

/** What the creator sets, in percent. `burnPct` and `dividendsPct` are of the pool; a row's `pct` is of creator funds. */
export type TokenSettingsInput = {
  pairedAsset: string;
  buyTaxPct: number;
  sellTaxPct: number;
  burnPct: number;
  dividendsPct: number;
  /** Whole coins a wallet must hold to earn dividends; ignored without dividends. */
  minDividendHolding: number;
  /** Row 0 is the creator's own; empty only when creator funds are 0%. */
  rewards: RewardRowInput[];
  sniperTax: boolean;
  editableMetadata: boolean;
};

/** The recommended settings (design section 2.3): ETH, 1.5% each side, everything to creator funds on one row. */
export function defaultTokenSettings(creator: Address): TokenSettingsInput {
  return {
    pairedAsset: DEFAULT_PAIRED_ASSET,
    buyTaxPct: DEFAULT_TAX_PCT,
    sellTaxPct: DEFAULT_TAX_PCT,
    burnPct: 0,
    dividendsPct: 0,
    minDividendHolding: MIN_DIVIDEND_HOLDING,
    rewards: [{ recipient: creator, admin: creator, pct: 100 }],
    sniperTax: true,
    editableMetadata: true,
  };
}

/** Creator funds, in percent of the pool: what the burn and dividends leave of the creator's 65%. */
export function creatorFundsPct(s: Pick<TokenSettingsInput, 'burnPct' | 'dividendsPct'>, b: V5Bounds = FALLBACK_V5_BOUNDS): number {
  return round2(creatorPoolBps(b) / 100 - s.burnPct - s.dividendsPct);
}

/** The reward rows' total, in percent of creator funds. */
export function allocatedPct(rows: readonly Pick<RewardRowInput, 'pct'>[]): number {
  return round2(rows.reduce((sum, r) => sum + (Number.isFinite(r.pct) ? r.pct : 0), 0));
}

export type SettingsProblem = { field: string; message: string };

const pctText = (n: number) => `${round2(n)}%`;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** True for a percent with at most two decimals. */
function twoDecimals(n: number): boolean {
  return Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
}

/**
 * Every problem with a settings input, in field order; empty means `launch(p, s)` passes the launcher's checks of design
 * section 2.2 (Clanker's own registration and policy are checked on chain). `kind` picks the paired-asset list.
 */
export function tokenSettingsProblems(s: TokenSettingsInput, b: V5Bounds = FALLBACK_V5_BOUNDS, kind: LaunchKind = 'agent'): SettingsProblem[] {
  const out: SettingsProblem[] = [];
  const assets = pairedAssetsFor(kind);
  const asset = pairedAssetBySymbol(s.pairedAsset);
  if (!asset || !asset.kinds.includes(kind)) out.push({ field: 'pairedAsset', message: `pairedAsset must be one of ${assets.map((a) => a.symbol).join(', ')}.` });
  const minTax = b.minTaxBps / 10_000;
  const maxTax = b.maxTaxBps / 10_000;
  for (const [field, label, v] of [
    ['buyTaxPct', 'Buy tax', s.buyTaxPct],
    ['sellTaxPct', 'Sell tax', s.sellTaxPct],
  ] as const) {
    if (!twoDecimals(v) || v < minTax || v > maxTax) out.push({ field, message: `${label} must be ${pctText(minTax)} to ${pctText(maxTax)}, in steps of 0.01%.` });
  }
  const room = creatorPoolBps(b) / 100;
  for (const [field, label, v] of [
    ['burnPct', 'Burn allocation', s.burnPct],
    ['dividendsPct', 'Holder dividends', s.dividendsPct],
  ] as const) {
    if (!twoDecimals(v) || v > room) out.push({ field, message: `${label} must be 0% to ${pctText(room)} of the tax pool, in steps of 0.01%.` });
  }
  const funds = creatorFundsPct(s, b);
  if (funds < 0) out.push({ field: 'burnPct', message: `Burn allocation and holder dividends add up to ${pctText(s.burnPct + s.dividendsPct)}: together they can take at most ${pctText(room)}, what the agent’s ${pctText(b.agentShareBps / 100)} and the platform’s ${pctText(b.platformShareBps / 100)} leave.` });
  if (s.dividendsPct > 0) {
    const h = s.minDividendHolding;
    if (!Number.isInteger(h) || h < MIN_DIVIDEND_HOLDING || h > V5_SUPPLY) {
      out.push({ field: 'minDividendHolding', message: `minDividendHolding must be a whole number of coins from ${MIN_DIVIDEND_HOLDING.toLocaleString('en-US')} to ${V5_SUPPLY.toLocaleString('en-US')}.` });
    }
  }
  if (funds > 0) {
    if (s.rewards.length < 1 || s.rewards.length > b.maxRewardRows) {
      out.push({ field: 'rewards', message: `rewards must have 1 to ${b.maxRewardRows} rows: yours first, then up to ${b.maxRewardRows - 1} more.` });
    }
    s.rewards.forEach((r, i) => {
      if (!isAddress(r.recipient, { strict: false }) || BigInt(r.recipient) === 0n) out.push({ field: `rewards.${i}.recipient`, message: `Row ${i + 1}: the recipient must be a wallet address.` });
      if (!isAddress(r.admin, { strict: false }) || BigInt(r.admin) === 0n) out.push({ field: `rewards.${i}.admin`, message: `Row ${i + 1}: the admin must be a wallet address.` });
      if (!twoDecimals(r.pct) || r.pct <= 0 || r.pct > 100) out.push({ field: `rewards.${i}.pct`, message: `Row ${i + 1}: the reward must be above 0% and at most 100%, in steps of 0.01%.` });
    });
    const total = allocatedPct(s.rewards);
    if (s.rewards.length > 0 && total !== 100) out.push({ field: 'rewards', message: `Allocated: ${total}/100%. The rows must add up to exactly 100%.` });
  }
  return out;
}

/**
 * The request's `launch.token` (or a stored draft's settings) into a `TokenSettingsInput`, with the defaults for missing
 * fields: `creator` fills the default reward row. A value that is present but unreadable is refused, never taken for
 * the default (these settings are permanent). `{ok: false}` carries the first problem.
 */
export function parseTokenSettings(
  raw: unknown,
  creator: Address | null,
  b: V5Bounds = FALLBACK_V5_BOUNDS,
  kind: LaunchKind = 'agent',
): { ok: true; settings: TokenSettingsInput } | ({ ok: false } & SettingsProblem) {
  if (raw === undefined || raw === null) {
    if (!creator) return { ok: false, field: 'token', message: 'token settings are required.' };
    return { ok: true, settings: defaultTokenSettings(creator) };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, field: 'token', message: 'token must be an object: {pairedAsset, buyTaxPct, sellTaxPct, burnPct, dividendsPct, minDividendHolding, rewards, sniperTax, editableMetadata}.' };
  const r = raw as Record<string, unknown>;
  const base = creator ? defaultTokenSettings(creator) : null;
  const num = (field: keyof TokenSettingsInput, fallback: number | undefined): number | SettingsProblem => {
    const v = r[field];
    if (v === undefined) return fallback ?? { field, message: `${field} is required.` };
    const n = typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(n)) return { field, message: `${field} must be a number such as 1.5, got ${JSON.stringify(v)?.slice(0, 40)}.` };
    return n;
  };
  const bool = (field: keyof TokenSettingsInput, fallback: boolean): boolean | SettingsProblem => {
    const v = r[field];
    if (v === undefined) return fallback;
    return typeof v === 'boolean' ? v : { field, message: `${field} must be true or false.` };
  };
  const pairedAsset = r.pairedAsset === undefined ? DEFAULT_PAIRED_ASSET : typeof r.pairedAsset === 'string' ? r.pairedAsset.trim().toUpperCase() : '';
  const fields = {
    buyTaxPct: num('buyTaxPct', DEFAULT_TAX_PCT),
    sellTaxPct: num('sellTaxPct', DEFAULT_TAX_PCT),
    burnPct: num('burnPct', 0),
    dividendsPct: num('dividendsPct', 0),
    minDividendHolding: num('minDividendHolding', MIN_DIVIDEND_HOLDING),
    sniperTax: bool('sniperTax', true),
    editableMetadata: bool('editableMetadata', true),
  };
  for (const v of Object.values(fields)) if (typeof v === 'object') return { ok: false, ...v };
  let rewards: RewardRowInput[];
  if (r.rewards === undefined) {
    if (!base) return { ok: false, field: 'rewards', message: 'rewards is required.' };
    rewards = base.rewards;
  } else if (!Array.isArray(r.rewards) || r.rewards.length > 16) {
    return { ok: false, field: 'rewards', message: `rewards must be a list of {recipient, admin, pct}, at most ${b.maxRewardRows} rows.` };
  } else {
    rewards = [];
    for (const [i, row] of r.rewards.entries()) {
      if (!row || typeof row !== 'object') return { ok: false, field: `rewards.${i}`, message: `Row ${i + 1} must be {recipient, admin, pct}.` };
      const { recipient, admin, pct } = row as Record<string, unknown>;
      const recipientAddr = typeof recipient === 'string' && isAddress(recipient, { strict: false }) ? getAddress(recipient) : null;
      // An admin left out is the recipient itself, the way Clanker's form fills a new row.
      const adminAddr = admin === undefined ? recipientAddr : typeof admin === 'string' && isAddress(admin, { strict: false }) ? getAddress(admin) : null;
      if (!recipientAddr) return { ok: false, field: `rewards.${i}.recipient`, message: `Row ${i + 1}: recipient must be a 0x address.` };
      if (!adminAddr) return { ok: false, field: `rewards.${i}.admin`, message: `Row ${i + 1}: admin must be a 0x address.` };
      const p = typeof pct === 'number' ? pct : typeof pct === 'string' && DECIMAL.test(pct.trim()) ? Number(pct) : NaN;
      if (!Number.isFinite(p)) return { ok: false, field: `rewards.${i}.pct`, message: `Row ${i + 1}: pct must be a number such as 50.` };
      rewards.push({ recipient: recipientAddr, admin: adminAddr, pct: p });
    }
  }
  const settings: TokenSettingsInput = {
    pairedAsset,
    buyTaxPct: fields.buyTaxPct as number,
    sellTaxPct: fields.sellTaxPct as number,
    burnPct: fields.burnPct as number,
    dividendsPct: fields.dividendsPct as number,
    minDividendHolding: fields.minDividendHolding as number,
    rewards,
    sniperTax: fields.sniperTax as boolean,
    editableMetadata: fields.editableMetadata as boolean,
  };
  // Nothing left for creator funds: the rows have nothing to share, so they are dropped rather than refused.
  if (creatorFundsPct(settings, b) === 0) settings.rewards = [];
  const [problem] = tokenSettingsProblems(settings, b, kind);
  return problem ? { ok: false, ...problem } : { ok: true, settings };
}

// ------------------------------------------------------------------ the contract struct

export type ContractTokenSettings = {
  quoteToken: Address;
  buyTaxBps: number;
  sellTaxBps: number;
  burnBps: number;
  dividendBps: number;
  minDividendHolding: bigint;
  rewards: { recipient: Address; admin: Address; bps: number }[];
  antiSnipe: boolean;
  metadataEditable: boolean;
  contractURI: string;
};

/** A checked input into the launcher's `TokenSettings` (call `tokenSettingsProblems` first). */
export function toContractSettings(s: TokenSettingsInput, contractURI: string, b: V5Bounds = FALLBACK_V5_BOUNDS): ContractTokenSettings {
  const asset = pairedAssetBySymbol(s.pairedAsset);
  if (!asset) throw new Error(`unknown paired asset ${s.pairedAsset}`);
  const funds = s.rewards.length > 0 && creatorFundsPct(s, b) > 0;
  return {
    quoteToken: asset.address,
    buyTaxBps: Math.round(s.buyTaxPct * 10_000),
    sellTaxBps: Math.round(s.sellTaxPct * 10_000),
    burnBps: Math.round(s.burnPct * 100),
    dividendBps: Math.round(s.dividendsPct * 100),
    minDividendHolding: s.dividendsPct > 0 ? BigInt(s.minDividendHolding) * 10n ** 18n : 0n,
    rewards: funds ? s.rewards.map((r) => ({ recipient: getAddress(r.recipient), admin: getAddress(r.admin), bps: Math.round(r.pct * 100) })) : [],
    antiSnipe: s.sniperTax,
    metadataEditable: s.editableMetadata,
    contractURI,
  };
}

// ------------------------------------------------------------------ per-trade arithmetic

/** Clanker's cut of one trade, in percent of the trade: 10% of the tax, at least 0.5%, at most 1% (and never above the tax). */
export function clankerCutPct(taxPct: number): number {
  if (!(taxPct > 0)) return 0;
  return Math.min(Math.max(taxPct * CLANKER_V5_POLICY.protocolTaxShare, CLANKER_V5_POLICY.minProtocolPct), CLANKER_V5_POLICY.maxProtocolPct, taxPct);
}

/** How the pool is shared, in bps of it: the locked agent and platform floors, the creator's burn and dividends. */
export type PoolShares = { agentBps: number; platformBps: number; burnBps: number; dividendBps: number };

/** Where one trade's tax goes, each in percent of the trade. */
export type TradeSplit = { tax: number; clanker: number; agent: number; platform: number; creatorFunds: number; dividends: number; burn: number };

export function tradeSplit(taxPct: number, shares: PoolShares): TradeSplit {
  const clanker = clankerCutPct(taxPct);
  const pool = taxPct - clanker;
  const of = (bps: number) => (pool * bps) / 10_000;
  const creatorFundsBps = Math.max(0, 10_000 - shares.agentBps - shares.platformBps - shares.burnBps - shares.dividendBps);
  return { tax: taxPct, clanker, agent: of(shares.agentBps), platform: of(shares.platformBps), creatorFunds: of(creatorFundsBps), dividends: of(shares.dividendBps), burn: of(shares.burnBps) };
}

/** The pool shares a settings input makes, with the launcher's floors. */
export function poolSharesOf(s: Pick<TokenSettingsInput, 'burnPct' | 'dividendsPct'>, b: V5Bounds = FALLBACK_V5_BOUNDS): PoolShares {
  return { agentBps: b.agentShareBps, platformBps: b.platformShareBps, burnBps: Math.round(s.burnPct * 100), dividendBps: Math.round(s.dividendsPct * 100) };
}

/** A small percent the way Clanker's footer writes it: up to three decimals, no trailing zeros (0.5%, 0.05%, 0.325%). */
export function shortPct(n: number): string {
  const s = (Math.round(n * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${s}%`;
}

/**
 * The form's footer, as Clanker's form writes it: "Per trade: 0.5% Clanker · 0.05% agent · 0.3% Bootr · 0.65% creator
 * funds", with holder dividends and the burn when chosen. One line per side when the buy and sell taxes differ.
 */
export function perTradeLines(s: Pick<TokenSettingsInput, 'buyTaxPct' | 'sellTaxPct' | 'burnPct' | 'dividendsPct'>, b: V5Bounds = FALLBACK_V5_BOUNDS): string[] {
  const line = (taxPct: number) => {
    const t = tradeSplit(taxPct, poolSharesOf(s, b));
    const parts = [`${shortPct(t.clanker)} Clanker`, `${shortPct(t.agent)} agent`, `${shortPct(t.platform)} Bootr`];
    if (t.creatorFunds > 0) parts.push(`${shortPct(t.creatorFunds)} creator funds`);
    if (t.dividends > 0) parts.push(`${shortPct(t.dividends)} holder dividends`);
    if (t.burn > 0) parts.push(`${shortPct(t.burn)} burn`);
    return parts.join(' · ');
  };
  if (s.buyTaxPct === s.sellTaxPct) return [`Per trade: ${line(s.buyTaxPct)}`];
  return [`Per buy: ${line(s.buyTaxPct)}`, `Per sell: ${line(s.sellTaxPct)}`];
}

// ------------------------------------------------------------------ a launched coin

/** The token-row fields `v5SettingsOf` reads (lib/types.ts). */
type V5Row = Pick<
  Token,
  | 'source'
  | 'v5Extras'
  | 'agentBps'
  | 'creatorBps'
  | 'platformBps'
  | 'burnBps'
  | 'buyTaxBps'
  | 'sellTaxBps'
  | 'rewardsBps'
  | 'dividendBps'
  | 'protocolBps'
  | 'minDividendHolding'
  | 'antiSnipe'
  | 'metadataEditable'
  | 'metadataLocked'
>;

/** How far the row's shares may miss `10000 − protocolBps` and still be read: the indexer's rounding of slot weights. */
export const V5_ROW_TOLERANCE_BPS = 4;

/**
 * A v5 coin's settings from the indexer's token row, or null for any coin not launched with settings (the fixed v5
 * launcher, v4, RWAGMI). The row gives every share in bps of the buy tax with Clanker's share inside it
 * (`agent + creator + rewards + burn + dividend + platform = 10000 − protocolBps`; apps/indexer README, "Clanker v5
 * token settings"); here they become shares of the tax pool after Clanker's cut, `x × 10000 / (10000 − protocolBps)`,
 * creator funds being the creator's own row and the extra rows together. A row that does not add up (within a few bps)
 * gives `splitKnown: false` and no shares at all, never a guessed platform figure. The reward rows and the metadata JSON
 * are not on the row: `v5Extras` (mock mode) or empty.
 */
export function v5SettingsOf(t: V5Row | null | undefined): V5TokenSettings | null {
  if (!t || t.source !== 'clanker-v5' || t.buyTaxBps == null || t.sellTaxBps == null || t.rewardsBps == null) return null;
  const buyTaxBps = Number(t.buyTaxBps);
  const protocol = t.protocolBps != null && Number.isFinite(Number(t.protocolBps)) ? Number(t.protocolBps) : clankerV5ProtocolBps(buyTaxBps);
  const slots = 10_000 - protocol;
  const n = (v: number | null | undefined) => (Number.isFinite(Number(v)) ? Number(v) : NaN);
  const parts = { agent: n(t.agentBps), creator: n(t.creatorBps), rewards: n(t.rewardsBps), burn: n(t.burnBps ?? 0), dividend: n(t.dividendBps ?? 0), platform: n(t.platformBps) };
  const sum = Object.values(parts).reduce((a, b) => a + b, 0);
  const splitKnown = slots > 0 && Number.isFinite(sum) && Math.abs(sum - slots) <= V5_ROW_TOLERANCE_BPS;
  const pool = (x: number) => (splitKnown ? Math.round((x * 10_000) / slots) : 0);
  return {
    buyTaxBps,
    sellTaxBps: Number(t.sellTaxBps),
    splitKnown,
    agentShareBps: pool(parts.agent),
    creatorFundsBps: pool(parts.creator + parts.rewards),
    platformShareBps: pool(parts.platform),
    burnBps: pool(parts.burn),
    dividendBps: pool(parts.dividend),
    minDividendHolding: t.minDividendHolding ?? '0',
    rewards: t.v5Extras?.rewards ?? [],
    antiSnipe: !!t.antiSnipe,
    metadataEditable: !!t.metadataEditable,
    metadataLocked: !!t.metadataLocked,
    metadataJson: t.v5Extras?.metadataJson ?? null,
  };
}

/** A launched coin's pool shares, from what the indexer reports (`v5SettingsOf`). */
export function poolSharesOfCoin(v: Pick<V5TokenSettings, 'agentShareBps' | 'platformShareBps' | 'burnBps' | 'dividendBps'>): PoolShares {
  return { agentBps: v.agentShareBps, platformBps: v.platformShareBps, burnBps: v.burnBps, dividendBps: v.dividendBps };
}

/** One trade's split on each side of a launched coin (the taxes may differ). */
export function coinTradeSplits(v: V5TokenSettings): { buy: TradeSplit; sell: TradeSplit } {
  const shares = poolSharesOfCoin(v);
  return { buy: tradeSplit(v.buyTaxBps / 10_000, shares), sell: tradeSplit(v.sellTaxBps / 10_000, shares) };
}

/** Whether the coin's creator may still change its image and metadata (editable, not locked). */
export function metadataStillEditable(v: Pick<V5TokenSettings, 'metadataEditable' | 'metadataLocked'> | null | undefined): boolean {
  return !!v && v.metadataEditable && !v.metadataLocked;
}

/** Whether the coin was launched with editable metadata (still editable, or locked by its creator since). */
export function metadataWasEditable(v: Pick<V5TokenSettings, 'metadataEditable' | 'metadataLocked'> | null | undefined): boolean {
  return !!v && (v.metadataEditable || v.metadataLocked);
}

/** The v5 hook's `poolFeeSlots(poolId)` (IClankerV5.sol `TaxLaunchHook`): the coin's fee slots as stored. */
export const clankerV5HookSlotsAbi = [
  {
    type: 'function',
    name: 'poolFeeSlots',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      {
        type: 'tuple[]',
        components: [
          { name: 'recipient', type: 'address' },
          { name: 'admin', type: 'address' },
          { name: 'weightBps', type: 'uint16' },
          { name: 'isCreator', type: 'bool' },
        ],
      },
    ],
  },
] as const;

/**
 * The creator-funds rows from a settings coin's fee slots: the launcher writes the agent's slot first and the
 * platform's second, then the creator's rows, whose weights share creator funds (as bps of creator funds here).
 */
export function rowsFromSlots(slots: readonly { recipient: Address; admin: Address; weightBps: number }[]): V5TokenSettings['rewards'] {
  const rows = slots.slice(2);
  const total = rows.reduce((sum, r) => sum + Number(r.weightBps), 0);
  if (total === 0) return [];
  return rows.map((r) => ({ recipient: r.recipient, admin: r.admin, bps: Math.round((Number(r.weightBps) * 10_000) / total) }));
}
