import { env } from '@/lib/env';
import { sweepDrafts, type SweepResult } from '@/lib/server/launch-drafts';
import { findTokenByLaunchId } from '@/lib/server/token-lookup';

if (typeof window !== 'undefined') throw new Error('lib/server/draft-sweep must not be imported in the browser');

/** A sweep at most this often, started by a draft write and never awaited by the request that started it. */
export const SWEEP_EVERY_MS = 10 * 60_000;

const KEY = Symbol.for('bootr.web.draft-sweep');
const g = globalThis as unknown as Record<symbol, { lastAt: number } | undefined>;
const state = (g[KEY] ??= { lastAt: 0 });

/**
 * Whether the indexer has finished historical indexing (`/ready`). A sweep only trusts "no coin carries this id"
 * from a caught-up indexer: during a resync a coin launched a day ago may not be indexed yet, and its draft must stay.
 */
export async function indexerReady(fetchImpl: typeof fetch = globalThis.fetch): Promise<boolean> {
  if (env.useMock) return true;
  try {
    const res = await fetchImpl(`${env.indexerUrl}/ready`, { signal: AbortSignal.timeout(3000) });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** True when an indexed coin carries the draft id, false when none does, null when the indexer cannot say. */
export async function draftLaunched(draftId: string): Promise<boolean | null> {
  try {
    return (await findTokenByLaunchId(draftId)) !== null;
  } catch {
    return null;
  }
}

/**
 * Runs `sweepDrafts` when the last sweep is older than SWEEP_EVERY_MS, else nothing (null). Never throws: the draft
 * write that triggered it must not fail on housekeeping.
 */
export function maybeSweepDrafts(now = Date.now()): Promise<SweepResult> | null {
  if (state.lastAt > now - SWEEP_EVERY_MS) return null;
  state.lastAt = now;
  return (async () => {
    if (!(await indexerReady())) return { removed: [], checked: 0, stopped: true };
    return sweepDrafts(draftLaunched, { now: Math.floor(now / 1000) });
  })().catch(() => ({ removed: [], checked: 0, stopped: true }));
}
