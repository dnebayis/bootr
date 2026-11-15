/**
 * One pass of the dataset: layer a when its interval has passed, the open sources that are due, layer c (the X
 * accounts, off until `DATASET_X_POSTS_PER_DAY` is set: then only the letting go of words is done), and once an hour
 * the ageing out of what is past its keeping time. The pass is what main.ts runs on a timer, in its own process: the
 * supervisor's tick serves agents one at a time and a slow feed must never hold a turn (the note's decision 6).
 */
import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsSources } from '../db/schema.js';
import type { IndexerClient } from '../indexer-client.js';
import type { Logger } from '../log.js';
import { runChain, type ChainReport } from './layer-a.js';
import { runOpenSources, type OpenSourcesReport } from './layer-b.js';
import { runXAccounts, type XLayerDeps, type XLayerReport } from './layer-c.js';
import { ageOut, syncSources } from './store.js';
import { syncXSources } from './x-pin.js';

export const AGE_OUT_EVERY_MS = 3_600_000;
/** How often the week counts of the supervisor's own tables are read (layer-a.ts `supervisorWeek`). */
export const WEEK_READ_EVERY_MS = 3_600_000;

export interface DatasetDeps {
  db: Db;
  indexer: Pick<IndexerClient, 'platformFeed' | 'graphql'>;
  log: Pick<Logger, 'info' | 'warn' | 'error'>;
  fetch?: typeof fetch;
  resolve?: (host: string) => Promise<{ address: string }[]>;
  chainEveryMs: number;
  sourcesPerPass: number;
  recordsPerDay: number;
  sourceRecordsPerDay?: number;
  sourceSightingsPerDay?: number;
  /** Layer c: the door to the sender (null when this process was not given one) and the day's cap (0 = off). */
  x?: Pick<XLayerDeps, 'x' | 'cap'>;
}

export interface PassReport {
  chain: ChainReport | null;
  open: OpenSourcesReport;
  x: XLayerReport;
  aged: { sightings: number; records: number } | null;
}

/** What a process keeps between passes: whether the source list was synced, when the tables were last aged and the week counts last read. */
export interface PassState {
  synced: boolean;
  agedAt: number;
  weekAt: number;
}

export const newPassState = (): PassState => ({ synced: false, agedAt: 0, weekAt: 0 });

export async function datasetPass(deps: DatasetDeps, state: PassState, now: Date): Promise<PassReport> {
  if (!state.synced) {
    const synced = await syncSources(deps.db, now);
    if (synced.added || synced.retired) deps.log.info(synced, 'dataset: source list synced');
    // The X accounts are listed (as `pending`) whether the layer is on or not: the owner sees the list before a cent is spent.
    const xSynced = await syncXSources(deps.db, now);
    if (xSynced.added || xSynced.retired) deps.log.info(xSynced, 'dataset: X account list synced');
    state.synced = true;
  }
  let chain: ChainReport | null = null;
  const [indexerRow] = await deps.db.select({ nextFetchAt: dsSources.nextFetchAt }).from(dsSources).where(eq(dsSources.id, 'a:indexer')).limit(1);
  if (!indexerRow?.nextFetchAt || indexerRow.nextFetchAt.getTime() <= now.getTime()) {
    const week = now.getTime() - state.weekAt >= WEEK_READ_EVERY_MS;
    chain = await runChain({ ...deps, skipWeek: !week }, now);
    if (week) state.weekAt = now.getTime();
    await deps.db
      .update(dsSources)
      .set({ lastFetchAt: now, ...(chain.indexer ? { lastOkAt: now, failures: 0, lastError: null } : { lastError: 'the indexer did not answer' }), nextFetchAt: new Date(now.getTime() + deps.chainEveryMs), updatedAt: now })
      .where(eq(dsSources.id, 'a:indexer'));
  }
  const open = await runOpenSources(deps, now);
  const x = await runXAccounts({ db: deps.db, log: deps.log, x: deps.x?.x ?? null, cap: deps.x?.cap ?? 0, recordsPerDay: deps.recordsPerDay }, now);
  let aged: PassReport['aged'] = null;
  if (now.getTime() - state.agedAt >= AGE_OUT_EVERY_MS) {
    aged = await ageOut(deps.db, now);
    state.agedAt = now.getTime();
  }
  return { chain, open, x, aged };
}
