'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/components/ui/cn';
import { DOC_GROUPS, DOC_PAGES, docPath } from './pages';

/** Grouped list on desktop; one horizontally scrolling row on mobile (group labels hidden). */
export function DocsNavView({ pathname }: { pathname: string | null }) {
  return (
    <nav aria-label="Docs" className="-mx-1 flex gap-1 overflow-x-auto px-1 md:mx-0 md:flex-col md:gap-5 md:overflow-visible md:px-0">
      {DOC_GROUPS.map((group) => (
        <div key={group} className="flex shrink-0 gap-1 md:flex-col">
          <div className="hidden px-2.5 pb-1 text-caption text-mute md:block">{group}</div>
          {DOC_PAGES.filter((p) => p.group === group).map((p) => {
            const href = docPath(p.slug);
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
        </div>
      ))}
    </nav>
  );
}

export function DocsNav() {
  return <DocsNavView pathname={usePathname()} />;
}
