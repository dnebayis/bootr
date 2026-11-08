/**
 * Server-side client for apps/supervisor's internal API (`/internal/agents/:id/config`, `/activity`, `/approvals`), used by the
 * coin page routes under `/api/agent/[kernel]/`. Same HMAC scheme as the sender (apps/supervisor/src/hmac.ts):
 *
 *   Authorization: HMAC <ts>:<hex>, hex = HMAC-SHA256(SUPERVISOR_SERVICE_KEY, ts + "\n" + METHOD + "\n" + path(+query) + "\n" + hex(sha256(body)))
 *
 * Web Crypto only (route handlers). Shapes are the contract in docs/design/agent-launch-v2.md.
 */
import { ALWAYS_ON_CAPABILITIES, CAPABILITY_KEYS, POSTS_PER_DAY, WORKER_BOUNDS, type CapabilityKey } from '@bootr/shared/workers';
import type { Address, Hex } from 'viem';
import { SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_DEFAULTS, SERVICES_PER_CALL_MAX_MICRO_USDC, type AgentActivity, type AgentActivityItem, type AgentApproval, type AgentApprovals, type AgentChat, type AgentChatMessage, type AgentNotification, type AgentNotifications, type AgentConfig, type AgentConfigChanges, type AgentFuel, type AgentImageStyle, type AgentServicesPolicy, type AgentWorkerConfig, type ApprovalDecision, type WorkerKind } from '@/lib/types';
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

async function call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown, timeoutMs = 10_000): Promise<Response> {
  const { serviceKey, url } = supervisorEnv();
  if (!serviceKey || !url) throw new SupervisorUnavailable('supervisor is not configured');
  const raw = body === undefined ? '' : JSON.stringify(body);
  const headers: Record<string, string> = { authorization: await signSenderRequest(serviceKey, method, path, raw) };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: raw } : {}), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
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
  const o = (raw ?? {}) as { days?: unknown; since?: unknown; firstAt?: unknown; byModel?: unknown };
  const days = Number(o.days);
  const byModel: AgentFuel['byModel'] = [];
  for (const it of Array.isArray(o.byModel) ? o.byModel : []) {
    const r = (it ?? {}) as Record<string, unknown>;
    const model = str(r.model, 80);
    const thoughts = Number(r.thoughts);
    const charged = typeof r.chargedMicroUsdc === 'string' ? r.chargedMicroUsdc : typeof r.chargedMicroUsdc === 'number' ? String(Math.round(r.chargedMicroUsdc)) : '';
    if (!model || !MODEL_ID_RE.test(model) || !Number.isInteger(thoughts) || thoughts < 0 || !/^\d{1,18}$/.test(charged)) continue;
    const paidFailures = Number(r.paidFailures);
    const directThoughts = Number(r.directThoughts);
    byModel.push({ model, thoughts, chargedMicroUsdc: charged, ...(Number.isInteger(paidFailures) && paidFailures > 0 ? { paidFailures } : {}), ...(Number.isInteger(directThoughts) && directThoughts > 0 ? { directThoughts } : {}) });
  }
  const firstAt = iso(o.firstAt);
  const thoughts = byModel.reduce((n, r) => n + r.thoughts, 0);
  const direct = byModel.reduce((n, r) => n + (r.directThoughts ?? 0), 0);
  const paidTo: AgentFuel['paidTo'] = thoughts === 0 ? null : direct > 0 ? 'blockrun' : 'bootr';
  return { days: Number.isInteger(days) && days > 0 ? days : 7, since: iso(o.since) ?? new Date(0).toISOString(), ...(firstAt ? { firstAt } : {}), byModel, paidTo };
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

/** A hostname or `*.example.com`, lower-cased; null for anything else. */
export function hostPattern(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const h = v.trim().toLowerCase();
  return h.length <= 253 && /^(\*\.)?[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*$/.test(h) ? h : null;
}

function hostList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.map(hostPattern).filter((h): h is string => h !== null).slice(0, 64) : [];
}

function microUsdc(raw: unknown, max: number, fallback: number): number {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

/** The services caps as the console shows them: defaults for anything missing or out of bounds. */
function servicesPolicy(raw: unknown): AgentServicesPolicy {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  return { perCallMicroUsdc: microUsdc(s.perCallMicroUsdc, SERVICES_PER_CALL_MAX_MICRO_USDC, SERVICES_DEFAULTS.perCallMicroUsdc), dailyMicroUsdc: microUsdc(s.dailyMicroUsdc, SERVICES_DAILY_MAX_MICRO_USDC, SERVICES_DEFAULTS.dailyMicroUsdc), allow: hostList(s.allow), deny: hostList(s.deny) };
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
    postsPerDay: Number.isInteger(o.postsPerDay) && (o.postsPerDay as number) >= 1 ? (o.postsPerDay as number) : POSTS_PER_DAY.default,
    requireApproval: o.requireApproval === true,
    routing: { decideModel: decideModelOf(o.routing) },
    imageModel: str(o.imageModel, 120) ?? '',
    imageStyle: imageStyle(o.imageStyle),
    services: servicesPolicy(o.services),
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

const NOTIFICATION_TONES: readonly AgentNotification['tone'][] = ['info', 'warning', 'danger'];

export function sanitizeNotification(raw: unknown): AgentNotification | null {
  const n = (raw ?? {}) as Record<string, unknown>;
  const id = str(n.id, 200);
  const event = str(n.event, 40);
  const title = str(n.title, 200);
  const body = str(n.body, 600);
  const firstAt = iso(n.firstAt);
  const lastSeenAt = iso(n.lastSeenAt);
  if (!id || !event || !title || !body || !firstAt || !lastSeenAt) return null;
  return {
    id,
    event,
    title,
    body,
    tone: NOTIFICATION_TONES.includes(n.tone as AgentNotification['tone']) ? (n.tone as AgentNotification['tone']) : 'info',
    state: n.state === 'resolved' ? 'resolved' : 'active',
    firstAt,
    lastSeenAt,
    resolvedAt: iso(n.resolvedAt),
  };
}

export function sanitizeNotifications(raw: unknown): AgentNotifications {
  const v = (raw ?? {}) as { items?: unknown; events?: unknown; telegram?: { available?: unknown; linked?: unknown; linkedAt?: unknown } };
  const items = (Array.isArray(v.items) ? v.items : []).map(sanitizeNotification).filter((i): i is AgentNotification => i !== null);
  const events = (Array.isArray(v.events) ? v.events : []).flatMap((e: { key?: unknown; label?: unknown; enabled?: unknown }) => {
    const key = str(e?.key, 40);
    const label = str(e?.label, 120);
    return key && label ? [{ key, label, enabled: e.enabled !== false }] : [];
  });
  return {
    items,
    active: items.filter((i) => i.state === 'active').length,
    events,
    telegram: { available: v.telegram?.available === true, linked: v.telegram?.linked === true, linkedAt: iso(v.telegram?.linkedAt) },
  };
}

const EMPTY_NOTIFICATIONS: AgentNotifications = { items: [], active: 0, events: [], telegram: { available: false, linked: false, linkedAt: null } };

/** `GET /internal/agents/:id/notifications`: the creator's inbox. Unknown agent = empty. */
export async function getAgentNotifications(agentId: string): Promise<AgentNotifications> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/notifications`);
  if (res.status === 404) return EMPTY_NOTIFICATIONS;
  if (!res.ok) throw await errorOf(res);
  return sanitizeNotifications(await res.json());
}

/** `GET /internal/agents/:id/notifications/count`: open items for the console's badge. Unknown agent = 0. */
export async function getAgentNotificationCount(agentId: string): Promise<number> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/notifications/count`);
  if (res.status === 404) return 0;
  if (!res.ok) throw await errorOf(res);
  const n = Number(((await res.json()) as { active?: unknown }).active);
  return Number.isInteger(n) && n >= 0 ? n : 0;
}

/** `PUT /internal/agents/:id/notifications/settings {by, optOut}`; the inbox after the change. */
export async function putNotificationSettings(agentId: string, body: { by: Address; optOut: string[] }): Promise<AgentNotifications> {
  const res = await call('PUT', `/internal/agents/${encodeURIComponent(agentId)}/notifications/settings`, body);
  if (!res.ok) throw await errorOf(res);
  return sanitizeNotifications(await res.json());
}

/** `POST /internal/agents/:id/notifications/telegram {by, action}`: a one-time deep link, or the chat removed. */
export async function postTelegramAction(agentId: string, body: { by: Address; action: 'link' | 'unlink' }): Promise<{ url: string | null }> {
  const res = await call('POST', `/internal/agents/${encodeURIComponent(agentId)}/notifications/telegram`, body);
  if (!res.ok) throw await errorOf(res);
  const url = str(((await res.json()) as { url?: unknown }).url, 200);
  return { url: url && url.startsWith('https://t.me/') ? url : null };
}

/** The longest message the chat takes; the supervisor checks it again (`CHAT_MAX_CHARS` in apps/supervisor/src/chat.ts). */
export const CHAT_MAX_CHARS = 1000;
/** A chat answer is one model call: as long as a thought may take (`INFERENCE_TIMEOUT_MS`) and a little more. */
const CHAT_SEND_TIMEOUT_MS = 170_000;

export function sanitizeChatMessage(raw: unknown): AgentChatMessage | null {
  const m = (raw ?? {}) as Record<string, unknown>;
  const id = str(m.id, 120);
  const at = iso(m.at);
  const text = str(m.text, 8000);
  if (!id || !at || text === null || (m.role !== 'creator' && m.role !== 'agent')) return null;
  const status = m.status === 'open' || m.status === 'failed' ? m.status : 'done';
  const charged = typeof m.chargedMicroUsdc === 'string' && /^\d{1,12}$/.test(m.chargedMicroUsdc) ? m.chargedMicroUsdc : null;
  return { id, role: m.role, text, status, chargedMicroUsdc: charged, remembered: m.remembered === true, at };
}

const count = (v: unknown): number => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);

export function sanitizeChat(raw: unknown): AgentChat {
  const v = (raw ?? {}) as { messages?: unknown; quote?: Record<string, unknown> };
  const q = v.quote ?? {};
  const limits = (q.limits ?? {}) as Record<string, unknown>;
  const approx = Number(q.approxMicroUsdc);
  return {
    messages: (Array.isArray(v.messages) ? v.messages : []).map(sanitizeChatMessage).filter((m): m is AgentChatMessage => m !== null),
    quote: {
      model: str(q.model, 80) ?? '',
      approxMicroUsdc: q.approxMicroUsdc !== null && Number.isFinite(approx) && approx > 0 ? approx : null,
      basis: q.basis === 'recent_messages' || q.basis === 'list_price' ? q.basis : null,
      maxMicroUsdc: count(q.maxMicroUsdc),
      refusal: str(q.refusal, 40),
      refusalText: str(q.refusalText, 300),
      limits: { perHour: count(limits.perHour), perDay: count(limits.perDay), usedHour: count(limits.usedHour), usedDay: count(limits.usedDay) },
      maxChars: count(q.maxChars) || CHAT_MAX_CHARS,
    },
  };
}

/** `GET /internal/agents/:id/chat`: the conversation and the quote. 404 becomes a SupervisorError the route relays. */
export async function getAgentChat(agentId: string): Promise<AgentChat> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/chat`);
  if (!res.ok) throw await errorOf(res);
  return sanitizeChat(await res.json());
}

/** `POST /internal/agents/:id/chat {by, text}`: waits for the answer, which is one paid model call. */
export async function sendAgentChat(agentId: string, body: { by: Address; text: string }): Promise<{ reply: AgentChatMessage | null; pending: boolean }> {
  const res = await call('POST', `/internal/agents/${encodeURIComponent(agentId)}/chat`, body, CHAT_SEND_TIMEOUT_MS);
  if (!res.ok) throw await errorOf(res);
  const json = (await res.json()) as { message?: unknown; pending?: unknown };
  return { reply: sanitizeChatMessage(json.message), pending: json.pending === true };
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
export function validateChanges(input: unknown): { ok: true; changes: AgentConfigChanges } | { ok: false; message: string; field: string } {
  if (!input || typeof input !== 'object') return { ok: false, field: 'changes', message: 'changes must be an object' };
  const o = input as { instructions?: unknown; model?: unknown; worker?: unknown; postsPerDay?: unknown; requireApproval?: unknown; imageModel?: unknown; imageStyle?: unknown; routing?: unknown; services?: unknown };
  const changes: AgentConfigChanges = {};
  if (o.services !== undefined) {
    if (!o.services || typeof o.services !== 'object' || Array.isArray(o.services)) return { ok: false, field: 'services', message: 'services must be an object' };
    const s = o.services as Partial<Record<keyof AgentServicesPolicy, unknown>>;
    const out: Partial<AgentServicesPolicy> = {};
    if (s.perCallMicroUsdc !== undefined) {
      const n = Number(s.perCallMicroUsdc);
      if (!Number.isInteger(n) || n < 1 || n > SERVICES_PER_CALL_MAX_MICRO_USDC) return { ok: false, field: 'services.perCallMicroUsdc', message: `The per-call cap is a whole number of micro-USDC from 1 to ${SERVICES_PER_CALL_MAX_MICRO_USDC} (${SERVICES_PER_CALL_MAX_MICRO_USDC / 1e6} USDC).` };
      out.perCallMicroUsdc = n;
    }
    if (s.dailyMicroUsdc !== undefined) {
      const n = Number(s.dailyMicroUsdc);
      if (!Number.isInteger(n) || n < 1 || n > SERVICES_DAILY_MAX_MICRO_USDC) return { ok: false, field: 'services.dailyMicroUsdc', message: `The daily cap is a whole number of micro-USDC from 1 to ${SERVICES_DAILY_MAX_MICRO_USDC} (${SERVICES_DAILY_MAX_MICRO_USDC / 1e6} USDC).` };
      out.dailyMicroUsdc = n;
    }
    for (const key of ['allow', 'deny'] as const) {
      if (s[key] === undefined) continue;
      if (!Array.isArray(s[key]) || (s[key] as unknown[]).length > 64) return { ok: false, field: `services.${key}`, message: `services.${key} is a list of at most 64 hosts.` };
      const hosts: string[] = [];
      for (const h of s[key] as unknown[]) {
        const p = hostPattern(h);
        if (!p) return { ok: false, field: `services.${key}`, message: 'Hosts are names like api.example.com, or *.example.com for a host and its subdomains.' };
        hosts.push(p);
      }
      out[key] = hosts;
    }
    if (!Object.keys(out).length) return { ok: false, field: 'services', message: 'Nothing to change.' };
    changes.services = out;
  }
  if (o.imageModel !== undefined) {
    if (typeof o.imageModel !== 'string' || !/^[\w.:/-]{1,80}$/.test(o.imageModel)) return { ok: false, field: 'imageModel', message: 'imageModel must be an image model id, such as google/gemini-3-pro-image.' };
    changes.imageModel = o.imageModel;
  }
  if (o.imageStyle !== undefined) {
    if (!o.imageStyle || typeof o.imageStyle !== 'object') return { ok: false, field: 'imageStyle', message: 'imageStyle must be an object' };
    const s = o.imageStyle as { reference?: unknown; notes?: unknown };
    const style: Partial<AgentImageStyle> = {};
    if (s.reference !== undefined) {
      if (s.reference !== null && httpsUrl(s.reference) === null) return { ok: false, field: 'imageStyle.reference', message: 'The reference image must be an https URL, or empty for none.' };
      style.reference = s.reference as string | null;
    }
    if (s.notes !== undefined) {
      const notes = cleanText(s.notes)?.replace(/\s+/g, ' ');
      if (notes == null || notes.length > IMAGE_NOTES_MAX) return { ok: false, field: 'imageStyle.notes', message: `Style notes are plain text of at most ${IMAGE_NOTES_MAX} characters.` };
      style.notes = notes;
    }
    if (Object.keys(style).length) changes.imageStyle = style;
  }
  if (o.requireApproval !== undefined) {
    if (typeof o.requireApproval !== 'boolean') return { ok: false, field: 'requireApproval', message: 'requireApproval must be true or false' };
    changes.requireApproval = o.requireApproval;
  }
  if (o.postsPerDay !== undefined) {
    const n = o.postsPerDay;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < POSTS_PER_DAY.min || n > POSTS_PER_DAY.max) {
      return { ok: false, field: 'postsPerDay', message: `Posts per day must be a whole number from ${POSTS_PER_DAY.min} to ${POSTS_PER_DAY.max}: original posts and replies together, over a rolling day.` };
    }
    changes.postsPerDay = n;
  }
  if (o.routing !== undefined) {
    if (!o.routing || typeof o.routing !== 'object' || Array.isArray(o.routing)) return { ok: false, field: 'routing', message: 'routing must be an object' };
    const m = (o.routing as { decideModel?: unknown }).decideModel;
    if (m !== null && (typeof m !== 'string' || !MODEL_ID_RE.test(m))) return { ok: false, field: 'routing.decideModel', message: 'routing.decideModel must be a model id from GET /api/models, or null to switch economy mode off.' };
    changes.routing = { decideModel: m };
  }
  if (o.instructions !== undefined) {
    const text = cleanText(o.instructions);
    if (text === null || text.length < INSTRUCTIONS_MIN || text.length > INSTRUCTIONS_MAX) {
      return { ok: false, field: 'instructions', message: `Instructions must be plain text of ${INSTRUCTIONS_MIN} to ${INSTRUCTIONS_MAX} characters.` };
    }
    changes.instructions = text;
  }
  if (o.model !== undefined) {
    if (typeof o.model !== 'string' || !MODEL_ID_RE.test(o.model)) return { ok: false, field: 'model', message: 'model must be a model id from GET /api/models.' };
    changes.model = o.model;
  }
  if (o.worker !== undefined) {
    if (!o.worker || typeof o.worker !== 'object') return { ok: false, field: 'worker', message: 'worker must be an object' };
    const w = o.worker as { capabilities?: unknown; postIntervalMs?: unknown; jobLines?: unknown };
    const worker: NonNullable<AgentConfigChanges['worker']> = {};
    if (w.capabilities !== undefined) {
      if (!w.capabilities || typeof w.capabilities !== 'object') return { ok: false, field: 'worker.capabilities', message: 'capabilities must be an object' };
      const caps = w.capabilities as Record<string, unknown>;
      const out: Partial<Record<CapabilityKey, boolean>> = {};
      for (const k of CAPABILITY_KEYS) {
        if (caps[k] === undefined) continue;
        if (typeof caps[k] !== 'boolean') return { ok: false, field: `worker.capabilities.${k}`, message: `${k} must be true or false` };
        if (ALWAYS_ON_CAPABILITIES.includes(k) && caps[k] === false) return { ok: false, field: `worker.capabilities.${k}`, message: `${k} is always on.` };
        out[k] = caps[k] as boolean;
      }
      worker.capabilities = out;
    }
    if (w.jobLines !== undefined) {
      if (!Array.isArray(w.jobLines) || w.jobLines.some((l) => typeof l !== 'string')) return { ok: false, field: 'worker.jobLines', message: 'jobLines must be an array of strings' };
      const lines = (w.jobLines as string[]).map((l) => l.trim()).filter(Boolean);
      if (lines.length > WORKER_BOUNDS.maxJobLines || lines.some((l) => l.length > WORKER_BOUNDS.maxJobLineChars)) return { ok: false, field: 'worker.jobLines', message: `At most ${WORKER_BOUNDS.maxJobLines} job lines of ${WORKER_BOUNDS.maxJobLineChars} characters.` };
      worker.jobLines = lines;
    }
    if (w.postIntervalMs !== undefined) {
      const n = Number(w.postIntervalMs);
      if (!Number.isInteger(n) || n < WORKER_BOUNDS.minPostIntervalMs || n > WORKER_BOUNDS.maxPostIntervalMs) {
        return { ok: false, field: 'worker.postIntervalMs', message: `Cadence must be between 30 minutes and 7 days: postIntervalMs from ${WORKER_BOUNDS.minPostIntervalMs} to ${WORKER_BOUNDS.maxPostIntervalMs}.` };
      }
      worker.postIntervalMs = n;
    }
    if (w.jobLines !== undefined) {
      if (!Array.isArray(w.jobLines) || w.jobLines.length > WORKER_BOUNDS.maxJobLines) return { ok: false, field: 'worker.jobLines', message: `At most ${WORKER_BOUNDS.maxJobLines} job lines.` };
      const lines: string[] = [];
      for (const l of w.jobLines) {
        const line = cleanText(l)?.replace(/\s+/g, ' ');
        if (line == null || line.length > WORKER_BOUNDS.maxJobLineChars) return { ok: false, field: 'worker.jobLines', message: `Each job line is plain text of at most ${WORKER_BOUNDS.maxJobLineChars} characters.` };
        if (line) lines.push(line);
      }
      worker.jobLines = lines;
    }
    if (Object.keys(worker).length) changes.worker = worker;
  }
  if (Object.keys(changes).length === 0) return { ok: false, field: 'changes', message: 'Nothing to change.' };
  return { ok: true, changes };
}
