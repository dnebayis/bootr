'use client';

import Link from 'next/link';
import { useRef, type ReactNode } from 'react';
import type { Token } from '@/lib/types';
import { age, usd } from '@/lib/format';
import { useReducedMotion } from '@/lib/hooks';
import { StatusDot, statusLabel } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';
import { TokenImage } from '@/components/ui/TokenImage';

export const CARD_HEIGHT = 164;

/**
 * A minimal 3D tilt for the token card: the wrapper rotates a few degrees toward the pointer (perspective
 * transform, CSS variables, no React state per move) and settles back on leave over `ease-base`. The same
 * variables carry a parallax offset for the dot-matrix layer on the image frame, which is what makes the
 * card read as holographic without any colour. Mouse only (touch cards stay flat), off under
 * `prefers-reduced-motion`.
 */
export function CardTilt({ children, className, intensity = 5 }: { children: ReactNode; className?: string; intensity?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();

  const set = (rx: number, ry: number, tx: number, ty: number) => {
    const el = ref.current;
    if (!el) return;
    el.style.setProperty('--rx', `${rx.toFixed(2)}deg`);
    el.style.setProperty('--ry', `${ry.toFixed(2)}deg`);
    el.style.setProperty('--tx', `${tx.toFixed(1)}px`);
    el.style.setProperty('--ty', `${ty.toFixed(1)}px`);
  };

  return (
    <div
      ref={ref}
      onPointerMove={(e) => {
        if (reduced || e.pointerType !== 'mouse') return;
        const b = e.currentTarget.getBoundingClientRect();
        const px = (e.clientX - b.left) / b.width - 0.5; // -0.5 .. 0.5
        const py = (e.clientY - b.top) / b.height - 0.5;
        set(-py * intensity, px * intensity, -px * 6, -py * 6);
      }}
      onPointerLeave={() => set(0, 0, 0, 0)}
      className={cn(
        'transition-transform duration-150 ease-base [transform:perspective(800px)_rotateX(var(--rx,0deg))_rotateY(var(--ry,0deg))]',
        className,
      )}
    >
      {children}
    </div>
  );
}

function Datum({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <div className="text-micro text-mute">{label}</div>
      <div className="truncate font-mono text-sm text-ink tabular">{value}</div>
    </div>
  );
}

/**
 * The 48px image frame with a dot-matrix layer over it: one `ink` dot per 3px, faint, shifting with the
 * tilt (`--tx` / `--ty`) so the picture reads as printed on the same grid as the page. The frame keeps the
 * hairline border of the design spec; the layer never covers the status dot or the text.
 */
function ImageFrame({ token }: { token: Token }) {
  return (
    <span className="relative inline-block size-12 shrink-0">
      <TokenImage src={token.image} symbol={token.symbol} size={48} className="rounded-xs" />
      <span
        aria-hidden="true"
        className="pointer-events-none absolute inset-px rounded-[3px] text-ink opacity-[0.14] transition-[background-position] duration-150 ease-base [background-image:radial-gradient(circle,currentColor_0.6px,transparent_0.9px)] [background-position:var(--tx,0px)_var(--ty,0px)] [background-size:3px_3px] dark:opacity-[0.18]"
      />
    </span>
  );
}

export function TokenCard({ token, now, flash }: { token: Token; now: number; flash?: boolean }) {
  const status = token.agent?.status;
  return (
    <CardTilt>
      <Link
        href={`/token/${token.id}`}
        className={cn(
          'group flex h-[164px] flex-col gap-3 rounded-md border border-edge bg-canvas p-4 transition-colors duration-150 ease-base hover:border-accent',
          flash && 'animate-flash',
        )}
      >
        <div className="flex items-start gap-3">
          <ImageFrame token={token} />
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
    </CardTilt>
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
