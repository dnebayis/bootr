/**
 * Server-side client for apps/supervisor's internal API (`/internal/agents/:id/config`, `/activity`, `/approvals`), used by the
 * coin page routes under `/api/agent/[kernel]/`. Same HMAC scheme as the sender (apps/supervisor/src/hmac.ts):
 *
 *   Authorization: HMAC <ts>:<hex>, hex = HMAC-SHA256(SUPERVISOR_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path(+query) + "\n" + hex(sha256(body)))
 *
 * Web Crypto only (route handlers). Shapes are the contract in docs/design/agent-launch-v2.md.
 */
import { ALWAYS_ON_CAPABILITIES, CAPABILITY_KEYS, WORKER_BOUNDS, type CapabilityKey } from '@bootr/shared/workers';
import type { Address, Hex } from 'viem';
import type { AgentActivity, AgentActivityItem, AgentApproval, AgentApprovals, AgentConfig, AgentConfigChanges, AgentFuel, AgentImageStyle, AgentWorkerConfig, ApprovalDecision, WorkerKind } from '@/lib/types';
import { supervisorEnv } from './env';
import { signSenderRequest } from './sender';

if (typeof window !== 'undefined') throw new Error('lib/server/supervisor must not be imported in the browser');

/** The supervisor is not configured (SUPERVISOR_URL / SUPERVISOR_SERVICE_KEY) or did not answer: routes answer 503. */
export class SupervisorUnavailable extends Error {}

/** The supervisor answered with an error the caller can relay (400 bounds, 403 not the creator, 404 unknown agent, 409 nothing changed). */
export class SupervisorError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const ACTIVITY_LIMIT_DEFAULT = 50;
export const ACTIVITY_LIMIT_MAX = 100;

/** Body of `PUT /internal/agents/:id/config`: the creator's changes plus what the web knows about who may change what. */
export type PutAgentConfigBody = AgentConfigChanges & {
  /** The signer; the supervisor checks it equals the stored creator. */
  by: Address;
  /** The admin allow-list (`lib/server/admin-config.ts`); the supervisor refuses a model outside it. */
  allowedModels: string[];
};

async function call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<Response> {
  const { serviceKey, url } = supervisorEnv();
  if (!serviceKey || !url) throw new SupervisorUnavailable('supervisor is not configured');
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { authorization: await signSenderRequest(serviceKey, method, path, raw) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: raw } : {}), cache: 'no-store', signal: AbortSignal.timeout(10_000) });
  } catch (err) {
    throw new SupervisorUnavailable(`supervisor unreachable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (res.status >= 500) throw new SupervisorUnavailable(`supervisor responded ${res.status}`);
  return res;
}

async function errorOf(res: Response): Promise<SupervisorError> {
  const body = (await res.json().catch(() => ({}))) as { error?: unknown; message?: unknown };
  const code = typeof body.error === 'string' ? body.error : `http_${res.status}`;
  const message = typeof body.message === 'string' ? body.message : code;
  return new SupervisorError(res.status, code, message);
}

// ------------------------------------------------------------------ sanitizers (trusted service, loosely typed)

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const KINDS: readonly WorkerKind[] = ['trader', 'researcher', 'community', 'custom'];

function str(v: unknown, max: number): string | null {
  return typeof v === 'string' && v.length <= max ? v : null;
}

function iso(v: unknown): string | null {
  if (typeof v === 'string' && Number.isFinite(Date.parse(v))) return v;
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  return null;
}

function worker(raw: unknown): AgentWorkerConfig | null {
  const w = (raw ?? {}) as { kind?: unknown; capabilities?: unknown; postIntervalMs?: unknown; jobLines?: unknown };
  const caps = (w.capabilities && typeof w.capabilities === 'object' ? w.capabilities : {}) as Record<string, unknown>;
  const capabilities = Object.fromEntries(CAPABILITY_KEYS.map((k) => [k, ALWAYS_ON_CAPABILITIES.includes(k) ? true : caps[k] === true])) as Record<CapabilityKey, boolean>;
  const interval = Number(w.postIntervalMs);
  if (!Number.isFinite(interval) || interval <= 0) return null;
  const jobLines = Array.isArray(w.jobLines) ? w.jobLines.filter((l): l is string => typeof l === 'string').slice(0, WORKER_BOUNDS.maxJobLines) : [];
  return { kind: KINDS.includes(w.kind as WorkerKind) ? (w.kind as WorkerKind) : 'custom', capabilities, postIntervalMs: Math.round(interval), jobLines };
}

const MODEL_ID_RE = /^[\w.:/-]{1,80}$/;

/** The decide model of a `routing` block, or null (off) for anything else. */
function decideModelOf(raw: unknown): string | null {
  const m = (raw as { decideModel?: unknown } | null | undefined)?.decideModel;
  return typeof m === 'string' && MODEL_ID_RE.test(m) ? m : null;
}

/** The fuel metering as the coin page renders it: whole thoughts, micro-USDC as digits, model ids only. */
export function sanitizeFuel(raw: unknown): AgentFuel {
  const o = (raw ?? {}) as { days?: unknown; since?: unknown; byModel?: unknown };
  const days = Number(o.days);
  const byModel: AgentFuel['byModel'] = [];
  for (const it of Array.isArray(o.byModel) ? o.byModel : []) {
    const r = (it ?? {}) as Record<string, unknown>;
    const model = str(r.model, 80);
    const thoughts = Number(r.thoughts);
    const charged = typeof r.chargedMicroUsdc === 'string' ? r.chargedMicroUsdc : typeof r.chargedMicroUsdc === 'number' ? String(Math.round(r.chargedMicroUsdc)) : '';
    if (!model || !MODEL_ID_RE.test(model) || !Number.isInteger(thoughts) || thoughts < 0 || !/^\d{1,18}$/.test(charged)) continue;
    byModel.push({ model, thoughts, chargedMicroUsdc: charged });
  }
  return { days: Number.isInteger(days) && days > 0 ? days : 7, since: iso(o.since) ?? new Date(0).toISOString(), byModel };
}

const HTTPS_RE = /^https:\/\/[^\s/?#]+[^\s]*$/i;

/** A public https URL (no credentials), as the supervisor's `httpsUrlSchema` accepts it; null otherwise. */
export function httpsUrl(v: unknown): string | null {
  if (typeof v !== 'string' || v.length > 2000 || !HTTPS_RE.test(v)) return null;
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? v : null;
  } catch {
    return null;
  }
}

function imageStyle(raw: unknown): AgentImageStyle {
  const s = (raw && typeof raw === 'object' ? raw : {}) as { reference?: unknown; notes?: unknown };
  return { reference: httpsUrl(s.reference), notes: str(s.notes, IMAGE_NOTES_MAX) ?? '' };
}

/** The config as the coin page renders it; null when the body is not a config. */
export function sanitizeConfig(raw: unknown): AgentConfig | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const agentId = typeof o.agentId === 'string' ? o.agentId : typeof o.agentId === 'number' ? String(o.agentId) : null;
  const kernel = str(o.kernel, 42);
  const creator = str(o.creator, 42);
  const w = worker(o.worker);
  if (!agentId || !kernel || !ADDRESS_RE.test(kernel) || !creator || !ADDRESS_RE.test(creator) || !w) return null;
  const revision = Number(o.revision);
  return {
    agentId,
    kernel: kernel as Address,
    creator: creator as Address,
    model: str(o.model, 120) ?? '',
    instructions: str(o.instructions, 4000) ?? '',
    worker: w,
    workerHash: (str(o.workerHash, 66) && HASH_RE.test(o.workerHash as string) ? (o.workerHash as Hex) : `0x${'0'.repeat(64)}`) as Hex,
    requireApproval: o.requireApproval === true,
    routing: { decideModel: decideModelOf(o.routing) },
    imageModel: str(o.imageModel, 120) ?? '',
    imageStyle: imageStyle(o.imageStyle),
    revision: Number.isFinite(revision) && revision >= 0 ? Math.round(revision) : 0,
    updatedAt: iso(o.updatedAt) ?? new Date(0).toISOString(),
  };
}

/** Keeps only the fields the tape renders: time, kind, one line of text, a tx hash and an https link. */
export function sanitizeActivity(raw: unknown): AgentActivity {
  const o = (raw ?? {}) as { items?: unknown };
  const items: AgentActivityItem[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const r = (it ?? {}) as Record<string, unknown>;
    const at = iso(r.at);
    const kind = str(r.kind, 40);
    const summary = str(r.summary, 1000);
    if (!at || !kind || !summary) continue;
    const item: AgentActivityItem = { at, kind, summary };
    if (typeof r.txHash === 'string' && HASH_RE.test(r.txHash)) item.txHash = r.txHash as Hex;
    if (typeof r.url === 'string' && /^https:\/\/[^\s]{1,300}$/.test(r.url)) item.url = r.url;
    items.push(item);
  }
  return { items };
}

const APPROVAL_STATUSES: readonly AgentApproval['status'][] = ['pending_approval', 'approved', 'rejected', 'failed'];
const IMAGE_MIME_RE = /^image\/(png|jpeg|webp|gif)$/;
/** The largest picture the queue embeds (base64; X takes 5 MB, the relay caps lower). */
const IMAGE_DATA_MAX = 8_000_000;

/** One queue item as the console renders it; null when it is not an approval. Image bytes become a data URL. */
export function sanitizeApproval(raw: unknown): AgentApproval | null {
  const o = (raw ?? {}) as Record<string, unknown>;
  const id = str(o.id, 120);
  const kind = o.kind === 'reply' ? 'reply' : o.kind === 'post' ? 'post' : null;
  const text = str(o.text, 8000);
  const status = APPROVAL_STATUSES.includes(o.status as AgentApproval['status']) ? (o.status as AgentApproval['status']) : null;
  const createdAt = iso(o.createdAt);
  if (!id || !kind || text === null || !status || !createdAt) return null;
  let image: AgentApproval['image'] = null;
  if (o.image && typeof o.image === 'object') {
    const im = o.image as { alt?: unknown; mime?: unknown; data?: unknown };
    const alt = str(im.alt, 1000) ?? '';
    const mime = str(im.mime, 40);
    const data = typeof im.data === 'string' && im.data.length <= IMAGE_DATA_MAX && /^[A-Za-z0-9+/=]*$/.test(im.data) ? im.data : null;
    image = { alt, ...(mime && IMAGE_MIME_RE.test(mime) && data ? { dataUrl: `data:${mime};base64,${data}` } : {}) };
  }
  const decision = o.decision === 'approve' || o.decision === 'reject' ? (o.decision as ApprovalDecision) : null;
  return {
    id,
    kind,
    text,
    inReplyTo: str(o.inReplyTo, 40),
    image,
    status,
    decision,
    decidedBy: str(o.decidedBy, 64),
    note: str(o.note, 1000),
    url: typeof o.url === 'string' && /^https:\/\/[^\s]{1,300}$/.test(o.url) ? o.url : null,
    createdAt,
    decidedAt: iso(o.decidedAt),
    expiresAt: iso(o.expiresAt) ?? new Date(Date.parse(createdAt) + 48 * 3_600_000).toISOString(),
  };
}

export function sanitizeApprovals(raw: unknown): AgentApprovals {
  const o = (raw ?? {}) as { items?: unknown; pending?: unknown };
  const items: AgentApproval[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const a = sanitizeApproval(it);
    if (a) items.push(a);
  }
  const n = Number(o.pending);
  return { items, pending: Number.isFinite(n) && n >= 0 ? Math.round(n) : items.filter((i) => i.status === 'pending_approval').length };
}

// ------------------------------------------------------------------ calls

/** `GET /internal/agents/:id/config`; null when the supervisor does not know the agent. */
export async function getAgentConfig(agentId: string): Promise<AgentConfig | null> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/config`);
  if (res.status === 404) return null;
  if (!res.ok) throw await errorOf(res);
  const cfg = sanitizeConfig(await res.json());
  if (!cfg) throw new SupervisorUnavailable('supervisor returned a malformed config');
  return cfg;
}

/** `PUT /internal/agents/:id/config`; the new config, or a SupervisorError the route relays (400 / 403 / 404 / 409). */
export async function putAgentConfig(agentId: string, body: PutAgentConfigBody): Promise<AgentConfig> {
  const res = await call('PUT', `/internal/agents/${encodeURIComponent(agentId)}/config`, body);
  if (!res.ok) throw await errorOf(res);
  const cfg = sanitizeConfig(await res.json());
  if (!cfg) throw new SupervisorUnavailable('supervisor returned a malformed config');
  return cfg;
}

/** `GET /internal/agents/:id/fuel?days=`: thoughts per model (economy mode shows its split here). Unknown agent = empty. */
export async function getAgentFuel(agentId: string, days = 7): Promise<AgentFuel> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/fuel?days=${Math.min(90, Math.max(1, Math.trunc(days)))}`);
  if (res.status === 404) return { days, since: new Date(Date.now() - days * 86_400_000).toISOString(), byModel: [] };
  if (!res.ok) throw await errorOf(res);
  return sanitizeFuel(await res.json());
}

/** `GET /internal/agents/:id/activity?limit=&before=`; newest first. `before` is the `at` of the last item shown. */
export async function getAgentActivity(agentId: string, opts: { limit?: number; before?: string } = {}): Promise<AgentActivity> {
  const limit = Math.min(ACTIVITY_LIMIT_MAX, Math.max(1, Math.trunc(opts.limit ?? ACTIVITY_LIMIT_DEFAULT)));
  const q = new URLSearchParams({ limit: String(limit) });
  if (opts.before) q.set('before', opts.before);
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/activity?${q.toString()}`);
  if (res.status === 404) return { items: [] };
  if (!res.ok) throw await errorOf(res);
  return sanitizeActivity(await res.json());
}

/** `GET /internal/agents/:id/approvals?status=`: the review queue (pending items carry their image). Unknown agent = empty. */
export async function getAgentApprovals(agentId: string, status: 'pending' | 'all' = 'pending'): Promise<AgentApprovals> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/approvals?status=${status}`);
  if (res.status === 404) return { items: [], pending: 0 };
  if (!res.ok) throw await errorOf(res);
  return sanitizeApprovals(await res.json());
}

/** `POST /internal/agents/:id/approvals/:approvalId {decision, by, note?}`; the decided item, or a SupervisorError (400/403/404/409/503). */
export async function decideAgentApproval(agentId: string, approvalId: string, body: { decision: ApprovalDecision; by: Address; note?: string }): Promise<AgentApproval> {
  const res = await call('POST', `/internal/agents/${encodeURIComponent(agentId)}/approvals/${encodeURIComponent(approvalId)}`, body);
  if (!res.ok) throw await errorOf(res);
  const item = sanitizeApproval(await res.json());
  if (!item) throw new SupervisorUnavailable('supervisor returned a malformed approval');
  return item;
}

// ------------------------------------------------------------------ creator changes (web-side pre-check; the supervisor is authoritative)

export const INSTRUCTIONS_MIN = 20;
export const INSTRUCTIONS_MAX = 600;
/** `MAX_IMAGE_STYLE_NOTES_CHARS` in packages/agent-core. */
export const IMAGE_NOTES_MAX = 200;

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * The `changes` a creator may send: instructions (20–600 plain chars), a model id, worker fields inside
 * WORKER_BOUNDS, the post review switch, an image model id and the image style (an https reference or null, notes
 * of at most IMAGE_NOTES_MAX plain characters). Unknown keys are dropped, always-on powers cannot be switched off.
 * Returns the error to show.
 */
export function validateChanges(input: unknown): { ok: true; changes: AgentConfigChanges } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') return { ok: false, message: 'changes must be an object' };
  const o = input as { instructions?: unknown; model?: unknown; worker?: unknown; requireApproval?: unknown; imageModel?: unknown; imageStyle?: unknown; routing?: unknown };
  const changes: AgentConfigChanges = {};
  if (o.imageModel !== undefined) {
    if (typeof o.imageModel !== 'string' || !/^[\w.:/-]{1,80}$/.test(o.imageModel)) return { ok: false, message: 'Pick an image model from the list.' };
    changes.imageModel = o.imageModel;
  }
  if (o.imageStyle !== undefined) {
    if (!o.imageStyle || typeof o.imageStyle !== 'object') return { ok: false, message: 'imageStyle must be an object' };
    const s = o.imageStyle as { reference?: unknown; notes?: unknown };
    const style: Partial<AgentImageStyle> = {};
    if (s.reference !== undefined) {
      if (s.reference !== null && httpsUrl(s.reference) === null) return { ok: false, message: 'The reference image must be an https URL, or empty for none.' };
      style.reference = s.reference as string | null;
    }
    if (s.notes !== undefined) {
      const notes = cleanText(s.notes)?.replace(/\s+/g, ' ');
      if (notes == null || notes.length > IMAGE_NOTES_MAX) return { ok: false, message: `Style notes are plain text of at most ${IMAGE_NOTES_MAX} characters.` };
      style.notes = notes;
    }
    if (Object.keys(style).length) changes.imageStyle = style;
  }
  if (o.requireApproval !== undefined) {
    if (typeof o.requireApproval !== 'boolean') return { ok: false, message: 'requireApproval must be true or false' };
    changes.requireApproval = o.requireApproval;
  }
  if (o.routing !== undefined) {
    if (!o.routing || typeof o.routing !== 'object' || Array.isArray(o.routing)) return { ok: false, message: 'routing must be an object' };
    const m = (o.routing as { decideModel?: unknown }).decideModel;
    if (m !== null && (typeof m !== 'string' || !MODEL_ID_RE.test(m))) return { ok: false, message: 'Pick a deciding model from the list, or switch economy mode off.' };
    changes.routing = { decideModel: m };
  }
  if (o.instructions !== undefined) {
    const text = cleanText(o.instructions);
    if (text === null || text.length < INSTRUCTIONS_MIN || text.length > INSTRUCTIONS_MAX) {
      return { ok: false, message: `Instructions must be plain text of ${INSTRUCTIONS_MIN} to ${INSTRUCTIONS_MAX} characters.` };
    }
    changes.instructions = text;
  }
  if (o.model !== undefined) {
    if (typeof o.model !== 'string' || !MODEL_ID_RE.test(o.model)) return { ok: false, message: 'Pick a model from the list.' };
    changes.model = o.model;
  }
  if (o.worker !== undefined) {
    if (!o.worker || typeof o.worker !== 'object') return { ok: false, message: 'worker must be an object' };
    const w = o.worker as { capabilities?: unknown; postIntervalMs?: unknown; jobLines?: unknown };
    const worker: NonNullable<AgentConfigChanges['worker']> = {};
    if (w.capabilities !== undefined) {
      if (!w.capabilities || typeof w.capabilities !== 'object') return { ok: false, message: 'capabilities must be an object' };
      const caps = w.capabilities as Record<string, unknown>;
      const out: Partial<Record<CapabilityKey, boolean>> = {};
      for (const k of CAPABILITY_KEYS) {
        if (caps[k] === undefined) continue;
        if (typeof caps[k] !== 'boolean') return { ok: false, message: `${k} must be true or false` };
        if (ALWAYS_ON_CAPABILITIES.includes(k) && caps[k] === false) return { ok: false, message: `${k} is always on.` };
        out[k] = caps[k] as boolean;
      }
      worker.capabilities = out;
    }
    if (w.jobLines !== undefined) {
      if (!Array.isArray(w.jobLines) || w.jobLines.some((l) => typeof l !== 'string')) return { ok: false, message: 'jobLines must be an array of strings' };
      const lines = (w.jobLines as string[]).map((l) => l.trim()).filter(Boolean);
      if (lines.length > WORKER_BOUNDS.maxJobLines || lines.some((l) => l.length > WORKER_BOUNDS.maxJobLineChars)) return { ok: false, message: `At most ${WORKER_BOUNDS.maxJobLines} job lines of ${WORKER_BOUNDS.maxJobLineChars} characters.` };
      worker.jobLines = lines;
    }
    if (w.postIntervalMs !== undefined) {
      const n = Number(w.postIntervalMs);
      if (!Number.isInteger(n) || n < WORKER_BOUNDS.minPostIntervalMs || n > WORKER_BOUNDS.maxPostIntervalMs) {
        return { ok: false, message: 'Cadence must be between 30 minutes and 7 days.' };
      }
      worker.postIntervalMs = n;
    }
    if (w.jobLines !== undefined) {
      if (!Array.isArray(w.jobLines) || w.jobLines.length > WORKER_BOUNDS.maxJobLines) return { ok: false, message: `At most ${WORKER_BOUNDS.maxJobLines} job lines.` };
      const lines: string[] = [];
      for (const l of w.jobLines) {
        const line = cleanText(l)?.replace(/\s+/g, ' ');
        if (line == null || line.length > WORKER_BOUNDS.maxJobLineChars) return { ok: false, message: `Each job line is plain text of at most ${WORKER_BOUNDS.maxJobLineChars} characters.` };
        if (line) lines.push(line);
      }
      worker.jobLines = lines;
    }
    if (Object.keys(worker).length) changes.worker = worker;
  }
  if (Object.keys(changes).length === 0) return { ok: false, message: 'Nothing to change.' };
  return { ok: true, changes };
}
