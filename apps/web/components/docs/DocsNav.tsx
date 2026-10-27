'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { DOC_PAGES } from './pages';

export function DocsNavView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Docs" className="flex gap-1 overflow-x-auto md:flex-col">
      {DOC_PAGES.map((p) => {
        const href = p.slug ? `/docs/${p.slug}` : '/docs';
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'whitespace-nowrap rounded-sm px-2.5 py-1.5 text-sm transition-colors duration-150',
              active ? 'bg-canvas-sub text-ink' : 'text-mute hover:text-ink',
            )}
          >
            {p.title}
          </Link>
        );
      })}
    </nav>
  );
}

export function DocsNav() {
  return <DocsNavView pathname={usePathname()} />;
}
