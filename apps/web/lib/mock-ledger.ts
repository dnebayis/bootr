/**
 * Mock-mode money ledger (`NEXT_PUBLIC_USE_MOCK`): a few days of an agent's money, deterministic per kernel, in the
 * shape `GET /api/agent/:kernel/ledger` answers. The cursor is the index of the next row.
 */
import { sumDays } from './ledger-view';
import type { AgentLedger, LedgerRow } from './types';

const DAY = 86_400_000;
const hex = (seed: number, n: number) => `0x${(seed * 2654435761 + n * 40503).toString(16).padStart(8, '0').repeat(8)}` as `0x${string}`;

function rowsFor(kernel: string, creator: string, now: number): LedgerRow[] {
  const seed = parseInt(kernel.slice(2, 8), 16) || 1;
  const usdc = (raw: number, bound?: 'at_most') => ({ asset: 'USDC' as const, decimals: 6, raw: String(raw), usd: raw / 1e6, ...(bound ? { bound } : {}) });
  const rows: LedgerRow[] = [];
  for (let d = 0; d < 6; d++) {
    const base = now - d * DAY;
    const day = new Date(base).toISOString().slice(0, 10);
    rows.push({ id: `think:${day}:relay:paid`, at: new Date(base - 600_000).toISOString(), kind: 'thinking', direction: 'out', status: 'confirmed', amount: usdc(180_000 + d * 7_000), counterparty: { role: 'thinking_service' }, reason: `Paid for ${18 + d} thoughts on ${day} (UTC)` });
    rows.push({ id: `claim:mock-${d}`, at: new Date(base - 3 * 3_600_000).toISOString(), kind: 'fee_claim', direction: 'in', status: 'confirmed', amount: { asset: 'WETH', decimals: 18, raw: String(1_200_000_000_000_000 + d * 100_000_000_000_000), usd: 4.1 + d * 0.3 }, counterparty: { role: 'fee_locker' }, reason: 'Collected its share of the trading fees', txHash: hex(seed, d) });
    if (d % 2 === 0) rows.push({ id: `op:mock-fuel-${d}`, at: new Date(base - 3 * 3_600_000 + 60_000).toISOString(), kind: 'fuel_topup', direction: 'move', status: 'confirmed', amount: usdc(2_000_000), counterparty: { role: 'own_wallet' }, reason: 'Moved fuel to the wallet that pays for its thinking', txHash: hex(seed, 100 + d) });
    if (d === 1) rows.push({ id: 'svc:mock-1', at: new Date(base - 5 * 3_600_000).toISOString(), kind: 'service', direction: 'out', status: 'confirmed', amount: usdc(5_000), counterparty: { role: 'service', host: 'data.example.com' }, reason: 'The ETH price for a reply about fees', txHash: hex(seed, 200) });
    if (d === 2) rows.push({ id: 'fuel:mock-2', at: new Date(base - 7 * 3_600_000).toISOString(), kind: 'fuel_received', direction: 'in', status: 'confirmed', amount: usdc(10_000_000), counterparty: { role: 'creator', address: creator.toLowerCase() }, reason: 'Its creator sent it fuel', txHash: hex(seed, 300) });
  }
  rows.push({ id: 'svc:mock-open', at: new Date(now - 120_000).toISOString(), kind: 'service', direction: 'out', status: 'unknown', amount: usdc(9_000, 'at_most'), counterparty: { role: 'service', host: 'news.example.com' }, reason: 'Today’s headlines about Base' });
  return rows.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.id < b.id ? 1 : -1));
}

export function mockLedger(kernel: string, creator: string, opts: { limit: number; cursor?: string | null }, now = Date.now()): AgentLedger {
  const all = rowsFor(kernel, creator, now);
  let start = 0;
  if (opts.cursor) {
    const n = /^\d{1,6}$/.test(opts.cursor) ? Number(opts.cursor) : 0;
    start = Number.isInteger(n) && n > 0 ? n : 0;
  }
  const rows = all.slice(start, start + opts.limit);
  const end = start + rows.length;
  const page: AgentLedger = { rows, next: end < all.length ? String(end) : null, partial: false };
  if (!opts.cursor) {
    const today = Math.floor(now / DAY) * DAY;
    page.days = sumDays(all, Array.from({ length: 7 }, (_, i) => new Date(today - i * DAY).toISOString().slice(0, 10)));
    page.daysComplete = true;
  }
  return page;
}
