/**
 * The model catalog (`@bootr/agent-core` MODEL_CATALOG) held against BlockRun's live list: at start and every few hours
 * when direct mode is on, and on demand from the admin API. A gap is logged in one line the owner can read (a model
 * gone, marked unavailable, or priced differently from the table), and an agent whose stored model BlockRun no longer
 * lists gets a `model_unavailable` notification for its creator and an error line for the owner, instead of a quiet
 * wait: with no relay behind BlockRun such an agent could otherwise fail unpaid forever (blockrun.ts `model_missing`).
 * Reads only; the only writes are the notification rows.
 */
import { catalogGaps, catalogModel, isImageModel, type CatalogGap, type LiveModel } from '@bootr/agent-core';
import { inArray } from 'drizzle-orm';
import type { SupervisorContext } from './context.js';
import { agents } from './db/schema.js';
import { raiseNotification, resolveNotification } from './notifications.js';

/** How often the running supervisor repeats the check. */
export const CATALOG_CHECK_MS = 6 * 3_600_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface AgentOnMissingModel {
  agentId: string;
  field: 'model' | 'decideModel' | 'imageModel';
  model: string;
}

export interface CatalogCheck {
  at: string;
  /** False when BlockRun's list could not be read; `gaps` and `agents` are then empty and say nothing. */
  read: boolean;
  /** How many models BlockRun listed. */
  live: number | null;
  gaps: CatalogGap[];
  /** Agents whose stored model BlockRun does not list, under its own or a catalog name. */
  agentsOnMissingModels: AgentOnMissingModel[];
  error?: string;
}

let last: CatalogCheck | null = null;

/** The latest check this process made, for `/health`. */
export function lastCatalogCheck(): CatalogCheck | null {
  return last;
}

/** BlockRun's `GET /v1/models`, or null when it cannot be read. */
export async function fetchBlockRunModels(ctx: Pick<SupervisorContext, 'config' | 'fetch'>): Promise<LiveModel[] | null> {
  try {
    const res = await ctx.fetch(`${ctx.config.BLOCKRUN_BASE_URL.replace(/\/+$/, '')}/models`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: unknown } | null;
    if (!Array.isArray(body?.data)) return null;
    const out: LiveModel[] = [];
    for (const m of body.data as { id?: unknown; available?: unknown; pricing?: unknown }[]) {
      if (typeof m?.id !== 'string') continue;
      const p = (m.pricing ?? null) as { input?: unknown; output?: unknown; per_image?: unknown } | null;
      out.push({
        id: m.id,
        available: typeof m.available === 'boolean' ? m.available : null,
        pricing: p ? { ...(typeof p.input === 'number' ? { input: p.input } : {}), ...(typeof p.output === 'number' ? { output: p.output } : {}), ...(typeof p.per_image === 'number' ? { per_image: p.per_image } : {}) } : null,
      });
    }
    return out;
  } catch {
    return null;
  }
}

/** The ids BlockRun serves right now (listed and not marked unavailable). */
export function servedIds(live: readonly LiveModel[]): Set<string> {
  return new Set(live.filter((m) => m.available !== false).map((m) => m.id));
}

/** The model fields of a stored config as BlockRun would be asked for them. */
export function modelFieldsOf(config: Record<string, unknown>): { field: AgentOnMissingModel['field']; model: string }[] {
  const out: { field: AgentOnMissingModel['field']; model: string }[] = [];
  if (typeof config.model === 'string' && config.model) out.push({ field: 'model', model: config.model });
  const decide = (config.routing as { decideModel?: unknown } | null | undefined)?.decideModel;
  if (typeof decide === 'string' && decide) out.push({ field: 'decideModel', model: decide });
  if (typeof config.imageModel === 'string' && config.imageModel) out.push({ field: 'imageModel', model: config.imageModel });
  return out;
}

/** Whether BlockRun serves this stored id: under the catalog's name for it, or under the id itself. */
export function servedByBlockRun(model: string, served: ReadonlySet<string>): boolean {
  const known = catalogModel(model);
  return served.has(known?.id ?? model) || served.has(model);
}

/**
 * One check: BlockRun's list against the catalog, then every onboarding or active agent's stored models against the
 * list. Raises `model_unavailable` for an agent on a model BlockRun lacks and clears it for the others; never throws.
 */
export async function checkModelCatalog(ctx: SupervisorContext): Promise<CatalogCheck> {
  const at = new Date(ctx.now()).toISOString();
  const live = await fetchBlockRunModels(ctx);
  if (!live) {
    ctx.log.warn('model check: BlockRun’s model list could not be read; the catalog stands unverified until the next check');
    last = { at, read: false, live: null, gaps: [], agentsOnMissingModels: [], error: 'blockrun_models_unreadable' };
    return last;
  }
  const gaps = catalogGaps(live);
  for (const gap of gaps) ctx.log.warn({ model: gap.id, kind: gap.kind, detail: gap.detail }, 'model check: the catalog differs from BlockRun');
  const served = servedIds(live);
  const missing: AgentOnMissingModel[] = [];
  try {
    const rows = await ctx.db.select({ agentId: agents.agentId, config: agents.config }).from(agents).where(inArray(agents.status, ['onboarding', 'active']));
    for (const row of rows) {
      const bad = modelFieldsOf(row.config).filter((f) => !servedByBlockRun(f.model, served));
      // A picture model that is gone stops pictures, not the agent; the owner still reads it in the log, the creator in the inbox.
      if (bad.length) {
        for (const f of bad) missing.push({ agentId: row.agentId, field: f.field, model: f.model });
        const first = bad[0]!;
        ctx.log.error({ agentId: row.agentId, models: bad }, 'model check: this agent’s model is not served by BlockRun; it cannot think until the creator or the platform changes it');
        await raiseNotification(ctx, row.agentId, 'model_unavailable', { model: first.model, field: first.field, picture: bad.every((f) => isImageModel(f.model) || f.field === 'imageModel') ? 1 : 0 });
      } else {
        await resolveNotification(ctx, row.agentId, 'model_unavailable');
      }
    }
  } catch (err) {
    ctx.log.warn({ err }, 'model check: could not read the agents');
  }
  ctx.log.info({ live: live.length, gaps: gaps.length, agentsOnMissingModels: missing.length }, 'model check: catalog held against BlockRun');
  last = { at, read: true, live: live.length, gaps, agentsOnMissingModels: missing };
  return last;
}

/** Runs the check now and then every `CATALOG_CHECK_MS`; returns the stop function. Nothing here throws into the caller. */
export function startCatalogChecks(ctx: SupervisorContext, intervalMs = CATALOG_CHECK_MS): () => void {
  const run = () => checkModelCatalog(ctx).catch((err) => ctx.log.warn({ err }, 'model check failed'));
  void run();
  const timer = setInterval(() => void run(), intervalMs);
  return () => clearInterval(timer);
}
