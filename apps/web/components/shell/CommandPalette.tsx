'use client';

import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSearch } from '@/lib/indexer';
import { shortAddr, usd } from '@/lib/format';
import { OPEN_SEARCH_EVENT } from './search-events';
import { NAV_ITEMS } from './nav-items';
import { TokenImage } from '@/components/ui/TokenImage';

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const router = useRouter();
  const search = useSearch(debounced);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const onOpen = (e: Event) => {
      const q = (e as CustomEvent<{ query?: string }>).detail?.query ?? '';
      setQuery(q);
      setOpen(true);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener(OPEN_SEARCH_EVENT, onOpen);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener(OPEN_SEARCH_EVENT, onOpen);
    };
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), 150);
    return () => clearTimeout(t);
  }, [query]);

  const go = (href: string) => {
    setOpen(false);
    setQuery('');
    router.push(href);
  };

  const results = search.data ?? [];

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Search tokens"
      shouldFilter={false}
      overlayClassName="fixed inset-0 z-50 bg-black/40"
      contentClassName="fixed left-1/2 top-[12vh] z-50 w-[min(560px,calc(100vw-32px))] -translate-x-1/2 overflow-hidden rounded-lg border border-hairline bg-canvas shadow-[0_1px_1px_#00000005,0_8px_16px_-4px_#0000000a,0_24px_32px_-8px_#0000001f]"
    >
      <div className="flex items-center gap-2 border-b border-hairline px-4">
        <Command.Input
          value={query}
          onValueChange={setQuery}
          placeholder="Search by name, $symbol, address or @handle"
          className="h-12 w-full bg-transparent text-sm text-ink placeholder:text-mute focus:outline-none"
        />
        <kbd className="rounded-xs border border-hairline px-1 font-mono text-micro text-mute">esc</kbd>
      </div>
      <Command.List className="max-h-[min(420px,60vh)] overflow-y-auto p-2">
        {debounced && !search.isFetching && results.length === 0 ? (
          <Command.Empty className="px-3 py-8 text-center text-sm text-mute">No tokens match “{debounced}”.</Command.Empty>
        ) : null}
        {results.length > 0 ? (
          <Command.Group heading="Tokens" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-mute">
            {results.map((t) => (
              <Command.Item
                key={t.id}
                value={t.id}
                onSelect={() => go(`/token/${t.id}`)}
                className="flex cursor-pointer items-center gap-3 rounded-sm px-2 py-2 data-[selected=true]:bg-canvas-sub data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]"
              >
                <TokenImage src={t.image} symbol={t.symbol} size={24} className="rounded-xs" />
                <span className="min-w-0 flex-1 truncate text-sm text-ink">
                  {t.name} <span className="font-mono text-caption text-mute">${t.symbol}</span>
                </span>
                {t.xHandle ? <span className="hidden font-mono text-caption text-mute sm:inline">@{t.xHandle}</span> : null}
                <span className="font-mono text-caption text-mute tabular">{usd(t.marketCapUsd)}</span>
                <span className="hidden font-mono text-caption text-mute sm:inline">{shortAddr(t.id, 4, 4)}</span>
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
        {!debounced ? (
          <Command.Group heading="Go to" className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-caption [&_[cmdk-group-heading]]:text-mute">
            {NAV_ITEMS.map((n) => (
              <Command.Item
                key={n.href}
                value={n.href}
                onSelect={() => go(n.href)}
                className="flex cursor-pointer items-center rounded-sm px-2 py-2 text-sm text-ink data-[selected=true]:bg-canvas-sub data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]"
              >
                {n.label}
              </Command.Item>
            ))}
          </Command.Group>
        ) : null}
      </Command.List>
    </Command.Dialog>
  );
}
