import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import { z } from 'zod';
import { getAccount, revokeAccount, saveAccount } from './accounts.js';
import { hmacAuth, MAX_SKEW_SEC, type AuthEnv } from './auth.js';
import { nowSec, type SenderContext } from './context.js';
import { safeEqualHex, safeEqualStr } from './crypto.js';
import {
  accountReadSchema,
  mentionsSchema,
  readAccount,
  readMentions,
  readThread,
  resolveInbox,
  resolveSchema,
  threadSchema,
} from './inbox.js';
import { log } from './log.js';
import { getMetering, meterRead } from './metering.js';
import {
  BINDING_COOKIE_PATH,
  STATE_TTL_SEC,
  bindingCookieName,
  bindingHash,
  buildAuthorizeUrl,
  consumeState,
  exchangeCode,
  oauthStartSignature,
  openState,
} from './oauth.js';
import { publish, publishSchema } from './publish.js';
import {
  clientIp,
  DEFAULT_PUBLIC_API,
  parseLimit,
  PUBLIC_CACHE_CONTROL,
  publicPosts,
  RateLimiter,
} from './public-posts.js';
import { AGENT_ID_RE, rebindAccount, rebindSchema } from './rebind.js';
import { getQuota, setQuota } from './quota.js';
import { getAction, toReceipt } from './receipt.js';

export const PUBLIC_BODY_LIMIT = 8 * 1024;
export const INTERNAL_BODY_LIMIT = 256 * 1024;
/** `/internal/publish` may carry one picture as base64 (5 MB of image is about 6.7 MB of base64). */
export const PUBLISH_BODY_LIMIT = 8 * 1024 * 1024;

const quotaSchema = z
  .object({
    postsPerDay: z.number().int().min(0).max(2400).nullable().optional(),
    mentionReadIntervalSec: z.number().int().min(0).max(86_400).nullable().optional(),
  })
  .strict();

type Fail = { ok: false; status: number; error: string; message: string; retryAt?: number };

function fail(c: Context, f: Fail) {
  return c.json(
    {
      error: f.error,
      message: f.message,
      ...(f.retryAt ? { retryAt: new Date(f.retryAt).toISOString() } : {}),
    },
    f.status as 400,
  );
}

function parseBody<T extends z.ZodTypeAny>(
  c: Context<AuthEnv>,
  schema: T,
): { ok: true; data: z.infer<T> } | { ok: false; res: Response } {
  let json: unknown;
  try {
    json = JSON.parse(c.get('rawBody') || '{}');
  } catch {
    return { ok: false, res: c.json({ error: 'invalid_json' }, 400) };
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      res: c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400),
    };
  }
  return { ok: true, data: parsed.data };
}

export function createApp(ctx: SenderContext): Hono {
  const app = new Hono();

  app.get('/health', (c) => c.json({ ok: true, service: 'sender' }));

  // Body limits: the browser-facing OAuth routes take no body; internal requests are small JSON
  // (publish text is at most 25k chars) except a publish carrying a picture. Oversized bodies get
  // 413 before any parsing.
  const tooLarge = (c: Context) => c.json({ error: 'payload_too_large' }, 413);
  app.use('/oauth/*', bodyLimit({ maxSize: PUBLIC_BODY_LIMIT, onError: tooLarge }));
  const internalLimit = bodyLimit({ maxSize: INTERNAL_BODY_LIMIT, onError: tooLarge });
  const publishLimit = bodyLimit({ maxSize: PUBLISH_BODY_LIMIT, onError: tooLarge });
  app.use('/internal/*', (c, next) =>
    new URL(c.req.url).pathname === '/internal/publish' ? publishLimit(c, next) : internalLimit(c, next),
  );

  // ---------------- OAuth (browser-facing) ----------------

  /**
   * GET /oauth/start?agentId=&state=&ts=&sig=[&reconnect=1][&redirect=1]
   * `sig` = hex HMAC-SHA256(SENDER_SERVICE_KEY, "oauth-start\n"+agentId+"\n"+state+"\n"+ts[+"\nreconnect=1"]),
   * so only the Bootr web app (or another SENDER_SERVICE_KEY holder) can start a binding, and only a
   * start signed with `reconnect=1` may replace an agent's existing, different X account.
   *
   * The browser that opens this URL receives an HttpOnly, SameSite=Lax cookie holding a random secret
   * whose hash is inside the OAuth `state`; `/oauth/callback` only completes in that same browser.
   *
   * A server-side caller may instead send the internal `Authorization: HMAC` header: it receives
   * `{url}` pointing back at this endpoint (signed, `redirect=1`), so the user's browser still passes
   * through here and gets the binding cookie.
   */
  app.get('/oauth/start', async (c) => {
    const agentId = c.req.query('agentId') ?? '';
    const state = c.req.query('state') ?? '';
    const reconnectParam = c.req.query('reconnect');
    if (
      !/^[\w:.-]{1,128}$/.test(agentId) ||
      state.length > 512 ||
      (reconnectParam !== undefined && reconnectParam !== '1')
    ) {
      return c.json({ error: 'invalid_request', message: 'agentId and state are required' }, 400);
    }
    const reconnect = reconnectParam === '1';
    const now = nowSec(ctx);
    const ts = c.req.query('ts');
    const sig = c.req.query('sig');
    if (ts && sig && /^\d{1,12}$/.test(ts) && Math.abs(now - Number(ts)) <= MAX_SKEW_SEC) {
      const expected = oauthStartSignature(ctx.serviceKey, agentId, state, ts, reconnect);
      if (safeEqualHex(expected, sig.toLowerCase())) {
        const start = buildAuthorizeUrl(ctx.oauth, agentId, state, now, { reconnect });
        setCookie(c, bindingCookieName(start.nonce), start.bindingSecret, {
          path: BINDING_COOKIE_PATH,
          httpOnly: true,
          secure: ctx.oauth.redirectUri.startsWith('https:'),
          sameSite: 'Lax',
          maxAge: STATE_TTL_SEC,
        });
        c.header('Cache-Control', 'no-store');
        c.header('Referrer-Policy', 'no-referrer');
        if (c.req.query('redirect') === '1') return c.redirect(start.url, 302);
        return c.json({ url: start.url });
      }
    }
    if (c.req.header('authorization')) {
      let passed = false;
      await hmacAuth(ctx.serviceKey, () => now)(c as unknown as Context<AuthEnv>, async () => {
        passed = true;
      });
      if (passed) {
        const signedTs = String(now);
        const q = new URLSearchParams({
          agentId,
          state,
          ts: signedTs,
          sig: oauthStartSignature(ctx.serviceKey, agentId, state, signedTs, reconnect),
          ...(reconnect ? { reconnect: '1' } : {}),
          redirect: '1',
        });
        return c.json({ url: `${new URL('/oauth/start', ctx.oauth.redirectUri).toString()}?${q}` });
      }
    }
    return c.json({ error: 'unauthorized', reason: 'bad_start_signature' }, 401);
  });

  app.get('/oauth/callback', async (c) => {
    c.header('Cache-Control', 'no-store');
    c.header('Referrer-Policy', 'no-referrer');
    const opened = openState(ctx.oauth, c.req.query('state') ?? '', nowSec(ctx));
    if (!opened) return c.json({ error: 'invalid_state' }, 400);

    // 1. Same browser as /oauth/start (OAuth CSRF / consent-phishing protection).
    const cookieName = bindingCookieName(opened.nonce);
    const secret = getCookie(c, cookieName);
    if (!secret || !safeEqualStr(bindingHash(secret), opened.bindingHash)) {
      log.warn('oauth callback without the binding cookie', { agentId: opened.agentId });
      return c.json({ error: 'invalid_state', reason: 'browser_mismatch' }, 400);
    }
    deleteCookie(c, cookieName, { path: BINDING_COOKIE_PATH });

    // 2. Single use: record the nonce before anything else happens.
    if (!(await consumeState(ctx, opened))) {
      log.warn('oauth state reused', { agentId: opened.agentId });
      return c.json({ error: 'invalid_state', reason: 'state_reused' }, 400);
    }

    const finish = (
      status: 'connected' | 'denied' | 'error',
      extra: Record<string, string> = {},
    ) => {
      if (ctx.oauthReturnUrl) {
        const u = new URL(ctx.oauthReturnUrl);
        u.searchParams.set('agentId', opened.agentId);
        u.searchParams.set('status', status);
        u.searchParams.set('state', opened.clientState);
        for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v);
        return c.redirect(u.toString(), 302);
      }
      return c.json(
        { agentId: opened.agentId, status, state: opened.clientState, ...extra },
        status === 'connected' ? 200 : 400,
      );
    };
    if (c.req.query('error'))
      return finish('denied', { reason: (c.req.query('error') ?? '').slice(0, 64) });
    const code = c.req.query('code');
    if (!code || code.length > 2048) return finish('error', { reason: 'missing_code' });

    const tokens = await exchangeCode(ctx.oauth, code, opened.verifier, ctx.now().getTime());
    if (!tokens.ok) {
      log.warn('oauth code exchange failed', { agentId: opened.agentId, reason: tokens.code });
      return finish('error', { reason: 'token_exchange_failed' });
    }
    const me = await ctx.x.me(tokens.tokens.accessToken);
    if (!me.ok || !me.data.data?.id || !me.data.data.username) {
      log.warn('oauth users/me failed', { agentId: opened.agentId });
      return finish('error', { reason: 'users_me_failed' });
    }
    // 3. Never silently replace a connected binding to a different X account.
    const saved = await saveAccount(
      ctx,
      opened.agentId,
      tokens.tokens,
      { id: me.data.data.id, username: me.data.data.username },
      { replace: opened.reconnect },
    );
    await meterRead(ctx, opened.agentId, 'users_me', 1);
    if (saved === 'conflict') {
      log.warn('oauth callback refused: agent already bound to another X account', {
        agentId: opened.agentId,
      });
      return finish('error', { reason: 'already_connected' });
    }
    log.info('x account connected', {
      agentId: opened.agentId,
      handle: me.data.data.username,
      reconnect: opened.reconnect,
    });
    return finish('connected', { handle: me.data.data.username });
  });

  // ---------------- Public read API (no auth) ----------------

  const publicApi = ctx.publicApi ?? DEFAULT_PUBLIC_API;
  const limiter = new RateLimiter(publicApi.ratePerMinute, () => ctx.now().getTime());
  app.use('/public/*', async (c, next) => {
    const retryAfter = limiter.check(clientIp(c, publicApi.trustProxy));
    if (retryAfter > 0) {
      c.header('Retry-After', String(retryAfter));
      c.header('Cache-Control', 'no-store');
      return c.json({ error: 'rate_limited' }, 429);
    }
    await next();
  });

  /**
   * GET /public/posts/:agentId?limit=3 (1..10)
   * The agent's latest published posts and replies: {agentId, handle, items[{id, kind, text, postId,
   * url, createdAt}]}. 404 for an agent the sender has never seen. Cacheable for 60 s.
   */
  app.get('/public/posts/:agentId', async (c) => {
    const res = await publicPosts(ctx, c.req.param('agentId'), parseLimit(c.req.query('limit')));
    c.header('Cache-Control', PUBLIC_CACHE_CONTROL);
    if (!res) return c.json({ error: 'not_found' }, 404);
    return c.json(res);
  });

  // ---------------- Internal API (HMAC) ----------------

  const internal = new Hono<AuthEnv>();
  internal.use(
    '*',
    hmacAuth(ctx.serviceKey, () => nowSec(ctx)),
  );

  internal.post('/publish', async (c) => {
    const body = parseBody(c, publishSchema);
    if (!body.ok) return body.res;
    const res = await publish(ctx, body.data);
    return c.json(res.body, res.http);
  });

  internal.get('/receipt/:actionId', async (c) => {
    const row = await getAction(ctx, c.req.param('actionId'));
    if (!row) return c.json({ error: 'not_found' }, 404);
    return c.json({
      status: row.status,
      ...(row.providerPostId ? { providerPostId: row.providerPostId } : {}),
      receipt: toReceipt(ctx, row),
    });
  });

  internal.post('/read/mentions', async (c) => {
    const body = parseBody(c, mentionsSchema);
    if (!body.ok) return body.res;
    const res = await readMentions(ctx, body.data);
    if (!res.ok) return fail(c, res);
    return c.json({
      throttled: res.throttled,
      ...(res.nextReadAt ? { nextReadAt: res.nextReadAt } : {}),
      fetched: res.fetched,
      sinceId: res.sinceId,
      items: res.items,
    });
  });

  internal.post('/read/thread', async (c) => {
    const body = parseBody(c, threadSchema);
    if (!body.ok) return body.res;
    const res = await readThread(ctx, body.data);
    if (!res.ok) return fail(c, res);
    return c.json({ posts: res.posts, truncated: res.truncated });
  });

  internal.post('/read/account', async (c) => {
    const body = parseBody(c, accountReadSchema);
    if (!body.ok) return body.res;
    const res = await readAccount(ctx, body.data);
    if (!res.ok) return fail(c, res);
    return c.json({ user: res.user });
  });

  internal.post('/inbox/resolve', async (c) => {
    const body = parseBody(c, resolveSchema);
    if (!body.ok) return body.res;
    const res = await resolveInbox(ctx, body.data);
    if (!res.ok) return fail(c, res);
    return c.json({ item: res.item });
  });

  internal.get('/metering/:agentId', async (c) => {
    const month = c.req.query('month') ?? ctx.now().toISOString().slice(0, 7);
    const res = await getMetering(ctx, c.req.param('agentId'), month);
    if (!res) return c.json({ error: 'invalid_request', message: 'month must be YYYY-MM' }, 400);
    return c.json(res);
  });

  internal.get('/account/:agentId', async (c) => {
    const agentId = c.req.param('agentId');
    const a = await getAccount(ctx, agentId);
    return c.json({
      agentId,
      connected: !!a && !a.revokedAt,
      revoked: !!a?.revokedAt,
      handle: a?.xHandle ?? null,
      xUserId: a?.xUserId ?? null,
      scopes: a?.scopes ?? null,
      expiresAt: a?.expiresAt.toISOString() ?? null,
      connectedAt: a?.connectedAt.toISOString() ?? null,
    });
  });

  /**
   * POST /internal/account/:agentId/rebind {to, connectedBefore?}
   * Moves the account connected under a launch draft id to the real agent id (see src/rebind.ts).
   */
  internal.post('/account/:agentId/rebind', async (c) => {
    const from = c.req.param('agentId');
    if (!AGENT_ID_RE.test(from)) return c.json({ error: 'invalid_request' }, 400);
    const body = parseBody(c, rebindSchema);
    if (!body.ok) return body.res;
    const res = await rebindAccount(ctx, from, body.data.to, {
      ...(body.data.connectedBefore
        ? { connectedBefore: new Date(body.data.connectedBefore) }
        : {}),
    });
    if (!res.ok) return fail(c, res);
    return c.json({ from, to: res.agentId, status: res.status, handle: res.handle });
  });

  /**
   * POST /internal/account/:agentId/revoke
   * Retires the agent's X authorization (operator action): nothing is read or published for it again until
   * the creator reconnects. 404 when no account is bound.
   */
  internal.post('/account/:agentId/revoke', async (c) => {
    const agentId = c.req.param('agentId');
    if (!AGENT_ID_RE.test(agentId)) return c.json({ error: 'invalid_request' }, 400);
    const res = await revokeAccount(ctx, agentId);
    if (!res.found) return c.json({ error: 'not_found' }, 404);
    return c.json({ agentId, revoked: true, alreadyRevoked: res.alreadyRevoked });
  });

  internal.get('/quota/:agentId', async (c) => {
    const q = await getQuota(ctx, c.req.param('agentId'));
    return c.json(quotaView(q));
  });

  internal.post('/quota/:agentId', async (c) => {
    const body = parseBody(c, quotaSchema);
    if (!body.ok) return body.res;
    const q = await setQuota(ctx, c.req.param('agentId'), body.data);
    return c.json(quotaView(q));
  });

  app.route('/internal', internal);

  app.onError((err, c) => {
    log.error('unhandled error', { path: new URL(c.req.url).pathname, err: err.message });
    return c.json({ error: 'internal_error' }, 500);
  });

  return app;
}

function quotaView(q: Awaited<ReturnType<typeof getQuota>>) {
  return {
    agentId: q.agentId,
    postsPerDay: q.postsPerDay,
    mentionReadIntervalSec: q.mentionReadIntervalSec,
    lastMentionsReadAt: q.lastMentionsReadAt?.toISOString() ?? null,
  };
}
