import type { ReactNode } from 'react';
import { cn } from './cn';

export function Panel({
  title,
  action,
  children,
  className,
  bodyClassName,
  id,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
  id?: string;
}) {
  return (
    <section id={id} className={cn('rounded-md border border-hairline bg-canvas', className)}>
      {title ? (
        <header className="flex items-center justify-between gap-3 border-b border-hairline px-5 py-3">
          <h2 className="text-sm font-semibold tracking-tight text-ink">{title}</h2>
          {action}
        </header>
      ) : null}
      <div className={cn('p-5', bodyClassName)}>{children}</div>
    </section>
  );
}

export function KV({ label, children, mono = true }: { label: ReactNode; children: ReactNode; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-caption text-mute">{label}</dt>
      <dd className={cn('text-right text-sm text-ink', mono && 'font-mono tabular')}>{children}</dd>
    </div>
  );
}

export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 px-6 py-12 text-center">
      <p className="text-sm text-mute">{children}</p>
      {action}
    </div>
  );
}
