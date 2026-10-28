import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { signRequest, verifyRequest } from '../src/hmac.js';
import { mockAdminSigner, makeWorld, SERVICE_KEY, SUPERVISOR_KEY, seedAgent } from './helpers.js';
import { runtimes } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';

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
      // the sender key is NOT a supervisor admin key (M-03)
      expect((await app.request('/internal/agents', { headers: { authorization: signRequest(SERVICE_KEY, 'GET', '/internal/agents', '', nowSec()) } })).status).toBe(401);
      const ok = await app.request('/internal/agents', { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', '/internal/agents', '', nowSec()) } });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { agents: { agentId: string; runtime: { status: string } }[] };
      expect(body.agents[0]!.agentId).toBe('7');
      const pause = await app.request('/internal/agents/7/pause', { method: 'POST', headers: { authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/7/pause', '', nowSec()) } });
      expect(pause.status).toBe(200);
      const detail = await app.request('/internal/agents/7', { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', '/internal/agents/7', '', nowSec()) } });
      expect(((await detail.json()) as { runtime: { status: string } }).runtime.status).toBe('paused');
      const resume = await app.request('/internal/agents/7/resume', { method: 'POST', headers: { authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/7/resume', '', nowSec()) } });
      expect(((await resume.json()) as { status: string }).status).toBe('waiting');
    } finally {
      await world.close();
    }
  });

  it('POST /internal/agents/panic-revoke bumps every kernel nonce in one batch, uninstalls each permission and pauses the fleet', async () => {
    const world = await makeWorld();
    try {
      const admin = mockAdminSigner();
      world.ctx.adminSigner = admin.signer;
      const agent = await seedAgent(world);
      const policy = { kernel: agent.kernel, token: agent.token, feeLocker: world.ctx.chain.rwagmi.lpLocker, rulesVersion: 2, swapHelper: world.ctx.chain.addresses.bootr.swapHelper, usdc: world.ctx.chain.addresses.usdc, weth: world.ctx.chain.addresses.weth, spender: world.ctx.spenderFor(agent).address, usdcTransferCap: '50000000', usdcWindowSeconds: 86400, gasAllowanceWei: '1', ratePerHour: 60, validUntil: 1, signatureCallers: null, sessionSigner: world.ctx.sessionSigner.address, policyAddresses: { callPolicy: world.ctx.chain.addresses.bootr.callPolicy, gasPolicy: world.ctx.chain.addresses.zerodev.gasPolicy, rateLimitPolicy: world.ctx.chain.addresses.zerodev.rateLimitPolicy, timestampPolicy: world.ctx.chain.addresses.zerodev.timestampPolicy, ecdsaSigner: world.ctx.chain.addresses.zerodev.ecdsaSigner } };
      const { agents } = await import('../src/db/schema.js');
      await world.db.update(agents).set({ sessionPolicy: policy }).where(eq(agents.agentId, agent.agentId));
      const nowSec = () => Math.floor(world.ctx.now() / 1000);
      const app = createApp(world.ctx, nowSec);
      const res = await app.request('/internal/agents/panic-revoke', { method: 'POST', headers: { authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/panic-revoke', '', nowSec()) } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nonceRevoked: { kernels: string[] }[]; uninstalled: { agentId: string; txHash: string | null; error: string | null }[]; paused: string[]; errors: string[] };
      expect(body.nonceRevoked).toEqual([{ kernels: [agent.kernel], txHash: '0xdddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd' }]);
      expect(admin.nonceRevoked).toEqual([[agent.kernel]]);
      expect(body.uninstalled).toEqual([{ agentId: agent.agentId, kernel: agent.kernel, permissionId: '0x11223344', txHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', error: null }]);
      expect(admin.revoked).toEqual(['0x11223344']);
      expect(body.paused).toEqual([agent.agentId]);
      expect(body.errors).toEqual([]);
      const runtime = await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) });
      expect(runtime?.status).toBe('paused');
      expect(runtime?.pausedBy).toBe('operator');
      // a failed uninstall is reported per agent (207), never hides the nonce bump
      admin.failRevoke.add('0x11223344');
      const again = await app.request('/internal/agents/panic-revoke', { method: 'POST', body: '{"uninstall":true}', headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/panic-revoke', '{"uninstall":true}', nowSec()) } });
      expect(again.status).toBe(200);
      const b2 = (await again.json()) as { uninstalled: { error: string | null }[]; nonceRevoked: unknown[] };
      expect(b2.nonceRevoked).toHaveLength(1);
      expect(b2.uninstalled[0]!.error).toMatch(/RootCallFailed/);
      // uninstall: false = nonce bump only
      const only = await app.request('/internal/agents/panic-revoke', { method: 'POST', body: '{"uninstall":false}', headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/panic-revoke', '{"uninstall":false}', nowSec()) } });
      expect(((await only.json()) as { uninstalled: unknown[] }).uninstalled).toEqual([]);
      expect(admin.nonceRevoked).toHaveLength(3);
    } finally {
      await world.close();
    }
  });

  it('refuses to panic-revoke without an admin signer', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world);
      const nowSec = () => Math.floor(world.ctx.now() / 1000);
      const app = createApp(world.ctx, nowSec);
      const res = await app.request('/internal/agents/panic-revoke', { method: 'POST', headers: { authorization: signRequest(SUPERVISOR_KEY, 'POST', '/internal/agents/panic-revoke', '', nowSec()) } });
      expect(res.status).toBe(500);
      expect(((await res.json()) as { error: string }).error).toBe('panic_revoke_failed');
    } finally {
      await world.close();
    }
  });
});
