import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getAccessToken, saveAccount } from '../src/accounts.js';
import { meterRead } from '../src/metering.js';
import { accounts, quotas, reads } from '../src/db/schema.js';
import { AGENT, setup } from './helpers.js';

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
const REAL = '10388';

describe('POST /internal/account/:agentId/rebind', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup({ connect: false });
    await saveAccount(
      env.ctx,
      DRAFT,
      {
        accessToken: 'draft-access',
        refreshToken: 'draft-refresh',
        expiresAt: new Date(env.clock.now().getTime() + 2 * 3600_000),
        scopes: 'tweet.read tweet.write users.read offline.access',
      },
      { id: '2000', username: 'agent_nine' },
    );
    await meterRead(env.ctx, DRAFT, 'users_me', 1);
  });
  afterEach(async () => env.close());

  it('moves the account to the real agent id, re-encrypting the tokens, and is idempotent', async () => {
    await env.call('POST', `/internal/quota/${DRAFT}`, { postsPerDay: 5 });
    await meterRead(env.ctx, REAL, 'users_me', 2);

    const res = await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: REAL });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ from: DRAFT, to: REAL, status: 'moved', handle: 'agent_nine' });

    // Tokens decrypt under the new id (the AAD binds the agent id).
    const tok = await getAccessToken(env.ctx, REAL);
    expect(tok.ok && tok.token).toBe('draft-access');
    expect(await getAccessToken(env.ctx, DRAFT)).toMatchObject({ ok: false, code: 'not_connected' });

    const acct = await env.call('GET', `/internal/account/${REAL}`);
    expect(acct.body).toMatchObject({ connected: true, handle: 'agent_nine', xUserId: '2000' });
    expect((await env.call('GET', `/internal/account/${DRAFT}`)).body).toMatchObject({ connected: false });

    // Quota moved, metering merged.
    expect((await env.call('GET', `/internal/quota/${REAL}`)).body).toMatchObject({ postsPerDay: 5 });
    expect(await env.db.select().from(quotas).where(eq(quotas.agentId, DRAFT))).toHaveLength(0);
    const r = await env.db.select().from(reads).where(eq(reads.agentId, REAL));
    expect(r).toHaveLength(1);
    expect(r[0]!.count).toBe(3);
    expect(await env.db.select().from(reads).where(eq(reads.agentId, DRAFT))).toHaveLength(0);

    // Retry after success: 200, nothing changes.
    const again = await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: REAL });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: 'already', handle: 'agent_nine' });
  });

  it('404 when neither id has an account, 409 when the target already has one', async () => {
    const none = await env.call('POST', '/internal/account/nope/rebind', { to: 'also-nope' });
    expect(none.status).toBe(404);
    expect(none.body.error).toBe('not_found');

    await saveAccount(
      env.ctx,
      AGENT,
      { accessToken: 'a', refreshToken: null, expiresAt: new Date(env.clock.now().getTime() + 3600_000), scopes: 's' },
      { id: '3000', username: 'other' },
    );
    const conflict = await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: AGENT });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('conflict');
    // Nothing moved.
    expect(await env.db.select().from(accounts).where(eq(accounts.agentId, DRAFT))).toHaveLength(1);
  });

  it('refuses accounts connected after connectedBefore', async () => {
    const cutoff = new Date(env.clock.now().getTime() - 1000).toISOString();
    const res = await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: REAL, connectedBefore: cutoff });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('connected_after_cutoff');
    expect(await env.db.select().from(accounts).where(eq(accounts.agentId, REAL))).toHaveLength(0);

    const ok = await env.call('POST', `/internal/account/${DRAFT}/rebind`, {
      to: REAL,
      connectedBefore: env.clock.now().toISOString(),
    });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('moved');
  });

  it('validates the request and requires HMAC', async () => {
    expect((await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: 'bad id!' })).status).toBe(400);
    expect((await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: DRAFT })).status).toBe(400);
    expect((await env.call('POST', `/internal/account/${DRAFT}/rebind`, { to: REAL, extra: 1 })).status).toBe(400);
    const unsigned = await env.app.request(`/internal/account/${DRAFT}/rebind`, {
      method: 'POST',
      body: JSON.stringify({ to: REAL }),
      headers: { 'content-type': 'application/json' },
    });
    expect(unsigned.status).toBe(401);
  });
});
