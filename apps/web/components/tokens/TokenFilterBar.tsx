'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { activeFilterCount, hasFilters, isCreatorAddress, TOKEN_SORTS, tokensPageQuery, type TokenFilters, type TokenSortKey } from '@/lib/token-filters';
import type { LaunchSource, TokenTab } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Input, Label, Select } from '@/components/ui/Field';

const ANY = 'any';

/** Creator as typed; it reaches the URL once it is a full address (or empty). */
function CreatorField({ value, onChange }: { value: string | undefined; onChange: (v: string | undefined) => void }) {
  const [draft, setDraft] = useState(value ?? '');
  const off = draft.trim() !== '' && !isCreatorAddress(draft);
  return (
    <div className="sm:col-span-2">
      <Label htmlFor="filter-creator">Creator</Label>
      <Input
        id="filter-creator"
        mono
        value={draft}
        placeholder="0x…"
        spellCheck={false}
        autoComplete="off"
        aria-invalid={off}
        aria-describedby={off ? 'filter-creator-error' : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setDraft(next);
          if (next.trim() === '') onChange(undefined);
          else if (isCreatorAddress(next)) onChange(next.trim().toLowerCase());
        }}
      />
      {off ? (
        <p id="filter-creator-error" className="mt-1 text-micro text-danger">
          Enter a full wallet address.
        </p>
      ) : null}
    </div>
  );
}

/**
 * The tokens page's filters and sort. All of it lives in the URL (`lib/token-filters.ts`), so a filtered view can be
 * shared as a link. The form opens by itself when the link it was opened from carries filters.
 */
export function TokenFilterBar({ tab, filters }: { tab: TokenTab; filters: TokenFilters }) {
  const router = useRouter();
  const pathname = usePathname();
  const [open, setOpen] = useState(() => hasFilters(filters));
  // Remounts the creator field when the filters are cleared, so it does not keep its draft.
  const [resets, setResets] = useState(0);
  const active = activeFilterCount(filters);
  const trending = tab === 'trending';

  const apply = (next: TokenFilters) => {
    const q = tokensPageQuery(tab, next);
    router.replace(q ? `${pathname}?${q}` : pathname, { scroll: false });
  };
  const set = <K extends keyof TokenFilters>(key: K, value: TokenFilters[K] | undefined) => {
    const next = { ...filters };
    if (value === undefined) delete next[key];
    else next[key] = value;
    apply(next);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <Button variant="secondary" size="sm" aria-expanded={open} aria-controls="token-filters" onClick={() => setOpen((v) => !v)}>
          Filters and sort{active ? ` · ${active}` : ''}
        </Button>
        {hasFilters(filters) ? (
          <button
            type="button"
            className="font-mono text-caption text-mute hover:text-link"
            onClick={() => {
              setResets((n) => n + 1);
              apply({});
            }}
          >
            Clear
          </button>
        ) : null}
      </div>
      {open ? (
        <div id="token-filters" data-testid="token-filters" className="grid grid-cols-1 gap-3 rounded-md border border-hairline p-4 sm:grid-cols-2 lg:grid-cols-4">
          <CreatorField key={`${resets}`} value={filters.creator} onChange={(v) => set('creator', v)} />
          <div>
            <Label htmlFor="filter-path">Launched through</Label>
            <Select
              id="filter-path"
              className="w-full"
              value={filters.path ?? ANY}
              options={[
                { value: ANY, label: 'Any' },
                { value: 'bootr', label: 'Bootr' },
                { value: 'clanker', label: 'Clanker' },
              ]}
              onValueChange={(v) => set('path', v === ANY ? undefined : (v as LaunchSource))}
            />
          </div>
          <div>
            <Label htmlFor="filter-agent">Agent</Label>
            <Select
              id="filter-agent"
              className="w-full"
              value={filters.agent ?? ANY}
              options={[
                { value: ANY, label: 'Any' },
                { value: 'yes', label: 'Has an agent' },
                { value: 'no', label: 'No agent' },
              ]}
              onValueChange={(v) => set('agent', v === ANY ? undefined : (v as 'yes' | 'no'))}
            />
          </div>
          <div>
            <Label htmlFor="filter-from">Launched from</Label>
            <Input id="filter-from" type="date" value={filters.from ?? ''} max={filters.to} onChange={(e) => set('from', e.target.value || undefined)} />
          </div>
          <div>
            <Label htmlFor="filter-to">Launched to</Label>
            <Input id="filter-to" type="date" value={filters.to ?? ''} min={filters.from} onChange={(e) => set('to', e.target.value || undefined)} />
          </div>
          <div className="sm:col-span-2">
            <Label htmlFor="filter-sort">Sort by</Label>
            <Select
              id="filter-sort"
              className="w-full"
              disabled={trending}
              value={trending ? 'score' : (filters.sort ?? ANY)}
              options={trending ? [{ value: 'score', label: 'Trending score' }] : [{ value: ANY, label: 'Tab default' }, ...TOKEN_SORTS.map((s) => ({ value: s.id, label: s.label }))]}
              onValueChange={(v) => set('sort', v === ANY ? undefined : (v as TokenSortKey))}
            />
          </div>
        </div>
      ) : null}
    </div>
  );
}
