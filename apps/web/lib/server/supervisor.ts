/**
 * Server-side client for apps/supervisor's internal API (`/internal/agents/:id/config`, `/activity`), used by the
 * coin page routes under `/api/agent/[kernel]/`. Same HMAC scheme as the sender (apps/supervisor/src/hmac.ts):
 *
 *   Authorization: HMAC <ts>:<hex>, hex = HMAC-SHA256(SUPERVISOR_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path(+query) + "\n" + hex(sha256(body)))
 *
 * Web Crypto only (route handlers). Shapes are the contract in docs/design/agent-launch-v2.md.
 */
import { ALWAYS_ON_CAPABILITIES, CAPABILITY_KEYS, WORKER_BOUNDS, type CapabilityKey } from '@bootr/shared/workers';
import type { Address, Hex } from 'viem';
import type { AgentActivity, AgentActivityItem, AgentConfig, AgentConfigChanges, AgentWorkerConfig, WorkerKind } from '@/lib/types';
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

async function call(method: 'GET' | 'PUT', path: string, body?: unknown): Promise<Response> {
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

// ------------------------------------------------------------------ creator changes (web-side pre-check; the supervisor is authoritative)

export const INSTRUCTIONS_MIN = 20;
export const INSTRUCTIONS_MAX = 600;

function cleanText(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  return v
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
}

/**
 * The `changes` a creator may send: instructions (20–600 plain chars), a model id, and worker fields inside
 * WORKER_BOUNDS. Unknown keys are dropped, always-on powers cannot be switched off. Returns the error to show.
 */
export function validateChanges(input: unknown): { ok: true; changes: AgentConfigChanges } | { ok: false; message: string } {
  if (!input || typeof input !== 'object') return { ok: false, message: 'changes must be an object' };
  const o = input as { instructions?: unknown; model?: unknown; worker?: unknown };
  const changes: AgentConfigChanges = {};
  if (o.instructions !== undefined) {
    const text = cleanText(o.instructions);
    if (text === null || text.length < INSTRUCTIONS_MIN || text.length > INSTRUCTIONS_MAX) {
      return { ok: false, message: `Instructions must be plain text of ${INSTRUCTIONS_MIN} to ${INSTRUCTIONS_MAX} characters.` };
    }
    changes.instructions = text;
  }
  if (o.model !== undefined) {
    if (typeof o.model !== 'string' || !/^[\w.:/-]{1,80}$/.test(o.model)) return { ok: false, message: 'Pick a model from the list.' };
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
