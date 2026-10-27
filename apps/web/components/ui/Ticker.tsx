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

export function Pct({ value, className }: { value: number | null | undefined; className?: string }) {
  if (value == null || !Number.isFinite(value)) return <span className={className}>—</span>;
  return (
    <NumberFlow
      value={value / 100}
      format={{ style: 'percent', maximumFractionDigits: 1, minimumFractionDigits: 1, signDisplay: 'always' }}
      locales="en-US"
      className={className}
    />
  );
}
