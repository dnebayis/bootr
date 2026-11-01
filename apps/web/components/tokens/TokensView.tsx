'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef } from 'react';
import { useTokenFeed } from '@/lib/indexer';
import type { TokenTab } from '@/lib/types';
import { cn } from '@/components/ui/cn';
import { Button } from '@/components/ui/Button';
import { Empty } from '@/components/ui/Panel';
import { SearchIcon } from '@/components/ui/Icons';
import { openSearch } from '@/components/shell/search-events';
import { TokenGrid } from './TokenGrid';
import { AsciiWake } from './AsciiWake';
import { TokenCardSkeleton } from './TokenCard';

export const TABS: { id: TokenTab; label: string; empty: string }[] = [
  { id: 'newest', label: 'Newest', empty: 'No coins have launched yet.' },
  { id: 'graduated', label: 'Graduated', empty: 'No coin has crossed the graduation threshold yet.' },
  { id: 'mcap', label: 'Market cap', empty: 'No coins to rank yet.' },
  { id: 'active', label: 'Active', empty: 'No agents are awake right now.' },
];

function parseTab(v: string | null): TokenTab {
  return TABS.some((t) => t.id === v) ? (v as TokenTab) : 'newest';
}

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
      <div className="pb-2.5 sm:w-72">
        <label htmlFor="token-search" className="sr-only">
          Search tokens
        </label>
        <div className="relative">
          <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-mute" />
          <input
            id="token-search"
            readOnly
            placeholder="Search name, symbol, address"
            onClick={() => openSearch()}
            onKeyDown={(e) => {
              if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                openSearch(e.key);
              } else if (e.key === 'Enter') openSearch();
            }}
            className="h-8 w-full cursor-pointer rounded-sm border border-hairline bg-canvas pl-8 pr-12 text-sm text-ink placeholder:text-mute hover:border-hairline-strong focus:border-accent focus:outline-none"
          />
          <kbd className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 rounded-xs border border-hairline px-1 font-mono text-micro text-mute">⌘K</kbd>
        </div>
      </div>
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
  const tokens = useMemo(() => feed.data?.pages.flatMap((p) => p.items) ?? [], [feed.data]);
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
      <AsciiWake />
      <Feed key={tab} tab={tab} />
    </div>
  );
}
