/**
 * Which records a turn is handed (docs/design/agent-behaviour.md stage 5): the one place that decides who is shown the
 * dataset, and the only caller of the serving seam (dataset/serve.ts) so far.
 *
 * Who: the platform account (@AgentBootr) alone. Coin agents and own agents are the next stage: for them this file
 * answers with nothing, whatever the dataset holds.
 *
 * When, all of:
 *   - the dataset is on (`DATASET_ENABLED` exactly `true`) and `PLATFORM_RECORDS` is above 0;
 *   - the turn holds a due original-post slot it may use, and carries neither the weekly digest nor the numbers post
 *     (the rule the platform update follows, platform-updates.ts): a record is something to write an original post
 *     from, so a turn that cannot write one is not charged for five of them;
 *   - the seam has something that fits.
 * Otherwise the answer is the empty list, and with it the turn's observation, its tools and its cost are exactly what
 * they were before this file existed (test/records-dark.test.ts replays a turn and compares).
 *
 * What: every cluster by its weight, every grade from `PLATFORM_RECORDS_MIN_GRADE` (each record says its grade in
 * words), its own coin's chain records, at most `PLATFORM_RECORDS`. Left out for it: the platform's totals of the
 * moment and of the day (the records of `a:indexer` about no coin). The `platformNumbers` section already carries
 * them, and the owner's rule is that they belong in the daily numbers post and in no other original post.
 *
 * A read that fails hands the turn nothing and is a warning: the dataset is never a reason for a turn to fail.
 */
import type { AgentConfig } from '@bootr/agent-core';
import type { AgentRow, SupervisorContext } from './context.js';
import { PLATFORM_TOTALS_SOURCE, recordsFor, type ServeRequest, type ServedRecord } from './dataset/serve.js';
import { noteServed } from './dataset/served.js';
import type { Grade } from './dataset/types.js';

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'log' | 'config'>;

/** How many records the platform account is handed at most; 0 = none. A caller that holds only a part of the config has none. */
export function platformRecordsLimit(ctx: { config?: { DATASET_ENABLED?: unknown; PLATFORM_RECORDS?: unknown } | null }): number {
  const n = ctx.config?.PLATFORM_RECORDS;
  return ctx.config?.DATASET_ENABLED === true && typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/** Whether this agent is handed records at all: the platform account, with the dataset on. */
export function recordsOn(ctx: { config?: { DATASET_ENABLED?: unknown; PLATFORM_RECORDS?: unknown } | null }, config: Pick<AgentConfig, 'platform' | 'capabilities'>): boolean {
  return config.platform === true && config.capabilities.xPublish === true && platformRecordsLimit(ctx) > 0;
}

/** The platform account's request to the seam. */
export function platformServeRequest(ctx: Pick<SupervisorContext, 'config'>, agent: Pick<AgentRow, 'agentId' | 'token'>): ServeRequest {
  const grade = Number(ctx.config.PLATFORM_RECORDS_MIN_GRADE ?? 1);
  return {
    agentId: agent.agentId,
    beat: { topics: 'all', coin: agent.token, withoutSources: [PLATFORM_TOTALS_SOURCE] },
    minGrade: (grade >= 1 && grade <= 5 ? Math.floor(grade) : 1) as Grade,
    limit: platformRecordsLimit(ctx),
  };
}

/** The records that fit this agent now, with no regard to whether a turn is running; empty for everyone but the platform account with the dataset on. Never throws. */
export async function recordsInBeat(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token'>, config: Pick<AgentConfig, 'platform' | 'capabilities'>): Promise<ServedRecord[]> {
  if (!recordsOn(ctx, config)) return [];
  try {
    return await recordsFor(ctx, platformServeRequest(ctx, agent));
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err: err instanceof Error ? err.message : String(err) }, 'records: the dataset could not be read; the turn goes on without records');
    return [];
  }
}

/** What a turn that is about to start tells this file about itself. */
export interface TurnSlot {
  /** The agent's schedule as the turn gets it. */
  schedule: { due: boolean; mayCompose: boolean } | null;
  /** The weekly digest or the daily numbers post rides this turn. */
  digest?: unknown;
  numbers?: unknown;
}

/** Whether a turn holds a due original-post slot of its own to write from. */
export function slotToWriteFrom(slot: TurnSlot): boolean {
  return !!slot.schedule?.due && slot.schedule.mayCompose && !slot.digest && !slot.numbers;
}

/**
 * The records of a turn that is about to start: `known` when the caller already asked the seam this tick (the quiet
 * slot did), else one request. Empty for a turn with no slot to write from.
 */
export async function turnRecords(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token'>, config: Pick<AgentConfig, 'platform' | 'capabilities'>, slot: TurnSlot, known?: readonly ServedRecord[] | null): Promise<ServedRecord[]> {
  if (!recordsOn(ctx, config) || !slotToWriteFrom(slot)) return [];
  return known ? [...known] : recordsInBeat(ctx, agent, config);
}

/** Notes that a turn's first observation carried `records` (dataset/served.ts): what makes a later citation of one valid. */
export async function noteTurnRecords(ctx: Ctx, agent: Pick<AgentRow, 'agentId'>, records: readonly ServedRecord[]): Promise<void> {
  if (records.length) await noteServed(ctx, agent.agentId, records.map((r) => r.id), { slotDue: true });
}
