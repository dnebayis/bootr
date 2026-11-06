export const DAY_SEC = 86_400;

/** UTC day id `YYYY-MM-DD` for a unix timestamp (seconds). */
export function dayId(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Unix seconds of 00:00 UTC of the day containing `ts`. */
export function dayStart(ts: number): number {
  return Math.floor(ts / DAY_SEC) * DAY_SEC;
}

export const HOUR_SEC = 3_600;

/**
 * Whether a snapshot block far behind the chain tip does the full recompute: the first snapshot of each UTC hour.
 * Stateless, so a replay always picks the same blocks. `spacingSec` is the time between snapshots at that block
 * (`snapshotSpacingSec`, which knows Base's block time before and after Denim): snapshots that far apart land exactly once
 * in that window of an hour, and a spacing of an hour or more is always due.
 */
export function historicalSnapshotDue(blockTimestamp: number, spacingSec: number): boolean {
  return blockTimestamp % HOUR_SEC < spacingSec;
}
