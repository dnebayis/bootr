/**
 * `GET /platform/fees` body: platform fee totals per launch path (`sourceStats` rows) plus the sums. Pure, so the
 * shape is testable without Ponder. Every figure is USD at the time it was booked; a source with no row yet
 * answers zeros, so the body always carries both sources.
 */
import { LAUNCH_SOURCES, type LaunchSource } from '../lib/fees';
import { usd } from '../lib/price';

export type SourceStatsRow = {
  id: string;
  tokens: number;
  volumeTotalUsd: number;
  feesTotalUsd: number;
  feesAgentUsd: number;
  feesCreatorUsd: number;
  feesBurnUsd: number;
  feesPlatformUsd: number;
  feesClaimedUsd: number;
  feesPlatformClaimedUsd: number;
  updatedAt: number;
};

export type SourceFees = {
  tokens: number;
  volumeTotalUsd: number;
  /** Gross swap fees traders paid (bootr: incl. RWAGMI's 10%; clanker: incl. Clanker's 20% on top). */
  feesTotalUsd: number;
  /** What accrued to Bootr's slots, per kind. */
  byKind: Record<'agent' | 'creator' | 'burn' | 'platform', number>;
  /** Claims of every slot kind, and of the platform slot alone. */
  feesClaimedUsd: number;
  feesPlatformClaimedUsd: number;
  updatedAt: number | null;
};

const empty = (): SourceFees => ({
  tokens: 0,
  volumeTotalUsd: 0,
  feesTotalUsd: 0,
  byKind: { agent: 0, creator: 0, burn: 0, platform: 0 },
  feesClaimedUsd: 0,
  feesPlatformClaimedUsd: 0,
  updatedAt: null,
});

function fromRow(r: SourceStatsRow): SourceFees {
  return {
    tokens: r.tokens,
    volumeTotalUsd: usd(r.volumeTotalUsd),
    feesTotalUsd: usd(r.feesTotalUsd),
    byKind: { agent: usd(r.feesAgentUsd), creator: usd(r.feesCreatorUsd), burn: usd(r.feesBurnUsd), platform: usd(r.feesPlatformUsd) },
    feesClaimedUsd: usd(r.feesClaimedUsd),
    feesPlatformClaimedUsd: usd(r.feesPlatformClaimedUsd),
    updatedAt: r.updatedAt || null,
  };
}

export function composePlatformFees(rows: readonly SourceStatsRow[]) {
  const bySource = Object.fromEntries(LAUNCH_SOURCES.map((s) => [s, empty()])) as Record<LaunchSource, SourceFees>;
  for (const r of rows) {
    if (r.id === 'bootr' || r.id === 'clanker') bySource[r.id] = fromRow(r);
  }
  const all = Object.values(bySource);
  const sum = (f: (s: SourceFees) => number) => usd(all.reduce((acc, s) => acc + f(s), 0));
  const total: SourceFees = {
    tokens: all.reduce((acc, s) => acc + s.tokens, 0),
    volumeTotalUsd: sum((s) => s.volumeTotalUsd),
    feesTotalUsd: sum((s) => s.feesTotalUsd),
    byKind: {
      agent: sum((s) => s.byKind.agent),
      creator: sum((s) => s.byKind.creator),
      burn: sum((s) => s.byKind.burn),
      platform: sum((s) => s.byKind.platform),
    },
    feesClaimedUsd: sum((s) => s.feesClaimedUsd),
    feesPlatformClaimedUsd: sum((s) => s.feesPlatformClaimedUsd),
    updatedAt: all.reduce<number | null>((acc, s) => (s.updatedAt !== null && (acc === null || s.updatedAt > acc) ? s.updatedAt : acc), null),
  };
  return { total, bySource };
}

export type PlatformFeesBody = ReturnType<typeof composePlatformFees>;
