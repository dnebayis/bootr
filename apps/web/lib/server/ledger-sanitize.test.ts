import { describe, expect, it } from 'vitest';
import { LEDGER_CURSOR_RE, sanitizeActivity, sanitizeLedger, sanitizeLedgerRow } from './supervisor';

const ADDR = '0xAbCdEf0123456789aBcDeF0123456789AbCdEf01';
const TX = `0x${'ab'.repeat(32)}`;

const row = {
  id: 'svc:act-1',
  at: '2026-11-15T10:00:00.000Z',
  kind: 'service',
  direction: 'out',
  status: 'confirmed',
  amount: { asset: 'USDC', decimals: 6, raw: '5000', usd: 0.005 },
  counterparty: { role: 'service', host: 'Data.Example.com', address: ADDR },
  reason: 'ETH price for a reply',
  txHash: TX,
};

describe('sanitizeLedgerRow', () => {
  it('rebuilds a row from its known fields and drops the rest', () => {
    expect(sanitizeLedgerRow({ ...row, extra: 'dropped', secret: 'x' })).toEqual({
      id: 'svc:act-1',
      at: '2026-11-15T10:00:00.000Z',
      kind: 'service',
      direction: 'out',
      status: 'confirmed',
      amount: { asset: 'USDC', decimals: 6, raw: '5000', usd: 0.005 },
      counterparty: { role: 'service', host: 'data.example.com', address: ADDR.toLowerCase() },
      reason: 'ETH price for a reply',
      txHash: TX,
    });
  });

  it('drops a row without a field it must have, or with a value outside its list', () => {
    for (const bad of [{ id: 'no prefix' }, { id: 'svc:<script>' }, { at: 'yesterday' }, { kind: 'withdraw_all' }, { direction: 'sideways' }, { status: 'pending' }, { reason: '' }, { reason: 7 }]) {
      expect([bad, sanitizeLedgerRow({ ...row, ...bad })]).toEqual([bad, null]);
    }
  });

  it('takes the decimals from the asset, never from the service, and refuses amounts that are not digits', () => {
    expect(sanitizeLedgerRow({ ...row, amount: { asset: 'WETH', decimals: 6, raw: '0024000000000000', usd: 5.1, bound: 'about' } })!.amount).toEqual({ asset: 'WETH', decimals: 18, raw: '24000000000000', usd: 5.1, bound: 'about' });
    expect(sanitizeLedgerRow({ ...row, amount: { asset: 'DOGE', raw: '1' } })!.amount).toBeUndefined();
    expect(sanitizeLedgerRow({ ...row, amount: { asset: 'USDC', raw: '-5' } })!.amount).toBeUndefined();
    expect(sanitizeLedgerRow({ ...row, amount: { asset: 'USDC', raw: '1e9' } })!.amount).toBeUndefined();
    expect(sanitizeLedgerRow({ ...row, amount: { asset: 'USDC', raw: '5', usd: -1, bound: 'maybe' } })!.amount).toEqual({ asset: 'USDC', decimals: 6, raw: '5' });
  });

  it('keeps only public, well-formed counterparties, links and hashes', () => {
    const r = sanitizeLedgerRow({ ...row, counterparty: { role: 'creator', address: 'not an address', host: 'evil.example' }, txHash: '0x1234', url: 'javascript:alert(1)', paidBy: 'someone' })!;
    expect(r.counterparty).toEqual({ role: 'creator' });
    expect(r.txHash).toBeUndefined();
    expect(r.url).toBeUndefined();
    expect(r.paidBy).toBeUndefined();
    expect(sanitizeLedgerRow({ ...row, counterparty: { role: 'boss' } })!.counterparty).toBeUndefined();
    // The only link: a post on X, rebuilt from its id; any other https link is dropped.
    expect(sanitizeLedgerRow({ ...row, url: 'https://x.com/i/status/1234' })!.url).toBe('https://x.com/i/status/1234');
    expect(sanitizeLedgerRow({ ...row, url: 'https://x.com.evil.example/i/status/1234' })!.url).toBeUndefined();
    expect(sanitizeLedgerRow({ ...row, kind: 'bounty_paid', paidBy: 'creator' })!.paidBy).toBe('creator');
  });

  it('prints a reason as one line of at most 300 characters', () => {
    expect(sanitizeLedgerRow({ ...row, reason: 'a\nprice now\u0007' })!.reason).toBe('a price now');
    const long = sanitizeLedgerRow({ ...row, reason: 'x'.repeat(1000) })!.reason;
    expect(long).toHaveLength(300);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('sanitizeLedger', () => {
  it('keeps the cursor only in the shape the supervisor writes, and the days in theirs', () => {
    const page = sanitizeLedger({
      rows: [row, { junk: true }],
      next: 'WzE3NjMyMDAwMDAwMDAsInN2YzphY3QtMSJd',
      partial: true,
      days: [
        { day: '2026-11-15', lines: [{ kind: 'thinking', direction: 'out', asset: 'USDC', raw: '120000', usd: 0.12, count: 3 }, { kind: 'bounty_paid', direction: 'out', asset: 'USDC', raw: '500000', usd: 0.5, count: 1, paidBy: 'creator' }, { kind: 'nope' }], inUsd: 12.5, outUsd: 0.12, unknown: 1, failed: 0 },
        { day: 'today', lines: [] },
      ],
      daysComplete: true,
    });
    expect(page.rows).toHaveLength(1);
    expect(page.next).toBe('WzE3NjMyMDAwMDAwMDAsInN2YzphY3QtMSJd');
    expect(page.partial).toBe(true);
    expect(page.days).toEqual([{ day: '2026-11-15', lines: [{ kind: 'thinking', direction: 'out', asset: 'USDC', decimals: 6, raw: '120000', usd: 0.12, count: 3 }, { kind: 'bounty_paid', direction: 'out', asset: 'USDC', decimals: 6, raw: '500000', usd: 0.5, count: 1, paidBy: 'creator' }], inUsd: 12.5, outUsd: 0.12, unknown: 1, failed: 0 }]);
    expect(page.daysComplete).toBe(true);
    expect(sanitizeLedger({ rows: [], next: '../../admin?x=1' }).next).toBeNull();
    expect(sanitizeLedger({ rows: [], next: 'a'.repeat(401) }).next).toBeNull();
    expect(sanitizeLedger(null)).toEqual({ rows: [], next: null, partial: false });
    expect(LEDGER_CURSOR_RE.test('abc_-123')).toBe(true);
  });
});

describe('sanitizeActivity next', () => {
  it('passes the next page’s start as an instant, null at the end, and nothing from a server that sends none', () => {
    expect(sanitizeActivity({ items: [], next: '2026-11-15T10:00:00.001Z' }).next).toBe('2026-11-15T10:00:00.001Z');
    expect(sanitizeActivity({ items: [], next: null })).toEqual({ items: [], next: null });
    expect(sanitizeActivity({ items: [] })).toEqual({ items: [] });
    expect(sanitizeActivity({ items: [], next: 'soon' })).toEqual({ items: [] });
  });
});
