import { eq, sql } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import { decrypt, encrypt } from './crypto.js';
import { accounts, type AccountRow } from './db/schema.js';
import { refreshTokens, type TokenSet } from './oauth.js';
import { log } from './log.js';
import type { XResult } from './x-client.js';

/** Refresh when the access token has less than this left. */
const REFRESH_MARGIN_MS = 2 * 60 * 1000;

export const aadAccess = (agentId: string) => `access:${agentId}`;
export const aadRefresh = (agentId: string) => `refresh:${agentId}`;

export async function getAccount(
  ctx: SenderContext,
  agentId: string,
): Promise<AccountRow | undefined> {
  const rows = await ctx.db.select().from(accounts).where(eq(accounts.agentId, agentId)).limit(1);
  return rows[0];
}

/**
 * Stores the tokens for `agentId`. An existing binding to a DIFFERENT X account that is still connected
 * (not revoked) is only replaced when `replace` is set (a start signed with `reconnect=1`); otherwise
 * nothing is written and `conflict` is returned. The check is part of the upsert, so two concurrent
 * callbacks cannot both overwrite.
 */
export async function saveAccount(
  ctx: SenderContext,
  agentId: string,
  tokens: TokenSet,
  user: { id: string; username: string },
  opts: { replace?: boolean } = { replace: true },
): Promise<'saved' | 'conflict'> {
  const now = ctx.now();
  const values = {
    agentId,
    xUserId: user.id,
    xHandle: user.username,
    encryptedAccessToken: encrypt(tokens.accessToken, ctx.encryptionKey, aadAccess(agentId)),
    encryptedRefreshToken: tokens.refreshToken
      ? encrypt(tokens.refreshToken, ctx.encryptionKey, aadRefresh(agentId))
      : null,
    scopes: tokens.scopes,
    expiresAt: tokens.expiresAt,
    revokedAt: null,
    connectedAt: now,
    updatedAt: now,
  };
  const rows = await ctx.db
    .insert(accounts)
    .values(values)
    .onConflictDoUpdate({
      target: accounts.agentId,
      set: { ...values, agentId: undefined },
      ...(opts.replace
        ? {}
        : {
            setWhere: sql`${accounts.xUserId} = ${user.id} or ${accounts.revokedAt} is not null`,
          }),
    })
    .returning({ agentId: accounts.agentId });
  return rows.length > 0 ? 'saved' : 'conflict';
}

export type TokenLookup =
  | { ok: true; token: string; account: AccountRow }
  | { ok: false; code: 'not_connected' | 'revoked' | 'refresh_failed'; message: string };

const inflight = new Map<string, Promise<TokenLookup>>();

/**
 * Returns a usable access token, refreshing it if it expires within REFRESH_MARGIN_MS (or when
 * `force` is set after a 401). Refreshes are serialised per agent because X rotates refresh
 * tokens: two concurrent refreshes would invalidate each other.
 */
export async function getAccessToken(
  ctx: SenderContext,
  agentId: string,
  opts: { force?: boolean } = {},
): Promise<TokenLookup> {
  const running = inflight.get(agentId);
  if (running) return running;
  const account = await getAccount(ctx, agentId);
  if (!account)
    return { ok: false, code: 'not_connected', message: 'agent has no connected X account' };
  if (account.revokedAt) return { ok: false, code: 'revoked', message: 'X authorization revoked' };
  const fresh = account.expiresAt.getTime() - ctx.now().getTime() > REFRESH_MARGIN_MS;
  if (fresh && !opts.force) {
    return {
      ok: true,
      token: decrypt(account.encryptedAccessToken, ctx.encryptionKey, aadAccess(agentId)),
      account,
    };
  }
  const p = refresh(ctx, account).finally(() => inflight.delete(agentId));
  inflight.set(agentId, p);
  return p;
}

async function refresh(ctx: SenderContext, account: AccountRow): Promise<TokenLookup> {
  const { agentId } = account;
  if (!account.encryptedRefreshToken) {
    return { ok: false, code: 'refresh_failed', message: 'no refresh token stored' };
  }
  const refreshToken = decrypt(
    account.encryptedRefreshToken,
    ctx.encryptionKey,
    aadRefresh(agentId),
  );
  const res = await refreshTokens(ctx.oauth, refreshToken, ctx.now().getTime());
  if (!res.ok) {
    if (res.status === 400 || res.status === 401) {
      // invalid_grant / invalid_request: the creator revoked access or the refresh token was
      // rotated away. Other failures (404, 5xx, network) are treated as transient.
      await ctx.db
        .update(accounts)
        .set({ revokedAt: ctx.now(), updatedAt: ctx.now() })
        .where(eq(accounts.agentId, agentId));
      log.warn('x token refresh rejected; account marked revoked', { agentId, reason: res.code });
      return { ok: false, code: 'revoked', message: 'X refused to refresh the token' };
    }
    log.warn('x token refresh failed', { agentId, reason: res.code });
    return { ok: false, code: 'refresh_failed', message: res.message };
  }
  const t = res.tokens;
  const set = {
    encryptedAccessToken: encrypt(t.accessToken, ctx.encryptionKey, aadAccess(agentId)),
    encryptedRefreshToken: t.refreshToken
      ? encrypt(t.refreshToken, ctx.encryptionKey, aadRefresh(agentId))
      : account.encryptedRefreshToken,
    expiresAt: t.expiresAt,
    scopes: t.scopes,
    updatedAt: ctx.now(),
  };
  await ctx.db.update(accounts).set(set).where(eq(accounts.agentId, agentId));
  return { ok: true, token: t.accessToken, account: { ...account, ...set } };
}

/** Run a READ with the agent's token; on 401 refresh once and retry. */
export async function withToken<T>(
  ctx: SenderContext,
  agentId: string,
  fn: (token: string, account: AccountRow) => Promise<XResult<T>>,
): Promise<
  | { ok: true; data: T; account: AccountRow }
  | { ok: false; status: number; error: string; message: string; retryAt?: number }
> {
  const t = await getAccessToken(ctx, agentId);
  if (!t.ok)
    return {
      ok: false,
      status: t.code === 'refresh_failed' ? 503 : 409,
      error: t.code,
      message: t.message,
    };
  let res = await fn(t.token, t.account);
  if (!res.ok && res.error.status === 401) {
    const again = await getAccessToken(ctx, agentId, { force: true });
    if (!again.ok) return { ok: false, status: 409, error: again.code, message: again.message };
    res = await fn(again.token, again.account);
  }
  if (!res.ok) {
    const status = res.error.status === 429 ? 429 : res.error.status === 404 ? 404 : 502;
    return {
      ok: false,
      status,
      error: `x_${res.error.code}`,
      message: res.error.message,
      retryAt: res.error.retryAt,
    };
  }
  return { ok: true, data: res.data, account: t.account };
}
