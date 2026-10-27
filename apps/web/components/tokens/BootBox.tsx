'use client';

import { formatUnits } from 'viem';
import { usePlatformStats } from '@/lib/indexer';
import { dexscreenerUrl, explorer } from '@/lib/chains';
import { env } from '@/lib/env';
import { shortAddr } from '@/lib/format';
import { Num, Pct, Usd } from '@/components/ui/Ticker';
import { Skeleton } from '@/components/ui/Skeleton';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { CopyButton } from '@/components/ui/CopyButton';

function Cell({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-canvas px-4 py-3 last:col-span-2 md:px-5 md:last:col-span-1">
      <span className="text-caption text-mute">{label}</span>
      <span className="truncate font-mono text-display-sm font-medium text-ink tabular">{children}</span>
    </div>
  );
}

export function BootBox() {
  const { data, isPending, isError } = usePlatformStats();

  if (isPending) {
    return (
      <section aria-label="BOOT token" className="rounded-md border border-hairline">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="grid grid-cols-2 gap-px bg-hairline md:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="bg-canvas px-5 py-3">
              <Skeleton className="mb-2 h-3 w-16" />
              <Skeleton className="h-6 w-24" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  if (isError || !data?.bootToken) {
    return (
      <section aria-label="BOOT token" className="flex items-center justify-between gap-4 rounded-md border border-hairline px-5 py-4">
        <div className="flex items-baseline gap-3">
          <span className="font-mono text-sm font-medium text-ink">$BOOT</span>
          <span className="text-sm text-mute">{isError ? 'Platform stats are unavailable right now.' : 'BOOT launches with the platform.'}</span>
        </div>
      </section>
    );
  }

  const burned = Number(formatUnits(BigInt(data.bootBurnedTotal || '0'), 18));
  const dex = dexscreenerUrl(data.bootToken);

  return (
    <section aria-label="BOOT token" className="overflow-hidden rounded-md border border-hairline">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-hairline px-4 py-3 md:px-5">
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm font-semibold text-ink">$BOOT</span>
          <span className="text-caption text-mute">Platform token · fees buy and burn it</span>
          <span className="hidden items-center gap-1 font-mono text-caption text-mute sm:inline-flex">
            {shortAddr(data.bootToken)}
            <CopyButton value={data.bootToken} label="Copy BOOT address" />
          </span>
        </div>
        <div className="flex items-center gap-4 text-caption">
          {dex ? <ExternalLink href={dex}>DexScreener</ExternalLink> : <ExternalLink href={explorer.token(data.bootToken)}>Explorer</ExternalLink>}
          {env.bootXUrl ? <ExternalLink href={env.bootXUrl}>X</ExternalLink> : null}
        </div>
      </header>
      <div className="grid grid-cols-2 gap-px bg-hairline md:grid-cols-5">
        <Cell label="Price">
          <Usd value={data.bootPriceUsd} />
        </Cell>
        <Cell label="Market cap">
          <Usd value={data.bootMarketCapUsd} />
        </Cell>
        <Cell label="24h">
          <Pct value={data.bootChange24hPct} />
        </Cell>
        <Cell label="Total burned">
          <Num value={burned} suffix=" BOOT" />
        </Cell>
        <Cell label="Fees to burn">
          <Usd value={data.bootFeesToBurnUsd} compact={false} />
        </Cell>
      </div>
    </section>
  );
}
