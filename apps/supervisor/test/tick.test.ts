import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { wakeDecision } from '@bootr/agent-core';
import { actions, runtimes, treasuryOps, inference as inferenceTable } from '../src/db/schema.js';
import { verifyRequest } from '../src/hmac.js';
import { IndexerClient } from '../src/indexer-client.js';
import { acquireLease, releaseLease } from '../src/runtime.js';
import { REVOKE_CHECK_GRACE_MS, processAgent, reconcilePending, tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, INDEXER_KEY, KERNEL, makeWorld, seedAgent, SPENDER, toolCallResponse } from './helpers.js';

async function runtimeRow(world: Awaited<ReturnType<typeof makeWorld>>) {
  return (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

describe('tick leasing', () => {
  it('only one worker takes a runtime; an expired lease can be taken over', async () => {
    const world = await makeWorld();
    try {
      await seedAgent(world);
      const a = await acquireLease(world.ctx, AGENT_ID, 'worker-a');
      const b = await acquireLease(world.ctx, AGENT_ID, 'worker-b');
      expect(a?.leaseToken).toBe('worker-a');
      expect(b).toBeNull();
      // wrong token cannot release
      await releaseLease(world.ctx, AGENT_ID, 'worker-b');
      expect(await acquireLease(world.ctx, AGENT_ID, 'worker-b')).toBeNull();
      // expired lease
      world.setNow(world.ctx.now() + 61_000);
      expect((await acquireLease(world.ctx, AGENT_ID, 'worker-b'))?.leaseToken).toBe('worker-b');
      await releaseLease(world.ctx, AGENT_ID, 'worker-b');
      expect((await acquireLease(world.ctx, AGENT_ID, 'worker-c'))?.leaseToken).toBe('worker-c');
      // a leased runtime is skipped by processAgent
      const r = await processAgent(world.ctx, (await world.db.query.agents.findFirst())!, await runtimeRow(world));
      expect(r?.skipped).toBe('leased');
    } finally {
      await world.close();
    }
  });
});

describe('wake -> inference -> action -> finish', () => {
  it('runs a turn with one tool per step, brokers the action, checkpoints and schedules nextAt', async () => {
    const world = await makeWorld();
    const start = world.ctx.now();
    const script = [toolCallResponse('read_market', {}), toolCallResponse('remember', { text: 'TEST trades at $0.01 on 2026-10-24', tags: ['price'] }), finishResponse(start + 3_600_000)];
    const w = await makeWorld({ script });
    await world.close();
    try {
      // original post not due yet (started 1h ago, 2h interval): the wake reason is the scheduled nextAt
      await seedAgent(w, { config: { socialStartedAt: new Date(start - 3_600_000).toISOString() } });
      const report = await tick(w.ctx);
      expect(report.ran).toEqual([AGENT_ID]);
      expect(report.errors).toEqual([]);

      const runtime = await runtimeRow(w);
      expect(runtime.status).toBe('waiting');
      expect(runtime.turn).toBeNull();
      expect(runtime.pending).toBeNull();
      expect(runtime.leaseToken).toBeNull();
      expect(runtime.cycle).toBe(3); // three inferences, three cycles
      expect(runtime.nextAt.getTime()).toBe(start + 3_600_000);
      expect(runtime.state).toMatchObject({ phase: 'social', memory: 'm', agenda: 'a', summary: 's' });

      const acts = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(acts.map((a) => (a.action as { tool: string }).tool).sort()).toEqual(['finish', 'read_market', 'remember']);
      expect(acts.every((a) => a.status === 'completed')).toBe(true);
      const market = acts.find((a) => (a.action as { tool: string }).tool === 'read_market')!;
      expect(market.result).toMatchObject({ status: 'completed', result: { snapshot: { priceUsd: 0.01 } } });

      // the model saw the tool result in the next request
      const posts = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      expect(posts).toHaveLength(3);
      const second = posts[1]!.body as { messages: { role: string; content: string | null }[]; tools: { function: { name: string } }[] };
      expect(second.messages.at(-1)?.role).toBe('tool');
      expect(second.messages.at(-1)?.content).toContain('priceUsd');
      // one idempotency key per cycle; search_web hidden (no SEARCH_API), generate_image hidden
      expect(new Set(posts.map((c) => c.headers.get('idempotency-key'))).size).toBe(3);
      expect(second.tools.map((t) => t.function.name)).not.toContain('search_web');
      expect(second.tools.map((t) => t.function.name)).not.toContain('generate_image');
      const inf = await w.db.select().from(inferenceTable);
      expect(inf.every((r) => r.status === 'succeeded')).toBe(true);
      expect((await w.ctx.memories.count(AGENT_ID))).toBe(1);
      // social stats posted to the indexer
      expect(w.indexer.posted.length).toBeGreaterThan(0);
      expect(w.indexer.posted.at(-1)).toMatchObject({ xHandle: 'bootr_agent', status: 'awake', spender: SPENDER });

      // not due anymore: next tick does not run a turn
      const second2 = await tick(w.ctx);
      expect(second2.ran).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('holds the turn on an unknown inference outcome and never pays for a replacement', async () => {
    const script = [new Response(JSON.stringify({ error: { code: 'request_outcome_unknown' } }), { status: 409, headers: { 'content-type': 'application/json' } })];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const runtime = await runtimeRow(w);
      expect(runtime.status).toBe('waiting');
      expect((runtime.state as { inferenceKey?: string }).inferenceKey).toMatch(/^inference:/);
      const rows = await w.db.select().from(inferenceTable);
      expect(rows[0]!.status).toBe('unknown');
      // next tick: no payment was ever signed for that key (the relay answered before any 402), so the relay can hold
      // nothing of ours: the row is failed without asking the relay and the next cycle pays with a NEW key
      w.setNow(w.ctx.now() + 120_000);
      await tick(w.ctx);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/requests/'))).toHaveLength(0);
      const after = await w.db.select().from(inferenceTable);
      expect(after.find((r) => r.cycle === rows[0]!.cycle)?.status).toBe('failed');
      expect(after.find((r) => r.cycle === rows[0]!.cycle)?.error).toBe('no_payment_signed');
      // a signed payment on an unknown row is never re-bought: reconcile by key with the proof, no new POST
      const [paid] = await w.db.update(inferenceTable).set({ status: 'unknown', error: null, receipt: { payment: { scheme: 'exact', network: 'eip155:84532', x402Version: 2, payload: { signature: '0x', authorization: {} } } } }).where(eq(inferenceTable.idempotencyKey, rows[0]!.idempotencyKey)).returning();
      const current = await runtimeRow(w);
      await w.db.update(runtimes).set({ state: { ...(current.state as Record<string, unknown>), inferenceKey: paid!.idempotencyKey }, cycle: paid!.cycle, status: 'waiting', nextAt: new Date(0) }).where(eq(runtimes.agentId, AGENT_ID));
      const before = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
      w.setNow(w.ctx.now() + 120_000);
      await tick(w.ctx);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/requests/')).length).toBeGreaterThan(0);
      expect(w.inference.calls.at(-1)!.headers.get('PAYMENT-SIGNATURE')).toBeTruthy();
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(before);
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, paid!.idempotencyKey) }))?.status).toBe('unknown');
    } finally {
      await w.close();
    }
  });
});

describe('held money action', () => {
  it('treasury_execute with a receipt timeout blocks the runtime until the hash reconciles', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const script = [toolCallResponse('treasury_prepare', { operation: 'swap', asset: 'ETH', amount: '0.01' })];
    const w = await makeWorld({ script, chain: { weth: 10n ** 17n } });
    try {
      await seedAgent(w);
      // 1st turn step: prepare. The model needs expectedHash, so script the execute call after reading the op.
      const scriptRef = script;
      // run the tick: step 1 prepares; step 2 must execute; we append the execute response lazily
      let prepared: { opId: string; callHash: string } | null = null;
      const origFetch = w.ctx.fetch;
      w.ctx.fetch = async (input, init) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        if (url.includes('/v1/chat/completions') && scriptRef.length === 0) {
          const op = (await w.db.select().from(treasuryOps))[0];
          if (op && !prepared) {
            prepared = { opId: op.opId, callHash: op.callHash };
            w.kernel.waitSucceeds = false; // receipt times out -> unknown
            return toolCallResponse('treasury_execute', { preparedId: op.opId, expectedHash: op.callHash });
          }
        }
        return origFetch(input, init);
      };
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      const runtime = await runtimeRow(w);
      expect(runtime.status).toBe('held');
      expect((runtime.pending as { status: string; action: { tool: string } }).status).toBe('held');
      expect((runtime.pending as { action: { tool: string } }).action.tool).toBe('treasury_execute');
      const ops = await w.db.select().from(treasuryOps);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.status).toBe('unknown');
      expect(ops[0]!.userOpHash).toMatch(/^0x/);
      expect(w.kernel.submitted).toHaveLength(1);
      // the swap op is WETH.approve(helper) + helper.swapWethToUsdc
      expect(ops[0]!.calls.map((c) => c.to)).toEqual([w.ctx.chain.addresses.weth, w.ctx.chain.addresses.bootr.swapHelper]);

      // wake decision refuses to run while held
      expect(wakeDecision({ now: start, enabled: true, status: 'blocked', nextAt: 0, heldAction: true }).run).toBe(false);
      // next tick: receipt not available yet -> still held, nothing resent
      w.kernel.receipt = null;
      w.setNow(w.ctx.now() + 60_000);
      await tick(w.ctx);
      expect((await runtimeRow(w)).status).toBe('held');
      expect(w.kernel.submitted).toHaveLength(1);

      // receipt appears -> op confirmed, pending reconciled, runtime unblocked with txHash in the receipt
      w.kernel.receipt = { success: true, receipt: { transactionHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } };
      scriptRef.push(finishResponse(w.ctx.now() + 3_600_000));
      w.setNow(w.ctx.now() + 60_000);
      const r3 = await tick(w.ctx);
      expect(r3.errors).toEqual([]);
      const after = await runtimeRow(w);
      expect(after.status).toBe('waiting');
      expect(after.pending).toBeNull();
      const opAfter = (await w.db.select().from(treasuryOps))[0]!;
      expect(opAfter.status).toBe('confirmed');
      expect(opAfter.txHash).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
      const exec = (await w.db.select().from(actions)).find((a) => (a.action as { tool: string }).tool === 'treasury_execute')!;
      expect(exec.status).toBe('completed');
      expect(exec.receipt).toMatchObject({ txHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
      expect(w.kernel.submitted).toHaveLength(1); // never replaced
      expect(prepared).not.toBeNull();
    } finally {
      await w.close();
    }
  });

  it('held publish reconciles from the sender receipt', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'hello world from a test' })] });
    try {
      await seedAgent(w);
      w.sender.publishStatus = 'held';
      await tick(w.ctx);
      let runtime = await runtimeRow(w);
      expect(runtime.status).toBe('held');
      const actionId = (runtime.pending as { id: string }).id;
      w.sender.receipts[actionId] = { status: 'sent', providerPostId: '777' };
      const agent = (await w.db.query.agents.findFirst())!;
      runtime = await reconcilePending(w.ctx, agent, runtime);
      expect(runtime.status).toBe('waiting');
      expect((runtime.pending as { status: string; result: { receipt: { postId: string } } }).status).toBe('completed');
      expect(w.sender.published).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('sleep rule', () => {
  it('sleeps below 1 USDC without buying inference and wakes on refuel', async () => {
    // kernel 0.5 USDC + spender 0.4 USDC: below 1 USDC in total (and below the 0.01 USDC top-up floor, so no fund op)
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T13:00:00Z'))], chain: { usdc: 500_000n, spenderUsdc: 400_000n } });
    try {
      await seedAgent(w);
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([]);
      expect((await runtimeRow(w)).status).toBe('sleeping');
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      expect(w.indexer.posted.at(-1)).toMatchObject({ status: 'sleeping', spender: SPENDER });
      // refuel
      w.state.usdc = 25_000_000n;
      const r2 = await tick(w.ctx);
      expect(r2.ran).toEqual([AGENT_ID]);
      expect((await runtimeRow(w)).status).toBe('waiting');
    } finally {
      await w.close();
    }
  });

  it('mirrors a guardian pause and refuses to run', async () => {
    const w = await makeWorld({ chain: { paused: true } });
    try {
      await seedAgent(w);
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([]);
      const rt = await runtimeRow(w);
      expect(rt.status).toBe('paused');
      expect(rt.pausedBy).toBe('guardian');
      w.state.paused = false;
      await tick(w.ctx);
      expect((await runtimeRow(w)).pausedBy).toBeNull();
    } finally {
      await w.close();
    }
  });
});

describe('sleep rule', () => {
  it('counts kernel + spender USDC as fuel', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 3_000_000n }, script: [finishResponse(Date.parse('2026-10-24T13:00:00Z'))] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      expect((await runtimeRow(w)).status).not.toBe('sleeping');
      w.state.spenderUsdc = 500_000n;
      w.setNow(w.ctx.now() + 3_600_000);
      await tick(w.ctx);
      expect((await runtimeRow(w)).status).toBe('sleeping');
    } finally {
      await w.close();
    }
  });
});

describe('social push to the indexer', () => {
  it('sends the spender in the signed social-stats body (mock indexer over the real client)', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 3_000_000n }, script: [finishResponse(Date.parse('2026-10-24T13:00:00Z'))] });
    const received: { path: string; body: Record<string, unknown> }[] = [];
    const indexerFetch: typeof fetch = async (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      if (init?.method !== 'POST') return Response.json({ priceUsd: 0.01, marketCapUsd: 1000 });
      const raw = String(init.body ?? '');
      const auth = verifyRequest(INDEXER_KEY, new Headers(init.headers).get('authorization') ?? undefined, 'POST', url.pathname, raw, Math.floor(Date.now() / 1000));
      if (!auth.ok) return Response.json({ error: 'unauthorized' }, { status: 401 });
      received.push({ path: url.pathname, body: JSON.parse(raw) as Record<string, unknown> });
      return Response.json({ ok: true });
    };
    w.ctx.indexer = new IndexerClient('http://indexer.test', INDEXER_KEY, indexerFetch);
    try {
      await seedAgent(w);
      await tick(w.ctx);
      expect(received.length).toBeGreaterThan(0);
      const last = received.at(-1)!;
      expect(last.path).toBe(`/internal/agent/${KERNEL}/social`);
      expect(last.body).toMatchObject({ xHandle: 'bootr_agent', postsCount24h: expect.any(Number), spender: SPENDER, firstPostAt: null });
      expect(Object.keys(last.body).sort()).toEqual(['firstPostAt', 'lastPostAt', 'model', 'postsCount24h', 'spender', 'status', 'xHandle']);
    } finally {
      await w.close();
    }
  });

  it('sends spender: null while sv_agents.spender is not derived yet', async () => {
    const w = await makeWorld({ chain: { usdc: 500_000n, spenderUsdc: 0n } });
    try {
      const agent = await seedAgent(w);
      expect(agent.spender).toBeNull();
      // processAgent directly: no onboarding pass, so the spender backfill does not run
      const r = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(r?.skipped).toBe('sleeping');
      expect(w.indexer.posted.at(-1)).toMatchObject({ status: 'sleeping', spender: null, model: expect.any(String) });
    } finally {
      await w.close();
    }
  });
});

describe('admin revoke is the kill switch', () => {
  it('pauses an agent (operator) once the kernel nonce passed its permission, and leaves a live one alone', async () => {
    const world = await makeWorld({ chain: { kernelNonce: 2 } });
    try {
      const agent = await seedAgent(world, { agent: { sessionKeyInstalledAt: new Date(world.ctx.now() - REVOKE_CHECK_GRACE_MS) } });
      const r = await processAgent(world.ctx, agent, await runtimeRow(world));
      expect(r?.skipped).toBe('keys_revoked');
      const rt = await runtimeRow(world);
      expect(rt.status).toBe('paused');
      expect(rt.pausedBy).toBe('operator');
      // sticky: the next tick does not touch it either
      expect((await processAgent(world.ctx, agent, rt))?.skipped).toBe('paused');
    } finally {
      await world.close();
    }
    const live = await makeWorld({ chain: { kernelNonce: 1 } });
    try {
      const agent = await seedAgent(live);
      const r = await processAgent(live.ctx, agent, await runtimeRow(live));
      expect(r?.skipped).not.toBe('keys_revoked');
      expect((await runtimeRow(live)).status).not.toBe('paused');
    } finally {
      await live.close();
    }
    // Freshly installed: a stale read (the RPC still answers with the pre-install state) must not pause the agent.
    const fresh = await makeWorld({ chain: { kernelNonce: 2 } });
    try {
      const agent = await seedAgent(fresh, { agent: { sessionKeyInstalledAt: new Date(fresh.ctx.now() - 30_000) } });
      const r = await processAgent(fresh.ctx, agent, await runtimeRow(fresh));
      expect(r?.skipped).not.toBe('keys_revoked');
      expect((await runtimeRow(fresh)).status).not.toBe('paused');
    } finally {
      await fresh.close();
    }
  });
});

describe('chain reads per visit (the RPC key is shared with the indexer\'s block tail)', () => {
  it('reads an agent in one multicall per visit, re-reads a sleeping one every REST_CHECK_MS, and wakes it on the refuel it then sees', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n } });
    try {
      const agent = await seedAgent(w);
      const pc = w.ctx.chain.publicClient as unknown as { multicall: (a: unknown) => Promise<unknown> };
      const inner = pc.multicall.bind(pc);
      let multicalls = 0;
      pc.multicall = async (a) => {
        multicalls += 1;
        return inner(a);
      };
      const poolIdReads = () => w.state.calls.filter((c) => c.fn === 'deploymentInfo').length;
      const guardianReads = () => w.state.calls.filter((c) => c.fn === 'agentInfo').length;

      // Awake: one batch carries the guardian flag, the balances, the fees and the price; the pool id is read once.
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).toBe('sleeping');
      expect(multicalls).toBe(1);
      expect(poolIdReads()).toBe(1);
      expect(guardianReads()).toBe(1);

      // The first tick asleep still reads (a quick refuel is seen at once) and starts the rest clock.
      w.setNow(w.ctx.now() + 60_000);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).toBe('sleeping');
      expect(multicalls).toBe(2);
      expect(poolIdReads()).toBe(1);

      // Within REST_CHECK_MS a sleeping agent costs the chain nothing, even when it was refuelled meanwhile.
      w.state.usdc = 25_000_000n;
      w.setNow(w.ctx.now() + 60_000);
      const resting = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(resting).toMatchObject({ ran: false, skipped: 'sleeping', reasons: ['resting'] });
      expect(multicalls).toBe(2);
      expect(guardianReads()).toBe(2);
      expect((await runtimeRow(w)).status).toBe('sleeping');

      // Once the rest is over the read sees the fuel and the agent wakes.
      w.setNow(w.ctx.now() + w.ctx.config.REST_CHECK_MS);
      const woken = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(woken?.skipped).not.toBe('sleeping');
      expect(multicalls).toBe(3);
      expect((await runtimeRow(w)).status).not.toBe('sleeping');
    } finally {
      await w.close();
    }
  });

  it('a guardian-paused agent is re-read every REST_CHECK_MS, and unpauses on the read that sees it', async () => {
    const w = await makeWorld({ chain: { paused: true } });
    try {
      const agent = await seedAgent(w);
      const guardianReads = () => w.state.calls.filter((c) => c.fn === 'agentInfo').length;
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).toBe('guardian_paused');
      // first tick paused: reads, starts the clock
      w.setNow(w.ctx.now() + 60_000);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).toBe('guardian_paused');
      const reads = guardianReads();
      w.state.paused = false;
      w.setNow(w.ctx.now() + 60_000);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).toBe('paused');
      expect(guardianReads()).toBe(reads);
      expect((await runtimeRow(w)).pausedBy).toBe('guardian');
      w.setNow(w.ctx.now() + w.ctx.config.REST_CHECK_MS);
      expect((await processAgent(w.ctx, agent, await runtimeRow(w)))?.skipped).not.toBe('paused');
      expect(guardianReads()).toBe(reads + 1);
      expect((await runtimeRow(w)).pausedBy).toBeNull();
    } finally {
      await w.close();
    }
  });
});
