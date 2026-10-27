import type { ReactNode } from 'react';
import { cn } from './cn';

/** Stat tile: caption label, ticking display value, optional note. Sits in a hairline grid. */
export function StatTile({ label, value, note, className }: { label: ReactNode; value: ReactNode; note?: ReactNode; className?: string }) {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 bg-canvas px-5 py-4', className)}>
      <span className="text-caption text-mute">{label}</span>
      <span className="truncate font-mono text-display-sm font-medium text-ink tabular">{value}</span>
      {note ? <span className="truncate text-caption text-mute">{note}</span> : null}
    </div>
  );
}

/** 1px hairline grid: the gap shows the border colour through. */
export function StatRow({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('grid gap-px overflow-hidden rounded-md border border-hairline bg-hairline', className)}>{children}</div>;
}
