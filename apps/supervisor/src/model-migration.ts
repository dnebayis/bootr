/**
 * Moving every agent to the models BlockRun serves, once, by the model catalog (`@bootr/agent-core` MODEL_CATALOG).
 *
 * For each agent, the three model fields of its stored config (`model`, `routing.decideModel`, `imageModel`) are read
 * against the catalog: a catalog id stays; a retired id becomes the catalog model that stands in for it (the same model
 * under BlockRun's name, or the closest model BlockRun serves); an id the catalog does not know stays when BlockRun's
 * live list serves it and is reported as `unknown` when it does not (the creator and the owner hear about it, nothing
 * is guessed). Nothing else on the config moves: memory, cadence, powers, the X account and the treasury are untouched;
 * `revision` goes up by one so the next tick starts a turn on the new model.
 *
 * Every change is one `config_updated` row on the agent's activity tape, by the platform, in plain words (activity.ts),
 * and one `model_changed` notification for the creator (notifications.ts). Running it again finds nothing to do: that
 * is the check that it is done. `dryRun` (the default) prints the plan and writes nothing.
 */
import { catalogModel, isAlias, isCatalogId, modelDisplayName } from '@bootr/agent-core';
import { eq, inArray } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { actions, agents } from './db/schema.js';
import { fetchBlockRunModels, modelFieldsOf, servedIds, type AgentOnMissingModel } from './model-check.js';
import { raiseNotification } from './notifications.js';

export const MIGRATION_BY = 'platform';
export const MIGRATION_REASON = 'model_migration';

export interface ModelChange {
  field: AgentOnMissingModel['field'];
  from: string;
  to: string;
  /** True when `to` is the same model under another name; false when it is a different model standing in. */
  same: boolean;
}

export interface AgentMigrationPlan {
  agentId: string;
  status: string;
  changes: ModelChange[];
  /** Ids neither the catalog nor BlockRun's live list knows (or that could not be checked); left as they are. */
  unknown: { field: AgentOnMissingModel['field']; model: string; checked: boolean }[];
  notes: string[];
}

export interface MigrationReport {
  dryRun: boolean;
  /** Whether BlockRun's live list was read: without it an id outside the catalog is `unknown` with `checked: false`. */
  checkedAgainstBlockRun: boolean;
  agents: AgentMigrationPlan[];
  summary: { agents: number; changed: number; unknown: number };
}

/** The plan for one stored config. Pure: the same config and list always give the same answer. */
export function planConfigMigration(config: Record<string, unknown>, served: ReadonlySet<string> | null): Pick<AgentMigrationPlan, 'changes' | 'unknown' | 'notes'> {
  const changes: ModelChange[] = [];
  const unknown: AgentMigrationPlan['unknown'] = [];
  const after: Record<string, string> = {};
  for (const { field, model } of modelFieldsOf(config)) {
    if (isCatalogId(model)) {
      after[field] = model;
      continue;
    }
    const known = catalogModel(model);
    if (known) {
      changes.push({ field, from: model, to: known.id, same: isAlias(model) });
      after[field] = known.id;
      continue;
    }
    if (served?.has(model)) {
      after[field] = model;
      continue;
    }
    unknown.push({ field, model, checked: served !== null });
    after[field] = model;
  }
  const notes: string[] = [];
  if (after.decideModel && after.model && after.decideModel === after.model && changes.some((c) => c.field === 'decideModel' || c.field === 'model')) {
    notes.push(`economy mode now does nothing: the deciding model and the writer are both ${modelDisplayName(after.model)}; the creator can pick another deciding model in the console`);
  }
  return { changes, unknown, notes };
}

/** The config after the plan: only the three model fields move. */
export function applyPlan(config: Record<string, unknown>, changes: readonly ModelChange[]): Record<string, unknown> {
  const next: Record<string, unknown> = { ...config };
  for (const c of changes) {
    if (c.field === 'model') next.model = c.to;
    else if (c.field === 'imageModel') next.imageModel = c.to;
    else next.routing = { ...((config.routing as Record<string, unknown> | null | undefined) ?? {}), decideModel: c.to };
  }
  return next;
}

/** The sentence the activity tape and the creator read for a set of changes. */
export function changeSummary(changes: readonly ModelChange[]): string {
  const part = (c: ModelChange) => {
    const what = c.field === 'imageModel' ? 'image model' : c.field === 'decideModel' ? 'deciding model' : 'model';
    return c.same ? `${what} now named ${modelDisplayName(c.to)} (the same model)` : `${what} changed to ${modelDisplayName(c.to)}`;
  };
  const text = changes.map(part).join('; ');
  return `${text.charAt(0).toUpperCase()}${text.slice(1)} by the platform; everything else unchanged.`;
}

export interface MigrationOptions {
  /** Default true: plan only, write nothing. */
  dryRun?: boolean;
  /** Only these agents; every onboarding or active agent otherwise. */
  agentIds?: string[];
}

/** Plans the move for every agent and, unless `dryRun`, writes it. Reads BlockRun's list once to tell `unknown` from merely unlisted. */
export async function migrateModels(ctx: SupervisorContext, opts: MigrationOptions = {}): Promise<MigrationReport> {
  const dryRun = opts.dryRun !== false;
  const live = await fetchBlockRunModels(ctx);
  const served = live ? servedIds(live) : null;
  const where = opts.agentIds?.length ? inArray(agents.agentId, opts.agentIds) : inArray(agents.status, ['onboarding', 'active']);
  const rows = await ctx.db.select().from(agents).where(where).orderBy(agents.agentId);
  const plans: AgentMigrationPlan[] = [];
  for (const row of rows) {
    const plan = { agentId: row.agentId, status: row.status, ...planConfigMigration(row.config, served) };
    plans.push(plan);
    if (plan.unknown.length) ctx.log.error({ agentId: row.agentId, unknown: plan.unknown }, dryRun ? 'model migration (dry run): models neither the catalog nor BlockRun knows' : 'model migration: models neither the catalog nor BlockRun knows; left as they are');
    if (!plan.changes.length || dryRun) continue;
    const before = row.config;
    const revision = (typeof before.revision === 'number' ? before.revision : 0) + 1;
    const config = { ...applyPlan(before, plan.changes), revision };
    const fields = plan.changes.map((c) => (c.field === 'decideModel' ? 'routing' : c.field));
    const now = new Date(ctx.now());
    await ctx.db.update(agents).set({ config, updatedAt: now }).where(eq(agents.agentId, row.agentId));
    await ctx.db
      .insert(actions)
      .values({
        actionId: `config-${row.agentId}-r${revision}`,
        agentId: row.agentId,
        cycleKey: `config:${revision}`,
        action: { kind: 'config_updated', fields, by: MIGRATION_BY, reason: MIGRATION_REASON, revision, changes: plan.changes, summary: changeSummary(plan.changes) },
        status: 'completed',
        result: null,
        receipt: null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();
    const main = plan.changes.find((c) => c.field === 'model') ?? plan.changes[0]!;
    await raiseNotification(ctx, row.agentId, 'model_changed', { model: main.to, from: main.from, same: main.same ? 1 : 0, fields: fields.join(','), summary: changeSummary(plan.changes) });
    ctx.log.info({ agentId: row.agentId, revision, changes: plan.changes, notes: plan.notes }, 'model migration: agent moved to the models BlockRun serves');
  }
  return {
    dryRun,
    checkedAgainstBlockRun: served !== null,
    agents: plans,
    summary: { agents: plans.length, changed: plans.filter((p) => p.changes.length).length, unknown: plans.filter((p) => p.unknown.length).length },
  };
}
