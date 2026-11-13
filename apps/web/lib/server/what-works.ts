/**
 * Server-side client for the agent's note on what works (docs/design/agent-tools-2.md section 6.3): the agent service's
 * `GET /internal/agents/:id/what-works` and `POST .../what-works/clear`, called by the two console routes under
 * `/api/agent/[kernel]/what-works/`. Same HMAC scheme as `lib/server/supervisor.ts`; the errors are that file's, so
 * the routes relay them the way the rest of the console does.
 */
import type { Address } from 'viem';
import type { AgentWhatWorks, WhatWorksItem } from '@/lib/types';
import { supervisorEnv } from './env';
import { signSenderRequest } from './sender';
import { SupervisorError, SupervisorUnavailable } from './supervisor';

if (typeof window !== 'undefined') throw new Error('lib/server/what-works must not be imported in the browser');

/** The most a note may hold (`WHAT_WORKS_NOTE_MAX_CHARS` in packages/agent-core). */
export const WHAT_WORKS_MAX_CHARS = 600;
const MAX_ITEMS = 10;
const MAX_FACT_LINES = 16;
const FACT_LINE_MAX_CHARS = 300;

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

const iso = (v: unknown): string | null => (typeof v === 'string' && Number.isFinite(Date.parse(v)) ? v : null);

function item(raw: unknown): WhatWorksItem | null {
  const r = (raw ?? {}) as Record<string, unknown>;
  const at = iso(r.at);
  if (typeof r.id !== 'string' || r.id.length > 120 || typeof r.text !== 'string' || !at) return null;
  return {
    id: r.id,
    text: r.text.slice(0, WHAT_WORKS_MAX_CHARS),
    at,
    by: r.by === 'creator' ? 'creator' : 'agent',
    facts: (Array.isArray(r.facts) ? r.facts : []).filter((l): l is string => typeof l === 'string').slice(0, MAX_FACT_LINES).map((l) => l.slice(0, FACT_LINE_MAX_CHARS)),
  };
}

/** The note as the console renders it: plain strings, bounded lists, a `current` that names a listed version. */
export function sanitizeWhatWorks(raw: unknown): AgentWhatWorks {
  const o = (raw ?? {}) as Record<string, unknown>;
  const items = (Array.isArray(o.items) ? o.items : []).map(item).filter((i): i is WhatWorksItem => i !== null).slice(0, MAX_ITEMS);
  const maxChars = Number(o.maxChars);
  return {
    enabled: o.enabled !== false,
    maxChars: Number.isInteger(maxChars) && maxChars > 0 && maxChars <= WHAT_WORKS_MAX_CHARS ? maxChars : WHAT_WORKS_MAX_CHARS,
    current: typeof o.current === 'string' && items.some((i) => i.id === o.current) ? o.current : null,
    nextRevisionAt: iso(o.nextRevisionAt),
    items,
  };
}

export const EMPTY_WHAT_WORKS: AgentWhatWorks = { enabled: true, maxChars: WHAT_WORKS_MAX_CHARS, current: null, nextRevisionAt: null, items: [] };

/** `GET /internal/agents/:id/what-works`. An agent the service does not know yet has no note. */
export async function getWhatWorks(agentId: string): Promise<AgentWhatWorks> {
  const res = await call('GET', `/internal/agents/${encodeURIComponent(agentId)}/what-works`);
  if (res.status === 404) return EMPTY_WHAT_WORKS;
  if (!res.ok) throw await errorOf(res);
  return sanitizeWhatWorks(await res.json());
}

/** `POST /internal/agents/:id/what-works/clear {by}`: the list after the clear. */
export async function clearWhatWorks(agentId: string, by: Address): Promise<AgentWhatWorks> {
  const res = await call('POST', `/internal/agents/${encodeURIComponent(agentId)}/what-works/clear`, { by });
  if (!res.ok) throw await errorOf(res);
  return sanitizeWhatWorks(await res.json());
}
