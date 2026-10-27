/** Admin / ops HTTP API (Hono). `/internal/*` requires `Authorization: HMAC <ts>:<hex>` like the sender. */
import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import type { Hex } from 'viem';
import type { SupervisorContext } from './context.js';
import { actions, agents, runtimes, treasuryOps } from './db/schema.js';
import { hmacAuth, type AuthEnv } from './hmac.js';
import { installSessionKey, rotateSessionKey } from './onboarding.js';
import { saveRuntime } from './runtime.js';
import { processAgent, reconcilePending } from './tick.js';
import { reconcileOps } from './treasury.js';
import { reconcileInference } from './inference.js';
import type { AgentState } from './runtime.js';

export function createApp(ctx: SupervisorContext, nowSec: () => number = () => Math.floor(ctx.now() / 1000)) {
  const app = new Hono<AuthEnv>();

  app.get('/health', (c) => c.json({ ok: true, chainId: ctx.chain.chainId, now: new Date(ctx.now()).toISOString() }));

  app.use('/internal/*', hmacAuth(ctx.config.SUPERVISOR_SERVICE_KEY, nowSec));

  app.get('/internal/agents', async (c) => {
    const rows = await ctx.db.select({ agent: agents, runtime: runtimes }).from(agents).leftJoin(runtimes, eq(runtimes.agentId, agents.agentId));
    return c.json({
      agents: rows.map(({ agent, runtime }) => ({
        agentId: agent.agentId,
        token: agent.token,
        kernel: agent.kernel,
        status: agent.status,
        xHandle: (agent.config as { xHandle?: string | null }).xHandle ?? null,
        permissionId: agent.permissionId,
        sessionValidUntil: agent.sessionValidUntil,
        builderCode: agent.builderCode,
        runtime: runtime ? { status: runtime.status, cycle: runtime.cycle, nextAt: runtime.nextAt, pausedBy: runtime.pausedBy, failures: runtime.failures } : null,
      })),
    });
  });

  app.get('/internal/agents/:id', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    const lastActions = await ctx.db.select().from(actions).where(eq(actions.agentId, id)).orderBy(desc(actions.createdAt)).limit(20);
    const ops = await ctx.db.select().from(treasuryOps).where(eq(treasuryOps.agentId, id)).orderBy(desc(treasuryOps.createdAt)).limit(20);
    return c.json({
      agent: { ...agent, validatorData: agent.validatorData ? `${agent.validatorData.slice(0, 20)}...` : null },
      runtime: runtime
        ? { ...runtime, turn: runtime.turn ? { steps: (runtime.turn as { steps?: number }).steps, messages: ((runtime.turn as { messages?: unknown[] }).messages ?? []).length } : null }
        : null,
      pending: runtime?.pending ?? null,
      inferenceKey: (runtime?.state as AgentState | undefined)?.inferenceKey ?? null,
      actions: lastActions,
      treasuryOps: ops,
    });
  });

  app.post('/internal/agents/:id/pause', async (c) => {
    const id = c.req.param('id');
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    if (!runtime) return c.json({ error: 'not_found' }, 404);
    await saveRuntime(ctx, id, { status: 'paused', pausedBy: 'operator' });
    return c.json({ agentId: id, status: 'paused' });
  });

  app.post('/internal/agents/:id/resume', async (c) => {
    const id = c.req.param('id');
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    if (!runtime) return c.json({ error: 'not_found' }, 404);
    if (runtime.status !== 'paused') return c.json({ agentId: id, status: runtime.status, note: 'not paused' });
    const pending = runtime.pending as { status?: string } | null;
    const status = pending?.status === 'held' ? 'held' : 'waiting';
    await saveRuntime(ctx, id, { status, pausedBy: null, nextAt: new Date(ctx.now()) });
    return c.json({ agentId: id, status });
  });

  app.post('/internal/agents/:id/reconcile', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    if (!agent || !runtime) return c.json({ error: 'not_found' }, 404);
    const ops = await reconcileOps(ctx, agent);
    const after = await reconcilePending(ctx, agent, runtime);
    const key = (runtime.state as unknown as AgentState).inferenceKey;
    const inference = key ? await reconcileInference(ctx, key) : null;
    return c.json({ agentId: id, treasuryOps: ops.map((o) => o.result), runtimeStatus: after.status, pending: after.pending, inference: inference ? { kind: inference.kind, key: inference.key } : null });
  });

  app.post('/internal/agents/:id/tick', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    if (!agent || !runtime) return c.json({ error: 'not_found' }, 404);
    const result = await processAgent(ctx, agent, runtime);
    return c.json({ agentId: id, result });
  });

  app.post('/internal/agents/:id/session/install', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { permissionId?: Hex };
    try {
      const result = await installSessionKey(ctx, agent, body.permissionId ? { permissionId: body.permissionId } : {});
      return c.json(result);
    } catch (err) {
      return c.json({ error: 'install_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/internal/agents/:id/session/rotate', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    try {
      return c.json(await rotateSessionKey(ctx, agent));
    } catch (err) {
      return c.json({ error: 'rotate_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  /** Live check of the ERC-1271 path the x402 payer depends on. */
  app.post('/internal/agents/:id/session/check-1271', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent || !agent.permissionId) return c.json({ error: 'not_found' }, 404);
    const kernel = await ctx.kernelFor(agent);
    const typedData = {
      domain: { name: 'USD Coin', version: '2', chainId: ctx.chain.chainId, verifyingContract: ctx.chain.addresses.usdc },
      types: { Probe: [{ name: 'note', type: 'string' }] },
      primaryType: 'Probe',
      message: { note: 'bootr erc1271 probe' },
    } as const;
    const { hashTypedData } = await import('viem');
    const signature = await kernel.signTypedData(typedData);
    // Called as USDC would call it (EIP-3009 settlement); with SESSION_1271_CALLERS=usdc any other caller fails by design.
    const valid = await kernel.verifySignature(hashTypedData(typedData), signature, ctx.chain.addresses.usdc);
    return c.json({ agentId: id, kernel: agent.kernel, permissionId: agent.permissionId, valid });
  });

  return app;
}
