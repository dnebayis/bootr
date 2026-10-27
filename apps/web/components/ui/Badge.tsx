import type { ReactNode } from 'react';
import { cn } from './cn';
import type { AgentStatus } from '@/lib/types';

export function Badge({ children, tone = 'default', className }: { children: ReactNode; tone?: 'default' | 'ink' | 'mono'; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex h-5 items-center gap-1 rounded-xs border px-1.5 text-micro font-medium',
        tone === 'ink' ? 'border-ink bg-ink text-on-ink' : 'border-hairline bg-canvas-soft text-body',
        tone === 'mono' && 'font-mono uppercase tracking-wide',
        className,
      )}
    >
      {children}
    </span>
  );
}

const STATUS_LABEL: Record<AgentStatus, string> = {
  awake: 'Awake',
  sleeping: 'Sleeping',
  paused: 'Paused',
  dormant: 'Dormant',
  claimed: 'Claimed',
};

export function StatusDot({ status, withLabel = false, className }: { status: AgentStatus | undefined; withLabel?: boolean; className?: string }) {
  const s = status ?? 'sleeping';
  const dot =
    s === 'awake'
      ? 'bg-ink'
      : s === 'sleeping'
        ? 'bg-mute'
        : 'border border-hairline-strong bg-transparent';
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <span className={cn('inline-block size-2 shrink-0 rounded-full', dot)} aria-hidden="true" />
      {withLabel ? <span className="text-caption text-body">{STATUS_LABEL[s]}</span> : <span className="sr-only">Agent {STATUS_LABEL[s]}</span>}
    </span>
  );
}

export function statusLabel(s: AgentStatus) {
  return STATUS_LABEL[s];
}
