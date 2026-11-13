/**
 * Server-side client for the scheduled posts of a coin's agent (docs/design/agent-tools-2.md sections 5 and 17.5): the
 * agent service's `GET /internal/agents/:id/scheduled` and `POST /internal/agents/:id/scheduled/:scheduledId/cancel`,
 * called by the console routes under `/api/agent/[kernel]/scheduled/`. Same HMAC scheme as `lib/server/supervisor.ts`.
 * The list is the creator's own: texts of posts that have not gone out, so it is only ever served inside a console session.
 */
import type { Address } from 'viem';
import { supervisorEnv } from './env';
import { signSenderRequest } from './sender';
import { SupervisorError, SupervisorUnavailable } from './supervisor';

if (typeof window !== 'undefined') throw new Error('lib/server/scheduled must not be imported in the browser');

/** `sch_` and 16 hex characters: the id of a scheduled post. */
export const SCHEDULED_ID_RE = /^sch_[0-9a-f]{16}$/;

export const SCHEDULED_STATUSES = ['waiting_review', 'waiting', 'sending'] as const;
export type ScheduledStatus = (typeof SCHEDULED_STATUSES)[number];

/** One post the agent scheduled that has not gone out yet. */
export interface ScheduledPost {
  id: string;
  /** ISO time it goes out. */
  sendAt: string;
  /** `waiting_review`: in the creator's review queue; `waiting`: goes out at its time; `sending`: on its way, no longer cancellable. */
  status: ScheduledStatus;
  /** The post, or the first part of a thread. */
  text: string;
  /** How many connected posts it is (1 = a single post). */
  parts: number;
  picture: boolean;
  /** The parts after the first, in order; empty for a single post. */
  thread: string[];
}

export interface ScheduledPosts {
  items: ScheduledPost[];
  /** How many more posts may wait. */
  mayQueue: number;
}

export const EMPTY_SCHEDULED: ScheduledPosts = { items: [], mayQueue: 0 };

const MAX_ITEMS = 50;
const MAX_TEXT = 4000;

export function sanitizeScheduled(raw: unknown): ScheduledPosts {
  const v = (raw ?? {}) as { items?: unknown; mayQueue?: unknown };
  const items: ScheduledPost[] = [];
  for (const it of Array.isArray(v.items) ? v.items.slice(0, MAX_ITEMS) : []) {
    const o = (it ?? {}) as Record<string, unknown>;
    const status = SCHEDULED_STATUSES.find((s) => s === o.status);
    if (typeof o.id !== 'string' || !SCHEDULED_ID_RE.test(o.id) || !status) continue;
    if (typeof o.sendAt !== 'string' || !Number.isFinite(Date.parse(o.sendAt)) || typeof o.text !== 'string' || o.text.length > MAX_TEXT) continue;
    const thread = Array.isArray(o.thread) ? o.thread.filter((t): t is string => typeof t === 'string' && t.length <= MAX_TEXT).slice(0, 8) : [];
    const parts = Number(o.parts);
    items.push({ id: o.id, sendAt: new Date(Date.parse(o.sendAt)).toISOString(), status, text: o.text, parts: Number.isInteger(parts) && parts >= 1 && parts <= 16 ? parts : 1 + thread.length, picture: o.picture === true, thread });
  }
  const mayQueue = Number(v.mayQueue);
  return { items, mayQueue: Number.isInteger(mayQueue) && mayQueue >= 0 ? mayQueue : 0 };
}

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Response> {
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
  return new SupervisorError(res.status, code, typeof body.message === 'string' ? body.message : code);
}

/** `GET /internal/agents/:id/scheduled`: the waiting posts, soonest first. An agent service from before this route, or an unknown agent, has none. */
export async function getScheduledPosts(agentId: string): Promise<ScheduledPosts> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/scheduled`);
  if (res.status === 404) return EMPTY_SCHEDULED;
  if (!res.ok) throw await errorOf(res);
  return sanitizeScheduled(await res.json());
}

/** `POST /internal/agents/:id/scheduled/:scheduledId/cancel {by}`: one waiting post is taken out; the list after it. */
export async function cancelScheduledPost(agentId: string, id: string, by: Address): Promise<ScheduledPosts> {
  const res = await call('POST', `/internal/agents/${encodeURIComponent(agentId)}/scheduled/${encodeURIComponent(id)}/cancel`, { by });
  if (!res.ok) throw await errorOf(res);
  return sanitizeScheduled(await res.json());
}
