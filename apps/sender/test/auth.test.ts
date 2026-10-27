import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { signRequest, verifyRequest } from '../src/auth.js';
import { SERVICE_KEY, setup } from './helpers.js';

describe('HMAC auth', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const nowSec = () => Math.floor(env.clock.now().getTime() / 1000);

  it('accepts a correctly signed request', async () => {
    const res = await env.call('GET', '/internal/account/agent-1');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ connected: true, revoked: false, handle: 'bootr_agent' });
  });

  it('rejects missing, malformed and wrongly signed headers', async () => {
    const path = '/internal/account/agent-1';
    expect((await env.app.request(path)).status).toBe(401);
    expect((await env.app.request(path, { headers: { authorization: 'Bearer x' } })).status).toBe(
      401,
    );
    const wrongKey = signRequest('another-key', 'GET', path, '', nowSec());
    const res = await env.app.request(path, { headers: { authorization: wrongKey } });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ reason: 'bad_signature' });
  });

  it('rejects timestamps outside the ±5 minute window', async () => {
    const path = '/internal/account/agent-1';
    for (const skew of [-301, 301]) {
      const auth = signRequest(SERVICE_KEY, 'GET', path, '', nowSec() + skew);
      const res = await env.app.request(path, { headers: { authorization: auth } });
      expect(res.status).toBe(401);
      expect(await res.json()).toMatchObject({ reason: 'stale_timestamp' });
    }
    const ok = signRequest(SERVICE_KEY, 'GET', path, '', nowSec() - 299);
    expect((await env.app.request(path, { headers: { authorization: ok } })).status).toBe(200);
  });

  it('binds the signature to method, path, query and body', async () => {
    const body = JSON.stringify({ postsPerDay: 5 });
    const auth = signRequest(SERVICE_KEY, 'POST', '/internal/quota/agent-1', body, nowSec());
    const tampered = await env.app.request('/internal/quota/agent-1', {
      method: 'POST',
      headers: { authorization: auth },
      body: JSON.stringify({ postsPerDay: 500 }),
    });
    expect(tampered.status).toBe(401);
    const otherPath = await env.app.request('/internal/quota/agent-2', {
      method: 'POST',
      headers: { authorization: auth },
      body,
    });
    expect(otherPath.status).toBe(401);
    const q = signRequest(
      SERVICE_KEY,
      'GET',
      '/internal/metering/agent-1?month=2026-10',
      '',
      nowSec(),
    );
    const swapped = await env.app.request('/internal/metering/agent-1?month=2026-09', {
      headers: { authorization: q },
    });
    expect(swapped.status).toBe(401);
  });

  it('accepts a byte-identical retry (idempotent endpoints, no replay cache)', async () => {
    const path = '/internal/account/agent-1';
    const auth = signRequest(SERVICE_KEY, 'GET', path, '', nowSec());
    expect((await env.app.request(path, { headers: { authorization: auth } })).status).toBe(200);
    expect((await env.app.request(path, { headers: { authorization: auth } })).status).toBe(200);
  });

  it('verifyRequest is a pure function of the canonical string', () => {
    const header = signRequest(SERVICE_KEY, 'post', '/internal/publish', '{"a":1}', 1_700_000_000);
    expect(
      verifyRequest(SERVICE_KEY, header, 'POST', '/internal/publish', '{"a":1}', 1_700_000_100),
    ).toEqual({ ok: true });
    expect(
      verifyRequest(SERVICE_KEY, header, 'POST', '/internal/publish', '{"a":2}', 1_700_000_100),
    ).toMatchObject({ ok: false });
  });

  it('does not protect /health', async () => {
    expect((await env.app.request('/health')).status).toBe(200);
  });

  it('rejects oversized bodies and unsigned requests before buffering them', async () => {
    const big = JSON.stringify({ agentId: 'agent-1', text: 'x'.repeat(300 * 1024) });
    const auth = signRequest(SERVICE_KEY, 'POST', '/internal/publish', big, nowSec());
    const tooBig = await env.app.request('/internal/publish', {
      method: 'POST',
      headers: { authorization: auth, 'content-type': 'application/json' },
      body: big,
    });
    expect(tooBig.status).toBe(413);
    const unsigned = await env.app.request('/internal/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(unsigned.status).toBe(401);
    const publicBody = await env.app.request('/oauth/callback?state=x', {
      method: 'GET',
    });
    expect(publicBody.status).toBe(400);
  });
});
