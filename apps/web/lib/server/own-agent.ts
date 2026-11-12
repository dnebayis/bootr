/**
 * Server side of the own-agent routes (docs/design/byo-agent.md sections 3.4 and 13.6): the public connect and run
 * routes under `/api/agent/connect/*` and `/api/agent/run/*` apply the flag, their limit and their body cap here, then
 * forward to the supervisor's `/internal/own/*` routes and relay the answer or the error unchanged. The supervisor is
 * the one that knows a credential; this file never stores one, never logs one and never puts one in a URL or an error.
 *
 * Same HMAC scheme as `lib/server/supervisor.ts` (apps/supervisor/src/hmac.ts). Every error a route answers is an
 * `OwnErrorBody` whose message is the one in `OWN_ERRORS`.
 */
import { CREDENTIAL_RE, DEVICE_POLL_INTERVAL_S, OWN_DEFAULTS, OWN_ERRORS, type OwnErrorBody, type OwnErrorCode } from '@bootr/shared/own-agent';
import { NextResponse, type NextRequest } from 'next/server';
import { ownAgentEnabled, supervisorEnv } from './env';
import { clientIp, RateLimiter } from './ipfs';
import { signSenderRequest } from './sender';

if (typeof window !== 'undefined') throw new Error('lib/server/own-agent must not be imported in the browser');

const NO_STORE = { 'Cache-Control': 'no-store' };

/** Requests a minute per credential, over all run routes together. */
export const RUN_PER_MINUTE = 120;
/** The same number per IP, counted before the credential is looked at, so guessed credentials are bounded too. */
export const RUN_PER_MINUTE_PER_IP = 120;
/** Token polls a minute per IP: a client polls every 5 seconds, so this leaves room for a few of them behind one address. */
export const TOKEN_PER_MINUTE_PER_IP = 60;
/** Body caps, in bytes. A picture of 5 MB is about 6.7 MB as base64; the upload route takes 8 MB. */
export const SMALL_BODY_BYTES = 16_384;
export const ACT_BODY_BYTES = 65_536;
export const UPLOAD_BODY_BYTES = 8 * 1024 * 1024;
/** A step can wait for X or the chain; a read should not. */
const MAX_DUE_KEYS = 10_000;
const QUICK_TIMEOUT_MS = 10_000;
const STEP_TIMEOUT_MS = 60_000;

/** `OWN_DUE_MIN_INTERVAL_MS` as the supervisor reads it (the same variable when it is set for both), else the default. */
export function dueIntervalMs(): number {
  const v = Number((process.env.OWN_DUE_MIN_INTERVAL_MS ?? '').trim());
  return Number.isFinite(v) && v >= 1000 ? Math.round(v) : OWN_DEFAULTS.OWN_DUE_MIN_INTERVAL_MS;
}

// One copy per server process, whichever route bundle asks first (the reason `server-state.ts` uses globalThis).
type Limits = { runByCredential: RateLimiter; runByIp: RateLimiter; dueNext: Map<string, number>; dueWindowMs: number; tokenByIp: RateLimiter; tokenByCode: RateLimiter };
const KEY = Symbol.for('bootr.web.own-agent-limits');
const g = globalThis as unknown as Record<symbol, Limits | undefined>;

function limits(): Limits {
  const dueWindowMs = dueIntervalMs();
  const existing = g[KEY];
  if (existing && existing.dueWindowMs === dueWindowMs) return existing;
  return (g[KEY] = {
    runByCredential: new RateLimiter(RUN_PER_MINUTE, 60_000),
    runByIp: new RateLimiter(RUN_PER_MINUTE_PER_IP, 60_000),
    dueNext: new Map(),
    dueWindowMs,
    tokenByIp: new RateLimiter(TOKEN_PER_MINUTE_PER_IP, 60_000),
    tokenByCode: new RateLimiter(1, DEVICE_POLL_INTERVAL_S * 1000),
  });
}

/** For tests: forget every count. */
export function resetOwnLimits(): void {
  delete g[KEY];
}

export type OwnErrorExtra = { retryAt?: string; field?: string; detail?: string; retryAfter?: number };

/** The one way a route answers an error: the code's status and message, a detail only where the contract allows one. */
export function ownError(code: OwnErrorCode, extra: OwnErrorExtra = {}): NextResponse {
  const { status, message } = OWN_ERRORS[code];
  const detailed = (code === 'invalid_request' || code === 'invalid_tool_call') && extra.detail;
  const body: OwnErrorBody = { error: code, message: detailed ? `${message} ${extra.detail}` : message, ...(extra.retryAt ? { retryAt: extra.retryAt } : {}), ...(extra.field ? { field: extra.field } : {}) };
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...(extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {}) } });
}

export function ownJson(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** `own_agent_disabled` while the flag is off, before anything else is read; null when the route may go on. */
export function ownDisabled(): NextResponse | null {
  return ownAgentEnabled() ? null : ownError('own_agent_disabled');
}

/** One hit on a limiter; the refusal names the moment trying again can work. `code` is `slow_down` for the token poll. */
export function ownLimited(limiter: RateLimiter, key: string, code: 'rate_limited' | 'slow_down' = 'rate_limited'): NextResponse | null {
  const retryAfter = limiter.hit(key);
  return retryAfter ? ownError(code, { retryAt: new Date(Date.now() + retryAfter * 1000).toISOString(), retryAfter }) : null;
}

export function ipOf(req: NextRequest): string {
  return clientIp(req.headers);
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * The JSON object of a request, read with a hard cap: the declared length is checked first and the stream is cut at
 * the cap whatever was declared. A body that is not a JSON object is `invalid_request`; an empty one is `{}`.
 */
export async function readOwnBody(req: NextRequest, maxBytes: number): Promise<Record<string, unknown> | NextResponse> {
  if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return ownError('payload_too_large');
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return ownError('payload_too_large');
      }
      chunks.push(value);
    }
  }
  if (size === 0) return {};
  const bytes = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return ownError('invalid_request', { detail: 'The body must be a JSON object.' });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ownError('invalid_request', { detail: 'The body must be a JSON object.' });
  return body as Record<string, unknown>;
}

const HMAC_REASONS = new Set(['missing_authorization', 'malformed_authorization', 'stale_timestamp', 'bad_signature']);

export type OwnAnswer = { ok: true; status: number; data: unknown } | { ok: false; response: NextResponse; code: OwnErrorCode };

/**
 * One signed call to the supervisor. A 2xx answer comes back as it is. An error comes back as the response to relay,
 * and only when it is an `OwnErrorBody` (a known code with its message); anything else, a supervisor that is not
 * configured, does not answer in time, answers 5xx, refuses this server's own signature or answers something that is
 * not JSON, is `supervisor_unavailable`. `Retry-After` follows `retryAt`.
 */
export async function askOwn(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = QUICK_TIMEOUT_MS): Promise<OwnAnswer> {
  const failed = (response: NextResponse, code: OwnErrorCode = 'supervisor_unavailable'): OwnAnswer => ({ ok: false, response, code });
  const { serviceKey, url } = supervisorEnv();
  if (!serviceKey || !url) return failed(ownError('supervisor_unavailable'));
  const raw = body === undefined ? '' : JSON.stringify(body);
  let res: Response;
  let answer: unknown;
  try {
    const headers: Record<string, string> = { authorization: await signSenderRequest(serviceKey, method, path, raw) };
    if (body !== undefined) headers['content-type'] = 'application/json';
    res = await fetch(`${url}${path}`, { method, headers, ...(body !== undefined ? { body: raw } : {}), cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) });
    answer = await res.json();
  } catch {
    // Neither the URL, the body nor the fetch error is logged: the body of a run call holds a credential.
    return failed(ownError('supervisor_unavailable'));
  }
  if (res.ok) return { ok: true, status: res.status, data: answer };
  const e = (answer ?? {}) as { error?: unknown; message?: unknown; reason?: unknown; retryAt?: unknown; field?: unknown };
  const known = typeof e.error === 'string' && Object.hasOwn(OWN_ERRORS, e.error) && typeof e.message === 'string';
  if (!known || res.status >= 500 || (typeof e.reason === 'string' && HMAC_REASONS.has(e.reason))) {
    if (typeof e.reason === 'string' && HMAC_REASONS.has(e.reason)) console.warn(`own agent: the supervisor refused this server's signature (${e.reason}); check SUPERVISOR_SERVICE_KEY and the clocks.`);
    return failed(ownError('supervisor_unavailable'));
  }
  const code = e.error as OwnErrorCode;
  const retryAt = typeof e.retryAt === 'string' && Number.isFinite(Date.parse(e.retryAt)) ? e.retryAt : undefined;
  const relayed: OwnErrorBody = { error: code, message: e.message as string, ...(retryAt ? { retryAt } : {}), ...(typeof e.field === 'string' ? { field: e.field.slice(0, 80) } : {}) };
  const retryAfter = retryAt ? Math.max(1, Math.ceil((Date.parse(retryAt) - Date.now()) / 1000)) : 0;
  return failed(NextResponse.json(relayed, { status: OWN_ERRORS[code].status, headers: { ...NO_STORE, ...(retryAfter ? { 'Retry-After': String(retryAfter) } : {}) } }), code);
}

/** `askOwn`, relayed: the answer or the error, unchanged. */
export async function forwardOwn(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = QUICK_TIMEOUT_MS): Promise<NextResponse> {
  const answer = await askOwn(method, path, body, timeoutMs);
  return answer.ok ? ownJson(answer.data, answer.status) : answer.response;
}

export type RunOp = 'status' | 'due' | 'turn' | 'act' | 'finish' | 'upload' | 'disconnect';

const RUN_BODY_BYTES: Record<RunOp, number> = { status: SMALL_BODY_BYTES, due: SMALL_BODY_BYTES, turn: SMALL_BODY_BYTES, act: ACT_BODY_BYTES, finish: ACT_BODY_BYTES, upload: UPLOAD_BODY_BYTES, disconnect: SMALL_BODY_BYTES };
const RUN_TIMEOUT_MS: Record<RunOp, number> = { status: QUICK_TIMEOUT_MS, due: STEP_TIMEOUT_MS, turn: STEP_TIMEOUT_MS, act: STEP_TIMEOUT_MS, finish: STEP_TIMEOUT_MS, upload: STEP_TIMEOUT_MS, disconnect: QUICK_TIMEOUT_MS };

/**
 * A run route, whole: the flag; no `Origin` (these routes are for a program holding a credential, never for a web
 * page, so a browser on any site, this one included, is refused); the per-IP count; the credential's shape; the
 * per-credential count (and for `due` the minimum interval); the body cap; then the supervisor, which is the one that
 * knows whether the credential is live. The credential travels in the signed body, never in the path.
 */
export async function runRoute(req: NextRequest, op: RunOp): Promise<NextResponse> {
  const off = ownDisabled();
  if (off) return off;
  if (req.headers.get('origin') !== null) return ownError('unauthorized');
  const l = limits();
  const byIp = ownLimited(l.runByIp, ipOf(req));
  if (byIp) return byIp;
  const credential = /^Bearer ([^\s]+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
  if (!credential || !CREDENTIAL_RE.test(credential)) return ownError('unauthorized');
  // Counted under a digest, so the limiter's keys are not credentials.
  const who = await sha256Hex(credential);
  const byCredential = ownLimited(l.runByCredential, who);
  if (byCredential) return byCredential;
  const body = await readOwnBody(req, RUN_BODY_BYTES[op]);
  if (body instanceof NextResponse) return body;
  if (op === 'due') {
    // The agent service does not hold a client to the interval between two looks: this route is the one that does.
    const now = Date.now();
    const next = l.dueNext.get(who) ?? 0;
    if (next > now) return ownError('rate_limited', { retryAt: new Date(next).toISOString(), retryAfter: Math.max(1, Math.ceil((next - now) / 1000)) });
    if (l.dueNext.size >= MAX_DUE_KEYS) {
      for (const [k, at] of l.dueNext) if (at <= now) l.dueNext.delete(k);
      if (l.dueNext.size >= MAX_DUE_KEYS) l.dueNext.clear();
    }
    l.dueNext.set(who, now + l.dueWindowMs);
  }
  // The header's credential last, so a `credential` field in the body cannot stand in for it.
  const answer = await askOwn('POST', `/internal/own/run/${op}`, { ...body, credential }, RUN_TIMEOUT_MS[op]);
  if (answer.ok) return ownJson(answer.data, answer.status);
  // A look that found the agent busy was not a look: the client is told to come back at `retryAt` and may.
  if (op === 'due' && answer.code === 'runtime_busy') l.dueNext.delete(who);
  return answer.response;
}

/** The token poll, per IP: counted before the body is read. */
export function tokenIpLimited(req: NextRequest): NextResponse | null {
  return ownLimited(limits().tokenByIp, ipOf(req));
}

/** The token poll, per device code: one call per polling interval (`slow_down`). Counted under a digest of the code. */
export async function tokenCodeLimited(deviceCode: string): Promise<NextResponse | null> {
  return ownLimited(limits().tokenByCode, await sha256Hex(deviceCode), 'slow_down');
}
