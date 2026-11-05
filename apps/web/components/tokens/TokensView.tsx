'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { TRENDING_MAX_TRADERS, TRENDING_WALLET_TRADES_CAP, TRENDING_WALLET_VOLUME_CAP_USD, TRENDING_WINDOW_HOURS } from '@bootr/shared/trending';
import { useTokenFeed } from '@/lib/indexer';
import { hasFilters, parseTokenFilters, tokensPageQuery, type TokenFilters } from '@/lib/token-filters';
import type { TokenTab } from '@/lib/types';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/Button';
import { Empty } from '@/components/ui/Panel';
import { TokenFilterBar } from './TokenFilterBar';
import { TokenGrid } from './TokenGrid';
import { TokenCardSkeleton } from './TokenCard';

export const TABS: { id: TokenTab; label: string; empty: string }[] = [
  { id: 'newest', label: 'Newest', empty: 'No coins have launched yet.' } /* bump order: last trade, else launch */,
  { id: 'trending', label: 'Trending', empty: `No coin has traded in the last ${TRENDING_WINDOW_HOURS} hours.` },
  { id: 'graduated', label: 'Graduated', empty: 'No coin has crossed the graduation threshold yet.' },
  { id: 'mcap', label: 'Market cap', empty: 'No coins to rank yet.' },
  { id: 'active', label: 'Active', empty: 'No agents are awake right now.' },
];

function parseTab(v: string | null): TokenTab {
  return TABS.some((t) => t.id === v) ? (v as TokenTab) : 'newest';
}

/** The tabs. Search lives in the hero (and ⌘K); this row only points at it. */
export function TabsRow({ tab, filters = {} }: { tab: TokenTab | null; filters?: TokenFilters }) {
  return (
    <div className="flex flex-col-reverse gap-3 border-b border-hairline sm:flex-row sm:items-end sm:justify-between">
      <nav aria-label="Token lists" className="-mb-px flex gap-5 overflow-x-auto">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <Link
              key={t.id}
              href={`/${tokensPageQuery(t.id, filters) ? `?${tokensPageQuery(t.id, filters)}` : ''}`}
              scroll={false}
              replace
              aria-current={active ? 'page' : undefined}
              className={cn(
                'whitespace-nowrap border-b py-2.5 text-sm transition-colors duration-150',
                active ? 'border-ink text-ink' : 'border-transparent text-mute hover:text-ink',
              )}
            >
              {t.label}
            </Link>
          );
        })}
      </nav>
      <span className="pb-2.5 font-mono text-caption text-mute max-sm:hidden">Search with ⌘K</span>
    </div>
  );
}

export function GridSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4" aria-busy="true" aria-label="Loading tokens">
      {Array.from({ length: 12 }, (_, i) => (
        <TokenCardSkeleton key={i} />
      ))}
    </div>
  );
}

/** What the Trending tab measures, in the numbers the score really uses. */
function TrendingNote() {
  return (
    <p className="text-caption text-mute" data-testid="trending-note">
      Ranked by how many different wallets traded each coin in the last {TRENDING_WINDOW_HOURS} hours (up to {TRENDING_MAX_TRADERS}), and by their volume and trades, with each wallet counted for at most ${TRENDING_WALLET_VOLUME_CAP_USD} and {TRENDING_WALLET_TRADES_CAP} trades, so one wallet cannot lift a coin. It measures recent trading activity only, not quality or what the price does next.
    </p>
  );
}

function Feed({ tab, filters }: { tab: TokenTab; filters: TokenFilters }) {
  const feed = useTokenFeed(tab, filters);
  // Dedupe by id: in bump order a coin can move from a later page to an earlier one between page fetches.
  const tokens = useMemo(() => {
    const seen = new Set<string>();
    return (feed.data?.pages.flatMap((p) => p.items) ?? []).filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
  }, [feed.data]);
  const sentinel = useRef<HTMLDivElement>(null);
  const { hasNextPage, isFetchingNextPage, fetchNextPage } = feed;

  useEffect(() => {
    const el = sentinel.current;
    if (!el || !hasNextPage) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting && !isFetchingNextPage) void fetchNextPage();
      },
      { rootMargin: '600px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  if (feed.isPending) return <GridSkeleton />;
  if (feed.isError)
    return (
      <Empty action={<Button onClick={() => void feed.refetch()}>Retry</Button>}>The indexer did not respond. Retry in a moment.</Empty>
    );
  if (tokens.length === 0) return <Empty>{hasFilters(filters) ? 'No coin matches these filters.' : TABS.find((t) => t.id === tab)!.empty}</Empty>;

  return (
    <>
      <TokenGrid tokens={tokens} resetKey={`${tab}?${tokensPageQuery(tab, filters)}`} />
      <div ref={sentinel} className="flex justify-center py-6">
        {hasNextPage ? (
          <Button variant="secondary" onClick={() => void fetchNextPage()} loading={isFetchingNextPage} loadingLabel="Loading…">
            Load more
          </Button>
        ) : (
          <span className="font-mono text-caption text-mute">{tokens.length} tokens</span>
        )}
      </div>
    </>
  );
}

export function TokensView() {
  const params = useSearchParams();
  const tab = parseTab(params.get('tab'));
  const query = params.toString();
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `query` is the content of `params`, which is a new object on every navigation
  const filters = useMemo(() => parseTokenFilters(params), [query]);
  return (
    <div className="flex flex-col gap-4">
      <TabsRow tab={tab} filters={filters} />
      <TokenFilterBar tab={tab} filters={filters} />
      {tab === 'trending' ? <TrendingNote /> : null}
      <Feed key={`${tab}?${tokensPageQuery(tab, filters)}`} tab={tab} filters={filters} />
    </div>
  );
}
