import type { ReactNode } from 'react';
import { cn } from './cn';
import { ArrowUpRightIcon } from './Icons';

export function ExternalLink({ href, children, className, icon = true }: { href: string; children: ReactNode; className?: string; icon?: boolean }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn('inline-flex items-center gap-0.5 text-link underline-offset-4 hover:underline', className)}
    >
      {children}
      {icon ? <ArrowUpRightIcon size={12} /> : null}
    </a>
  );
}
