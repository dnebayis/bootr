/**
 * Own agents, the browser's side (docs/design/byo-agent.md sections 3.2 and 13.9): what the approval page at
 * `/connect/<code>` needs to read a connection request, list the wallet's coins and send the signed approval. Nothing
 * here holds or sees a credential: the page approves, and the AI client collects its credential on its own.
 */
import {
  CLIENT_LABEL_MAX,
  CONNECT_COIN_STATEMENT,
  CONNECT_DRAFT_STATEMENT,
  OWN_ERRORS,
  USER_CODE_ALPHABET,
  USER_CODE_RE,
  type CoinRef,
  type ConnectApproveRequest,
  type ConnectApproveResponse,
  type ConnectCoinsResponse,
  type ConnectGrantView,
  type OwnErrorBody,
  type OwnErrorCode,
} from '@bootr/shared/own-agent';

/** Where the launch page keeps the draft of this browser's next launch: `{ draftId, at }`, `at` in milliseconds. */
export const LAUNCH_DRAFT_KEY = 'bootr.launchDraft';
/** A draft older than this is not offered: the launch it belonged to is over or forgotten. */
export const LAUNCH_DRAFT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isDraftUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

/** The draft id out of the stored value, or null when it is missing, malformed or older than a day. */
export function parseLaunchDraft(raw: string | null, now = Date.now()): string | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as { draftId?: unknown; at?: unknown };
    if (!isDraftUuid(v.draftId) || typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
    return now - v.at >= 0 && now - v.at < LAUNCH_DRAFT_MAX_AGE_MS ? v.draftId : null;
  } catch {
    return null;
  }
}

/** The open launch draft of this browser, if any. Storage can be blocked: that reads as no draft. */
export function readLaunchDraft(now = Date.now()): string | null {
  try {
    return typeof window === 'undefined' ? null : parseLaunchDraft(window.localStorage.getItem(LAUNCH_DRAFT_KEY), now);
  } catch {
    return null;
  }
}

/**
 * A code as a person types it, made canonical: letters only, upper case, a dash after the fourth. Null when it cannot
 * be a code (the alphabet has no vowels and no I or O, so most typos fail here and never reach the server).
 */
export function normalizeUserCode(input: string): string | null {
  const letters = input.toUpperCase().replace(/[^A-Z]/g, '');
  if (letters.length !== 8 || [...letters].some((c) => !USER_CODE_ALPHABET.includes(c))) return null;
  const code = `${letters.slice(0, 4)}-${letters.slice(4)}`;
  return USER_CODE_RE.test(code) ? code : null;
}

/** The coin the AI client named first (its symbol, its coin address or its treasury address), the rest in the order given. */
export function orderCoins(coins: CoinRef[], hint: string | null): CoinRef[] {
  const h = (hint ?? '').trim().replace(/^\$/, '').toLowerCase();
  if (!h) return coins;
  const matches = (c: CoinRef) => c.symbol.toLowerCase() === h || c.token.toLowerCase() === h || c.kernel.toLowerCase() === h;
  return [...coins.filter(matches), ...coins.filter((c) => !matches(c))];
}

/** The label a creator typed, cut to what the server keeps; undefined when empty so the client's own name is used. */
export function cleanLabel(input: string): string | undefined {
  const label = input.replace(/\s+/g, ' ').trim().slice(0, CLIENT_LABEL_MAX);
  return label || undefined;
}

export type ApprovalTarget = { kind: 'coin'; kernel: string; agentId: string } | { kind: 'draft'; draftId: string };

/** What a signed statement approves, and for which code; null when it is neither of the two connect statements. */
export function readConnectStatement(statement: string): { target: ApprovalTarget; userCode: string } | null {
  const coin = CONNECT_COIN_STATEMENT.exec(statement);
  if (coin) return { target: { kind: 'coin', agentId: coin[2]!, kernel: coin[3]! }, userCode: coin[4]! };
  const draft = CONNECT_DRAFT_STATEMENT.exec(statement);
  if (draft) return { target: { kind: 'draft', draftId: draft[1]! }, userCode: draft[2]! };
  return null;
}

export type OwnResult<T> = { ok: true; data: T } | { ok: false; error: OwnErrorBody };

function unavailable(): OwnErrorBody {
  return { error: 'supervisor_unavailable', message: OWN_ERRORS.supervisor_unavailable.message };
}

async function read<T>(res: Response): Promise<OwnResult<T>> {
  const body = (await res.json().catch(() => null)) as (T & { error?: unknown; message?: unknown }) | null;
  if (res.ok && body) return { ok: true, data: body };
  const code = body && typeof body.error === 'string' && Object.hasOwn(OWN_ERRORS, body.error) ? (body.error as OwnErrorCode) : null;
  if (!code) return { ok: false, error: unavailable() };
  const b = body as unknown as OwnErrorBody;
  // The words are this build's own, never the response's: an error is shown to a person about to sign.
  return { ok: false, error: { error: code, message: OWN_ERRORS[code].message, ...(typeof b.retryAt === 'string' ? { retryAt: b.retryAt } : {}) } };
}

async function ask<T>(input: string, init?: RequestInit): Promise<OwnResult<T>> {
  try {
    return await read<T>(await fetch(input, { cache: 'no-store', ...init }));
  } catch {
    return { ok: false, error: unavailable() };
  }
}

export function fetchGrant(code: string): Promise<OwnResult<ConnectGrantView>> {
  return ask(`/api/agent/connect/grant?code=${encodeURIComponent(code)}`);
}

export function fetchConnectCoins(creator: string): Promise<OwnResult<ConnectCoinsResponse>> {
  return ask(`/api/agent/connect/coins?creator=${encodeURIComponent(creator)}`);
}

export function approveConnection(body: ConnectApproveRequest): Promise<OwnResult<ConnectApproveResponse>> {
  return ask('/api/agent/connect/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

/** Whether own agents are offered on this deployment (`GET /api/platform`). Unreadable means no. */
export async function fetchOwnAgentEnabled(): Promise<boolean> {
  try {
    const res = await fetch('/api/platform', { cache: 'no-store' });
    return res.ok && ((await res.json()) as { ownAgent?: unknown }).ownAgent === true;
  } catch {
    return false;
  }
}
