import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccessToken } from '../src/accounts.js';
import { oauthStartSignature } from '../src/oauth.js';
import { SERVICE_KEY, json, setup } from './helpers.js';

describe('X OAuth 2.0 PKCE', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup({ connect: false });
  });
  afterEach(async () => env.close());

  const startUrl = (agentId: string, state: string, sig?: string) => {
    const ts = String(Math.floor(env.clock.now().getTime() / 1000));
    const s = sig ?? oauthStartSignature(SERVICE_KEY, agentId, state, ts);
    return `/oauth/start?agentId=${agentId}&state=${state}&ts=${ts}&sig=${s}`;
  };

  it('requires a signed start request', async () => {
    expect((await env.app.request('/oauth/start?agentId=agent-9&state=abc')).status).toBe(401);
    expect((await env.app.request(startUrl('agent-9', 'abc', '00'.repeat(32)))).status).toBe(401);
  });

  it('start -> callback stores encrypted tokens and the X identity', async () => {
    const start = await env.app.request(startUrl('agent-9', 'web-state-1'));
    expect(start.status).toBe(200);
    const { url } = (await start.json()) as { url: string };
    const authorize = new URL(url);
    expect(authorize.searchParams.get('scope')).toBe(
      'tweet.read tweet.write users.read offline.access',
    );
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    const state = authorize.searchParams.get('state')!;

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
    expect((await env.app.request(`/oauth/callback?code=the-code&state=${state}x`)).status).toBe(
      400,
    );

    const cb = await env.app.request(
      `/oauth/callback?code=the-code&state=${encodeURIComponent(state)}`,
    );
    expect(cb.status).toBe(200);
    expect(await cb.json()).toMatchObject({
      agentId: 'agent-9',
      status: 'connected',
      state: 'web-state-1',
      handle: 'agent_nine',
    });
    expect(verifier.length).toBeGreaterThan(40);

    const tok = await getAccessToken(env.ctx, 'agent-9');
    expect(tok.ok && tok.token).toBe('at-1');
    const acct = await env.call('GET', '/internal/account/agent-9');
    expect(acct.body).toMatchObject({ connected: true, handle: 'agent_nine', xUserId: '2000' });
  });

  it('marks the account revoked when refresh is refused', async () => {
    const start = await env.app.request(startUrl('agent-9', 's'));
    const state = new URL(((await start.json()) as { url: string }).url).searchParams.get('state')!;
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
    await env.app.request(`/oauth/callback?code=c&state=${encodeURIComponent(state)}`);
    const tok = await getAccessToken(env.ctx, 'agent-9'); // expires in 60s < refresh margin
    expect(tok).toMatchObject({ ok: false, code: 'revoked' });
    const acct = await env.call('GET', '/internal/account/agent-9');
    expect(acct.body).toMatchObject({ connected: false, revoked: true });
  });
});
