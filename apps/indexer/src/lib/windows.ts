/**
 * Rolling windows over hourly buckets. Each token keeps at most `MAX_BUCKETS` hours
 * (7 days + 1 hour so a "24h ago" close is always available inside the 7d window).
 */
export const HOUR = 3600;
export const DAY = 86_400;
export const MAX_BUCKETS = 7 * 24 + 1;

export type Bucket = {
  /** Hour index: floor(timestamp / 3600). */
  h: number;
  /** Volume (USD) in that hour. */
  v: number;
  /** LP fees to recipients (USD) in that hour. */
  f: number;
  /** Number of trades. */
  n: number;
  /** Last trade price (USD) in that hour. */
  p: number;
};

export const hourOf = (ts: number) => Math.floor(ts / HOUR);

/** Returns a new bucket array with the trade added; buckets stay sorted and pruned. */
export function addTrade(
  buckets: readonly Bucket[],
  ts: number,
  volumeUsd: number,
  feeUsd: number,
  priceUsd: number,
): Bucket[] {
  const h = hourOf(ts);
  const out = buckets.map((b) => ({ ...b }));
  const existing = out.find((b) => b.h === h);
  if (existing) {
    existing.v += volumeUsd;
    existing.f += feeUsd;
    existing.n += 1;
    existing.p = priceUsd;
  } else {
    out.push({ h, v: volumeUsd, f: feeUsd, n: 1, p: priceUsd });
    out.sort((a, b) => a.h - b.h);
  }
  return prune(out, ts);
}

export function prune(buckets: Bucket[], nowTs: number): Bucket[] {
  const minH = hourOf(nowTs) - MAX_BUCKETS + 1;
  return buckets.filter((b) => b.h >= minH);
}

/** Sum over trades in (now - windowSec, now], at hour granularity (the current hour counts fully). */
export function sumWindow(buckets: readonly Bucket[], nowTs: number, windowSec: number) {
  const hours = Math.ceil(windowSec / HOUR);
  const minH = hourOf(nowTs) - hours + 1;
  let volume = 0;
  let fees = 0;
  let trades = 0;
  for (const b of buckets) {
    if (b.h >= minH && b.h <= hourOf(nowTs)) {
      volume += b.v;
      fees += b.f;
      trades += b.n;
    }
  }
  return { volume, fees, trades };
}

/**
 * Percent change of `currentPrice` against the last traded price at or before now-24h.
 * `null` when there was no trade 24h ago (inside the retained 7d history).
 */
export function change24hPct(buckets: readonly Bucket[], nowTs: number, currentPrice: number): number | null {
  const refH = hourOf(nowTs - DAY);
  let ref: Bucket | undefined;
  for (const b of buckets) if (b.h <= refH && (!ref || b.h > ref.h)) ref = b;
  if (!ref || !(ref.p > 0) || !(currentPrice > 0)) return null;
  return Math.round(((currentPrice / ref.p - 1) * 100) * 1e4) / 1e4;
}
