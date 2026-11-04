/**
 * Post-launch control (docs/design/agent-launch-v2.md, decision 6): the creator can change an agent's
 * instructions, powers, cadence, model, image model and image style from the coin page. The on-chain `workerHash` stays the launch-time
 * commitment; the configuration in force lives in `sv_agents.config`, `revision` counts the edits and every
 * edit is an `sv_actions` row `{kind: 'config_updated', fields}` (the activity tape shows it). The running
 * agent reads its config from the `sv_agents` row on every tick (`agentConfigOf` in tick.ts), so an update is
 * live on the next tick; nothing is cached.
 */
import { imageStyleSchema, MAX_CREATOR_IDENTITY_CHARS, MAX_IMAGE_STYLE_NOTES_CHARS, normalizeCreatorIdentity, type ImageStyle } from '@bootr/agent-core';
import { CAPABILITY_KEYS, CUSTOM_WORKER_ID, normalizeWorkerPreset, type WorkerPreset } from '@bootr/shared/workers';
import { eq } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, agents } from './db/schema.js';
import { requiresApproval } from './approvals.js';
import { relayImageModels } from './image-models.js';
import { imageModelOf, imageStyleOf } from './images.js';
import { storedWorkerPreset, withCreatorIdentity, withWorkerPreset, type ResolvedWorker } from './onboarding.js';

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
  /** Posts and replies wait for the creator's approval before they go out (approvals.ts). */
  requireApproval: boolean;
  /** The image model in force (`images.ts`: the default when the config names none). */
  imageModel: string;
  /** The reference picture and notes every generated image follows (images.ts). */
  imageStyle: ImageStyle;
  revision: number;
  updatedAt: string;
}

/** The field names an update can touch (stored in the `config_updated` action and shown in the activity tape). */
export type ConfigField = 'instructions' | 'model' | 'powers' | 'cadence' | 'jobLines' | 'requireApproval' | 'imageModel' | 'imageStyle';

/** The worker preset in force for a stored config: live capabilities and cadence, stored or template job lines. */
function currentPreset(config: Record<string, unknown>): WorkerPreset {
  const stored = storedWorkerPreset(config);
  const caps = normalizeWorkerPreset({ capabilities: config.capabilities, postIntervalMs: stored.postIntervalMs })?.capabilities ?? stored.capabilities;
  const interval = typeof config.postIntervalMs === 'number' ? config.postIntervalMs : stored.postIntervalMs;
  return { capabilities: caps, postIntervalMs: interval, identity: stored.identity };
}

function workerKind(config: Record<string, unknown>): ResolvedWorker['id'] {
  const t = config.workerTemplate;
  return t === 'trader' || t === 'researcher' || t === 'community' || t === CUSTOM_WORKER_ID ? t : 'community';
}

export function configView(agent: AgentRow): AgentConfigView {
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
    requireApproval: requiresApproval(config),
    imageModel: imageModelOf(config),
    imageStyle: imageStyleOf(config),
    revision: typeof config.revision === 'number' ? config.revision : 0,
    updatedAt: agent.updatedAt.toISOString(),
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
  /** Post approval mode on/off (independent of the worker). */
  requireApproval?: unknown;
  /** The image model: one of the relay's image models (image-models.ts). */
  imageModel?: unknown;
  /** Partial `{reference?: https url | null, notes?: string}`, merged onto the stored style. */
  imageStyle?: unknown;
}

/** One line of plain text for the style notes: controls and runs of whitespace collapsed. */
function normalizeStyleNotes(input: string): string {
  // eslint-disable-next-line no-control-regex -- the C0 range is the point
  return input.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, ' ').replace(/\s+/g, ' ').trim();
}

export type ConfigUpdateResult = { ok: true; config: AgentConfigView; fields: ConfigField[] } | { ok: false; status: 400 | 403 | 409; error: string; message: string };

const reject = (status: 400 | 403 | 409, error: string, message: string): ConfigUpdateResult => ({ ok: false, status, error, message });

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

  // Post approval mode: a plain boolean, independent of the worker preset.
  if (body.requireApproval !== undefined) {
    if (typeof body.requireApproval !== 'boolean') return reject(400, 'invalid_require_approval', 'requireApproval must be a boolean');
    if (body.requireApproval !== requiresApproval(before)) {
      config.requireApproval = body.requireApproval;
      fields.push('requireApproval');
    }
  }

  // Image model: one of the image models the relay lists (the built-in three when it cannot be reached).
  if (body.imageModel !== undefined) {
    const model = typeof body.imageModel === 'string' ? body.imageModel.trim() : '';
    if (!model || model.length > MAX_MODEL_CHARS) return reject(400, 'invalid_image_model', `imageModel must be a string of 1..${MAX_MODEL_CHARS} characters`);
    const offered = await relayImageModels(ctx);
    if (!offered.includes(model)) return reject(400, 'image_model_not_allowed', `image model ${model} is not offered by the relay`);
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

  if (!fields.length) return reject(409, 'unchanged', 'nothing changed');

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
