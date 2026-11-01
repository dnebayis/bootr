'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { NAV_ITEMS, isActive } from './nav-items';

export function NavLinksView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Primary" className="hidden items-center gap-1 md:flex">
      {NAV_ITEMS.map((item) => {
        const active = pathname ? isActive(pathname, item.href) : false;
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'relative rounded-sm px-3 py-2 text-base transition-colors duration-150',
              active ? 'text-ink' : 'text-mute hover:text-ink',
            )}
          >
            {item.label}
            {active ? <span className="absolute inset-x-3 -bottom-[17px] h-px bg-accent" aria-hidden="true" /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

export function NavLinks() {
  const pathname = usePathname();
  return <NavLinksView pathname={pathname} />;
}
