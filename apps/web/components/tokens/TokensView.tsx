'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { useTokenFeed } from '@/lib/indexer';
import type { TokenTab } from '@/lib/types';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/Button';
import { Empty } from '@/components/ui/Panel';
import { TokenGrid } from './TokenGrid';
import { TokenCardSkeleton } from './TokenCard';

export const TABS: { id: TokenTab; label: string; empty: string }[] = [
  { id: 'newest', label: 'Newest', empty: 'No coins have launched yet.' } /* bump order: last trade, else launch */,
  { id: 'graduated', label: 'Graduated', empty: 'No coin has crossed the graduation threshold yet.' },
  { id: 'mcap', label: 'Market cap', empty: 'No coins to rank yet.' },
  { id: 'active', label: 'Active', empty: 'No agents are awake right now.' },
];

function parseTab(v: string | null): TokenTab {
  return TABS.some((t) => t.id === v) ? (v as TokenTab) : 'newest';
}

/** The tabs. Search lives in the hero (and ⌘K); this row only points at it. */
export function TabsRow({ tab }: { tab: TokenTab | null }) {
  return (
    <div className="flex flex-col-reverse gap-3 border-b border-hairline sm:flex-row sm:items-end sm:justify-between">
      <nav aria-label="Token lists" className="-mb-px flex gap-5 overflow-x-auto">
        {TABS.map((t) => {
          const active = t.id === tab;
          return (
            <Link
              key={t.id}
              href={t.id === 'newest' ? '/' : `/?tab=${t.id}`}
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

function Feed({ tab }: { tab: TokenTab }) {
  const feed = useTokenFeed(tab);
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
  if (tokens.length === 0) return <Empty>{TABS.find((t) => t.id === tab)!.empty}</Empty>;

  return (
    <>
      <TokenGrid tokens={tokens} resetKey={tab} />
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
  return (
    <div className="flex flex-col gap-4">
      <TabsRow tab={tab} />
      <Feed key={tab} tab={tab} />
    </div>
  );
}
