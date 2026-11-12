/**
 * Own agents (docs/design/byo-agent.md "Limits added after review"): the daily budgets of turns and steps. Fuel was
 * the hosted agent's real rate limit: every thought cost money, so a coin could only take as many steps as it could
 * pay for. An own coin buys no thought, so without a count of its own the only bound on what its client makes the
 * server do was the web's request limit per credential. The counts live on the runtime's state, in one bucket per
 * hour, and are read and written under the runtime lease like everything else on it.
 *
 * A bucket counts from its hour until 24 hours after that hour ended, so no real 24-hour window ever holds more than
 * the budget; the price is that a call can be held up to an hour longer than an exact window would hold it.
 */
import type { AgentState } from '../runtime.js';

export const USAGE_BUCKET_MS = 3_600_000;
export const USAGE_WINDOW_MS = 24 * USAGE_BUCKET_MS;

/** One hour of use: the hour's start (epoch ms) and how many were counted in it. */
export type UsageBucket = [hourStart: number, count: number];
export type UsageKind = 'turns' | 'steps';
export type OwnUsage = { [K in UsageKind]?: UsageBucket[] };

const counts = (b: UsageBucket, now: number) => Number.isFinite(b[0]) && Number.isFinite(b[1]) && b[0] + USAGE_BUCKET_MS > now - USAGE_WINDOW_MS && b[0] <= now;

function live(state: Pick<AgentState, 'ownUsage'>, kind: UsageKind, now: number): UsageBucket[] {
  const stored = state.ownUsage?.[kind];
  return Array.isArray(stored) ? stored.filter((b): b is UsageBucket => Array.isArray(b) && b.length === 2 && counts(b, now)) : [];
}

/** How many of `kind` this coin used in the last 24 hours. */
export function usedInWindow(state: Pick<AgentState, 'ownUsage'>, kind: UsageKind, now: number): number {
  return live(state, kind, now).reduce((sum, b) => sum + b[1], 0);
}

/** Counts one more of `kind` now, and drops the buckets that left the window. */
export function countUse(state: Pick<AgentState, 'ownUsage'>, kind: UsageKind, now: number): void {
  const buckets = live(state, kind, now);
  const hour = Math.floor(now / USAGE_BUCKET_MS) * USAGE_BUCKET_MS;
  const current = buckets.find((b) => b[0] === hour);
  if (current) current[1] += 1;
  else buckets.push([hour, 1]);
  state.ownUsage = { ...(state.ownUsage ?? {}), [kind]: buckets.sort((a, b) => a[0] - b[0]) };
}

/** When the use of `kind` is next below `limit` with nothing more counted: the moment enough of the oldest hours have left the window. */
export function budgetOpensAt(state: Pick<AgentState, 'ownUsage'>, kind: UsageKind, limit: number, now: number): number {
  const buckets = live(state, kind, now).sort((a, b) => a[0] - b[0]);
  let used = buckets.reduce((sum, b) => sum + b[1], 0);
  for (const [hour, count] of buckets) {
    if (used < limit) break;
    used -= count;
    if (used < limit) return hour + USAGE_BUCKET_MS + USAGE_WINDOW_MS;
  }
  return now + USAGE_BUCKET_MS;
}
