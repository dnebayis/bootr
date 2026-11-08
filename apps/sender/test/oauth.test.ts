import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccessToken } from '../src/accounts.js';
import { signRequest } from '../src/auth.js';
import { oauthStartSignature } from '../src/oauth.js';
import { SERVICE_KEY, json, setup } from './helpers.js';

describe('X OAuth 2.0 PKCE', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup({ connect: false });
  });
  afterEach(async () => env.close());

  const startUrl = (
    agentId: string,
    state: string,
    opts: { sig?: string; reconnect?: boolean } = {},
  ) => {
    const ts = String(Math.floor(env.clock.now().getTime() / 1000));
    const s = opts.sig ?? oauthStartSignature(SERVICE_KEY, agentId, state, ts, opts.reconnect);
    return `/oauth/start?agentId=${agentId}&state=${state}&ts=${ts}&sig=${s}${opts.reconnect ? '&reconnect=1' : ''}`;
  };

  /** Runs /oauth/start like a browser: returns the X `state` and the binding cookie it was given. */
  const start = async (agentId: string, state: string, opts: { reconnect?: boolean } = {}) => {
    const res = await env.app.request(startUrl(agentId, state, opts));
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const setCookie = res.headers.get('set-cookie') ?? '';
    const cookie = setCookie.split(';')[0]!;
    return {
      authorize: new URL(url),
      state: new URL(url).searchParams.get('state')!,
      cookie,
      setCookie,
    };
  };

  const callback = (state: string, cookie: string | null, code = 'the-code') =>
    env.app.request(`/oauth/callback?code=${code}&state=${encodeURIComponent(state)}`, {
      headers: cookie ? { cookie } : {},
    });

  const xUser = (id: string, username: string) => {
    env.fake.on('POST', '/2/oauth2/token', () =>
      json({
        access_token: `at-${id}`,
        refresh_token: `rt-${id}`,
        expires_in: 7200,
        scope: 'tweet.read tweet.write users.read offline.access',
      }),
    );
    env.fake.on('GET', '/2/users/me', () => json({ data: { id, username } }));
  };

  it('requires a signed start request', async () => {
    expect((await env.app.request('/oauth/start?agentId=agent-9&state=abc')).status).toBe(401);
    expect(
      (await env.app.request(startUrl('agent-9', 'abc', { sig: '00'.repeat(32) }))).status,
    ).toBe(401);
    // A connect signature does not authorize a reconnect.
    const ts = String(Math.floor(env.clock.now().getTime() / 1000));
    const plain = oauthStartSignature(SERVICE_KEY, 'agent-9', 'abc', ts);
    const forged = `/oauth/start?agentId=agent-9&state=abc&ts=${ts}&sig=${plain}&reconnect=1`;
    expect((await env.app.request(forged)).status).toBe(401);
  });

  it('start -> callback stores encrypted tokens and the X identity', async () => {
    const s = await start('agent-9', 'web-state-1');
    expect(s.authorize.searchParams.get('scope')).toBe(
      'tweet.read tweet.write users.read offline.access media.write',
    );
    expect(s.authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(s.setCookie).toMatch(/HttpOnly/i);
    expect(s.setCookie).toMatch(/SameSite=Lax/i);
    expect(s.setCookie).toMatch(/Path=\/oauth\/callback/);
    expect(s.setCookie).toMatch(/Max-Age=600/);
    expect(s.setCookie).toMatch(/Secure/);

    let verifier = '';
    env.fake.on('POST', '/2/oauth2/token', ({ body, headers }) => {
      const form = new URLSearchParams(String(body));
      verifier = form.get('code_verifier') ?? '';
      expect(form.get('code')).toBe('the-code');
      expect(headers.get('authorization')).toMatch(/^Basic /);
      return json({
        access_token: 'at-1',
        refresh_token: 'rt-1',
        expires_in: 7200,
        scope: 'tweet.read tweet.write users.read offline.access',
      });
    });
    env.fake.on('GET', '/2/users/me', () => json({ data: { id: '2000', username: 'agent_nine' } }));

    // Tampered state is refused.
    expect((await callback(`${s.state}x`, s.cookie)).status).toBe(400);

    const cb = await callback(s.state, s.cookie);
    expect(cb.status).toBe(200);
    expect(await cb.json()).toMatchObject({
      agentId: 'agent-9',
      status: 'connected',
      state: 'web-state-1',
      handle: 'agent_nine',
    });
    expect(cb.headers.get('set-cookie')).toMatch(/Max-Age=0/); // binding cookie cleared
    expect(verifier.length).toBeGreaterThan(40);

    const tok = await getAccessToken(env.ctx, 'agent-9');
    expect(tok.ok && tok.token).toBe('at-1');
    const acct = await env.call('GET', '/internal/account/agent-9');
    expect(acct.body).toMatchObject({ connected: true, handle: 'agent_nine', xUserId: '2000' });
  });

  it("connect stores X's verified_type and the account view says whether the account has Premium", async () => {
    const connect = async (agentId: string, me: Record<string, unknown>) => {
      const s = await start(agentId, `st-${agentId}`);
      env.fake.on('POST', '/2/oauth2/token', () => json({ access_token: `at-${agentId}`, refresh_token: `rt-${agentId}`, expires_in: 7200 }));
      env.fake.on('GET', '/2/users/me', ({ url }) => {
        expect(url.searchParams.get('user.fields')).toBe('username,verified,verified_type');
        return json({ data: me });
      });
      expect((await callback(s.state, s.cookie)).status).toBe(200);
      return (await env.call('GET', `/internal/account/${agentId}`)).body;
    };
    // @BRIANBRAINAI's case: verified_type none, no Premium
    expect(await connect('agent-free', { id: '3001', username: 'brian', verified: false, verified_type: 'none' })).toMatchObject({ connected: true, verifiedType: 'none', premium: false });
    // the platform account and a business account post long; government counts as long-post capable too
    expect(await connect('agent-blue', { id: '3002', username: 'bootr', verified: true, verified_type: 'blue' })).toMatchObject({ verifiedType: 'blue', premium: true });
    expect(await connect('agent-biz', { id: '3003', username: 'biz', verified: true, verified_type: 'business' })).toMatchObject({ verifiedType: 'business', premium: true });
    expect(await connect('agent-gov', { id: '3004', username: 'gov', verified: true, verified_type: 'government' })).toMatchObject({ verifiedType: 'government', premium: true });
    // one users/me per connect (metered as users_me); the account view did not ask X again the same day
    expect(env.fake.count('GET', '/2/users/me')).toBe(4);
    const rows = (await env.db.execute(sql`select agent_id, verified_type, verified_checked_at from sender_accounts order by agent_id`)) as { rows: Record<string, unknown>[] };
    expect(rows.rows.map((r) => [r.agent_id, r.verified_type, r.verified_checked_at !== null])).toEqual([
      ['agent-biz', 'business', true],
      ['agent-blue', 'blue', true],
      ['agent-free', 'none', true],
      ['agent-gov', 'government', true],
    ]);
    // an answer without the field: Premium stays unknown (null), and so does the view
    const unknown = await connect('agent-old', { id: '3005', username: 'old' });
    expect(unknown).toMatchObject({ connected: true, verifiedType: null, premium: null });
  });

  it('refuses a callback from another browser (no or wrong binding cookie)', async () => {
    xUser('2000', 'agent_nine');
    const s = await start('agent-9', 'st');
    const other = await start('agent-9', 'st'); // a cookie from a different flow
    for (const cookie of [null, other.cookie, s.cookie.replace(/=.*/, '=forged')]) {
      const res = await callback(s.state, cookie);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({
        error: 'invalid_state',
        reason: 'browser_mismatch',
      });
    }
    expect(env.fake.count('POST', '/2/oauth2/token')).toBe(0);
    // The legitimate browser can still finish.
    expect((await callback(s.state, s.cookie)).status).toBe(200);
  });

  it('a state is single-use', async () => {
    xUser('2000', 'agent_nine');
    const s = await start('agent-9', 'st');
    expect((await callback(s.state, s.cookie)).status).toBe(200);
    const again = await callback(s.state, s.cookie, 'another-code');
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: 'invalid_state', reason: 'state_reused' });
    expect(env.fake.count('POST', '/2/oauth2/token')).toBe(1);
  });

  it('a denied consent also consumes the state', async () => {
    const s = await start('agent-9', 'st');
    const denied = await env.app.request(
      `/oauth/callback?error=access_denied&state=${encodeURIComponent(s.state)}`,
      { headers: { cookie: s.cookie } },
    );
    expect(await denied.json()).toMatchObject({ status: 'denied' });
    expect((await callback(s.state, s.cookie)).status).toBe(400);
  });

  it('never silently replaces a connected account; reconnect=1 may', async () => {
    xUser('2000', 'agent_nine');
    const first = await start('agent-9', 'st');
    expect((await callback(first.state, first.cookie)).status).toBe(200);

    // The same X account may refresh its binding without reconnect.
    const same = await start('agent-9', 'st');
    expect((await callback(same.state, same.cookie)).status).toBe(200);

    // A different X account through a plain connect is refused and nothing changes.
    xUser('6666', 'attacker');
    const hijack = await start('agent-9', 'st');
    const refused = await callback(hijack.state, hijack.cookie);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ status: 'error', reason: 'already_connected' });
    expect((await env.call('GET', '/internal/account/agent-9')).body).toMatchObject({
      xUserId: '2000',
      handle: 'agent_nine',
    });

    // A start signed with reconnect=1 replaces it.
    const re = await start('agent-9', 'st', { reconnect: true });
    expect((await callback(re.state, re.cookie)).status).toBe(200);
    expect((await env.call('GET', '/internal/account/agent-9')).body).toMatchObject({
      xUserId: '6666',
      handle: 'attacker',
    });
  });

  it('a revoked binding can be replaced without reconnect', async () => {
    xUser('2000', 'agent_nine');
    const first = await start('agent-9', 'st');
    await callback(first.state, first.cookie);
    await env.ctx.db.execute(
      sql`update sender_accounts set revoked_at = now() where agent_id = 'agent-9'`,
    );
    xUser('7777', 'fresh');
    const s = await start('agent-9', 'st');
    expect((await callback(s.state, s.cookie)).status).toBe(200);
    expect((await env.call('GET', '/internal/account/agent-9')).body).toMatchObject({
      xUserId: '7777',
      connected: true,
    });
  });

  it('the server-to-server variant returns a signed start link (browser still gets the cookie)', async () => {
    const path = '/oauth/start?agentId=agent-9&state=srv&reconnect=1';
    const auth = signRequest(
      SERVICE_KEY,
      'GET',
      path,
      '',
      Math.floor(env.clock.now().getTime() / 1000),
    );
    const res = await env.app.request(path, { headers: { authorization: auth } });
    expect(res.status).toBe(200);
    const { url } = (await res.json()) as { url: string };
    const link = new URL(url);
    expect(link.origin + link.pathname).toBe('https://sender.test/oauth/start');
    expect(link.searchParams.get('redirect')).toBe('1');
    expect(link.searchParams.get('reconnect')).toBe('1');
    expect(res.headers.get('set-cookie')).toBeNull();
    const browser = await env.app.request(link.pathname + link.search);
    expect(browser.status).toBe(302);
    expect(browser.headers.get('location')).toMatch(/^https:\/\/x\.test\/i\/oauth2\/authorize\?/);
    expect(browser.headers.get('set-cookie')).toMatch(/^bootr_xoauth_/);
  });

  it('marks the account revoked when refresh is refused', async () => {
    const s = await start('agent-9', 's');
    env.fake.on('POST', '/2/oauth2/token', ({ body }) =>
      String(body).includes('refresh_token=')
        ? json(
            {
              error: 'invalid_request',
              error_description: 'Value passed for the token was invalid.',
            },
            400,
          )
        : json({ access_token: 'at', refresh_token: 'rt', expires_in: 60 }),
    );
    env.fake.on('GET', '/2/users/me', () => json({ data: { id: '2000', username: 'agent_nine' } }));
    await callback(s.state, s.cookie, 'c');
    const tok = await getAccessToken(env.ctx, 'agent-9'); // expires in 60s < refresh margin
    expect(tok).toMatchObject({ ok: false, code: 'revoked' });
    const acct = await env.call('GET', '/internal/account/agent-9');
    expect(acct.body).toMatchObject({ connected: false, revoked: true });
  });
});
