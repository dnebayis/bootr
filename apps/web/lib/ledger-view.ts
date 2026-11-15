/**
 * How the money ledger reads on the page (components/token/LedgerTable.tsx, LedgerPage.tsx, the console's money box):
 * plain words for every kind, direction, status and counterparty, and amounts in their own asset. No word of the
 * internals reaches a visitor ("wallet", "thinking", "paid service"), and nothing is coloured or worded as a gain or a
 * loss: the ledger is a record of what the agent did with money, not a price.
 */
import { formatUnits } from 'viem';
import type { AgentServicesPolicy, AgentBountiesPolicy, LedgerAmount, LedgerDay, LedgerDayLine, LedgerDirection, LedgerKind, LedgerParty, LedgerRow, LedgerStatus } from './types';

export const KIND_LABEL: Record<LedgerKind, string> = {
  fee_claim: 'Fee claim',
  fuel_received: 'Fuel sent to it',
  fuel_topup: 'Fuel for thinking',
  gas_topup: 'Gas',
  swap: 'Swap',
  transfer: 'Transfer',
  thinking: 'Thinking',
  service: 'Paid service',
  trade: 'Trade',
  bounty_posted: 'Bounty offered',
  bounty_judged: 'Bounty judged',
  bounty_paid: 'Bounty paid',
  bounty_closed: 'Bounty closed',
};

export const DIRECTION_LABEL: Record<LedgerDirection, string> = { in: 'In', out: 'Out', move: 'Moved', none: '—' };

export const DIRECTION_TITLE: Record<LedgerDirection, string> = {
  in: 'Money that came into the agent’s wallet',
  out: 'Money that left the agent’s wallets',
  move: 'Between the agent’s own wallets, or from one of its assets to another: not spent',
  none: 'No money moved',
};

export const STATUS_LABEL: Record<LedgerStatus, string> = { confirmed: 'Done', failed: 'Failed', unknown: 'Not settled yet' };

export const STATUS_TITLE: Record<LedgerStatus, string> = {
  confirmed: 'Settled: on chain, or paid and answered',
  failed: 'Did not go through; nothing moved',
  unknown: 'The payment may have gone out and is not settled yet; it stays this way until the chain settles it',
};

const ROLE_LABEL: Record<LedgerParty['role'], string> = {
  fee_locker: 'Fee contract',
  person: 'Someone',
  creator: 'Its creator',
  own_wallet: 'Its own wallet',
  thinking_service: 'Bootr (thinking)',
  blockrun: 'BlockRun (thinking)',
  service: 'A web service',
  bounty_winner: 'Bounty winner',
  swap: 'Swap contract',
  gas: 'Gas for its transactions',
  unknown: '—',
};

/** Who the other side is, in words; a service is named by its host. */
export function partyLabel(p: LedgerParty | undefined): string {
  if (!p) return '—';
  if (p.role === 'service' && p.host) return p.host;
  return ROLE_LABEL[p.role];
}

/** "0.0024", "12.5", "0.000004": up to `maxFrac` decimals, tiny amounts keep two significant digits. */
export function amountNumber(raw: string, decimals: number, maxFrac = 6): string {
  let n: number;
  try {
    n = Number(formatUnits(BigInt(raw), decimals));
  } catch {
    return '—';
  }
  if (!Number.isFinite(n)) return '—';
  if (n === 0) return '0';
  if (n < 10 ** -maxFrac) return n.toLocaleString('en-US', { maximumSignificantDigits: 2, maximumFractionDigits: 18 });
  return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
}

const BOUND_WORD: Record<NonNullable<LedgerAmount['bound']>, string> = { about: 'about ', at_least: 'at least ', at_most: 'at most ' };

/** "about 0.0024 WETH", "at most 0.05 USDC", "12 USDC". */
export function amountText(a: LedgerAmount | undefined): string {
  if (!a) return '—';
  return `${a.bound ? BOUND_WORD[a.bound] : ''}${amountNumber(a.raw, a.decimals, a.asset === 'USDC' ? 4 : 6)} ${a.asset}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const two = (n: number) => String(n).padStart(2, '0');

/**
 * A row's time as the day totals above it count it: in UTC, in English, the same for every visitor ("15 Nov, 16:19
 * UTC"). The viewer's own zone would put a row under a different day than its total, and the locale would mix
 * languages on the page. Null for a time that does not parse.
 */
export function utcWhen(at: string): { short: string; full: string } | null {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const day = `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
  const time = `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
  return { short: `${day}, ${time} UTC`, full: `${day} ${d.getUTCFullYear()}, ${time}:${two(d.getUTCSeconds())} UTC` };
}

/** "≈ $5.10" where the site has a dollar value and the asset is not already dollars; null otherwise. */
export function usdText(a: LedgerAmount | undefined): string | null {
  if (!a || a.asset === 'USDC' || a.usd === undefined) return null;
  return `≈ $${a.usd >= 1 ? a.usd.toFixed(2) : a.usd.toLocaleString('en-US', { maximumSignificantDigits: 2 })}`;
}

/** A dollar sum of a day's side, or a dash when one of its lines has no dollar value. */
export function usdSum(v: number | null): string {
  if (v === null) return '—';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "Sat 15 Nov" for a UTC day. */
export function dayName(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** The lines of a day in a stable order: in, out, moved, promises; within each, by kind. */
export function orderedLines(day: LedgerDay): LedgerDayLine[] {
  const rank: Record<LedgerDirection, number> = { in: 0, out: 1, move: 2, none: 3 };
  const kinds = Object.keys(KIND_LABEL);
  return [...day.lines].sort((a, b) => rank[a.direction] - rank[b.direction] || kinds.indexOf(a.kind) - kinds.indexOf(b.kind) || a.asset.localeCompare(b.asset));
}

/** "Thinking: 0.12 USDC (3)". */
export function lineText(l: LedgerDayLine): string {
  return `${KIND_LABEL[l.kind]}${l.paidBy === 'creator' ? ' (from its creator’s wallet)' : ''}: ${amountNumber(l.raw, l.decimals, l.asset === 'USDC' ? 4 : 6)} ${l.asset}${l.count > 1 ? ` (${l.count})` : ''}`;
}

/** What a day has used of the creator's caps (creator console): services settled and bounties offered, beside each cap. */
export function capUse(day: LedgerDay | undefined, services: Pick<AgentServicesPolicy, 'dailyMicroUsdc'>, bounties: Pick<AgentBountiesPolicy, 'dailyCapMicroUsdc'>): { label: string; usedMicro: number; capMicro: number }[] {
  const sum = (kind: LedgerKind) => (day?.lines ?? []).filter((l) => l.kind === kind && l.asset === 'USDC').reduce((s, l) => s + Number(l.raw), 0);
  return [
    { label: 'Paid services', usedMicro: sum('service'), capMicro: services.dailyMicroUsdc },
    { label: 'Bounties offered', usedMicro: sum('bounty_posted'), capMicro: bounties.dailyCapMicroUsdc },
  ];
}

/** Totals of confirmed rows per UTC day, the supervisor's `ledgerDays` (apps/supervisor/src/ledger.ts) for the mock. */
export function sumDays(rows: readonly LedgerRow[], days: readonly string[]): LedgerDay[] {
  const out = new Map<string, LedgerDay>(days.map((d) => [d, { day: d, lines: [], inUsd: 0, outUsd: 0, unknown: 0, failed: 0 }]));
  for (const r of rows) {
    const day = out.get(r.at.slice(0, 10));
    if (!day) continue;
    if (r.status === 'unknown') day.unknown += 1;
    if (r.status === 'failed') day.failed += 1;
    if (r.status !== 'confirmed' || !r.amount) continue;
    const a = r.amount;
    let line = day.lines.find((l) => l.kind === r.kind && l.asset === a.asset);
    if (!line) {
      line = { kind: r.kind, direction: r.direction, asset: a.asset, decimals: a.decimals, raw: '0', usd: 0, count: 0, ...(r.paidBy ? { paidBy: r.paidBy } : {}) };
      day.lines.push(line);
    }
    line.raw = (BigInt(line.raw) + BigInt(a.raw)).toString();
    line.count += 1;
    line.usd = line.usd === null || a.usd === undefined ? null : line.usd + a.usd;
  }
  for (const day of out.values()) {
    for (const dir of ['in', 'out'] as const) {
      const own = day.lines.filter((l) => l.direction === dir && !l.paidBy);
      const sum = own.some((l) => l.usd === null) ? null : Math.round(own.reduce((s, l) => s + (l.usd ?? 0), 0) * 100) / 100;
      if (dir === 'in') day.inUsd = sum;
      else day.outUsd = sum;
    }
  }
  return [...out.values()];
}

/** The ledger page of a coin. */
export function ledgerHref(tokenId: string): string {
  return `/token/${tokenId}/ledger`;
}
