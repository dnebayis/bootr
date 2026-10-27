import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getAccount, saveAccount } from './accounts.js';
import { hmacAuth, MAX_SKEW_SEC, type AuthEnv } from './auth.js';
import { nowSec, type SenderContext } from './context.js';
import { safeEqualHex } from './crypto.js';
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
import { buildAuthorizeUrl, exchangeCode, oauthStartSignature, openState } from './oauth.js';
import { publish, publishSchema } from './publish.js';
import { AGENT_ID_RE, rebindAccount, rebindSchema } from './rebind.js';
import { getQuota, setQuota } from './quota.js';
import { getAction, toReceipt } from './receipt.js';

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

  // ---------------- OAuth (browser-facing) ----------------

  /**
   * GET /oauth/start?agentId=&state=&ts=&sig=[&redirect=1]
   * `sig` = hex HMAC-SHA256(SENDER_SERVICE_KEY, "oauth-start\n"+agentId+"\n"+state+"\n"+ts), so only
   * the Bootr web app can bind an X account to an agent. Alternatively call it server-to-server
   * with the internal `Authorization: HMAC` header.
   */
  app.get('/oauth/start', async (c) => {
    const agentId = c.req.query('agentId') ?? '';
    const state = c.req.query('state') ?? '';
    if (!/^[\w:.-]{1,128}$/.test(agentId) || state.length > 512) {
      return c.json({ error: 'invalid_request', message: 'agentId and state are required' }, 400);
    }
    const now = nowSec(ctx);
    let authorized = false;
    const ts = c.req.query('ts');
    const sig = c.req.query('sig');
    if (ts && sig && /^\d{1,12}$/.test(ts) && Math.abs(now - Number(ts)) <= MAX_SKEW_SEC) {
      authorized = safeEqualHex(
        oauthStartSignature(ctx.serviceKey, agentId, state, ts),
        sig.toLowerCase(),
      );
    }
    if (!authorized && c.req.header('authorization')) {
      let passed = false;
      await hmacAuth(ctx.serviceKey, () => now)(c as unknown as Context<AuthEnv>, async () => {
        passed = true;
      });
      authorized = passed;
    }
    if (!authorized) return c.json({ error: 'unauthorized', reason: 'bad_start_signature' }, 401);
    const url = buildAuthorizeUrl(ctx.oauth, agentId, state, now);
    if (c.req.query('redirect') === '1') return c.redirect(url, 302);
    return c.json({ url });
  });

  app.get('/oauth/callback', async (c) => {
    const opened = openState(ctx.oauth, c.req.query('state') ?? '', nowSec(ctx));
    if (!opened) return c.json({ error: 'invalid_state' }, 400);
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
    if (!code) return finish('error', { reason: 'missing_code' });

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
    await saveAccount(ctx, opened.agentId, tokens.tokens, {
      id: me.data.data.id,
      username: me.data.data.username,
    });
    await meterRead(ctx, opened.agentId, 'users_me', 1);
    log.info('x account connected', { agentId: opened.agentId, handle: me.data.data.username });
    return finish('connected', { handle: me.data.data.username });
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
      ...(body.data.connectedBefore ? { connectedBefore: new Date(body.data.connectedBefore) } : {}),
    });
    if (!res.ok) return fail(c, res);
    return c.json({ from, to: res.agentId, status: res.status, handle: res.handle });
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
