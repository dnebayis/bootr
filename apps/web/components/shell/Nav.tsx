import Link from 'next/link';
import { Suspense } from 'react';
import { Wordmark } from '@/components/brand/Wordmark';
import { NavLinks, NavLinksView } from './NavLinks';
import { MobileNav, MobileNavView } from './MobileNav';
import { SearchTrigger } from './SearchTrigger';
import { ThemeToggle } from './ThemeToggle';
import { ConnectButton } from './ConnectButton';
import { CommandPalette } from './CommandPalette';

export function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-hairline bg-canvas">
      <div className="mx-auto flex h-14 max-w-[1280px] items-center gap-6 px-4 md:px-6">
        <Link href="/" aria-label="Bootr home" className="shrink-0">
          <Wordmark />
        </Link>
        {/* usePathname suspends on routes with unknown params; the fallback renders the same links without an active state. */}
        <Suspense fallback={<NavLinksView pathname={null} />}>
          <NavLinks />
        </Suspense>
        <div className="ml-auto flex items-center gap-1.5">
          <SearchTrigger />
          <div className="hidden md:block">
            <ThemeToggle />
          </div>
          <div className="hidden md:block">
            <ConnectButton />
          </div>
          <Suspense fallback={<MobileNavView pathname={null} />}>
            <MobileNav />
          </Suspense>
        </div>
      </div>
      <CommandPalette />
    </header>
  );
}
