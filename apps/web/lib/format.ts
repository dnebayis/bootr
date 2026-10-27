import { formatUnits } from 'viem';

const compact = new Intl.NumberFormat('en-US', {
  notation: 'compact',
  maximumFractionDigits: 1,
});

/** $1.2M, $840K, $12.40, $0.00042 */
export function usd(value: number | null | undefined, opts?: { compact?: boolean }): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const sign = value < 0 ? '-' : '';
  const v = Math.abs(value);
  if (opts?.compact !== false && v >= 1_000) return `${sign}$${compact.format(v)}`;
  if (v >= 1) return `${sign}$${v.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
  if (v === 0) return '$0';
  return `${sign}$${price(v)}`;
}

/** Small prices with significant digits: 0.00042, 0.0000031 */
export function price(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (value === 0) return '0';
  if (value >= 1) return value.toLocaleString('en-US', { maximumFractionDigits: 4 });
  return value.toLocaleString('en-US', { maximumSignificantDigits: 2, maximumFractionDigits: 12 });
}

export function num(value: number | null | undefined, opts?: { compact?: boolean }): string {
  if (value == null || !Number.isFinite(value)) return '—';
  if (opts?.compact !== false && Math.abs(value) >= 10_000) return compact.format(value);
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** Signed, colour-neutral percent: +4.2% / −3.1% */
export function pct(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return '—';
  const s = Math.abs(value).toFixed(digits);
  if (value > 0) return `+${s}%`;
  if (value < 0) return `−${s}%`;
  return `${s}%`;
}

/** bps of 10000 -> "20%" */
export function bps(value: number): string {
  const p = value / 100;
  return `${Number.isInteger(p) ? p : p.toFixed(1)}%`;
}

export function units(raw: string | bigint | null | undefined, decimals: number, maxFrac = 4): string {
  if (raw == null || raw === '') return '—';
  try {
    const n = Number(formatUnits(BigInt(raw), decimals));
    if (n >= 10_000) return compact.format(n);
    return n.toLocaleString('en-US', { maximumFractionDigits: maxFrac });
  } catch {
    return '—';
  }
}

/** 2h ago, 3d ago, just now */
export function ago(unixSeconds: number | null | undefined, now = Date.now()): string {
  if (!unixSeconds) return '—';
  const s = Math.max(0, Math.floor(now / 1000 - unixSeconds));
  if (s < 45) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${Math.max(1, m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** Age without the "ago": 2h, 3d */
export function age(unixSeconds: number | null | undefined, now = Date.now()): string {
  const a = ago(unixSeconds, now);
  return a === 'just now' ? 'new' : a.replace(' ago', '');
}

export function shortAddr(a: string | null | undefined, head = 6, tail = 4): string {
  if (!a) return '—';
  if (a.length <= head + tail + 1) return a;
  return `${a.slice(0, head)}…${a.slice(-tail)}`;
}

export function shortHash(h: string | null | undefined): string {
  return shortAddr(h, 8, 6);
}

export function dateLabel(isoDay: string): string {
  const d = new Date(`${isoDay}T00:00:00Z`);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
