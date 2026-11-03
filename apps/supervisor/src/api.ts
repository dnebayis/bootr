/** Admin / ops HTTP API (Hono). `/internal/*` requires `Authorization: HMAC <ts>:<hex>` like the sender. */
import { Hono } from 'hono';
import { desc, eq, inArray } from 'drizzle-orm';
import { erc20Abi, formatUnits, getAddress, recoverTypedDataAddress, type Address, type Hex } from 'viem';
import { agentActivity } from './activity.js';
import { configView, updateAgentConfig, type ConfigUpdateBody } from './agent-config.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, agents, runtimes, treasuryOps } from './db/schema.js';
import { hmacAuth, type AuthEnv } from './hmac.js';
import { installSessionKey, rotateSessionKey } from './onboarding.js';
import { saveRuntime } from './runtime.js';
import { buildDeinitData, deserializeSessionPolicy, type SerializedSessionPolicy } from './session-key.js';
import { readGas, gasView } from './gas.js';
import { fundingBudget } from './treasury.js';
import { processAgent, reconcilePending } from './tick.js';
import { reconcileOps } from './treasury.js';
import { reconcileInference } from './inference.js';
import type { AgentState } from './runtime.js';

export interface PanicRevokeResult {
  /** Kernels whose valid nonce was bumped (`revokeAllSessionKeysBatch`), by batch tx. */
  nonceRevoked: { kernels: Address[]; txHash: Hex }[];
  /** Per-agent `revokeSessionKey` (uninstall) results; `error` when the admin tx failed (retry by hand). */
  uninstalled: { agentId: string; kernel: Address; permissionId: Hex; txHash: Hex | null; error: string | null }[];
  /** Runtimes paused by the operator so the loop stops acting on dead keys. */
  paused: string[];
  errors: string[];
}

/** Chunk size for `revokeAllSessionKeysBatch` (each kernel is one root call inside the guardian tx). */
const PANIC_BATCH = 40;

/**
 * Fleet-wide key-leak response (H-01): (1) one guardian tx per `PANIC_BATCH` kernels bumps every kernel's valid
 * nonce, which kills the userOp path of every permission and the ERC-1271 path of every permission that carries
 * BootrAuthorizationPolicy; (2) unless `uninstall: false`, every active permission is then uninstalled
 * (`revokeSessionKey`), which is the only thing that closes the ERC-1271 path of legacy permissions and also
 * withdraws their enable approvals; (3) every runtime is paused by the operator. Agents need a session install
 * (`POST /internal/agents/:id/session/install`) after the signer key is replaced.
 */
export async function panicRevoke(ctx: SupervisorContext, opts: { uninstall?: boolean; agentIds?: string[] } = {}): Promise<PanicRevokeResult> {
  if (!ctx.adminSigner) throw new Error('ADMIN_PRIVATE_KEY is not configured; cannot revoke session keys');
  const result: PanicRevokeResult = { nonceRevoked: [], uninstalled: [], paused: [], errors: [] };
  const rows = (await ctx.db.select().from(agents).where(inArray(agents.status, ['onboarding', 'active']))) as AgentRow[];
  const targets = rows.filter((a) => a.permissionId && (!opts.agentIds || opts.agentIds.includes(a.agentId)));
  const kernels = [...new Set(targets.map((a) => getAddress(a.kernel)))];
  for (let i = 0; i < kernels.length; i += PANIC_BATCH) {
    const chunk = kernels.slice(i, i + PANIC_BATCH);
    try {
      const { txHash } = await ctx.adminSigner.revokeAllSessionKeysBatch(chunk);
      result.nonceRevoked.push({ kernels: chunk, txHash });
      ctx.log.warn({ kernels: chunk, txHash }, 'panic revoke: nonce bumped');
    } catch (err) {
      const error = `nonce batch ${i / PANIC_BATCH} failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      result.errors.push(error);
      ctx.log.error({ err, kernels: chunk }, 'panic revoke: nonce batch failed');
    }
  }
  for (const agent of targets) {
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, agent.agentId) });
    if (runtime && runtime.status !== 'paused') {
      await saveRuntime(ctx, agent.agentId, { status: 'paused', pausedBy: 'operator' });
      result.paused.push(agent.agentId);
    }
    if (opts.uninstall === false) continue;
    const kernel = getAddress(agent.kernel);
    const permissionId = agent.permissionId as Hex;
    try {
      const policy = agent.sessionPolicy ? deserializeSessionPolicy(agent.sessionPolicy as unknown as SerializedSessionPolicy) : null;
      if (!policy) throw new Error('no stored session policy (cannot build deinit data)');
      const { txHash } = await ctx.adminSigner.revokeSessionKey(kernel, permissionId, buildDeinitData(policy));
      result.uninstalled.push({ agentId: agent.agentId, kernel, permissionId, txHash, error: null });
      ctx.log.warn({ agentId: agent.agentId, kernel, permissionId, txHash }, 'panic revoke: permission uninstalled');
    } catch (err) {
      const error = err instanceof Error ? err.message.split('\n')[0]! : String(err);
      result.uninstalled.push({ agentId: agent.agentId, kernel, permissionId, txHash: null, error });
      ctx.log.error({ err, agentId: agent.agentId, kernel }, 'panic revoke: uninstall failed');
    }
  }
  return result;
}

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

  /** Key-leak runbook step 1 (see README "Runbook: session signer leak"). Body: `{uninstall?: boolean, agentIds?: string[]}`. */
  app.post('/internal/agents/panic-revoke', async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { uninstall?: boolean; agentIds?: string[] };
    try {
      const result = await panicRevoke(ctx, { ...(body.uninstall !== undefined ? { uninstall: body.uninstall } : {}), ...(Array.isArray(body.agentIds) ? { agentIds: body.agentIds.map(String) } : {}) });
      return c.json(result, result.errors.length ? 207 : 200);
    } catch (err) {
      return c.json({ error: 'panic_revoke_failed', message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/internal/agents/:id', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const runtime = await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) });
    const lastActions = await ctx.db.select().from(actions).where(eq(actions.agentId, id)).orderBy(desc(actions.createdAt)).limit(20);
    const ops = await ctx.db.select().from(treasuryOps).where(eq(treasuryOps.agentId, id)).orderBy(desc(treasuryOps.createdAt)).limit(20);
    const gas = await readGas(ctx, agent.kernel as Address).then(gasView).catch(() => null);
    return c.json({
      agent: { ...agent, validatorData: agent.validatorData ? `${agent.validatorData.slice(0, 20)}...` : null },
      gas,
      runtime: runtime
        ? { ...runtime, turn: runtime.turn ? { steps: (runtime.turn as { steps?: number }).steps, messages: ((runtime.turn as { messages?: unknown[] }).messages ?? []).length } : null }
        : null,
      pending: runtime?.pending ?? null,
      inferenceKey: (runtime?.state as AgentState | undefined)?.inferenceKey ?? null,
      actions: lastActions,
      treasuryOps: ops,
    });
  });

  // ---- Post-launch control and the activity tape (docs/design/agent-launch-v2.md). The web proxies these for the coin page.

  app.get('/internal/agents/:id/config', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    return c.json(configView(agent));
  });

  /** Body `{by, instructions?, model?, allowedModels?, worker?: {capabilities?, postIntervalMs?, jobLines?}}`; see agent-config.ts. */
  app.put('/internal/agents/:id/config', async (c) => {
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, c.req.param('id')) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const body = (await c.req.json().catch(() => null)) as ConfigUpdateBody | null;
    if (!body || typeof body !== 'object') return c.json({ error: 'invalid_body', message: 'JSON object expected' }, 400);
    const result = await updateAgentConfig(ctx, agent, body);
    if (!result.ok) return c.json({ error: result.error, message: result.message }, result.status);
    return c.json(result.config);
  });

  /** `?limit=50` (max 200) `&before=<iso>`: newest first; see activity.ts for the kinds and summaries. */
  app.get('/internal/agents/:id/activity', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const runtime = (await ctx.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) })) ?? null;
    const limitRaw = c.req.query('limit');
    const limit = limitRaw === undefined ? undefined : Number(limitRaw);
    if (limit !== undefined && !Number.isFinite(limit)) return c.json({ error: 'invalid_limit' }, 400);
    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? new Date(beforeRaw) : undefined;
    if (before && Number.isNaN(before.getTime())) return c.json({ error: 'invalid_before', message: 'before must be an ISO timestamp' }, 400);
    return c.json({ items: await agentActivity(ctx, agent, runtime, { limit, before }) });
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

  /**
   * Live check of the x402 spender the agent pays with: its address and USDC balance, the remaining funding budget
   * of the current window, and a dry EIP-712 signature (never sent anywhere) recovered back to the spender.
   */
  app.post('/internal/agents/:id/session/check-spender', async (c) => {
    const id = c.req.param('id');
    const agent = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, id) });
    if (!agent) return c.json({ error: 'not_found' }, 404);
    const spender = ctx.spenderFor(agent);
    const usdc = await ctx.chain.publicClient.readContract({ address: ctx.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [spender.address] }).catch(() => null);
    const typedData = {
      domain: { name: 'Bootr spender probe', version: '1', chainId: ctx.chain.chainId, verifyingContract: ctx.chain.addresses.usdc },
      types: { Probe: [{ name: 'agentId', type: 'string' }, { name: 'at', type: 'uint256' }] },
      primaryType: 'Probe' as const,
      message: { agentId: id, at: BigInt(Math.floor(ctx.now() / 1000)) },
    };
    const signature = await spender.signTypedData(typedData);
    const recovered = await recoverTypedDataAddress({ ...typedData, signature });
    const budget = await fundingBudget(ctx, agent);
    return c.json({
      agentId: id,
      kernel: agent.kernel,
      spender: spender.address,
      stored: agent.spender,
      storedMatches: agent.spender ? getAddress(agent.spender) === spender.address : null,
      usdc: usdc === null ? null : formatUnits(usdc, 6),
      signatureOk: recovered === spender.address,
      fundingBudget: budget ? { cap: formatUnits(budget.cap, 6), remaining: formatUnits(budget.remaining, 6), windowEnd: new Date(budget.windowEnd * 1000).toISOString(), windowSeconds: budget.windowSeconds } : null,
    });
  });

  return app;
}
