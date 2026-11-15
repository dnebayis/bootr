/** Shared pieces of the stage-5 tests: records as the serving seam hands them over. */
import type { ServedRecord } from '../src/dataset/serve.js';

export const NOW = Date.parse('2026-11-15T12:00:00Z');
export const H = 3_600_000;
export const D = 24 * H;

let n = 0;
/** A served record: an official release of Base, first seen two hours before `NOW`, unless `over` says otherwise. */
export function served(over: Partial<ServedRecord> = {}): ServedRecord {
  n += 1;
  return {
    id: `r_${String(n).padStart(12, '0')}`,
    kind: 'release',
    grade: 4,
    groups: 1,
    cited: false,
    status: 'open',
    headline: 'Base node v0.14.2 is out',
    link: 'https://github.com/base/node/releases/tag/v0.14.2',
    cluster: 'base',
    weight: 3,
    coin: null,
    firstSeenAt: new Date(NOW - 2 * H),
    observationCount: 1,
    eventTime: new Date(NOW - 3 * H),
    eventEnd: null,
    eventPrecision: 'day',
    numbers: [],
    sources: [{ sourceId: 'b:base-node', name: 'Base node releases', group: 'coinbase', official: true, open: false }],
    reportOnly: false,
    othersPosted: 0,
    offered: 0,
    score: 1,
    ...over,
  };
}

/** Five records that bring every rule block in: a metric, a desk's report, an incident, a planned event, an old one. */
export function fiveRecords(): ServedRecord[] {
  return [
    served({ kind: 'metric', grade: 4, headline: 'agents on base paid 139.3 usdc for their own thinking this week', cluster: 'bootr', sources: [{ sourceId: 'a:supervisor', name: 'Bootr supervisor', group: 'bootr', official: true, open: false }], numbers: [{ value: 139.3, unit: 'usdc', what: 'paid for thinking, 7 days', asOf: new Date(NOW - H).toISOString(), sourceId: 'a:supervisor' }, { value: 1458, unit: '', what: 'thoughts', asOf: null, sourceId: 'a:supervisor' }] }),
    served({ kind: 'product', grade: 3, groups: 2, headline: 'Stripe opens stablecoin accounts to AI agents', link: 'https://decrypt.co/1/stripe-agents', cluster: 'payments', weight: 2, sources: [{ sourceId: 'b:decrypt', name: 'Decrypt', group: 'decrypt', official: false, open: false }, { sourceId: 'b:the-block', name: 'The Block', group: 'the-block', official: false, open: false }], observationCount: 2 }),
    served({ kind: 'incident', grade: 2, headline: 'A lending market on Base paused withdrawals after an exploit', link: 'https://rekt.news/x', cluster: 'security', weight: 2, reportOnly: true, sources: [{ sourceId: 'b:rekt', name: 'rekt news', group: 'rekt', official: false, open: false }], numbers: [{ value: 2_400_000, unit: 'usd', what: 'lost', asOf: null, sourceId: 'b:rekt' }] }),
    served({ kind: 'governance', grade: 4, headline: 'Optimism upgrade 16 is scheduled', link: 'https://gov.optimism.io/t/1', cluster: 'l2', weight: 2, eventTime: new Date(NOW + 5 * D), eventPrecision: 'planned', sources: [{ sourceId: 'b:op-stack', name: 'OP Stack releases', group: 'optimism', official: true, open: false }] }),
    served({ kind: 'release', grade: 4, headline: 'x402 v0.9.0 adds a payment router for agents', link: 'https://github.com/coinbase/x402/releases/tag/v0.9.0', cluster: 'x402', firstSeenAt: new Date(NOW - 3 * D), eventTime: new Date(NOW - 3 * D), sources: [{ sourceId: 'b:x402-releases', name: 'x402 releases', group: 'coinbase', official: true, open: false }] }),
  ];
}
