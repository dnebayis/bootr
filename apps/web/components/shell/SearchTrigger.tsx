'use client';

import { SearchIcon } from '@/components/ui/Icons';
import { openSearch } from './search-events';

export function SearchTrigger() {
  return (
    <button
      type="button"
      onClick={() => openSearch()}
      aria-label="Search tokens"
      aria-keyshortcuts="Meta+K Control+K"
      className="inline-flex h-8 items-center gap-2 rounded-sm border border-hairline px-2.5 text-sm text-mute transition-colors hover:border-hairline-strong hover:text-ink"
    >
      <SearchIcon />
      <span className="hidden lg:inline">Search</span>
      <kbd className="hidden rounded-xs border border-hairline px-1 font-mono text-micro text-mute lg:inline">⌘K</kbd>
    </button>
  );
}
