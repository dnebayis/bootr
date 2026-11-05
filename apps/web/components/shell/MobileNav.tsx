'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';
import { Drawer } from 'vaul';
import { MenuIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';
import { Wordmark } from '@/components/brand/Wordmark';
import { NAV_ITEMS, isActive } from './nav-items';
import { ConnectButton } from './ConnectButton';
import { ThemeToggle } from './ThemeToggle';

export function MobileNavView({ pathname }: { pathname: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <Drawer.Root open={open} onOpenChange={setOpen} direction="bottom">
      <Drawer.Trigger
        aria-label="Open menu"
        className="inline-flex size-8 items-center justify-center rounded-sm text-ink hover:bg-canvas-sub lg:hidden"
      >
        <MenuIcon />
      </Drawer.Trigger>
      <Drawer.Portal>
        <Drawer.Overlay className="fixed inset-0 z-50 bg-black/40" />
        <Drawer.Content className="fixed inset-x-0 bottom-0 z-50 flex flex-col rounded-t-lg border-t border-hairline bg-canvas pb-[max(16px,env(safe-area-inset-bottom))] outline-none">
          <div className="mx-auto mt-2 h-1 w-10 rounded-full bg-hairline-strong" aria-hidden="true" />
          <div className="flex items-center justify-between px-4 py-3">
            <Drawer.Title asChild>
              <span>
                <Wordmark size="sm" />
              </span>
            </Drawer.Title>
            <ThemeToggle />
          </div>
          <Drawer.Description className="sr-only">Site navigation</Drawer.Description>
          <nav aria-label="Mobile" className="flex flex-col border-y border-hairline">
            {NAV_ITEMS.map((n) => {
              const active = pathname ? isActive(pathname, n.href) : false;
              return (
                <Link
                  key={n.href}
                  href={n.href}
                  onClick={() => setOpen(false)}
                  aria-current={active ? 'page' : undefined}
                  className={cn('border-b border-hairline px-4 py-3 text-base last:border-b-0', active ? 'text-ink' : 'text-mute')}
                >
                  {n.label}
                </Link>
              );
            })}
          </nav>
          <div className="px-4 pt-4">
            <ConnectButton block />
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

export function MobileNav() {
  const pathname = usePathname();
  return <MobileNavView pathname={pathname} />;
}
