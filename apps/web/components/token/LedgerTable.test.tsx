import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { amountText, capUse, ledgerHref, sumDays, usdText, utcWhen } from '@/lib/ledger-view';
import { mockLedger } from '@/lib/mock-ledger';
import { activityNextPage } from '@/lib/indexer';
import type { LedgerRow } from '@/lib/types';
import { LedgerDays } from './LedgerDays';
import { LedgerTable } from './LedgerTable';

const CREATOR = '0x2222222222222222222222222222222222222222';
const TX = `0x${'ab'.repeat(32)}` as const;

const rows: LedgerRow[] = [
  { id: 'fuel:a', at: '2026-11-15T10:00:00.000Z', kind: 'fuel_received', direction: 'in', status: 'confirmed', amount: { asset: 'USDC', decimals: 6, raw: '10000000', usd: 10 }, counterparty: { role: 'creator', address: CREATOR }, reason: 'Its creator sent it fuel', txHash: TX },
  { id: 'claim:a', at: '2026-11-15T09:00:00.000Z', kind: 'fee_claim', direction: 'in', status: 'confirmed', amount: { asset: 'WETH', decimals: 18, raw: '2400000000000000', usd: 5.1 }, counterparty: { role: 'fee_locker', address: '0x3333333333333333333333333333333333333333' }, reason: 'Collected its share of the trading fees', txHash: TX },
  { id: 'op:a', at: '2026-11-15T08:00:00.000Z', kind: 'swap', direction: 'move', status: 'confirmed', amount: { asset: 'WETH', decimals: 18, raw: '2000000000000000' }, received: { asset: 'USDC', decimals: 6, raw: '5500000', bound: 'at_least' }, counterparty: { role: 'swap' }, reason: 'Swapped WETH to USDC for fuel' },
  { id: 'svc:a', at: '2026-11-15T07:00:00.000Z', kind: 'service', direction: 'out', status: 'unknown', amount: { asset: 'USDC', decimals: 6, raw: '9000', usd: 0.009, bound: 'at_most' }, counterparty: { role: 'service', host: 'news.example.com' }, reason: 'Today’s headlines <b>about</b> Base' },
  { id: 'bounty:x:posted', at: '2026-11-15T06:00:00.000Z', kind: 'bounty_posted', direction: 'none', status: 'confirmed', amount: { asset: 'USDC', decimals: 6, raw: '500000', usd: 0.5 }, reason: 'Offered a bounty: a picture', url: 'https://x.com/i/status/1234' },
];

describe('LedgerTable', () => {
  it('shows every row with its amount, counterparty, status and link, in plain words', () => {
    const html = renderToStaticMarkup(<LedgerTable rows={rows} />);
    // Phone cards and the wide table both carry every row.
    expect(html.match(/data-testid="ledger-row"/g)).toHaveLength(5);
    expect(html).toContain('10 USDC');
    expect(html).toContain('0.0024 WETH');
    expect(html).toContain('≈ $5.10');
    expect(html).toContain('for at least 5.5 USDC');
    expect(html).toContain('at most 0.009 USDC');
    expect(html).toContain('Not settled yet');
    expect(html).toContain('Its creator');
    expect(html).toContain('news.example.com');
    expect(html).toContain(`https://sepolia.basescan.org/address/${CREATOR}`);
    expect(html).toContain(`/tx/${TX}`);
    expect(html).toContain('https://x.com/i/status/1234');
    expect(html).toContain('Moved');
    // The model's words are text, never markup.
    expect(html).toContain('&lt;b&gt;about&lt;/b&gt;');
    // No internal words and no price talk reach a visitor.
    expect(html).not.toMatch(/x402|session key|kernel|spender|profit|return|gain|loss/i);
  });

  it('says plainly when nothing has moved', () => {
    const html = renderToStaticMarkup(<LedgerTable rows={[]} />);
    expect(html).toContain('data-testid="ledger-empty"');
    expect(html).toContain('No money has moved yet.');
    expect(html).not.toContain('ledger-table');
  });
});

describe('LedgerDays', () => {
  const days = sumDays(rows, ['2026-11-15', '2026-11-14']);

  it('sums each day, keeps moves and promises out of in and out, and says what is not settled', () => {
    expect(days[0]).toMatchObject({ inUsd: 15.1, outUsd: 0, unknown: 1 });
    const html = renderToStaticMarkup(<LedgerDays days={days} />);
    expect(html).toContain('in $15.10 · out $0.00');
    expect(html).toContain('Fuel sent to it: 10 USDC');
    expect(html).toContain('Bounty offered: 0.5 USDC');
    expect(html).toContain('1 not settled yet');
    // An empty day other than today is left out.
    expect(html).not.toContain('2026-11-14');
  });

  it('shows today’s use of the creator’s caps in the console', () => {
    const html = renderToStaticMarkup(<LedgerDays days={days} caps={{ services: { dailyMicroUsdc: 1_000_000 }, bounties: { dailyCapMicroUsdc: 2_000_000 } }} />);
    expect(html).toContain('Bounties offered today (UTC)');
    expect(html).toContain('0.5 of 2 USDC');
    expect(capUse(days[0], { dailyMicroUsdc: 1_000_000 }, { dailyCapMicroUsdc: 2_000_000 })).toEqual([
      { label: 'Paid services', usedMicro: 0, capMicro: 1_000_000 },
      { label: 'Bounties offered', usedMicro: 500_000, capMicro: 2_000_000 },
    ]);
  });
});

describe('ledger words and paging helpers', () => {
  it('writes amounts in their own asset, and a dollar value only beside another asset', () => {
    expect(amountText({ asset: 'WETH', decimals: 18, raw: '1000000000000000', bound: 'about' })).toBe('about 0.001 WETH');
    expect(amountText({ asset: 'USDC', decimals: 6, raw: '4' })).toBe('0.000004 USDC');
    expect(amountText(undefined)).toBe('—');
    expect(usdText({ asset: 'USDC', decimals: 6, raw: '5000000', usd: 5 })).toBeNull();
    expect(usdText({ asset: 'ETH', decimals: 18, raw: '1', usd: 0.004 })).toBe('≈ $0.004');
    expect(ledgerHref('0xabc')).toBe('/token/0xabc/ledger');
  });

  it('pages the mock ledger to the end with its cursor', () => {
    const now = Date.parse('2026-11-15T12:00:00Z');
    const first = mockLedger('0x1234567890123456789012345678901234567890', CREATOR, { limit: 4 }, now);
    expect(first.days).toHaveLength(7);
    const seen = [...first.rows];
    let next = first.next;
    while (next) {
      const page = mockLedger('0x1234567890123456789012345678901234567890', CREATOR, { limit: 4, cursor: next }, now);
      expect(page.days).toBeUndefined();
      seen.push(...page.rows);
      next = page.next;
    }
    expect(new Set(seen.map((r) => r.id)).size).toBe(seen.length);
    expect(seen.length).toBeGreaterThan(12);
  });

  it('follows the tape’s next, and falls back to the last item for an older server', () => {
    expect(activityNextPage({ items: [], next: '2026-11-15T10:00:00.001Z' })).toBe('2026-11-15T10:00:00.001Z');
    expect(activityNextPage({ items: [{ at: 'x', kind: 'post', summary: 's' }], next: null })).toBeUndefined();
    const full = Array.from({ length: 30 }, (_, i) => ({ at: `2026-11-15T10:00:${String(59 - i).padStart(2, '0')}.000Z`, kind: 'post', summary: 's' }));
    expect(activityNextPage({ items: full })).toBe('2026-11-15T10:00:30.000Z');
    expect(activityNextPage({ items: full.slice(0, 3) })).toBeUndefined();
  });
});

describe('utcWhen: a row\'s time is UTC, like the day totals', () => {
  it('writes the same day and hour for every visitor, in English', () => {
    expect(utcWhen('2026-11-15T16:19:42.000Z')).toEqual({ short: '15 Nov, 16:19 UTC', full: '15 Nov 2026, 16:19:42 UTC' });
    // just before midnight UTC stays on the UTC day the totals count it under
    expect(utcWhen('2026-11-14T23:59:00.000Z')?.short).toBe('14 Nov, 23:59 UTC');
    expect(utcWhen('2026-01-02T03:04:05Z')?.short).toBe('2 Jan, 03:04 UTC');
    expect(utcWhen('not a time')).toBeNull();
  });
});

