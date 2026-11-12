import { getAddress, isAddress } from 'viem';
import type { LaunchInput, LaunchTokenSettings, TokenSettings } from './types.js';

/**
 * The checks `POST /api/agent/launch` makes on a Clanker v5 launch's `token` settings and `devBuySlippagePct` before it
 * reads the chain, with the same bounds and the same messages. `prepareLaunch` runs them before it sends anything, so a
 * mistake costs no nonce: the signed message stays unused. The site checks again against the launcher's live bounds,
 * which its owner can move for future launches; these are the deploy values the site itself checks first.
 * `apps/web/lib/token-settings.sdk.test.ts` fails when they drift from the site's own.
 */

/** The launcher's deploy bounds for an agent coin on Clanker v5, in percent. */
export const TOKEN_SETTINGS_BOUNDS = {
  /** What a coin may trade against; also the asset its fees, rewards and dividends are paid in. */
  pairedAssets: ['ETH', 'USDC'],
  /** Each side's tax, in percent of the trade. */
  minTaxPct: 1,
  maxTaxPct: 5,
  /** The agent's and the platform's locked shares of the tax pool, in percent. */
  agentSharePct: 5,
  platformSharePct: 30,
  /** Reward rows: the creator's own plus up to four more. */
  maxRewardRows: 5,
  /** Whole coins a wallet must hold to earn dividends: Clanker's minimum, and the supply. */
  minDividendHolding: 10_000,
  supply: 1_000_000_000,
} as const;

/** What the site uses for a field left out. */
export const TOKEN_SETTINGS_DEFAULTS = {
  pairedAsset: 'ETH',
  buyTaxPct: 1.5,
  sellTaxPct: 1.5,
  burnPct: 0,
  dividendsPct: 0,
  minDividendHolding: 10_000,
  sniperTax: true,
  editableMetadata: true,
} as const;

/** The dev buy's slippage tolerance on Clanker v5, in percent below the quote. */
export const DEV_BUY_SLIPPAGE = { defaultPct: 3, minPct: 0.1, maxPct: 50 } as const;

export type SettingsProblem = { field: string; message: string };

const B = TOKEN_SETTINGS_BOUNDS;
/** A decimal number written as text ("1.5", "10000"); the bounds are checked afterwards. */
const DECIMAL = /^\d{1,12}(\.\d{1,6})?$/;

const round2 = (n: number) => Math.round(n * 100) / 100;
const pctText = (n: number) => `${round2(n)}%`;
/** True for a percent with at most two decimals. */
const twoDecimals = (n: number) =>
  Number.isFinite(n) && n >= 0 && Math.abs(n * 100 - Math.round(n * 100)) < 1e-6;
/** The share the creator splits between creator funds, holder dividends and the burn: 65% of the pool. */
const creatorPoolPct = () => 100 - B.agentSharePct - B.platformSharePct;
const creatorFundsPct = (s: Pick<TokenSettings, 'burnPct' | 'dividendsPct'>) =>
  round2(creatorPoolPct() - s.burnPct - s.dividendsPct);

/** A caller's value as a short quoted string, as the site names it in a refusal. */
function quoted(value: unknown, max = 64): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean')
    return value === null || value === undefined ? 'nothing' : `an ${typeof value}`;
  const line = String(value).replace(/\p{Cc}+/gu, ' ');
  return JSON.stringify(line.length > max ? `${line.slice(0, max)}…` : line);
}

/** Every problem with complete settings, in field order; empty means the launcher's own checks pass. */
export function tokenSettingsProblems(s: TokenSettings): SettingsProblem[] {
  const out: SettingsProblem[] = [];
  if (!(B.pairedAssets as readonly string[]).includes(s.pairedAsset))
    out.push({
      field: 'pairedAsset',
      message: `pairedAsset must be one of ${B.pairedAssets.join(', ')}.`,
    });
  for (const [field, label, v] of [
    ['buyTaxPct', 'Buy tax', s.buyTaxPct],
    ['sellTaxPct', 'Sell tax', s.sellTaxPct],
  ] as const) {
    if (!twoDecimals(v) || v < B.minTaxPct || v > B.maxTaxPct)
      out.push({
        field,
        message: `${label} must be ${pctText(B.minTaxPct)} to ${pctText(B.maxTaxPct)}, in steps of 0.01%.`,
      });
  }
  const room = creatorPoolPct();
  for (const [field, label, v] of [
    ['burnPct', 'Burn allocation', s.burnPct],
    ['dividendsPct', 'Holder dividends', s.dividendsPct],
  ] as const) {
    if (!twoDecimals(v) || v > room)
      out.push({
        field,
        message: `${label} must be 0% to ${pctText(room)} of the tax pool, in steps of 0.01%.`,
      });
  }
  const funds = creatorFundsPct(s);
  if (funds < 0)
    out.push({
      field: 'burnPct',
      message: `Burn allocation and holder dividends add up to ${pctText(s.burnPct + s.dividendsPct)}: together they can take at most ${pctText(room)}, what the agent’s ${pctText(B.agentSharePct)} and the platform’s ${pctText(B.platformSharePct)} leave.`,
    });
  if (s.dividendsPct > 0) {
    const h = s.minDividendHolding;
    if (!Number.isInteger(h) || h < B.minDividendHolding || h > B.supply)
      out.push({
        field: 'minDividendHolding',
        message: `minDividendHolding must be a whole number of coins from ${B.minDividendHolding.toLocaleString('en-US')} to ${B.supply.toLocaleString('en-US')}.`,
      });
  }
  if (funds > 0) {
    if (s.rewards.length < 1 || s.rewards.length > B.maxRewardRows)
      out.push({
        field: 'rewards',
        message: `rewards must have 1 to ${B.maxRewardRows} rows: yours first, then up to ${B.maxRewardRows - 1} more.`,
      });
    s.rewards.forEach((r, i) => {
      if (!isAddress(r.recipient, { strict: false }) || BigInt(r.recipient) === 0n)
        out.push({
          field: `rewards.${i}.recipient`,
          message: `Row ${i + 1}: the recipient must be a wallet address.`,
        });
      if (!isAddress(r.admin, { strict: false }) || BigInt(r.admin) === 0n)
        out.push({
          field: `rewards.${i}.admin`,
          message: `Row ${i + 1}: the admin must be a wallet address.`,
        });
      if (!twoDecimals(r.pct) || r.pct <= 0 || r.pct > 100)
        out.push({
          field: `rewards.${i}.pct`,
          message: `Row ${i + 1}: the reward must be above 0% and at most 100%, in steps of 0.01%.`,
        });
    });
    const total = round2(
      s.rewards.reduce((sum, r) => sum + (Number.isFinite(r.pct) ? r.pct : 0), 0),
    );
    if (s.rewards.length > 0 && total !== 100)
      out.push({
        field: 'rewards',
        message: `Allocated: ${total}/100%. The rows must add up to exactly 100%.`,
      });
  }
  return out;
}

/**
 * A launch's `token` as the site reads it: the defaults filled in (`creator` is the default reward row), then checked.
 * A value that is present but cannot be read is refused, never taken for the default, since these settings are
 * permanent. `{ok: false}` carries the first problem, with the field as the site names it inside `token`.
 */
export function checkTokenSettings(
  raw: LaunchTokenSettings | undefined | null,
  creator: string,
): { ok: true; settings: TokenSettings } | ({ ok: false } & SettingsProblem) {
  const owner = getAddress(creator);
  const base: TokenSettings = {
    ...TOKEN_SETTINGS_DEFAULTS,
    rewards: [{ recipient: owner, admin: owner, pct: 100 }],
  };
  if (raw === undefined || raw === null) return { ok: true, settings: base };
  if (typeof raw !== 'object' || Array.isArray(raw))
    return {
      ok: false,
      field: 'token',
      message:
        'token must be an object: {pairedAsset, buyTaxPct, sellTaxPct, burnPct, dividendsPct, minDividendHolding, rewards, sniperTax, editableMetadata}.',
    };
  const r = raw as Record<string, unknown>;
  const num = (field: string, fallback: number): number | SettingsProblem => {
    const v = r[field];
    if (v === undefined) return fallback;
    const n =
      typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v.trim()) ? Number(v) : NaN;
    if (!Number.isFinite(n))
      return {
        field,
        message: `${field} must be a number such as 1.5, got ${JSON.stringify(v)?.slice(0, 40)}.`,
      };
    return n;
  };
  const bool = (field: string, fallback: boolean): boolean | SettingsProblem => {
    const v = r[field];
    if (v === undefined) return fallback;
    return typeof v === 'boolean' ? v : { field, message: `${field} must be true or false.` };
  };
  const pairedAsset =
    r.pairedAsset === undefined
      ? base.pairedAsset
      : typeof r.pairedAsset === 'string'
        ? r.pairedAsset.trim().toUpperCase()
        : '';
  const fields = {
    buyTaxPct: num('buyTaxPct', base.buyTaxPct),
    sellTaxPct: num('sellTaxPct', base.sellTaxPct),
    burnPct: num('burnPct', base.burnPct),
    dividendsPct: num('dividendsPct', base.dividendsPct),
    minDividendHolding: num('minDividendHolding', base.minDividendHolding),
    sniperTax: bool('sniperTax', base.sniperTax),
    editableMetadata: bool('editableMetadata', base.editableMetadata),
  };
  for (const v of Object.values(fields)) if (typeof v === 'object') return { ok: false, ...v };
  let rewards: TokenSettings['rewards'];
  if (r.rewards === undefined) {
    rewards = base.rewards;
  } else if (!Array.isArray(r.rewards) || r.rewards.length > 16) {
    return {
      ok: false,
      field: 'rewards',
      message: `rewards must be a list of {recipient, admin, pct}, at most ${B.maxRewardRows} rows.`,
    };
  } else {
    rewards = [];
    for (const [i, row] of (r.rewards as unknown[]).entries()) {
      if (!row || typeof row !== 'object')
        return {
          ok: false,
          field: `rewards.${i}`,
          message: `Row ${i + 1} must be {recipient, admin, pct}.`,
        };
      const { recipient, admin, pct } = row as Record<string, unknown>;
      const recipientAddr =
        typeof recipient === 'string' && isAddress(recipient, { strict: false })
          ? getAddress(recipient)
          : null;
      // An admin left out is the recipient itself, the way Clanker's form fills a new row.
      const adminAddr =
        admin === undefined
          ? recipientAddr
          : typeof admin === 'string' && isAddress(admin, { strict: false })
            ? getAddress(admin)
            : null;
      if (!recipientAddr)
        return {
          ok: false,
          field: `rewards.${i}.recipient`,
          message: `Row ${i + 1}: recipient must be a 0x address.`,
        };
      if (!adminAddr)
        return {
          ok: false,
          field: `rewards.${i}.admin`,
          message: `Row ${i + 1}: admin must be a 0x address.`,
        };
      const p =
        typeof pct === 'number'
          ? pct
          : typeof pct === 'string' && DECIMAL.test(pct.trim())
            ? Number(pct)
            : NaN;
      if (!Number.isFinite(p))
        return {
          ok: false,
          field: `rewards.${i}.pct`,
          message: `Row ${i + 1}: pct must be a number such as 50.`,
        };
      rewards.push({ recipient: recipientAddr, admin: adminAddr, pct: p });
    }
  }
  const settings: TokenSettings = {
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
  if (creatorFundsPct(settings) === 0) settings.rewards = [];
  const [problem] = tokenSettingsProblems(settings);
  return problem ? { ok: false, ...problem } : { ok: true, settings };
}

/** A slippage tolerance in percent: 0.1 to 50 with at most two decimals, or null. */
export function parseSlippagePct(v: unknown): number | null {
  const n =
    typeof v === 'number' ? v : typeof v === 'string' && DECIMAL.test(v.trim()) ? Number(v) : NaN;
  if (
    !Number.isFinite(n) ||
    n < DEV_BUY_SLIPPAGE.minPct ||
    n > DEV_BUY_SLIPPAGE.maxPct ||
    Math.abs(n * 100 - Math.round(n * 100)) > 1e-6
  )
    return null;
  return n;
}

/**
 * The first problem the site would find with a launch's path and Clanker v5 fields, as `{field, message}` with the
 * field as the site names it (`token.buyTaxPct`); null when there is none. `creator` is the signing wallet, the
 * default reward row. Only what can be told without the chain: `launchThrough: 'clanker'` is the deployment's own
 * Clanker path (v5 where its launcher is live), so token settings there are checked as v5 and the site decides.
 */
export function launchProblem(
  launch: Pick<LaunchInput, 'launchThrough' | 'token' | 'devBuySlippagePct'>,
  creator: string,
): SettingsProblem | null {
  const through = launch.launchThrough;
  if (
    through !== undefined &&
    through !== null &&
    !['bootr', 'clanker', 'clanker-v5'].includes(through)
  )
    return {
      field: 'launchThrough',
      message: `launchThrough must be bootr (default), clanker or clanker-v5, got ${quoted(through)}.`,
    };
  const plain = through === undefined || through === null || through === 'bootr';
  if (plain && launch.token !== undefined)
    return {
      field: 'token',
      message:
        'token settings apply to Clanker v5 launches only (launchThrough clanker on a deployment with the v5 launcher, or clanker-v5); this launch goes through bootr.',
    };
  if (!plain && launch.token !== undefined) {
    const checked = checkTokenSettings(launch.token, creator);
    if (!checked.ok)
      return {
        field: checked.field === 'token' ? 'token' : `token.${checked.field}`,
        message: checked.message,
      };
  }
  if (launch.devBuySlippagePct !== undefined) {
    if (plain)
      return {
        field: 'devBuySlippagePct',
        message:
          'devBuySlippagePct applies to Clanker v5 launches only; this launch goes through bootr.',
      };
    if (parseSlippagePct(launch.devBuySlippagePct) === null)
      return {
        field: 'devBuySlippagePct',
        message: `devBuySlippagePct must be a percent from ${DEV_BUY_SLIPPAGE.minPct} to ${DEV_BUY_SLIPPAGE.maxPct} (default ${DEV_BUY_SLIPPAGE.defaultPct}), got ${quoted(launch.devBuySlippagePct)}.`,
      };
  }
  return null;
}
