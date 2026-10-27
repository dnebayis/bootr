'use client';

import Link from 'next/link';
import { isAddress } from 'viem';
import { useToken } from '@/lib/indexer';
import { useNow } from '@/lib/hooks';
import { age, num, pct, price, shortAddr, usd } from '@/lib/format';
import { chainBadge, explorer, swapLink } from '@/lib/chains';
import { Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { LinkButton } from '@/components/ui/Button';
import { Panel, Empty } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { Usd } from '@/components/ui/Ticker';
import { ArrowUpRightIcon } from '@/components/ui/Icons';
import { DexChart } from './DexChart';
import { TokenImage } from '@/components/ui/TokenImage';
import { AgentPanel } from './AgentPanel';
import { FeeSplit } from './FeeSplit';
import { TradesTable } from './TradesTable';

export function TokenSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading token">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <Skeleton className="h-16 w-full" />
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-[480px] w-full" />
      </div>
    </div>
  );
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 bg-canvas px-4 py-3">
      <span className="text-caption text-mute">{label}</span>
      <span className="truncate font-mono text-base font-medium text-ink tabular">{children}</span>
    </div>
  );
}

function NotFound({ address, reason }: { address: string; reason: string }) {
  return (
    <div className="flex flex-col items-start gap-3 py-16">
      <span className="font-mono text-caption text-mute">{address.length > 20 ? shortAddr(address) : address || '—'}</span>
      <h1 className="text-display-md font-semibold text-ink">Token not found.</h1>
      <p className="text-sm text-mute">{reason}</p>
      <Link href="/" className="text-link hover:underline">
        Back to tokens
      </Link>
    </div>
  );
}

export function TokenView({ address }: { address: string }) {
  const valid = isAddress(address, { strict: false });
  const { data: token, isPending, isError, refetch } = useToken(valid ? address : undefined);
  const now = useNow();

  if (!valid) return <NotFound address={address} reason="That is not a valid token address." />;

  if (isPending) return <TokenSkeleton />;
  if (isError)
    return (
      <Empty action={<button className="text-link hover:underline" onClick={() => void refetch()}>Retry</button>}>
        The indexer did not respond.
      </Empty>
    );
  if (!token) return <NotFound address={address} reason="It may not be a Bootr coin, or the indexer has not seen it yet." />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-4">
          <TokenImage src={token.image} symbol={token.symbol} size={56} className="rounded-sm" />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="truncate text-display-md font-semibold text-ink">{token.name}</h1>
              <span className="font-mono text-base text-mute">${token.symbol}</span>
              {token.graduated ? <Badge tone="ink">Graduated</Badge> : null}
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-caption text-mute">
              <a href={explorer.token(token.id)} target="_blank" rel="noopener noreferrer" className="hover:text-link">
                {shortAddr(token.id, 8, 6)}
              </a>
              <CopyButton value={token.id} label="Copy token address" />
              <Badge tone="mono">{chainBadge(token.chainId)}</Badge>
            </div>
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="text-right">
            <div className="text-caption text-mute">Price</div>
            <div className="font-mono text-display-sm font-medium text-ink tabular">${price(token.priceUsd)}</div>
          </div>
          <LinkButton href={swapLink(token.id)} external variant="primary" size="lg">
            Trade <ArrowUpRightIcon />
          </LinkButton>
        </div>
      </header>

      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-md border border-hairline bg-hairline sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Market cap">
          <Usd value={token.marketCapUsd} />
        </Stat>
        <Stat label="24h">{pct(token.change24hPct)}</Stat>
        <Stat label="Volume 24h">{usd(token.volume24hUsd)}</Stat>
        <Stat label="Liquidity">{usd(token.liquidityUsd)}</Stat>
        <Stat label="Holders">{num(token.holders)}</Stat>
        <Stat label="Age">{age(token.launchedAt, now)}</Stat>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="flex min-w-0 flex-col gap-6">
          <DexChart target={token.poolId || token.id} />
          <FeeSplit token={token} />
          <Panel title="Recent trades" bodyClassName="p-0">
            <TradesTable trades={token.trades} symbol={token.symbol} now={now} />
          </Panel>
        </div>
        <aside className="flex flex-col gap-6">
          <AgentPanel token={token} now={now} />
        </aside>
      </div>
    </div>
  );
}
