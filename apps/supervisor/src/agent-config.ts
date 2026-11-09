/**
 * Post-launch control (docs/design/agent-launch-v2.md, decision 6): the creator can change an agent's
 * instructions, powers, posts per day (which sets the cadence), model, image model and image style from the coin page. The on-chain `workerHash` stays the launch-time
 * commitment; the configuration in force lives in `sv_agents.config`, `revision` counts the edits and every
 * edit is an `sv_actions` row `{kind: 'config_updated', fields}` (the activity tape shows it). The running
 * agent reads its config from the `sv_agents` row on every tick (`agentConfigOf` in tick.ts), so an update is
 * live on the next tick; nothing is cached.
 */
import { catalogModel, DEFAULT_SERVICES_POLICY, imageStyleSchema, MAX_CREATOR_IDENTITY_CHARS, MAX_IMAGE_STYLE_NOTES_CHARS, normalizeCreatorIdentity, relayModelId, SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_PER_CALL_MAX_MICRO_USDC, servicesPolicySchema, type ImageStyle, type ServicesPolicy } from '@bootr/agent-core';
import { CAPABILITY_KEYS, CUSTOM_WORKER_ID, normalizeWorkerPreset, POSTS_PER_DAY, postIntervalForPostsPerDay, type WorkerPreset } from '@bootr/shared/workers';
import { eq } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, agents, runtimes } from './db/schema.js';
import { requiresApproval } from './approvals.js';
import { relayImageModels } from './image-models.js';
import { imageModelOf, imageStyleOf } from './images.js';
import { storedWorkerPreset, withCreatorIdentity, withWorkerPreset, type ResolvedWorker } from './onboarding.js';
import { postsPerDayOf } from './post-budget.js';
import { decideModelOf } from './routing.js';
import { sessionRulesStatus, type SessionRulesStatus } from './session-rules.js';

export const MIN_INSTRUCTIONS_CHARS = 20;
const MAX_MODEL_CHARS = 128;

/** `GET /internal/agents/:id/config`. */
export interface AgentConfigView {
  agentId: string;
  kernel: string;
  creator: string;
  model: string;
  /** The creator's Instructions text ('' when none was ever read). */
  instructions: string;
  worker: {
    kind: ResolvedWorker['id'];
    capabilities: WorkerPreset['capabilities'];
    postIntervalMs: number;
    jobLines: string[];
  };
  workerHash: string | null;
  /**
   * The daily budget of posts and replies (the sender's rolling 24 h quota): stored on the config when the creator set
   * it, else the sender's default. Setting it derives `worker.postIntervalMs` (`postIntervalForPostsPerDay`).
   */
  postsPerDay: number;
  /** Posts and replies wait for the creator's approval before they go out (approvals.ts). */
  requireApproval: boolean;
  /** Economy mode (routing.ts): the cheaper model a turn starts on; null = the whole turn runs on `model`. */
  routing: { decideModel: string | null };
  /** The image model in force (`images.ts`: the default when the config names none). */
  imageModel: string;
  /** The reference picture and notes every generated image follows (images.ts). */
  imageStyle: ImageStyle;
  /**
   * The money bounds of the Paid services power (services.ts), whether or not the power is on: per-call and daily caps
   * in micro-USDC (the console shows USDC) and the host allow and deny lists. The daily cap is the most this power can
   * cost in a day, whatever the model does.
   */
  services: ServicesPolicy;
  /**
   * The on-chain rules of the installed session key against the ones the powers in force imply (session-rules.ts):
   * `current` is what the key allows today, `wanted` what the config asks for, and `reinstallNeeded` says the tick's
   * rotation scan will rotate the key (at most once a day) so a power switched on here reaches the chain without
   * waiting for the expiry rotation. Read-only.
   */
  sessionRules: SessionRulesStatus;
  revision: number;
  updatedAt: string;
  /**
   * A hold X put on the account's posting, for the coin page to show the creator while it lasts: today only the
   * 403 "not permitted" hold (runtime.ts `postForbiddenUntil`, rhythm.ts `forbiddenHold`). Null when the account may post.
   * Read-only; a reconnect from the page ends it (`liftForbiddenHoldOnReconnect`).
   */
  xHold: XHoldView | null;
  /**
   * The X connection as the sender holds it: `connected`, `revoked` (X dropped it; the creator must connect the same
   * account again, and no hold can end before that) or `none` (no account row). Null when the sender could not be asked:
   * the page then shows nothing new. Read-only.
   */
  xConnection: XConnectionView | null;
}

export type XConnectionView = 'connected' | 'revoked' | 'none';

/** The sender's account row as the three words the page needs; null when the sender does not answer. */
export async function xConnectionOf(ctx: Pick<SupervisorContext, 'sender'>, agentId: string): Promise<XConnectionView | null> {
  const account = await ctx.sender.account(agentId).catch(() => null);
  if (!account) return null;
  return account.revoked ? 'revoked' : account.connected ? 'connected' : 'none';
}

export interface XHoldView {
  reason: 'forbidden';
  /** ISO 8601: when the hold ends on its own. */
  until: string;
  /** Refusals in a row (6 h, 12 h, then a day). */
  strikes: number;
}

/** The X hold in force on the agent's runtime state, or null: none set, or its time has passed. */
export async function xHoldOf(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<XHoldView | null> {
  const row = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agentId), columns: { state: true } });
  const state = (row?.state ?? {}) as { postForbiddenUntil?: unknown; postForbiddenStrikes?: unknown };
  const until = typeof state.postForbiddenUntil === 'number' && Number.isFinite(state.postForbiddenUntil) ? state.postForbiddenUntil : null;
  if (until === null || until <= ctx.now()) return null;
  const strikes = typeof state.postForbiddenStrikes === 'number' && Number.isFinite(state.postForbiddenStrikes) && state.postForbiddenStrikes >= 1 ? Math.floor(state.postForbiddenStrikes) : 1;
  return { reason: 'forbidden', until: new Date(until).toISOString(), strikes };
}

/** The field names an update can touch (stored in the `config_updated` action and shown in the activity tape). */
export type ConfigField = 'instructions' | 'model' | 'powers' | 'cadence' | 'postsPerDay' | 'jobLines' | 'requireApproval' | 'imageModel' | 'imageStyle' | 'routing' | 'services';

/** The stored `services` block, or the defaults when it is missing or malformed. */
export function servicesOf(config: Record<string, unknown>): ServicesPolicy {
  const parsed = servicesPolicySchema.safeParse(config.services ?? {});
  return parsed.success ? parsed.data : DEFAULT_SERVICES_POLICY;
}

/** The worker preset in force for a stored config: live capabilities and cadence, stored or template job lines. */
function currentPreset(config: Record<string, unknown>): WorkerPreset {
  const stored = storedWorkerPreset(config);
  const caps = normalizeWorkerPreset({ capabilities: config.capabilities, postIntervalMs: stored.postIntervalMs })?.capabilities ?? stored.capabilities;
  const interval = typeof config.postIntervalMs === 'number' ? config.postIntervalMs : stored.postIntervalMs;
  return { capabilities: caps, postIntervalMs: interval, identity: stored.identity };
}

/** The stored `routing` block, or off when it is missing or malformed. */
function routingOf(config: Record<string, unknown>): { decideModel: string | null } {
  const r = config.routing as { decideModel?: unknown } | null | undefined;
  return { decideModel: r && typeof r === 'object' && typeof r.decideModel === 'string' && r.decideModel ? r.decideModel : null };
}

function workerKind(config: Record<string, unknown>): ResolvedWorker['id'] {
  const t = config.workerTemplate;
  return t === 'trader' || t === 'researcher' || t === 'community' || t === CUSTOM_WORKER_ID ? t : 'community';
}

export function configView(agent: AgentRow, xHold: XHoldView | null = null, xConnection: XConnectionView | null = null): AgentConfigView {
  const config = agent.config;
  const preset = currentPreset(config);
  return {
    agentId: agent.agentId,
    kernel: agent.kernel,
    creator: agent.creator,
    model: typeof config.model === 'string' ? config.model : '',
    instructions: typeof config.creatorIdentity === 'string' ? config.creatorIdentity : '',
    worker: { kind: workerKind(config), capabilities: preset.capabilities, postIntervalMs: preset.postIntervalMs, jobLines: preset.identity },
    workerHash: typeof config.workerHash === 'string' ? config.workerHash : null,
    postsPerDay: postsPerDayOf(config),
    requireApproval: requiresApproval(config),
    routing: { decideModel: decideModelOf({ model: typeof config.model === 'string' ? config.model : '', routing: routingOf(config) }) },
    imageModel: imageModelOf(config),
    imageStyle: imageStyleOf(config),
    services: servicesOf(config),
    sessionRules: sessionRulesStatus(agent, config),
    revision: typeof config.revision === 'number' ? config.revision : 0,
    updatedAt: agent.updatedAt.toISOString(),
    xHold,
    xConnection,
  };
}

/** `PUT /internal/agents/:id/config` body. */
export interface ConfigUpdateBody {
  by?: unknown;
  instructions?: unknown;
  model?: unknown;
  /** The admin model allow-list the web passes; when present `model` must be in it. */
  allowedModels?: unknown;
  worker?: unknown;
  /** Posts and replies per rolling day (POSTS_PER_DAY.min..max): written to the sender's quota, and the cadence follows. */
  postsPerDay?: unknown;
  /** Post approval mode on/off (independent of the worker). */
  requireApproval?: unknown;
  /** Economy mode: `{decideModel: string | null}`; the model must be in `allowedModels` like `model`. */
  routing?: unknown;
  /** The image model: one of the relay's image models (image-models.ts). */
  imageModel?: unknown;
  /** Partial `{reference?: https url | null, notes?: string}`, merged onto the stored style. */
  imageStyle?: unknown;
  /** Partial `{perCallMicroUsdc?, dailyMicroUsdc?, allow?, deny?}`, merged onto the stored services policy. */
  services?: unknown;
}

/** One line of plain text for the style notes: controls and runs of whitespace collapsed. */
function normalizeStyleNotes(input: string): string {
  // eslint-disable-next-line no-control-regex -- the C0 range is the point
  return input.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type ConfigUpdateResult = { ok: true; config: AgentConfigView; fields: ConfigField[] } | { ok: false; status: 400 | 403 | 409 | 503; error: string; message: string };

const reject = (status: 400 | 403 | 409 | 503, error: string, message: string): ConfigUpdateResult => ({ ok: false, status, error, message });

/** Validates and applies a creator's config update; see the module comment for what it writes. */
export async function updateAgentConfig(ctx: SupervisorContext, agent: AgentRow, body: ConfigUpdateBody): Promise<ConfigUpdateResult> {
  // Who: the stored creator, case-insensitively (the web verified the SIWE signature; `by` is the signer).
  let by: Address;
  try {
    by = getAddress(String(body.by ?? ''));
  } catch {
    return reject(400, 'invalid_by', '`by` must be the creator address');
  }
  if (!isAddressEqual(by, agent.creator as Address)) return reject(403, 'not_creator', '`by` is not the creator of this agent');

  const before = agent.config;
  const fields: ConfigField[] = [];
  let config: Record<string, unknown> = { ...before };

  // Instructions: normalised like the creator identity at launch, 20..600 plain-text characters.
  if (body.instructions !== undefined) {
    const raw = body.instructions;
    if (typeof raw !== 'string' || Array.from(raw.trim()).length > MAX_CREATOR_IDENTITY_CHARS) return reject(400, 'invalid_instructions', `instructions must be a string of at most ${MAX_CREATOR_IDENTITY_CHARS} characters`);
    const text = normalizeCreatorIdentity(raw);
    if (text.length < MIN_INSTRUCTIONS_CHARS) return reject(400, 'invalid_instructions', `instructions must be at least ${MIN_INSTRUCTIONS_CHARS} characters of plain text`);
    if (text !== (typeof before.creatorIdentity === 'string' ? before.creatorIdentity : '')) {
      config = withCreatorIdentity(config, text);
      fields.push('instructions');
    }
  }

  // Model: a non-empty id; inside the allow-list when the caller passes one.
  if (body.model !== undefined) {
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model || model.length > MAX_MODEL_CHARS) return reject(400, 'invalid_model', `model must be a string of 1..${MAX_MODEL_CHARS} characters`);
    if (Array.isArray(body.allowedModels) && !body.allowedModels.some((m) => m === model)) return reject(400, 'model_not_allowed', `model ${model} is not in the allow-list`);
    if (model !== before.model) {
      config.model = model;
      fields.push('model');
    }
  }

  // Worker: partial updates merge onto the preset in force, then the whole thing is re-validated.
  if (body.worker !== undefined) {
    if (!body.worker || typeof body.worker !== 'object' || Array.isArray(body.worker)) return reject(400, 'invalid_worker', 'worker must be an object');
    const w = body.worker as { capabilities?: unknown; postIntervalMs?: unknown; jobLines?: unknown };
    const current = currentPreset(before);
    const capabilities = { ...current.capabilities } as Record<string, boolean>;
    if (w.capabilities !== undefined) {
      if (!w.capabilities || typeof w.capabilities !== 'object' || Array.isArray(w.capabilities)) return reject(400, 'invalid_worker', 'worker.capabilities must be an object of booleans');
      for (const [k, v] of Object.entries(w.capabilities as Record<string, unknown>)) {
        if (!(CAPABILITY_KEYS as readonly string[]).includes(k)) return reject(400, 'invalid_worker', `unknown capability ${k}`);
        if (typeof v !== 'boolean') return reject(400, 'invalid_worker', `capability ${k} must be a boolean`);
        capabilities[k] = v;
      }
    }
    const merged = normalizeWorkerPreset({
      capabilities,
      postIntervalMs: w.postIntervalMs !== undefined ? w.postIntervalMs : current.postIntervalMs,
      identity: w.jobLines !== undefined ? w.jobLines : current.identity,
    });
    if (!merged) return reject(400, 'invalid_worker', 'worker is out of bounds (cadence 30 min .. 7 days, at most 4 job lines of 240 characters)');
    const kind = workerKind(before);
    const linesChanged = JSON.stringify(merged.identity) !== JSON.stringify(current.identity);
    if (linesChanged && kind !== CUSTOM_WORKER_ID) return reject(400, 'job_lines_fixed', `job lines of the ${kind} preset cannot be edited`);
    if (JSON.stringify(merged.capabilities) !== JSON.stringify(current.capabilities)) fields.push('powers');
    if (merged.postIntervalMs !== current.postIntervalMs) fields.push('cadence');
    if (linesChanged) fields.push('jobLines');
    if (fields.some((f) => f === 'powers' || f === 'cadence' || f === 'jobLines')) config = withWorkerPreset(config, kind, merged);
  }

  // Posts per day: the sender's quota (posts and replies, rolling 24 h) and, from it, the cadence: original posts take
  // half the budget (`postIntervalForPostsPerDay`), so it overrides a `worker.postIntervalMs` sent in the same body.
  // Written to the sender below, once everything else validated, and before the config is stored.
  let quotaToWrite: number | null = null;
  if (body.postsPerDay !== undefined) {
    const n = body.postsPerDay;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < POSTS_PER_DAY.min || n > POSTS_PER_DAY.max) return reject(400, 'invalid_posts_per_day', `postsPerDay must be an integer of ${POSTS_PER_DAY.min}..${POSTS_PER_DAY.max}`);
    if (n !== postsPerDayOf(before)) {
      config.postsPerDay = n;
      fields.push('postsPerDay');
      quotaToWrite = n;
      const preset = currentPreset(config);
      const interval = postIntervalForPostsPerDay(n);
      if (interval !== preset.postIntervalMs) {
        config = withWorkerPreset(config, workerKind(before), { ...preset, postIntervalMs: interval });
        if (!fields.includes('cadence')) fields.push('cadence');
      }
    }
  }

  // Post approval mode: a plain boolean, independent of the worker preset.
  if (body.requireApproval !== undefined) {
    if (typeof body.requireApproval !== 'boolean') return reject(400, 'invalid_require_approval', 'requireApproval must be a boolean');
    if (body.requireApproval !== requiresApproval(before)) {
      config.requireApproval = body.requireApproval;
      fields.push('requireApproval');
    }
  }

  // Economy mode: the decide model is validated like `model`; null switches the mode off. Stored as given: a decide
  // model equal to the writer is kept and simply behaves as off (routing.ts), so a later model change can re-enable it.
  if (body.routing !== undefined) {
    if (!body.routing || typeof body.routing !== 'object' || Array.isArray(body.routing)) return reject(400, 'invalid_routing', 'routing must be an object {decideModel}');
    const raw = (body.routing as { decideModel?: unknown }).decideModel;
    let decideModel: string | null;
    if (raw === null) decideModel = null;
    else {
      decideModel = typeof raw === 'string' ? raw.trim() : '';
      if (!decideModel || decideModel.length > MAX_MODEL_CHARS) return reject(400, 'invalid_routing', `routing.decideModel must be null or a string of 1..${MAX_MODEL_CHARS} characters`);
      if (Array.isArray(body.allowedModels) && !body.allowedModels.some((m) => m === decideModel)) return reject(400, 'model_not_allowed', `model ${decideModel} is not in the allow-list`);
    }
    if (decideModel !== routingOf(before).decideModel) {
      config.routing = { decideModel };
      fields.push('routing');
    }
  }

  // Image model: one the agent's route offers (the catalog's image models in direct mode, the relay's list otherwise),
  // named by its catalog id or by the relay's name for the same model; stored under the catalog id.
  if (body.imageModel !== undefined) {
    const raw = typeof body.imageModel === 'string' ? body.imageModel.trim() : '';
    if (!raw || raw.length > MAX_MODEL_CHARS) return reject(400, 'invalid_image_model', `imageModel must be a string of 1..${MAX_MODEL_CHARS} characters`);
    const offered = await relayImageModels(ctx, agent);
    const known = catalogModel(raw);
    const model = known?.role === 'image' ? known.id : raw;
    if (![raw, model, relayModelId(model)].some((name) => offered.includes(name))) return reject(400, 'image_model_not_allowed', `image model ${raw} is not offered; pick one of ${offered.join(', ')}`);
    if (model !== imageModelOf(before)) {
      config.imageModel = model;
      fields.push('imageModel');
    }
  }

  // Image style: a partial object merged onto the style in force; the reference is an https URL or null.
  if (body.imageStyle !== undefined) {
    if (!body.imageStyle || typeof body.imageStyle !== 'object' || Array.isArray(body.imageStyle)) return reject(400, 'invalid_image_style', 'imageStyle must be an object');
    const current = imageStyleOf(before);
    const patch = body.imageStyle as { reference?: unknown; notes?: unknown };
    const parsed = imageStyleSchema.safeParse({
      reference: patch.reference !== undefined ? patch.reference : current.reference,
      notes: patch.notes !== undefined ? (typeof patch.notes === 'string' ? normalizeStyleNotes(patch.notes) : patch.notes) : current.notes,
    });
    if (!parsed.success) return reject(400, 'invalid_image_style', `imageStyle.reference must be a public https URL or null and imageStyle.notes plain text of at most ${MAX_IMAGE_STYLE_NOTES_CHARS} characters`);
    if (JSON.stringify(parsed.data) !== JSON.stringify(current)) {
      config.imageStyle = parsed.data;
      fields.push('imageStyle');
    }
  }

  // Paid services caps: a partial block merged onto the policy in force, then the whole thing re-validated (hard ceilings).
  if (body.services !== undefined) {
    if (!body.services || typeof body.services !== 'object' || Array.isArray(body.services)) return reject(400, 'invalid_services', 'services must be an object');
    const current = servicesOf(before);
    const patch = body.services as Partial<Record<keyof ServicesPolicy, unknown>>;
    const parsed = servicesPolicySchema.safeParse({
      perCallMicroUsdc: patch.perCallMicroUsdc !== undefined ? patch.perCallMicroUsdc : current.perCallMicroUsdc,
      dailyMicroUsdc: patch.dailyMicroUsdc !== undefined ? patch.dailyMicroUsdc : current.dailyMicroUsdc,
      allow: patch.allow !== undefined ? (Array.isArray(patch.allow) ? patch.allow.map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : h)) : patch.allow) : current.allow,
      deny: patch.deny !== undefined ? (Array.isArray(patch.deny) ? patch.deny.map((h) => (typeof h === 'string' ? h.trim().toLowerCase() : h)) : patch.deny) : current.deny,
    });
    if (!parsed.success) return reject(400, 'invalid_services', `services caps must be whole micro-USDC amounts (per call at most ${SERVICES_PER_CALL_MAX_MICRO_USDC}, per day at most ${SERVICES_DAILY_MAX_MICRO_USDC}) and the host lists hostnames or *.example.com patterns, at most 64 each`);
    if (parsed.data.perCallMicroUsdc > parsed.data.dailyMicroUsdc) return reject(400, 'invalid_services', 'the per-call cap cannot exceed the daily cap');
    if (JSON.stringify(parsed.data) !== JSON.stringify(current)) {
      config.services = parsed.data;
      fields.push('services');
    }
  }

  if (!fields.length) return reject(409, 'unchanged', 'nothing changed');

  // The sender enforces the budget, so it learns the new one first; a sender that cannot be reached means no change at
  // all (a stored budget the sender does not apply would mislead the creator and the agent's own pacing).
  if (quotaToWrite !== null) {
    try {
      await ctx.sender.setQuota(agent.agentId, { postsPerDay: quotaToWrite });
    } catch (err) {
      ctx.log.warn({ agentId: agent.agentId, err, postsPerDay: quotaToWrite }, 'posts per day: the sender refused the quota write; config unchanged');
      return reject(503, 'sender_unavailable', 'the posting service could not take the new posts-per-day budget; nothing was changed, try again in a moment');
    }
  }

  const revision = (typeof before.revision === 'number' ? before.revision : 0) + 1;
  config.revision = revision;
  const now = new Date(ctx.now());
  const [row] = await ctx.db.update(agents).set({ config, updatedAt: now }).where(eq(agents.agentId, agent.agentId)).returning();
  await ctx.db
    .insert(actions)
    .values({
      actionId: `config-${agent.agentId}-r${revision}`,
      agentId: agent.agentId,
      cycleKey: `config:${revision}`,
      action: { kind: 'config_updated', fields, by, revision },
      status: 'completed',
      result: null,
      receipt: null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  ctx.log.info({ agentId: agent.agentId, by, revision, fields }, 'agent config updated by the creator');
  return { ok: true, config: configView(row ?? { ...agent, config, updatedAt: now }), fields };
}
