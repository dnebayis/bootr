import { describe, expect, it } from 'vitest';

import { DEFAULT_SNAPSHOT_INTERVAL, DENIM_FIRST_BLOCK, blockSecondsAt, secondsBetweenBlocks, snapshotSources, snapshotSpacingSec } from './blocks';
import { HOUR_SEC, historicalSnapshotDue } from './time';

const BASE = 8453;
const SEPOLIA = 84532;
const DENIM = DENIM_FIRST_BLOCK[BASE]!;
/** Timestamps as read from Base mainnet: 53556126 at 17:59:59, then five blocks a second from 18:00:01. */
const DENIM_TS = 1_793_901_601;
const tsOf = (n: number) => (n >= DENIM ? DENIM_TS + Math.floor((n - DENIM) / 5) : DENIM_TS - 2 - (DENIM - 1 - n) * 2);
const PROD_START = 53_219_209;

/** Every snapshot block of a source between `from` and `to`, the way Ponder picks them (`n % interval === start % interval`). */
function grid(s: { startBlock: number | 'latest'; endBlock?: number; interval: number }, from: number, to: number) {
  const out: number[] = [];
  const start = s.startBlock as number;
  const last = Math.min(s.endBlock ?? to, to);
  const first = Math.max(from + ((((start - from) % s.interval) + s.interval) % s.interval), start);
  for (let n = first; n <= last; n += s.interval) out.push(n);
  return out;
}

describe('the era of a block', () => {
  it('knows the boundary block', () => {
    expect(blockSecondsAt(BASE, DENIM - 1)).toBe(2);
    expect(blockSecondsAt(BASE, DENIM)).toBe(0.2);
    expect(blockSecondsAt(SEPOLIA, 1)).toBe(0.2);
  });

  it('agrees with the timestamps on chain, across the boundary', () => {
    expect(tsOf(53_556_126)).toBe(1_793_901_599);
    expect(secondsBetweenBlocks(BASE, DENIM - 300, DENIM - 1)).toBe(598);
    expect(secondsBetweenBlocks(BASE, DENIM, DENIM + 300)).toBeCloseTo(60, 9);
    expect(secondsBetweenBlocks(BASE, DENIM - 150, DENIM + 150)).toBeCloseTo(330, 9);
    expect(secondsBetweenBlocks(BASE, 10, 5)).toBe(-10);
    expect(secondsBetweenBlocks(SEPOLIA, 0, 300)).toBeCloseTo(60, 9);
  });
});

describe('snapshotSources', () => {
  it('keeps 60 s on both sides of the fork', () => {
    const { main, preDenim } = snapshotSources(BASE, PROD_START, DEFAULT_SNAPSHOT_INTERVAL);
    expect(preDenim).toEqual({ startBlock: PROD_START, endBlock: DENIM - 1, interval: 30 });
    expect(main).toEqual({ startBlock: DENIM, interval: 300 });
    expect(snapshotSpacingSec(BASE, DENIM - 1, DEFAULT_SNAPSHOT_INTERVAL)).toBe(60);
    expect(snapshotSpacingSec(BASE, DENIM, DEFAULT_SNAPSHOT_INTERVAL)).toBe(60);
    const before = grid(preDenim!, DENIM - 300, DENIM);
    const after = grid(main, DENIM, DENIM + 900);
    expect(tsOf(before[1]!) - tsOf(before[0]!)).toBe(60);
    expect(tsOf(after[1]!) - tsOf(after[0]!)).toBe(60);
  });

  it('has one source when the range starts at or after the fork, on Sepolia and for an unknown start', () => {
    expect(snapshotSources(BASE, DENIM, 300)).toEqual({ main: { startBlock: DENIM, interval: 300 }, preDenim: null });
    expect(snapshotSources(BASE, DENIM + 7, 300)).toEqual({ main: { startBlock: DENIM + 7, interval: 300 }, preDenim: null });
    expect(snapshotSources(BASE, 'latest', 300)).toEqual({ main: { startBlock: 'latest', interval: 300 }, preDenim: null });
    expect(snapshotSources(SEPOLIA, 49_367_726, 300)).toEqual({ main: { startBlock: 49_367_726, interval: 300 }, preDenim: null });
  });

  it('never starts a source after its end', () => {
    const { main, preDenim } = snapshotSources(BASE, DENIM - 1, 300);
    expect(preDenim).toEqual({ startBlock: DENIM - 1, endBlock: DENIM - 1, interval: 30 });
    expect(main.startBlock).toBe(DENIM);
  });

  it("keeps an override in time, counted in today's blocks", () => {
    expect(snapshotSources(BASE, PROD_START, 600).preDenim!.interval).toBe(60);
    expect(snapshotSpacingSec(BASE, DENIM - 1, 600)).toBe(120);
    expect(snapshotSpacingSec(BASE, DENIM, 600)).toBe(120);
    expect(snapshotSources(BASE, PROD_START, 1).preDenim!.interval).toBe(1);
  });
});

describe('the hourly snapshot of history, across the boundary block', () => {
  const { main, preDenim } = snapshotSources(BASE, PROD_START, DEFAULT_SNAPSHOT_INTERVAL);
  const FORK_HOUR = Math.floor(DENIM_TS / HOUR_SEC);

  /** How many snapshot blocks do the full recompute, per UTC hour. */
  function dueByHour(blocks: number[]) {
    const hours = new Map<number, number>();
    for (const n of blocks) {
      const ts = tsOf(n);
      const hour = Math.floor(ts / HOUR_SEC);
      const due = historicalSnapshotDue(ts, snapshotSpacingSec(BASE, n, DEFAULT_SNAPSHOT_INTERVAL)) ? 1 : 0;
      hours.set(hour, (hours.get(hour) ?? 0) + due);
    }
    return hours;
  }

  it('runs exactly once in every hour on both sides, the fork hour included', () => {
    const before = grid(preDenim!, DENIM - 6 * 1800, DENIM);
    const after = grid(main, DENIM, DENIM + 6 * 18_000);
    const hours = dueByHour([...before, ...after]);
    expect(hours.has(FORK_HOUR - 1)).toBe(true);
    expect(hours.has(FORK_HOUR)).toBe(true);
    // The first and last hours of the sample may be cut short; every whole hour has its one snapshot.
    const whole = [...hours].filter(([h]) => h > FORK_HOUR - 6 && h < FORK_HOUR + 5);
    expect(whole).toHaveLength(10);
    for (const [, due] of whole) expect(due).toBe(1);
  });

  it('runs at the first block after the fork', () => {
    expect(historicalSnapshotDue(tsOf(DENIM), snapshotSpacingSec(BASE, DENIM, DEFAULT_SNAPSHOT_INTERVAL))).toBe(true);
  });

  it('would go wrong with one block time for both eras', () => {
    // 60 s spacing read as 6 s: most hours before the fork would have no snapshot.
    const before = grid(preDenim!, DENIM - 24 * 1800, DENIM);
    const hit = new Set(before.filter((n) => historicalSnapshotDue(tsOf(n), 6)).map((n) => Math.floor(tsOf(n) / HOUR_SEC)));
    expect(hit.size).toBeLessThan(10);
    // 300 blocks read at 2 s: ten runs an hour since the fork instead of one.
    const after = grid(main, DENIM, DENIM + 18_000 - 1);
    expect(after.filter((n) => historicalSnapshotDue(tsOf(n), 600)).length).toBe(10);
  });

  it('is one an hour on Sepolia too, where the old 2 s assumption ran ten', () => {
    const spacing = snapshotSpacingSec(SEPOLIA, 1, DEFAULT_SNAPSHOT_INTERVAL);
    expect(spacing).toBe(60);
    let due = 0;
    for (let ts = 1_793_620_800 + 7; ts < 1_793_620_800 + HOUR_SEC + 7; ts += spacing) if (historicalSnapshotDue(ts, spacing)) due += 1;
    expect(due).toBe(1);
  });
});
