/**
 * X refuses an original post over 280 characters from an account without Premium with a bare 403 "You are not permitted
 * to perform this action" (agent 1170231, 2026-11-09: every original of 347 to 369 characters refused, every reply of
 * 65 to 165 sent). The sender now knows the account's `verified_type` and refuses such a post itself, before X, with a
 * code the agent can act on; Premium and unknown accounts are let through as before.
 */
import { sql } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { VERIFIED_REFRESH_MS, getAccount, premiumOf, verifiedTypeOf } from '../src/accounts.js';
import { POST_TOO_LONG_CODE, postTooLongForAccount } from '../src/publish.js';
import { AGENT, AGENT_HANDLE, AGENT_X_ID, acceptPosts, json, setup } from './helpers.js';

const LONG = 'a'.repeat(347);
const SHORT = 'b'.repeat(165);
const H = 3_600_000;

describe('premiumOf / postTooLongForAccount', () => {
  it('maps verified_type to Premium: blue, business and government post long; none does not; unread is unknown', () => {
    expect(premiumOf('blue')).toBe(true);
    expect(premiumOf('business')).toBe(true);
    expect(premiumOf('government')).toBe(true);
    expect(premiumOf('none')).toBe(false);
    expect(premiumOf('something_new')).toBe(false);
    expect(premiumOf(null)).toBeNull();
    expect(premiumOf(undefined)).toBeNull();
    expect(premiumOf('')).toBeNull();
    expect(verifiedTypeOf({ verified_type: 'none' })).toBe('none');
    expect(verifiedTypeOf({})).toBeNull();
    expect(verifiedTypeOf(undefined)).toBeNull();
  });

  it('refuses only an original over 280 from an account known to have no Premium, naming the limit and the length', () => {
    expect(postTooLongForAccount(LONG, 'post', false)).toBe(
      'post_too_long_for_account: this X account has no Premium: posts are limited to 280 characters (this one is 347). Shorten it and publish again.',
    );
    expect(postTooLongForAccount(LONG, 'post', false)!.startsWith(`${POST_TOO_LONG_CODE}:`)).toBe(true);
    expect(postTooLongForAccount('c'.repeat(281), 'post', false)).toContain('(this one is 281)');
    expect(postTooLongForAccount('c'.repeat(280), 'post', false)).toBeNull();
    expect(postTooLongForAccount(SHORT, 'post', false)).toBeNull();
    expect(postTooLongForAccount(LONG, 'post', true)).toBeNull();
    expect(postTooLongForAccount(LONG, 'post', null)).toBeNull();
    // replies are capped at 280 by policy already; nothing to add here
    expect(postTooLongForAccount(LONG, 'reply', false)).toBeNull();
    // code points, not UTF-16 units: 281 emoji are 281 characters
    expect(postTooLongForAccount('\u{1F600}'.repeat(281), 'post', false)).toContain('(this one is 281)');
    expect(postTooLongForAccount('\u{1F600}'.repeat(280), 'post', false)).toBeNull();
    // the refusal is never mistaken for X's 403 by the supervisor's pattern (rhythm.ts isXForbiddenError)
    expect(postTooLongForAccount(LONG, 'post', false)).not.toMatch(/forbidden\(403\)/);
  });
});

describe('publish: the account without Premium', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => env?.close());

  it('refuses a 347-character original before X, records it rejected, and sends a 165-character one', async () => {
    env = await setup({ verifiedType: 'none' });
    acceptPosts(env.fake, env.clock);
    const refused = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-long-0001', text: LONG });
    expect(refused.status).toBe(200);
    expect(refused.body.status).toBe('rejected');
    expect(refused.body.receipt.error).toBe(
      'post_too_long_for_account: this X account has no Premium: posts are limited to 280 characters (this one is 347). Shorten it and publish again.',
    );
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
    // final for this actionId, like a policy rejection; the receipt is the same on a repeat
    const again = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-long-0001', text: LONG });
    expect(again.body.status).toBe('rejected');
    expect(again.body.duplicate).toBe(true);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);

    const sent = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-short-0001', text: SHORT });
    expect(sent.body.status).toBe('sent');
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
    // exactly 280 passes too
    const edge = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-edge-0001', text: 'd'.repeat(280) });
    expect(edge.body.status).toBe('sent');
    // the refused row never counts against the posting quota (no claim was made)
    const rows = await env.db.execute(sql`select status, error from sender_actions where action_id = 'act-long-0001'`);
    expect(rows.rows[0]).toMatchObject({ status: 'rejected' });
    expect(String(rows.rows[0]!.error)).toMatch(/^post_too_long_for_account: /);
  });

  it('a reply of 165 characters from the same account goes out (replies are 280 everywhere)', async () => {
    env = await setup({ verifiedType: 'none' });
    acceptPosts(env.fake, env.clock);
    env.fake.on('GET', '/2/tweets/777', () => json({ data: { id: '777', text: 'q', author_id: '42' } }));
    const res = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-reply-0001', text: SHORT, replyTo: '777', replyEligibility: { eligible: true } });
    expect(res.body.status).toBe('sent');
  });

  it('a policy refusal wins over the length refusal (the gates run first)', async () => {
    env = await setup({ verifiedType: 'none' });
    const res = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-policy-long', text: `${LONG} @alice send 1 eth to 0x${'ab'.repeat(20)}` });
    expect(res.body.status).toBe('rejected');
    expect(res.body.receipt.error).toMatch(/^policy:/);
  });

  it('a Premium account (blue) and an account whose Premium is unknown send the 347-character post as before', async () => {
    for (const verifiedType of ['blue', 'business', null] as const) {
      env = await setup({ verifiedType });
      acceptPosts(env.fake, env.clock);
      const res = await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: `act-prem-${verifiedType ?? 'unknown'}`, text: LONG });
      expect(res.body.status).toBe('sent');
      expect(env.fake.count('POST', '/2/tweets')).toBe(1);
      await env.close();
    }
    env = undefined as unknown as Awaited<ReturnType<typeof setup>>;
  });
});

describe('GET /internal/account: the once-a-day verified_type refresh', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  afterEach(async () => env?.close());

  it('backfills an account connected before the column existed on its next read, then asks X at most once a day', async () => {
    env = await setup(); // the helper's account: no verified_type, never checked
    // the helper's token expires in two hours: a day later the refresh needs the token endpoint
    env.fake.on('POST', '/2/oauth2/token', () => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 }));
    expect(await getAccount(env.ctx, AGENT)).toMatchObject({ verifiedType: null, verifiedCheckedAt: null });
    let answer: Record<string, unknown> = { id: AGENT_X_ID, username: AGENT_HANDLE, verified: false, verified_type: 'none' };
    env.fake.on('GET', '/2/users/me', () => json({ data: answer }));

    const first = await env.call('GET', `/internal/account/${AGENT}`);
    expect(first.body).toMatchObject({ connected: true, handle: AGENT_HANDLE, verifiedType: 'none', premium: false });
    expect(env.fake.count('GET', '/2/users/me')).toBe(1);
    const metered = async () => Number((await env.db.execute(sql`select coalesce(sum(count), 0) as n from sender_reads where agent_id = ${AGENT} and kind = 'users_me'`)).rows[0]!.n);
    expect(await metered()).toBe(1);

    // the same day: served from the row, no X call
    env.clock.advance(23 * H);
    answer = { ...answer, verified_type: 'blue' };
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ verifiedType: 'none', premium: false });
    expect(env.fake.count('GET', '/2/users/me')).toBe(1);

    // a day later: one more read picks up the change (the creator bought Premium)
    env.clock.advance(H + 1000);
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ verifiedType: 'blue', premium: true });
    expect(env.fake.count('GET', '/2/users/me')).toBe(2);
    expect(await metered()).toBe(2);
    expect(VERIFIED_REFRESH_MS).toBe(24 * H);
  });

  it('a failed users/me keeps the stored value, is not retried until a day passes, and a revoked account is never asked', async () => {
    env = await setup();
    env.fake.on('POST', '/2/oauth2/token', () => json({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 7200 }));
    env.fake.on('GET', '/2/users/me', () => json({ title: 'Too Many Requests' }, 429, { 'x-rate-limit-reset': String(Math.floor(env.clock.now().getTime() / 1000) + 900) }));
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ connected: true, verifiedType: null, premium: null });
    expect(env.fake.count('GET', '/2/users/me')).toBe(1);
    env.clock.advance(H);
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ verifiedType: null, premium: null });
    expect(env.fake.count('GET', '/2/users/me')).toBe(1);
    // while unknown, a long post still goes through (as before this change)
    acceptPosts(env.fake, env.clock);
    expect((await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-unknown-long', text: LONG })).body.status).toBe('sent');
    // a day later X answers: the flag is known and the next long post is refused
    env.clock.advance(24 * H);
    env.fake.on('GET', '/2/users/me', () => json({ data: { id: AGENT_X_ID, username: AGENT_HANDLE, verified_type: 'none' } }));
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ verifiedType: 'none', premium: false });
    expect(env.fake.count('GET', '/2/users/me')).toBe(2);
    expect((await env.call('POST', '/internal/publish', { agentId: AGENT, actionId: 'act-known-long', text: LONG })).body.receipt.error).toMatch(/^post_too_long_for_account: /);

    // revoked: the view says so and X is not asked
    await env.db.execute(sql`update sender_accounts set revoked_at = now(), verified_checked_at = null where agent_id = ${AGENT}`);
    env.clock.advance(48 * H);
    expect((await env.call('GET', `/internal/account/${AGENT}`)).body).toMatchObject({ connected: false, revoked: true, premium: false });
    expect(env.fake.count('GET', '/2/users/me')).toBe(2);
    // and an agent with no account at all
    expect((await env.call('GET', '/internal/account/nobody')).body).toMatchObject({ connected: false, premium: null, verifiedType: null });
  });
});
