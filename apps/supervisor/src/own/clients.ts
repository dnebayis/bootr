/**
 * Own agents (docs/design/byo-agent.md sections 3.2 and 3.3): the device-style approval that connects a creator's AI
 * client to a coin's agent, and the credential that client then holds.
 *
 * A client starts a grant and gets a device code (secret, for the token route alone) and a user code (shown to the
 * creator, worthless without the wallet's signature). The creator approves in the browser; the web verifies the
 * signature and hands the recovered address here, where it is checked against the coin's creator in `sv_agents`, the
 * row the supervisor wrote from the launch itself. The client then redeems the grant once for a credential scoped to
 * that one coin (or to a launch draft, adopted at registration when the launch's creator is the wallet that approved).
 *
 * What is stored: the SHA-256 of the device code and of the credential, never either value. What is logged: client
 * ids and agent ids, never a code or a credential. Every run call passes `verifyCredential`, which checks the hash,
 * the revocation, the expiry, the coin, and that the wallet that approved is still the coin's creator.
 */
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import {
  CLIENT_ID_PREFIX,
  CLIENT_LABEL_MAX,
  DEVICE_CODE_TTL_S,
  DEVICE_POLL_INTERVAL_S,
  OWN_ERRORS,
  USER_CODE_ALPHABET,
  USER_CODE_RE,
  type ClientView,
  type ClientsResponse,
  type CoinRef,
  type ConnectApproveResponse,
  type ConnectCoinsResponse,
  type ConnectGrantView,
  type ConnectStartResponse,
  type ConnectTarget,
  type ConnectTokenResponse,
  type DraftClientsResponse,
  type OwnErrorBody,
  type OwnErrorCode,
  type WaitingApprovalView,
} from '@bootr/shared/own-agent';
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import { getAddress, isAddress, isAddressEqual, type Address } from 'viem';
import type { AgentRow, SupervisorContext } from '../context.js';
import { actions, agentClients, agentGrants, agents } from '../db/schema.js';
import { DRAFT_ID_RE } from '../onboarding.js';
import { ownSetting } from './registry.js';

export type ClientRow = typeof agentClients.$inferSelect;
export type GrantRow = typeof agentGrants.$inferSelect;

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'config' | 'log'>;

/** A grant is forgotten a day after it was started (deleted whenever a new one is started). */
export const GRANT_RETENTION_MS = 24 * 60 * 60 * 1000;
/** `last_used_at` is written at most this often, so a busy client does not write a row on every call. */
export const LAST_USED_WRITE_MS = 60_000;
/** Requests waiting for an approval at one time, over all callers: beyond it a new one is `rate_limited`. */
export const MAX_PENDING_GRANTS = 500;
/** Lookups of a user code that found nothing, a minute, over all callers: beyond it no code is looked up until the minute ends. */
export const GRANT_MISSES_PER_MINUTE = 120;
export const DEFAULT_CLIENT_NAME = 'AI client';
export const COIN_HINT_MAX = 80;

// ---------------------------------------------------------------------------
// Errors: one shape for every own-agent route
// ---------------------------------------------------------------------------

/** A call that could not be taken (13.1 rule 7): the code, and what `OwnErrorBody` carries beside the fixed message. */
export class OwnError extends Error {
  constructor(
    readonly code: OwnErrorCode,
    readonly extra: { detail?: string; retryAt?: number; field?: string } = {},
  ) {
    super(code);
    this.name = 'OwnError';
  }
}

/** The HTTP status and body of an error; the text is `OWN_ERRORS[code].message`, with a detail only where the contract allows one. */
export function ownErrorResponse(err: OwnError): { status: number; body: OwnErrorBody } {
  const def = OWN_ERRORS[err.code];
  const detailed = err.code === 'invalid_request' || err.code === 'invalid_tool_call';
  return {
    status: def.status,
    body: {
      error: err.code,
      message: detailed && err.extra.detail ? `${def.message} ${err.extra.detail}` : def.message,
      ...(err.extra.retryAt !== undefined && Number.isFinite(err.extra.retryAt) ? { retryAt: new Date(err.extra.retryAt).toISOString() } : {}),
      ...(err.extra.field ? { field: err.extra.field } : {}),
    },
  };
}

const invalid = (field: string, detail: string) => new OwnError('invalid_request', { field, detail });

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

/** SHA-256 (hex) of a device code or a credential: the only form either is ever stored in. */
export function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length || !/^[0-9a-f]{64}$/.test(a) || !/^[0-9a-f]{64}$/.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

/** The SHA-256 of a credential as the web sends it (lower-case hex): the only form of a credential this service ever sees. */
export const CREDENTIAL_HASH_RE = /^[0-9a-f]{64}$/;

/** 32 random bytes as unpadded base64url (43 characters). */
function randomSecret(): string {
  return randomBytes(32).toString('base64url');
}

/** Two groups of four letters from `USER_CODE_ALPHABET`, each drawn with `crypto.randomInt`. */
export function newUserCode(): string {
  const letter = () => USER_CODE_ALPHABET[randomInt(0, USER_CODE_ALPHABET.length)]!;
  const group = () => letter() + letter() + letter() + letter();
  return `${group()}-${group()}`;
}

/** A name or a hint as it may be stored and shown: one line, no control, invisible or direction-changing characters, cut to `max`. */
export function cleanText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const text = raw
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return [...text].slice(0, max).join('').trim();
}

function sameAddress(a: string, b: string): boolean {
  return isAddress(a) && isAddress(b) && isAddressEqual(a as Address, b as Address);
}

// ---------------------------------------------------------------------------
// Views
// ---------------------------------------------------------------------------

export function coinRef(agent: Pick<AgentRow, 'agentId' | 'kernel' | 'token' | 'config'>): CoinRef {
  const token = (agent.config as { token?: { symbol?: unknown; name?: unknown } }).token;
  return { agentId: agent.agentId, kernel: agent.kernel, token: agent.token, symbol: typeof token?.symbol === 'string' ? token.symbol : '', name: typeof token?.name === 'string' ? token.name : '' };
}

export function clientView(row: ClientRow): ClientView {
  return { clientId: row.id, label: row.label, createdAt: row.createdAt.toISOString(), lastUsedAt: row.lastUsedAt ? row.lastUsedAt.toISOString() : null, expiresAt: row.expiresAt.toISOString() };
}

const live = (now: Date) => and(isNull(agentClients.revokedAt), gt(agentClients.expiresAt, now));

/** A row on the coin's public tape, of the kind `config_updated` is (activity.ts): that a client was connected or disconnected, and nothing else. */
async function noteOnTape(ctx: Ctx, agentId: string, field: 'clientConnected' | 'clientDisconnected', key: string): Promise<void> {
  const now = new Date(ctx.now());
  try {
    await ctx.db
      .insert(actions)
      .values({ actionId: `own-${field}-${key}`, agentId, cycleKey: `own:${key}`, action: { kind: 'config_updated', fields: [field] }, status: 'completed', result: null, receipt: null, createdAt: now, updatedAt: now })
      .onConflictDoNothing();
  } catch (err) {
    ctx.log.warn({ agentId, err }, 'own agent: tape row not written');
  }
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

/**
 * The one coin a client's `coin` names, or null: a kernel or token address of a coin, or a symbol (with or without `$`)
 * that exactly one coin has. Symbols are not unique on a launchpad, so one that two coins share names neither. A
 * revoked coin is no coin.
 */
async function resolveCoin(ctx: Ctx, hint: string | null): Promise<AgentRow | null> {
  const named = (hint ?? '').trim();
  if (!named) return null;
  const listed = ne(agents.status, 'revoked');
  let match;
  if (isAddress(named, { strict: false })) {
    const address = named.toLowerCase();
    match = or(sql`lower(${agents.kernel}) = ${address}`, sql`lower(${agents.token}) = ${address}`);
  } else {
    const symbol = named.replace(/^\$/, '');
    if (!/^[A-Za-z0-9_]{1,16}$/.test(symbol)) return null;
    match = sql`lower(${agents.config}->'token'->>'symbol') = ${symbol.toLowerCase()}`;
  }
  const rows = await ctx.db.select().from(agents).where(and(listed, match)).limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

/**
 * `POST /internal/own/connect/start`: a new grant. The device code is returned here once and kept nowhere. A `coin`
 * that names exactly one coin binds the grant to it (the row's `agent_id`, set while it is still pending): the
 * approval page shows that coin and no other, and `approveGrant` refuses any other target, so a request the client
 * made for one coin cannot be approved for another.
 */
export async function startGrant(ctx: Ctx, input: { clientName?: unknown; coin?: unknown; siteUrl?: unknown }): Promise<ConnectStartResponse> {
  let site: URL;
  try {
    site = new URL(typeof input.siteUrl === 'string' ? input.siteUrl : '');
  } catch {
    throw invalid('siteUrl', 'siteUrl must be the address of the site.');
  }
  if (site.protocol !== 'https:' && site.protocol !== 'http:') throw invalid('siteUrl', 'siteUrl must be an http or https address.');
  if (input.clientName !== undefined && typeof input.clientName !== 'string') throw invalid('clientName', 'clientName must be text.');
  if (input.coin !== undefined && typeof input.coin !== 'string') throw invalid('coin', 'coin must be text.');
  const now = ctx.now();
  await ctx.db.delete(agentGrants).where(lt(agentGrants.createdAt, new Date(now - GRANT_RETENTION_MS)));
  // With them go the clients approved for a launch draft a day or more ago whose launch never came: a draft is
  // offered for a day (the web's LAUNCH_DRAFT_MAX_AGE_MS), and such a row could otherwise wait for ever for a launch
  // that names its draft id. One whose launch exists is left for `adoptDraftClients`.
  await ctx.db
    .delete(agentClients)
    .where(and(isNull(agentClients.agentId), isNotNull(agentClients.draftId), lt(agentClients.createdAt, new Date(now - GRANT_RETENTION_MS)), sql`not exists (select 1 from ${agents} launched where launched.draft_id = ${agentClients}.draft_id)`));
  // Starting a request needs no credential and no signature, so what bounds the table is this count: the requests
  // still waiting for an approval, over every caller. One lasts ten minutes; the oldest says when a place frees up.
  const [waiting] = await ctx.db
    .select({ n: sql<number>`count(*)::int`, soonest: sql<Date | string | null>`min(${agentGrants.expiresAt})` })
    .from(agentGrants)
    .where(and(eq(agentGrants.status, 'pending'), gt(agentGrants.expiresAt, new Date(now))));
  if (Number(waiting?.n ?? 0) >= MAX_PENDING_GRANTS) {
    const soonest = waiting?.soonest ? new Date(waiting.soonest).getTime() : NaN;
    throw new OwnError('rate_limited', { retryAt: Number.isFinite(soonest) ? Math.max(soonest, now + 1000) : now + 60_000 });
  }
  const clientName = cleanText(input.clientName, CLIENT_LABEL_MAX) || DEFAULT_CLIENT_NAME;
  const coinHint = cleanText(input.coin, COIN_HINT_MAX) || null;
  const bound = await resolveCoin(ctx, coinHint);
  const deviceCode = randomSecret();
  const expiresAt = new Date(now + DEVICE_CODE_TTL_S * 1000);
  // A user code is unique among the grants of the last day; a clash (one in 20^8) draws again.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userCode = newUserCode();
    const rows = await ctx.db
      .insert(agentGrants)
      .values({ deviceHash: hashSecret(deviceCode), userCode, clientName, coinHint, status: 'pending', agentId: bound?.agentId ?? null, createdAt: new Date(now), expiresAt })
      .onConflictDoNothing()
      .returning({ userCode: agentGrants.userCode });
    if (rows.length === 0) continue;
    const base = site.origin;
    return { deviceCode, userCode, verificationUri: `${base}/connect`, verificationUriComplete: `${base}/connect/${userCode}`, expiresIn: DEVICE_CODE_TTL_S, interval: DEVICE_POLL_INTERVAL_S, ...(bound ? { coin: coinRef(bound) } : {}) };
  }
  throw new OwnError('supervisor_unavailable');
}

function grantStatus(grant: GrantRow, now: number): ConnectGrantView['status'] {
  if (grant.status === 'redeemed') return 'redeemed';
  if (grant.expiresAt.getTime() <= now) return 'expired';
  return grant.status;
}

/** The window of user-code lookups that found nothing, per database (one per process; a test world has its own). */
const grantMisses = new WeakMap<object, { count: number; reset: number }>();

/**
 * A grant by the code a person reads off their AI client. A code is eight letters of twenty and worth nothing without
 * a wallet's signature, but whoever guesses the code of somebody's waiting request can approve it for a coin of their
 * own, and that somebody's client is then connected to the guesser's coin. The per-address limits in front (the web's)
 * do not bound guessing from many addresses, so the misses are counted here, over every caller:
 * `GRANT_MISSES_PER_MINUTE` in a minute, and for the rest of that minute no code is looked up at all (`rate_limited`),
 * a real one included.
 */
async function grantByUserCode(ctx: Ctx, userCode: unknown): Promise<GrantRow> {
  if (typeof userCode !== 'string' || !USER_CODE_RE.test(userCode)) throw new OwnError('grant_not_found');
  const now = ctx.now();
  let window = grantMisses.get(ctx.db);
  if (!window || window.reset <= now) grantMisses.set(ctx.db, (window = { count: 0, reset: now + 60_000 }));
  if (window.count >= GRANT_MISSES_PER_MINUTE) throw new OwnError('rate_limited', { retryAt: window.reset });
  const grant = await ctx.db.query.agentGrants.findFirst({ where: eq(agentGrants.userCode, userCode) });
  if (!grant) {
    window.count += 1;
    if (window.count === GRANT_MISSES_PER_MINUTE) ctx.log.warn({ misses: window.count }, 'own agent: many lookups of connection codes that do not exist; code lookups are refused for the rest of this minute');
    throw new OwnError('grant_not_found');
  }
  return grant;
}

/** `GET /internal/own/connect/grant?code=`: what the approval page shows. Never the device code's hash, never who approved. */
export async function grantView(ctx: Ctx, userCode: unknown): Promise<ConnectGrantView> {
  const grant = await grantByUserCode(ctx, userCode);
  const status = grantStatus(grant, ctx.now());
  // The coin a waiting request is bound to (public facts of a coin). Once approved the page has nothing more to choose,
  // and what was approved for is not this route's to say.
  const bound = status === 'pending' && grant.agentId ? await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, grant.agentId) }) : null;
  return { userCode: grant.userCode, clientName: grant.clientName, coinHint: grant.coinHint, status, expiresAt: grant.expiresAt.toISOString(), coin: bound ? coinRef(bound) : null };
}

export type ApproveTarget = { kind: 'coin'; kernel: string; agentId: string } | { kind: 'draft'; draftId: string };

function parseTarget(raw: unknown): ApproveTarget {
  const t = (raw ?? {}) as { kind?: unknown; kernel?: unknown; agentId?: unknown; draftId?: unknown };
  if (t.kind === 'coin') {
    if (typeof t.kernel !== 'string' || !isAddress(t.kernel)) throw invalid('target.kernel', 'target.kernel must be an address.');
    if (typeof t.agentId !== 'string' || !/^\d{1,20}$/.test(t.agentId)) throw invalid('target.agentId', 'target.agentId must be the agent id.');
    return { kind: 'coin', kernel: t.kernel, agentId: t.agentId };
  }
  if (t.kind === 'draft') {
    if (typeof t.draftId !== 'string' || !DRAFT_ID_RE.test(t.draftId)) throw invalid('target.draftId', 'target.draftId must be a launch draft id.');
    return { kind: 'draft', draftId: t.draftId };
  }
  throw invalid('target', 'target.kind must be coin or draft.');
}

/**
 * Clients that count against `OWN_CLIENTS_PER_AGENT` for a target: the live ones, and the grants approved for it that
 * can still be redeemed. A coin's clients are all its creator's. A launch draft's are counted per approving wallet: the
 * draft id is no secret once the launch is on chain, and a stranger who approves clients for somebody's draft must not
 * be able to fill the places of the creator (the stranger's are revoked at registration anyway).
 */
async function claimsOn(ctx: Ctx, target: { agentId: string } | { draftId: string; creator: string }, now: Date): Promise<number> {
  const clientMatch = 'agentId' in target ? eq(agentClients.agentId, target.agentId) : and(eq(agentClients.draftId, target.draftId), isNull(agentClients.agentId), eq(agentClients.creator, target.creator));
  const grantMatch = 'agentId' in target ? eq(agentGrants.agentId, target.agentId) : and(eq(agentGrants.draftId, target.draftId), eq(agentGrants.creator, target.creator));
  const [clients] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(agentClients).where(and(clientMatch, live(now)));
  const [grants] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(agentGrants).where(and(grantMatch, eq(agentGrants.status, 'approved'), gt(agentGrants.expiresAt, now)));
  return Number(clients?.n ?? 0) + Number(grants?.n ?? 0);
}

/**
 * `POST /internal/own/connect/approve`. `creator` is the address the web recovered from the wallet's signature. For a
 * coin, it must be the coin's creator and the agent id must be the row's (the signed text named both); for a draft, the
 * wallet and the draft are stored and judged at registration (`adoptDraftClients`). A grant is approved once.
 */
export async function approveGrant(ctx: Ctx, input: { userCode?: unknown; creator?: unknown; label?: unknown; target?: unknown }): Promise<ConnectApproveResponse> {
  if (typeof input.userCode !== 'string' || !USER_CODE_RE.test(input.userCode)) throw invalid('userCode', 'userCode must be a code like BCDF-GHJK.');
  if (typeof input.creator !== 'string' || !isAddress(input.creator)) throw invalid('creator', 'creator must be an address.');
  if (input.label !== undefined && typeof input.label !== 'string') throw invalid('label', 'label must be text.');
  const target = parseTarget(input.target);
  const creator = getAddress(input.creator);
  const now = ctx.now();
  const grant = await grantByUserCode(ctx, input.userCode);
  if (grant.status !== 'pending') throw new OwnError('grant_used');
  if (grant.expiresAt.getTime() <= now) throw new OwnError('grant_expired');
  // A request the client made for one coin is approved for that coin or not at all: not for another coin of the same
  // wallet, and not for a launch draft. (A pending grant's `agent_id` is the binding `startGrant` wrote.)
  if (grant.agentId && (target.kind !== 'coin' || target.agentId !== grant.agentId)) throw new OwnError('wrong_coin');
  const label = cleanText(input.label, CLIENT_LABEL_MAX) || grant.clientName;
  const max = ownSetting(ctx, 'OWN_CLIENTS_PER_AGENT');

  let answer: ConnectTarget;
  let bind: { agentId: string | null; draftId: string | null };
  if (target.kind === 'coin') {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, target.agentId) });
    // The agent id and the kernel were both in the text the wallet signed: a mismatch means the text named no real coin.
    if (!agent || agent.status === 'revoked' || !sameAddress(agent.kernel, target.kernel)) throw new OwnError('unknown_coin');
    if (!sameAddress(agent.creator, creator)) throw new OwnError('not_creator');
    if ((await claimsOn(ctx, { agentId: agent.agentId }, new Date(now))) >= max) throw new OwnError('too_many_clients');
    answer = { kind: 'coin', coin: coinRef(agent) };
    bind = { agentId: agent.agentId, draftId: null };
  } else {
    if ((await claimsOn(ctx, { draftId: target.draftId, creator }, new Date(now))) >= max) throw new OwnError('too_many_clients');
    answer = { kind: 'draft', draftId: target.draftId };
    bind = { agentId: null, draftId: target.draftId };
  }
  // Still pending and not run out at the moment of the write: two approvals of one code cannot both take.
  const rows = await ctx.db
    .update(agentGrants)
    .set({ status: 'approved', ...bind, creator, label, approvedAt: new Date(now) })
    .where(and(eq(agentGrants.deviceHash, grant.deviceHash), eq(agentGrants.status, 'pending'), gt(agentGrants.expiresAt, new Date(now))))
    .returning({ deviceHash: agentGrants.deviceHash });
  if (rows.length === 0) throw new OwnError('grant_used');
  ctx.log.info({ target: target.kind, agentId: bind.agentId, draft: bind.draftId !== null }, 'own agent: a client was approved');
  return { ok: true, target: answer, label };
}

/** What the token route answers the web: the public answer without the credential, which never exists in this process. */
export type RedeemAnswer = { status: 'pending' } | Omit<Extract<ConnectTokenResponse, { status: 'approved' }>, 'credential'>;

/**
 * `POST /internal/own/connect/token`: `pending` until the creator approved, then the client, once. The web makes the
 * credential and sends only its SHA-256 (`credentialHash`); this service stores that hash and never sees the
 * credential itself. The grant is marked redeemed and the client row written in one transaction, so a crash between
 * the two cannot leave a grant that hands out a second credential or a credential with no row.
 */
export async function redeemGrant(ctx: Ctx, deviceCode: unknown, credentialHash: unknown): Promise<RedeemAnswer> {
  if (typeof credentialHash !== 'string' || !CREDENTIAL_HASH_RE.test(credentialHash)) throw invalid('credentialHash', 'credentialHash must be the SHA-256 of the new credential, as 64 hex characters.');
  if (typeof deviceCode !== 'string' || deviceCode.length < 20 || deviceCode.length > 200) throw new OwnError('grant_not_found');
  const deviceHash = hashSecret(deviceCode);
  const grant = await ctx.db.query.agentGrants.findFirst({ where: eq(agentGrants.deviceHash, deviceHash) });
  if (!grant || !sameHash(grant.deviceHash, deviceHash)) throw new OwnError('grant_not_found');
  const now = ctx.now();
  if (grant.status === 'redeemed') throw new OwnError('grant_used');
  if (grant.expiresAt.getTime() <= now) throw new OwnError('grant_expired');
  if (grant.status === 'pending') return { status: 'pending' };

  const clientId = CLIENT_ID_PREFIX + randomBytes(8).toString('hex');
  const expiresAt = new Date(now + ownSetting(ctx, 'OWN_CLIENT_TTL_DAYS') * 86_400_000);
  const label = grant.label ?? grant.clientName;
  const creator = grant.creator;
  if (!creator || (!grant.agentId && !grant.draftId)) throw new OwnError('grant_not_found');
  const taken = await ctx.db.transaction(async (tx) => {
    const flipped = await tx
      .update(agentGrants)
      .set({ status: 'redeemed' })
      .where(and(eq(agentGrants.deviceHash, deviceHash), eq(agentGrants.status, 'approved')))
      .returning({ deviceHash: agentGrants.deviceHash });
    if (flipped.length === 0) return false;
    await tx.insert(agentClients).values({ id: clientId, agentId: grant.agentId, draftId: grant.draftId, creator, tokenHash: credentialHash, label, createdAt: new Date(now), expiresAt });
    return true;
  });
  if (!taken) throw new OwnError('grant_used');

  let target: ConnectTarget;
  if (grant.agentId) {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, grant.agentId) });
    if (!agent) throw new OwnError('unknown_coin');
    target = { kind: 'coin', coin: coinRef(agent) };
    await noteOnTape(ctx, agent.agentId, 'clientConnected', clientId);
  } else {
    target = { kind: 'draft', draftId: grant.draftId! };
    // The launch may have been registered between the approval and now: the client is judged against it at once.
    await adoptLateDraft(ctx, grant.draftId!);
  }
  ctx.log.info({ clientId, agentId: grant.agentId, draft: grant.draftId !== null }, 'own agent: a client was connected');
  return { status: 'approved', clientId, label, target, expiresAt: expiresAt.toISOString() };
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export interface VerifiedClient {
  client: ClientRow;
  agent: AgentRow;
}

/**
 * The credential of a run call, checked here in the supervisor whatever the web checked before. The web sends the
 * SHA-256 of the credential, never the credential: this checks the hash's shape, looks the client up by it (compared
 * in constant time), that it was not revoked and has not run out, that its coin exists, and that the wallet that
 * approved it is still the coin's creator. Answers the first that fails, in the order of 13.6.
 */
export async function verifyCredential(ctx: Ctx, credentialHash: unknown): Promise<VerifiedClient> {
  const found = await findClient(ctx, credentialHash);
  if (!found.agent) throw new OwnError('coin_not_launched');
  return { client: found.client, agent: found.agent };
}

/**
 * The client a credential belongs to, with its coin when it has one. A client approved for a launch that has not
 * happened yet has none: it can run nothing (`verifyCredential` answers `coin_not_launched`), but it can give its
 * credential up (`run/disconnect`), so a creator who connected the wrong client can end it before the launch.
 */
export async function findClient(ctx: Ctx, credentialHash: unknown): Promise<{ client: ClientRow; agent: AgentRow | null }> {
  if (typeof credentialHash !== 'string' || !CREDENTIAL_HASH_RE.test(credentialHash)) throw new OwnError('unauthorized');
  const tokenHash = credentialHash;
  let client = await ctx.db.query.agentClients.findFirst({ where: eq(agentClients.tokenHash, tokenHash) });
  if (!client || !sameHash(client.tokenHash, tokenHash)) throw new OwnError('unauthorized');
  const now = ctx.now();
  if (client.revokedAt) throw new OwnError('credential_revoked');
  if (client.expiresAt.getTime() <= now) throw new OwnError('credential_expired');
  if (!client.agentId && client.draftId) {
    // Bound to a launch draft: registration adopts it (`adoptDraftClients`); a registration that ran before this
    // client existed is caught up with here, under the same creator check.
    await adoptLateDraft(ctx, client.draftId);
    client = await ctx.db.query.agentClients.findFirst({ where: eq(agentClients.id, client.id) });
    if (!client) throw new OwnError('unauthorized');
    if (client.revokedAt) throw new OwnError('credential_revoked');
  }
  if (!client.agentId) return { client, agent: null };
  const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, client.agentId) });
  if (!agent || agent.status === 'revoked') throw new OwnError('unauthorized');
  if (!sameAddress(agent.creator, client.creator)) throw new OwnError('unauthorized');
  if (!client.lastUsedAt || now - client.lastUsedAt.getTime() >= LAST_USED_WRITE_MS) {
    await ctx.db.update(agentClients).set({ lastUsedAt: new Date(now) }).where(eq(agentClients.id, client.id));
    client = { ...client, lastUsedAt: new Date(now) };
  }
  return { client, agent };
}

/** Live (not revoked, not run out) clients of the agent, oldest first. */
export async function liveClients(ctx: Ctx, agentId: string): Promise<ClientRow[]> {
  return ctx.db.select().from(agentClients).where(and(eq(agentClients.agentId, agentId), live(new Date(ctx.now())))).orderBy(agentClients.createdAt);
}

export async function countClients(ctx: Ctx, agentId: string): Promise<number> {
  const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(agentClients).where(and(eq(agentClients.agentId, agentId), live(new Date(ctx.now()))));
  return Number(row?.n ?? 0);
}

/**
 * The grants that can still become a client of this coin: approved for it, or for the launch draft it was launched
 * from by the wallet that launched it (`redeemGrant` binds such a client at once). With `pending`, also the ones a
 * client started for this coin by name that nobody has approved yet.
 */
function grantsToward(agent: Pick<AgentRow, 'agentId' | 'creator' | 'draftId'>, opts: { pending: boolean }) {
  const ofDraft = agent.draftId && DRAFT_ID_RE.test(agent.draftId) ? and(eq(agentGrants.draftId, agent.draftId), sql`lower(${agentGrants.creator}) = ${agent.creator.toLowerCase()}`) : undefined;
  const bound = ofDraft ? or(eq(agentGrants.agentId, agent.agentId), ofDraft) : eq(agentGrants.agentId, agent.agentId);
  return and(bound, opts.pending ? inArray(agentGrants.status, ['pending', 'approved']) : eq(agentGrants.status, 'approved'));
}

/** Approvals the creator signed whose client has not collected its credential yet, oldest first. */
async function waitingApprovals(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'creator' | 'draftId'>): Promise<WaitingApprovalView[]> {
  const rows = await ctx.db
    .select()
    .from(agentGrants)
    .where(and(grantsToward(agent, { pending: false }), gt(agentGrants.expiresAt, new Date(ctx.now()))))
    .orderBy(agentGrants.approvedAt);
  return rows.map((g) => ({ userCode: g.userCode, label: g.label ?? g.clientName, approvedAt: (g.approvedAt ?? g.createdAt).toISOString(), expiresAt: g.expiresAt.toISOString() }));
}

/**
 * `GET /internal/agents/:id/clients`: the live clients, and the approvals still waiting to be collected. An approval
 * is as good as a client for the ten minutes it lasts, so the creator sees it and can cancel it.
 */
export async function listClients(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'creator' | 'draftId'>): Promise<ClientsResponse> {
  return { clients: (await liveClients(ctx, agent.agentId)).map(clientView), max: ownSetting(ctx, 'OWN_CLIENTS_PER_AGENT'), waiting: await waitingApprovals(ctx, agent) };
}

/**
 * `POST /internal/agents/:id/clients/revoke`: one client, one approval not yet collected (`userCode`) or all of both,
 * by the coin's creator (`by` is the address the web took from the console's signed session). Returns the ids of the
 * clients that were revoked; the caller closes the turn one of them had open. Never refused because of the flag: a
 * creator can always disconnect a client.
 *
 * "All" means nothing in flight survives either: every grant that could still become a client of this coin is deleted
 * first (approved and not collected, or started for this coin by name and not yet approved), so a credential cannot
 * be collected a moment after the creator disconnected everything. The grants go before the clients: a redemption
 * that won the race has its client row in place by then and is revoked with the rest.
 */
export async function revokeClients(ctx: Ctx, agent: AgentRow, input: { by?: unknown; clientId?: unknown; userCode?: unknown; all?: unknown }): Promise<string[]> {
  if (typeof input.by !== 'string' || !isAddress(input.by)) throw invalid('by', '`by` must be the creator address.');
  if (!sameAddress(input.by, agent.creator)) throw new OwnError('not_creator');
  const now = new Date(ctx.now());
  if (input.all === true) {
    // A client of this coin's launch draft that registration did not bind yet would be bound on its next call: it is
    // bound (or, approved by another wallet, revoked) now, so it is among the clients this disconnects.
    await adoptDraftClients(ctx, agent);
    const voided = await ctx.db.delete(agentGrants).where(grantsToward(agent, { pending: true })).returning({ status: agentGrants.status });
    const rows = await ctx.db.update(agentClients).set({ revokedAt: now }).where(and(eq(agentClients.agentId, agent.agentId), isNull(agentClients.revokedAt))).returning({ id: agentClients.id });
    for (const row of rows) await noteOnTape(ctx, agent.agentId, 'clientDisconnected', row.id);
    if (rows.length || voided.length) ctx.log.info({ agentId: agent.agentId, clients: rows.map((r) => r.id), approvals: voided.filter((g) => g.status === 'approved').length, requests: voided.filter((g) => g.status === 'pending').length }, 'own agent: every client was disconnected by the creator');
    return rows.map((r) => r.id);
  }
  if (input.userCode !== undefined) {
    if (typeof input.userCode !== 'string' || !USER_CODE_RE.test(input.userCode)) throw invalid('userCode', 'userCode must be a code like BCDF-GHJK.');
    // Only an approval for this coin: a code of another coin's approval, or one already collected, is no approval here.
    const gone = await ctx.db.delete(agentGrants).where(and(eq(agentGrants.userCode, input.userCode), grantsToward(agent, { pending: false }))).returning({ userCode: agentGrants.userCode });
    if (gone.length === 0) throw new OwnError('client_not_found');
    ctx.log.info({ agentId: agent.agentId }, 'own agent: an approval not yet collected was cancelled by the creator');
    return [];
  }
  if (typeof input.clientId !== 'string' || !input.clientId.startsWith(CLIENT_ID_PREFIX)) throw invalid('clientId', 'Name a client, or all of them.');
  const rows = await ctx.db
    .update(agentClients)
    .set({ revokedAt: now })
    .where(and(eq(agentClients.id, input.clientId), eq(agentClients.agentId, agent.agentId), live(now)))
    .returning({ id: agentClients.id });
  if (rows.length === 0) throw new OwnError('client_not_found');
  await noteOnTape(ctx, agent.agentId, 'clientDisconnected', input.clientId);
  ctx.log.info({ agentId: agent.agentId, clientId: input.clientId }, 'own agent: a client was disconnected by the creator');
  return [input.clientId];
}

/** `run/disconnect`: the client gives up its own credential. */
export async function disconnectClient(ctx: Ctx, client: ClientRow): Promise<void> {
  await ctx.db.update(agentClients).set({ revokedAt: new Date(ctx.now()) }).where(and(eq(agentClients.id, client.id), isNull(agentClients.revokedAt)));
  if (client.agentId) await noteOnTape(ctx, client.agentId, 'clientDisconnected', client.id);
  ctx.log.info({ agentId: client.agentId, clientId: client.id }, 'own agent: a client disconnected itself');
}

// ---------------------------------------------------------------------------
// Launch drafts
// ---------------------------------------------------------------------------

/**
 * The clients approved for the agent's launch draft are bound to the agent when the wallet that approved them is the
 * launch's creator, and revoked otherwise: a draft id is no secret worth trusting (it travels in the launch
 * transaction), so a stranger who approved a client for somebody's draft, or launched with somebody's draft id, gets
 * nothing. Returns how many were bound.
 */
export async function adoptDraftClients(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'creator' | 'draftId'>): Promise<number> {
  if (!agent.draftId || !DRAFT_ID_RE.test(agent.draftId)) return 0;
  // Only the earliest launch that carries a draft id decides about the draft's clients: a later launch can copy an id
  // that is public on chain, and must not get to revoke what the creator approved for the real one.
  const first = await earliestLaunch(ctx, agent.draftId);
  if (first && first.agentId !== agent.agentId) return 0;
  const now = new Date(ctx.now());
  const waiting = await ctx.db.select().from(agentClients).where(and(eq(agentClients.draftId, agent.draftId), isNull(agentClients.agentId), isNull(agentClients.revokedAt)));
  let bound = 0;
  for (const client of waiting) {
    if (sameAddress(client.creator, agent.creator)) {
      await ctx.db.update(agentClients).set({ agentId: agent.agentId }).where(and(eq(agentClients.id, client.id), isNull(agentClients.agentId)));
      await noteOnTape(ctx, agent.agentId, 'clientConnected', client.id);
      bound += 1;
    } else {
      await ctx.db.update(agentClients).set({ revokedAt: now }).where(eq(agentClients.id, client.id));
      ctx.log.warn({ agentId: agent.agentId, clientId: client.id }, 'own agent: a client approved for this launch draft by another wallet was revoked');
    }
  }
  // Approvals still waiting to be redeemed for this draft by another wallet can no longer become a client of this coin either:
  // `redeemGrant` judges them the same way when they are redeemed.
  if (bound) ctx.log.info({ agentId: agent.agentId, bound }, 'own agent: the launch draft\'s clients were bound to the agent');
  return bound;
}

/**
 * The launch a draft id belongs to: the earliest one that carries it, as `adoptDraftAccount` (onboarding.ts) decides
 * for the X account. A launch with no block on record counts as earlier than any with one; the lower agent id breaks a tie.
 */
async function earliestLaunch(ctx: Ctx, draftId: string): Promise<AgentRow | null> {
  const rows = await ctx.db.select().from(agents).where(eq(agents.draftId, draftId));
  const before = (a: AgentRow, b: AgentRow) => {
    if (a.launchBlock == null || b.launchBlock == null) return a.launchBlock == null && (b.launchBlock != null || BigInt(a.agentId) < BigInt(b.agentId));
    return a.launchBlock < b.launchBlock || (a.launchBlock === b.launchBlock && BigInt(a.agentId) < BigInt(b.agentId));
  };
  return rows.reduce<AgentRow | null>((first, row) => (first === null || before(row, first) ? row : first), null);
}

async function adoptLateDraft(ctx: Ctx, draftId: string): Promise<void> {
  const agent = await earliestLaunch(ctx, draftId);
  if (agent) await adoptDraftClients(ctx, agent);
}

/**
 * `GET /internal/own/drafts/:draftId/clients`: what the launch wizard polls while the creator connects a client.
 * A draft id is a secret only until its launch: from then on it is on chain for anyone to read, so once a launch
 * carries it this answers nothing (the coin's clients are the console's to list, inside its signed session). With
 * `creator`, the wallet the wizard will launch from, only the clients that wallet approved are listed: another
 * wallet's would be revoked at registration, and the wizard must not call the launch connected because of one.
 */
export async function draftClients(ctx: Ctx, draftId: unknown, creator?: unknown): Promise<DraftClientsResponse> {
  if (typeof draftId !== 'string' || !DRAFT_ID_RE.test(draftId)) throw invalid('draftId', 'draftId must be a launch draft id.');
  if (creator !== undefined && (typeof creator !== 'string' || !isAddress(creator))) throw invalid('creator', 'creator must be an address.');
  const launched = await ctx.db.select({ agentId: agents.agentId }).from(agents).where(eq(agents.draftId, draftId)).limit(1);
  if (launched.length > 0) return { connected: false, clients: [] };
  const mine = typeof creator === 'string' ? sql`lower(${agentClients.creator}) = ${creator.toLowerCase()}` : undefined;
  const rows = await ctx.db
    .select()
    .from(agentClients)
    .where(and(eq(agentClients.draftId, draftId), isNull(agentClients.agentId), live(new Date(ctx.now())), mine))
    .orderBy(agentClients.createdAt);
  return { connected: rows.length > 0, clients: rows.map((r) => ({ clientId: r.id, label: r.label, createdAt: r.createdAt.toISOString() })) };
}

/** `GET /internal/own/connect/coins?creator=`: the coins that wallet launched, newest first, at most 50. */
export async function coinsOf(ctx: Ctx, creator: unknown): Promise<ConnectCoinsResponse> {
  if (typeof creator !== 'string' || !isAddress(creator)) throw invalid('creator', 'creator must be an address.');
  const rows = await ctx.db
    .select()
    .from(agents)
    .where(and(sql`lower(${agents.creator}) = ${creator.toLowerCase()}`, ne(agents.status, 'revoked')))
    .orderBy(desc(agents.createdAt))
    .limit(50);
  return { coins: rows.map(coinRef) };
}
