import Link from 'next/link';
import type { Token } from '@/lib/types';
import { age, usd } from '@/lib/format';
import { StatusDot, statusLabel } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';
import { TokenImage } from '@/components/ui/TokenImage';

export const CARD_HEIGHT = 164;

function Datum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-micro text-mute">{label}</div>
      <div className="truncate font-mono text-sm text-ink tabular">{value}</div>
    </div>
  );
}

export function TokenCard({ token, now, flash }: { token: Token; now: number; flash?: boolean }) {
  const status = token.agent?.status;
  return (
    <Link
      href={`/token/${token.id}`}
      className={cn(
        'group flex h-[164px] flex-col gap-3 rounded-md border border-edge bg-canvas p-4 transition-colors duration-150 ease-base hover:border-accent',
        flash && 'animate-flash',
      )}
    >
      <div className="flex items-start gap-3">
        <TokenImage src={token.image} symbol={token.symbol} size={48} className="rounded-xs" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-medium text-ink">{token.name}</span>
            {token.graduated ? <span className="shrink-0 rounded-xs bg-warning-surface px-1 text-micro font-medium text-warning">Grad</span> : null}
          </div>
          <div className="mt-0.5 flex items-center gap-2 font-mono text-caption text-mute">
            <span>${token.symbol}</span>
            <span aria-hidden="true">·</span>
            <span title={new Date(token.launchedAt * 1000).toISOString()}>{age(token.launchedAt, now)}</span>
          </div>
        </div>
        <span title={status ? `Agent ${statusLabel(status)}` : 'Agent'} className="pt-1">
          <StatusDot status={status} />
        </span>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <Datum label="Market cap" value={usd(token.marketCapUsd)} />
        <Datum label="Vol 24h" value={usd(token.volume24hUsd)} />
        <Datum label="Fees 24h" value={usd(token.fees24hUsd)} />
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-hairline pt-2.5 font-mono text-caption text-mute">
        <span className="truncate">{token.xHandle ? `@${token.xHandle}` : 'No X account'}</span>
        <span className="shrink-0">{status ? statusLabel(status) : ''}</span>
      </div>
    </Link>
  );
}

export function TokenCardSkeleton() {
  return (
    <div className="flex h-[164px] flex-col gap-3 rounded-md border border-edge bg-canvas p-4" aria-hidden="true">
      <div className="flex gap-3">
        <div className="size-12 animate-shimmer rounded-xs bg-canvas-sub" />
        <div className="flex flex-1 flex-col gap-2 pt-1">
          <div className="h-3.5 w-2/3 animate-shimmer rounded-xs bg-canvas-sub" />
          <div className="h-3 w-1/3 animate-shimmer rounded-xs bg-canvas-sub" />
        </div>
      </div>
      <div className="grid grid-cols-3 gap-3">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-8 animate-shimmer rounded-xs bg-canvas-sub" />
        ))}
      </div>
      <div className="mt-auto h-3 w-1/2 animate-shimmer rounded-xs bg-canvas-sub" />
    </div>
  );
}
