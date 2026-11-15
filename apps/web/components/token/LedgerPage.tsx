'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { isAddress } from 'viem';
import { useAgentLedger, useToken } from '@/lib/indexer';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { TokenImage } from '@/components/ui/TokenImage';
import { LedgerDays } from './LedgerDays';
import { LedgerTable } from './LedgerTable';

export function LedgerSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy="true" aria-label="Loading the ledger">
      <Skeleton className="h-8 w-56" />
      <Skeleton className="h-32 w-full" />
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function LedgerRoute() {
  const params = useParams<{ address: string }>();
  const address = decodeURIComponent(params?.address ?? '');
  return <LedgerPage key={address.toLowerCase()} address={address} />;
}

/**
 * `/token/:address/ledger`: the agent's money, newest first, with the last seven days' totals on top. Public: what a
 * holder can check about where the agent's money came from and went. Mobile first: one column, rows as short cards.
 */
export function LedgerPage({ address }: { address: string }) {
  const valid = isAddress(address, { strict: false });
  const { data: token, isPending, isError } = useToken(valid ? address : undefined);
  const ledger = useAgentLedger(token?.kernel);

  if (!valid || (!isPending && !isError && !token)) {
    return (
      <div className="flex flex-col items-start gap-3 py-16">
        <h1 className="text-display-md font-semibold text-ink">Token not found.</h1>
        <Link href="/" className="text-link hover:underline">
          Back to tokens
        </Link>
      </div>
    );
  }
  if (isPending) return <LedgerSkeleton />;
  if (isError || !token) {
    return (
      <div className="flex flex-col items-start gap-3 py-16">
        <h1 className="text-display-md font-semibold text-ink">The indexer did not respond.</h1>
        <Link href={`/token/${address}`} className="text-link hover:underline">
          Back to coin
        </Link>
      </div>
    );
  }

  const pages = ledger.data?.pages ?? [];
  const rows = pages.flatMap((p) => p.rows);
  const first = pages[0];
  const partial = pages.some((p) => p.partial);
  return (
    <section aria-labelledby="ledger-title" className="mx-auto flex w-full max-w-5xl flex-col gap-5" data-testid="ledger-page">
      <header className="flex flex-col gap-2">
        <Link href={`/token/${token.id}`} className="inline-flex items-center gap-2 text-caption text-body hover:text-link">
          <TokenImage src={token.image} symbol={token.symbol} size={20} className="rounded-xs" />
          <span>
            {token.name} <span className="font-mono text-mute">${token.symbol}</span>
          </span>
        </Link>
        <h1 id="ledger-title" className="text-display-sm font-semibold text-ink">
          The agent&rsquo;s money
        </h1>
        <p className="max-w-2xl text-sm text-body">
          Every amount that came into the agent&rsquo;s wallet or left it, newest first: fees it collected, fuel people sent it, what it paid for its thinking and
          for paid services, and its bounties. Each line was written by code when it happened; nobody can edit it.
        </p>
      </header>

      <Panel title="Last seven days (UTC)">
        {ledger.isPending ? (
          <Skeleton className="h-24" />
        ) : first?.days ? (
          <LedgerDays days={first.days} complete={first.daysComplete !== false} />
        ) : (
          <p className="text-caption text-mute">The totals are unavailable right now.</p>
        )}
      </Panel>

      <Panel title="Every movement" bodyClassName="px-5 py-2">
        {partial ? (
          <p className="mb-2 rounded-xs bg-canvas-soft px-3 py-2 text-caption text-body" data-testid="ledger-partial">
            Fee claims and money people sent could not be read just now; they are missing from this list until the next load.
          </p>
        ) : null}
        {ledger.isPending ? (
          <div className="flex flex-col gap-2 py-2">
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
            <Skeleton className="h-10" />
          </div>
        ) : ledger.isError && rows.length === 0 ? (
          <p className="py-4 text-caption text-mute">The ledger is unavailable right now.</p>
        ) : (
          <LedgerTable rows={rows} />
        )}
        {ledger.hasNextPage ? (
          <div className="py-2">
            <Button variant="ghost" size="sm" onClick={() => void ledger.fetchNextPage()} loading={ledger.isFetchingNextPage} loadingLabel="Loading…">
              Show older
            </Button>
          </div>
        ) : null}
      </Panel>

      <footer className="flex max-w-2xl flex-col gap-1 text-micro text-mute">
        <p>Amounts are in their own asset; a dollar value is the one at the time, where the site has it.</p>
        <p>&ldquo;Moved&rdquo; is money between the agent&rsquo;s own wallets or from one of its assets to another: not spent, and in neither total.</p>
        <p>&ldquo;Not settled yet&rdquo; means a payment may have gone out and the chain has not settled it; the line stays that way until it does.</p>
        <p>This is a record of what the agent did with money. It says nothing about the coin&rsquo;s price.</p>
      </footer>
    </section>
  );
}
