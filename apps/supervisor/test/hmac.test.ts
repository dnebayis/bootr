import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { signRequest, verifyRequest } from '../src/hmac.js';
import { makeWorld, SERVICE_KEY, seedAgent } from './helpers.js';

describe('HMAC auth (sender scheme)', () => {
  it('verifies ts\\nMETHOD\\npath\\nsha256(body) and rejects stale or forged headers', () => {
    const now = 1_700_000_000;
    const header = signRequest(SERVICE_KEY, 'POST', '/internal/agents/7/pause?x=1', '{"a":1}', now);
    expect(verifyRequest(SERVICE_KEY, header, 'POST', '/internal/agents/7/pause?x=1', '{"a":1}', now + 10)).toEqual({ ok: true });
    expect(verifyRequest(SERVICE_KEY, header, 'POST', '/internal/agents/7/pause', '{"a":1}', now).ok).toBe(false);
    expect(verifyRequest(SERVICE_KEY, header, 'POST', '/internal/agents/7/pause?x=1', '{"a":2}', now).ok).toBe(false);
    expect(verifyRequest(SERVICE_KEY, header, 'POST', '/internal/agents/7/pause?x=1', '{"a":1}', now + 600)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyRequest('other', header, 'POST', '/internal/agents/7/pause?x=1', '{"a":1}', now)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRequest(SERVICE_KEY, undefined, 'GET', '/x', '', now)).toEqual({ ok: false, reason: 'missing_authorization' });
  });

  it('protects /internal/* on the admin API and leaves /health open', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world);
      const nowSec = () => Math.floor(world.ctx.now() / 1000);
      const app = createApp(world.ctx, nowSec);
      expect((await app.request('/health')).status).toBe(200);
      expect((await app.request('/internal/agents')).status).toBe(401);
      const ok = await app.request('/internal/agents', { headers: { authorization: signRequest(SERVICE_KEY, 'GET', '/internal/agents', '', nowSec()) } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { agents: { agentId: string; runtime: { status: string } }[] };
      expect(body.agents[0]!.agentId).toBe('7');
      const pause = await app.request('/internal/agents/7/pause', { method: 'POST', headers: { authorization: signRequest(SERVICE_KEY, 'POST', '/internal/agents/7/pause', '', nowSec()) } });
      expect(pause.status).toBe(200);
      const detail = await app.request('/internal/agents/7', { headers: { authorization: signRequest(SERVICE_KEY, 'GET', '/internal/agents/7', '', nowSec()) } });
      expect(((await detail.json()) as { runtime: { status: string } }).runtime.status).toBe('paused');
      const resume = await app.request('/internal/agents/7/resume', { method: 'POST', headers: { authorization: signRequest(SERVICE_KEY, 'POST', '/internal/agents/7/resume', '', nowSec()) } });
      expect(((await resume.json()) as { status: string }).status).toBe('waiting');
    } finally {
      await world.close();
    }
  });
});
