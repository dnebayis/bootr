'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { formatUnits } from 'viem';
import { useAgents, useDailyStats, usePlatformStats } from '@/lib/indexer';
import { dateLabel, num, usd } from '@/lib/format';
import { Num, Usd } from '@/components/ui/Ticker';
import { StatRow, StatTile } from '@/components/ui/StatTile';
import { Skeleton } from '@/components/ui/Skeleton';
import { Empty } from '@/components/ui/Panel';
import { cn } from '@/components/ui/cn';
import { BarsChart, HBarsChart, Legend, SeriesChart, StackedBarsChart } from './charts';

const RANGES = [
  { id: 30, label: '30D' },
  { id: 90, label: '90D' },
] as const;

function ChartPanel({ title, value, note, children, className, legend }: { title: string; value?: ReactNode; note?: ReactNode; children: ReactNode; className?: string; legend?: ReactNode }) {
  return (
    <section className={cn('flex min-w-0 flex-col gap-4 rounded-md border border-hairline p-5', className)}>
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-medium text-ink">{title}</h2>
        {value ? (
          <span className="flex flex-col items-end gap-0.5">
            <span className="font-mono text-sm text-ink tabular">{value}</span>
            {note ? <span className="text-caption text-mute">{note}</span> : null}
          </span>
        ) : null}
      </header>
      {children}
      {legend}
    </section>
  );
}

export function AnalyticsView() {
  const daily = useDailyStats();
  const platform = usePlatformStats();
  const agents = useAgents();
  const [range, setRange] = useState<30 | 90>(90);

  const rows = useMemo(() => (daily.data ?? []).slice(-range), [daily.data, range]);
  const series = useMemo(() => {
    const daily = rows.map((d) => Number(formatUnits(BigInt(d.bootBurnedToken || '0'), 18)));
    return rows.map((d, i) => ({ ...d, burnedCum: daily.slice(0, i + 1).reduce((a, b) => a + b, 0) }));
  }, [rows]);

  const topAgents = useMemo(
    () =>
      (agents.data ?? [])
        .filter((a) => a.reputationScore != null && a.tokenInfo)
        .sort((a, b) => (b.reputationScore ?? 0) - (a.reputationScore ?? 0) || b.reputationCount - a.reputationCount)
        .slice(0, 10),
    [agents.data],
  );

  const p = platform.data;
  const burnedTotal = p ? Number(formatUnits(BigInt(p.bootBurnedTotal || '0'), 18)) : null;
  const sum = (k: 'volumeUsd' | 'feesUsd' | 'launches') => rows.reduce((a, d) => a + d[k], 0);
  // What the four reward slots received; `feesUsd` is the gross swap fee, with RWAGMI's 10% (bootr) or
  // Clanker's 20% on top (clanker) included, and had been shown as if it all went to the recipients.
  const toRecipients = rows.reduce((a, d) => a + d.feesAgentUsd + d.feesCreatorUsd + d.feesBurnUsd + d.feesPlatformUsd, 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-display-lg font-semibold text-ink">Analytics</h1>
          <p className="text-sm text-mute">Platform-wide activity, by UTC day.</p>
        </div>
        <div role="tablist" aria-label="Range" className="inline-flex rounded-sm border border-hairline p-0.5">
          {RANGES.map((r) => (
            <button
              key={r.id}
              role="tab"
              aria-selected={range === r.id}
              onClick={() => setRange(r.id)}
              className={cn('h-7 rounded-xs px-2.5 font-mono text-caption transition-colors', range === r.id ? 'bg-ink text-on-ink' : 'text-mute hover:text-ink')}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <StatRow className="grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
        <StatTile label="Tokens" value={<Num value={p?.tokens} compact={false} />} />
        <StatTile label="Agents awake" value={<Num value={p?.agentsAwake} compact={false} />} />
        <StatTile label="Volume 24h" value={<Usd value={p?.volume24hUsd} />} />
        <StatTile label="Volume, all time" value={<Usd value={p?.volumeTotalUsd} />} />
        <StatTile label="Swap fees charged, all time" value={<Usd value={p?.feesTotalUsd} />} note="incl. the launch protocol’s share" />
        <StatTile label="BOOTR burned" value={<Num value={burnedTotal} />} />
      </StatRow>

      {daily.isPending ? (
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} className="h-[300px]" />
          ))}
        </div>
      ) : daily.isError ? (
        <Empty>Daily stats are unavailable right now.</Empty>
      ) : rows.length === 0 ? (
        <Empty>No activity recorded yet.</Empty>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <ChartPanel title="Total volume" value={usd(sum('volumeUsd'))} className="lg:col-span-2">
            <SeriesChart label="Total volume" data={rows.map((d) => ({ x: d.id, y: d.volumeUsd }))} height={240} format={(n) => usd(n)} labelFormat={dateLabel} />
          </ChartPanel>
          <ChartPanel
            title="Fees to recipients"
            value={usd(toRecipients)}
            note={`of ${usd(sum('feesUsd'))} charged on trades`}
            legend={
              <Legend
                items={[
                  { label: 'Agent', className: 'bg-chart-1' },
                  { label: 'Creator', className: 'bg-chart-2' },
                  { label: 'Burn', className: 'bg-chart-3' },
                  { label: 'Platform', className: 'bg-chart-4' },
                ]}
              />
            }
          >
            <StackedBarsChart
              label="Fees by recipient"
              data={rows.map((d) => ({ x: d.id, agent: d.feesAgentUsd, creator: d.feesCreatorUsd, burn: d.feesBurnUsd, platform: d.feesPlatformUsd }))}
              keys={['agent', 'creator', 'burn', 'platform']}
              labels={{ agent: 'Agent', creator: 'Creator', burn: 'Burn', platform: 'Platform' }}
              format={(n) => usd(n)}
              labelFormat={dateLabel}
            />
          </ChartPanel>
          <ChartPanel title="Launches per day" value={`${num(sum('launches'))} total`}>
            <BarsChart label="Launches per day" data={rows.map((d) => ({ x: d.id, y: d.launches }))} height={220} format={(n) => num(n)} labelFormat={dateLabel} />
          </ChartPanel>
          <ChartPanel title="Awake agents" value={rows.length ? num(rows[rows.length - 1]!.awakeAgents) : undefined}>
            <SeriesChart label="Awake agents" kind="line" data={rows.map((d) => ({ x: d.id, y: d.awakeAgents }))} format={(n) => num(Math.round(n))} labelFormat={dateLabel} />
          </ChartPanel>
          <ChartPanel title="$BOOTR burned, cumulative" value={series.length ? `${num(series[series.length - 1]!.burnedCum)} BOOTR` : undefined}>
            <SeriesChart label="BOOTR burned cumulative" data={series.map((d) => ({ x: d.id, y: d.burnedCum }))} format={(n) => num(n)} labelFormat={dateLabel} />
          </ChartPanel>
          <ChartPanel title="Top agents by reputation" className="lg:col-span-2">
            {agents.isPending ? (
              <Skeleton className="h-64" />
            ) : topAgents.length === 0 ? (
              <Empty>No agent has received feedback yet.</Empty>
            ) : (
              <HBarsChart
                max={100}
                format={(n) => n.toFixed(1)}
                items={topAgents.map((a) => ({
                  label: a.tokenInfo!.name,
                  sub: `$${a.tokenInfo!.symbol} · ${a.reputationCount}`,
                  value: a.reputationScore ?? 0,
                  href: `/token/${a.tokenInfo!.id}`,
                }))}
              />
            )}
          </ChartPanel>
        </div>
      )}
    </div>
  );
}
