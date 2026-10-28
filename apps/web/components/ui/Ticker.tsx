'use client';

import NumberFlow from '@number-flow/react';
import type { Format } from '@number-flow/react';

/** Ticking numbers. number-flow respects prefers-reduced-motion by default. */
export function Usd({ value, compact = true, className }: { value: number | null | undefined; compact?: boolean; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={className}>—</span>;
  const small = Math.abs(value) < 1 && value !== 0;
  const format: Format = small
    ? { style: 'currency', currency: 'USD', maximumSignificantDigits: 3 }
    : compact && Math.abs(value) >= 10_000
      ? { style: 'currency', currency: 'USD', notation: 'compact', maximumFractionDigits: 1 }
      : { style: 'currency', currency: 'USD', maximumFractionDigits: 2, minimumFractionDigits: Math.abs(value) < 1000 ? 2 : 0 };
  return <NumberFlow value={value} format={format} locales="en-US" className={className} willChange />;
}

export function Num({ value, compact = true, className, suffix }: { value: number | null | undefined; compact?: boolean; className?: string; suffix?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={className}>—</span>;
  const format: Format = compact && Math.abs(value) >= 10_000 ? { notation: 'compact', maximumFractionDigits: 1 } : { maximumFractionDigits: 2 };
  return <NumberFlow value={value} format={format} locales="en-US" className={className} suffix={suffix} />;
}

/** 24h change colour by sign (DESIGN.md: the only market number that is coloured). Zero and missing stay ink. */
export function changeClass(value: number | null | undefined): string | undefined {
  if (value == null || !Number.isFinite(value) || value === 0) return undefined;
  return value > 0 ? 'text-positive-text' : 'text-negative-text';
}

export function Pct({ value, className, tone = false }: { value: number | null | undefined; className?: string; tone?: boolean }) {
  if (value == null || !Number.isFinite(value)) return <span className={className}>—</span>;
  return (
    <NumberFlow
      value={value / 100}
      format={{ style: 'percent', maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: 'always' }}
      locales="en-US"
      className={[className, tone ? changeClass(value) : undefined].filter(Boolean).join(' ') || undefined}
    />
  );
}
