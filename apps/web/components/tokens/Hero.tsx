'use client';

import type { CSSProperties } from 'react';
import { AsciiField } from '@/components/art/AsciiField';
import { LinkButton } from '@/components/ui/Button';
import { SearchIcon } from '@/components/ui/Icons';
import { Scramble } from '@/components/ui/Scramble';
import { openSearch } from '@/components/shell/search-events';

/**
 * The home hero: one line of display type, one centred input, one primary button. The input reads like the
 * search field and behaves like the ⌘K trigger (the first key you type opens the command palette with that
 * query, so searching never needs a second field); "Launch" is the page's one accent fill and goes to
 * `/launch`. Behind it the ASCII field drifts, masked to a ring so the copy sits on plain canvas.
 */

/* The mask clears an ellipse behind the copy and fades the field out before the hero's edges, so there is no hard rectangle on the dotted page. */
const MASK = 'radial-gradient(ellipse 64% 72% at 50% 48%, transparent 30%, #000 58%, #000 72%, transparent 100%)';
const FIELD_MASK: CSSProperties = { maskImage: MASK, WebkitMaskImage: MASK };

export function Hero() {
  return (
    <section aria-labelledby="hero-title" data-testid="hero" className="relative -mt-6 overflow-hidden py-14 md:-mt-8 md:py-20">
      <AsciiField style={FIELD_MASK} />
      <div className="relative mx-auto flex w-full max-w-[640px] flex-col items-center gap-5 text-center">
        <p className="font-doto text-sm font-semibold uppercase tracking-[0.1em] text-body">Launchpad · Built on Base</p>
        <h1 id="hero-title" className="text-balance text-display-lg font-semibold text-ink md:text-display-xl">
          <Scramble text="Every coin gets an agent." />
        </h1>
        <p className="max-w-[440px] text-balance text-sm text-body">Every coin here is run by its own agent on its own X account, paid for by the coin&rsquo;s trading fees.</p>
        <div className="mt-1 w-full max-w-[520px]">
          <label htmlFor="token-search" className="sr-only">
            Search tokens
          </label>
          <div className="relative">
            <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-mute" />
            <input
              id="token-search"
              data-testid="hero-search"
              readOnly
              placeholder="Search by name, $symbol, address or @handle"
              aria-keyshortcuts="Meta+K Control+K"
              onClick={() => openSearch()}
              onKeyDown={(e) => {
                if (e.key.length === 1 && !e.metaKey && !e.ctrlKey) {
                  e.preventDefault();
                  openSearch(e.key);
                } else if (e.key === 'Enter') openSearch();
              }}
              className="h-12 w-full cursor-pointer rounded-sm border border-edge bg-canvas pl-10 pr-[7.25rem] text-sm text-ink placeholder:text-mute transition-colors duration-150 ease-base hover:border-hairline-strong focus:border-accent focus:outline-none sm:pr-[9.5rem]"
            />
            <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
              <kbd className="pointer-events-none hidden rounded-xs border border-hairline px-1 font-mono text-micro text-mute sm:inline">⌘K</kbd>
              <LinkButton href="/launch" variant="primary" size="md" data-testid="hero-launch">
                Launch
              </LinkButton>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
