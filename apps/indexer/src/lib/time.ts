export const DAY_SEC = 86_400;

/** UTC day id `YYYY-MM-DD` for a unix timestamp (seconds). */
export function dayId(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

/** Unix seconds of 00:00 UTC of the day containing `ts`. */
export function dayStart(ts: number): number {
  return Math.floor(ts / DAY_SEC) * DAY_SEC;
}
