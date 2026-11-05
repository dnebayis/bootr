/**
 * An outage of the model provider behind the relay must not drain an agent. These run the supervisor against the
 * relay's own app (apps/inference, in-process: real credit logic, real x402 gate, mock facilitator), with the real
 * payer signing for the agent's spender; only the provider and the chain settlement are fake.
 */
import { describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { wakeDecision } from '@bootr/agent-core';
import { actions, agents, inference as inferenceTable, runtimes } from '../src/db/schema.js';
import { generateImage, IMAGE_WINDOW_MS, MAX_IMAGES_PER_DAY } from '../src/images.js';
import { processAgent, tick } from '../src/tick.js';
import type { AgentState, Turn } from '../src/runtime.js';
import { spenderAccount } from '../src/spender.js';
import { createTestApp, jsonResponse, PAY_TO } from '../../inference/src/test/helpers.js';
import { AGENT_ID, agentConfig, finishResponse, makeWorld, seedAgent, SPENDER_MASTER, toolCallResponse, type TestWorld } from './helpers.js';

const MINUTE = 60_000;
const refused = () => jsonResponse({ error: { code: 402, message: 'Insufficient credits' } }, 402);
const down = () => jsonResponse({ error: { message: 'overloaded' } }, 503);
const completion = () =>
  jsonResponse({
    id: 'gen',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_finish', type: 'function', function: { name: 'finish', arguments: JSON.stringify({ memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-10-24T20:00:00Z' }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
  });

/** A world wired to the real relay; `provider` is what the model provider answers right now. */
async function outage(provider: () => Response = refused) {
  const w = await makeWorld({ config: { INFERENCE_PAYTO_ADDRESS: PAY_TO } });
  const sim = { provider, signed: 0 };
  const relay = createTestApp({ upstreamFetch: async () => sim.provider() });
  const posts: { key: string | null; body: string }[] = [];
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (req.method === 'POST' && req.headers.get('PAYMENT-SIGNATURE')) posts.push({ key: req.headers.get('Idempotency-Key'), body: await req.clone().text() });
    return relay.appFetch(req);
  }) as typeof fetch;
  w.ctx.spenderFor = (agent) => {
    const account = spenderAccount(SPENDER_MASTER, agent.agentId);
    return {
      ...account,
      signTypedData: (typedData: Parameters<typeof account.signTypedData>[0]) => {
        sim.signed += 1;
        return account.signTypedData(typedData);
      },
    } as typeof account;
  };
  return { w, relay, sim, posts };
}

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

const stateOf = (r: { state: unknown }) => r.state as AgentState;

/** One tick a minute, as the supervisor does. */
async function minutes(w: TestWorld, n: number, each?: () => void) {
  for (let i = 0; i < n; i++) {
    w.setNow(w.ctx.now() + MINUTE);
    await tick(w.ctx);
    each?.();
  }
}

describe.each([
  ['the provider refuses the account (upstream_rejected, kept as credit)', refused],
  ['the provider is down (upstream_failed_credited)', down],
])('outage: %s', (_name, provider) => {
  it('signs one payment until the credit is exhausted, logs the refund, and pays again only after the backoff', async () => {
    const { w, relay, sim, posts } = await outage(provider);
    const refund = vi.spyOn(w.ctx.log, 'error');
    try {
      await seedAgent(w);
      const start = w.ctx.now();
      await tick(w.ctx);
      expect(sim.signed).toBe(1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(1);
      let rt = await runtimeRow(w);
      const firstKey = stateOf(rt).inferenceKey!;
      expect(firstKey).toMatch(/^inference:/);
      expect(rt.failures).toBe(1);
      expect(rt.cycle).toBe(0);
      expect(rt.nextAt.getTime()).toBe(start + 2 * MINUTE);
      expect(stateOf(rt).inferenceRetryAt).toBe(start + 2 * MINUTE);
      const row = await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, firstKey) });
      expect(row?.status).toBe('unknown');
      // the path the "owed" query in the report reads
      expect((row?.receipt as { payment: { payload: { authorization: { value: string } } } }).payment.payload.authorization.value).toMatch(/^\d+$/);

      // second attempt, two minutes in: the credit, the same key and request, no signature
      await minutes(w, 1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(1);
      await minutes(w, 1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(2);
      expect(sim.signed).toBe(1);
      rt = await runtimeRow(w);
      expect(stateOf(rt).inferenceKey).toBe(firstKey);
      expect(rt.failures).toBe(2);
      expect(rt.nextAt.getTime()).toBe(start + 6 * MINUTE);
      expect(refund).not.toHaveBeenCalledWith(expect.anything(), expect.stringContaining('refund due'));

      // third attempt, four minutes later: the attempts are spent
      await minutes(w, 3);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(2);
      await minutes(w, 1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(3);
      expect(sim.signed).toBe(1);
      expect(relay.facilitator.settle).toHaveBeenCalledTimes(1);
      expect(refund).toHaveBeenCalledWith(expect.objectContaining({ key: firstKey, agentId: AGENT_ID, code: 'credit_exhausted', chargedMicroUsdc: expect.stringMatching(/^\d+$/) }), expect.stringMatching(/refund due to the agent: \d+ micro-USDC$/));
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, firstKey) }))?.status).toBe('failed');
      rt = await runtimeRow(w);
      expect(stateOf(rt).inferenceKey).toBeNull();
      expect(rt.turn).toBeNull();
      expect(rt.cycle).toBe(1);
      expect(rt.failures).toBe(3);
      expect(rt.nextAt.getTime()).toBe(start + 14 * MINUTE);

      // no second payment before that backoff ends, then exactly one under a new key
      await minutes(w, 7, () => expect(sim.signed).toBe(1));
      await minutes(w, 1);
      expect(w.ctx.now()).toBe(start + 14 * MINUTE);
      expect(sim.signed).toBe(2);
      expect(relay.facilitator.settle).toHaveBeenCalledTimes(2);
      expect(new Set(posts.map((p) => p.key)).size).toBe(2);
      expect((await runtimeRow(w)).failures).toBe(4);
    } finally {
      await w.close();
    }
  });
});

describe('the 2026-11-04 outage, replayed', () => {
  it('107 minutes at the backoff cap cost 3 payments instead of 110', async () => {
    const { w, sim, relay } = await outage(refused);
    try {
      await seedAgent(w, { runtime: { failures: 108 } });
      await tick(w.ctx);
      await minutes(w, 107);
      expect(sim.signed).toBe(3);
      expect(relay.facilitator.settle).toHaveBeenCalledTimes(3);
    } finally {
      await w.close();
    }
  });
});

describe('recovery', () => {
  it('spends the credit without a new payment, in the same turn and with the same request, and success resets', async () => {
    const { w, relay, sim, posts } = await outage(refused);
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const stopped = await runtimeRow(w);
      const key = stateOf(stopped).inferenceKey!;
      expect((stopped.turn as unknown as Turn).messages).toHaveLength(2);

      sim.provider = completion;
      await minutes(w, 2);
      expect(sim.signed).toBe(1);
      expect(relay.facilitator.settle).toHaveBeenCalledTimes(1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(2);
      expect(posts.map((p) => p.key)).toEqual([key, key]);
      expect(JSON.parse(posts[1]!.body)).toEqual(JSON.parse(posts[0]!.body));

      const row = await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) });
      expect(row?.status).toBe('succeeded');
      expect(row?.error).toBeNull();
      const rt = await runtimeRow(w);
      expect(rt.failures).toBe(0);
      expect(rt.lastError).toBeNull();
      expect(rt.turn).toBeNull();
      expect(stateOf(rt).inferenceKey).toBeNull();
      expect(stateOf(rt).inferenceRetryAt).toBeNull();
      expect(stateOf(rt).continuation).toBeNull();
      expect(stateOf(rt).lastCheckpointAt).toBe(w.ctx.now());
      expect(await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('a credit is used even when the failed attempt was the last step of the turn', async () => {
    const { w, sim } = await outage(refused);
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const rt = await runtimeRow(w);
      await w.db.update(runtimes).set({ turn: { ...(rt.turn as Record<string, unknown>), steps: w.ctx.config.MAX_TOOL_STEPS } }).where(eq(runtimes.agentId, AGENT_ID));
      sim.provider = completion;
      await minutes(w, 2);
      expect(sim.signed).toBe(1);
      const after = await runtimeRow(w);
      expect(after.failures).toBe(0);
      expect(stateOf(after).lastCheckpointAt).toBe(w.ctx.now());
    } finally {
      await w.close();
    }
  });
});

describe('the backoff holds against every wake', () => {
  it('continuation, a mention, a due post and a config change buy nothing before nextAt', async () => {
    const { w, relay, sim, posts } = await outage(refused);
    try {
      const agent = await seedAgent(w);
      await tick(w.ctx);
      const stopped = await runtimeRow(w);
      expect(stateOf(stopped).continuation).toBeTruthy();
      expect(stopped.turn).toBeTruthy();
      const retryAt = stopped.nextAt.getTime();

      // the wake rule alone would run on a mention: this is why the hold sits in front of it
      expect(wakeDecision({ now: retryAt - MINUTE, enabled: true, status: 'waiting', nextAt: retryAt, inbox: [{ postId: '900', status: 'pending', eligible: true, seenAt: null, deferredUntil: null }] }).run).toBe(true);

      w.sender.items = [{ postId: '900', authorId: '555', conversationId: '900', status: 'pending', observedAt: new Date(w.ctx.now()).toISOString(), post: { id: '900', text: 'hello @bootr_agent', authorId: '555', conversationId: '900' } as (typeof w.sender.items)[number]['post'] }];
      const config = agentConfig(w.ctx.now(), { revision: 2 });
      await w.db.update(agents).set({ config }).where(eq(agents.agentId, AGENT_ID));
      w.setNow(w.ctx.now() + MINUTE);
      expect(await processAgent(w.ctx, { ...agent, config }, stopped)).toEqual({ ran: false, reasons: ['inference_backoff'] });
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(1);
      expect(sim.signed).toBe(1);

      // a refuel or an operator resume moves nextAt to now; the hold still stands
      await w.db.update(runtimes).set({ nextAt: new Date(w.ctx.now() - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
      expect(await processAgent(w.ctx, { ...agent, config }, stopped)).toEqual({ ran: false, reasons: ['inference_backoff'] });

      // the request that goes out afterwards is the stored one, though the world has moved on
      await minutes(w, 1);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(2);
      expect(sim.signed).toBe(1);
      expect(JSON.parse(posts.at(-1)!.body)).toEqual(JSON.parse(posts[0]!.body));
      expect(posts.at(-1)!.body).not.toContain('hello @bootr_agent');
    } finally {
      await w.close();
    }
  });

  it('a held action is still reconciled during the backoff, with nothing paid', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'hello world from a test' })] });
    try {
      const agent = await seedAgent(w);
      w.sender.publishStatus = 'held';
      await tick(w.ctx);
      const held = await runtimeRow(w);
      expect(held.status).toBe('held');
      const actionId = (held.pending as { id: string }).id;
      w.sender.receipts[actionId] = { status: 'sent', providerPostId: '777' };
      await w.db.update(runtimes).set({ state: { ...stateOf(held), inferenceRetryAt: w.ctx.now() + 10 * MINUTE } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, AGENT_ID));
      const calls = w.inference.calls.length;
      w.setNow(w.ctx.now() + MINUTE);
      expect(await processAgent(w.ctx, agent, held)).toEqual({ ran: false, reasons: ['inference_backoff'] });
      const after = await runtimeRow(w);
      expect(after.status).toBe('waiting');
      expect((after.pending as { status: string }).status).toBe('completed');
      expect(w.inference.calls).toHaveLength(calls);
    } finally {
      await w.close();
    }
  });
});

describe('the other failures keep their own rule', () => {
  const json = (body: unknown, status: number) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('nothing paid (quote refused): a new key after the backoff, no credit, no signature', async () => {
    const w = await makeWorld({ script: [json({ error: { code: 'quote_exceeds_max' }, quoteMicroUsdc: '9', maxQuoteMicroUsdc: '1' }, 402), finishResponse(Date.parse('2026-10-24T20:00:00Z'))] });
    try {
      await seedAgent(w);
      const start = w.ctx.now();
      await tick(w.ctx);
      const rt = await runtimeRow(w);
      expect(rt.cycle).toBe(1);
      expect(rt.failures).toBe(1);
      expect(rt.lastError).toBe('quote_exceeds_max');
      expect(stateOf(rt).inferenceKey ?? null).toBeNull();
      expect(rt.nextAt.getTime()).toBe(start + 2 * MINUTE);
      const chats = () => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      expect(chats()).toHaveLength(1);
      await minutes(w, 1);
      expect(chats()).toHaveLength(1);
      await minutes(w, 1);
      expect(chats()).toHaveLength(2);
      expect(chats()[1]!.headers.get('Idempotency-Key')).not.toBe(chats()[0]!.headers.get('Idempotency-Key'));
      expect((await runtimeRow(w)).failures).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('an unknown outcome still polls by key every minute, without growing the failure count or holding the wake', async () => {
    const w = await makeWorld({ script: [json({ error: { code: 'request_outcome_unknown' } }, 409)] });
    try {
      await seedAgent(w);
      const start = w.ctx.now();
      await tick(w.ctx);
      const rt = await runtimeRow(w);
      expect(stateOf(rt).inferenceKey).toMatch(/^inference:/);
      expect(stateOf(rt).inferenceRetryAt ?? null).toBeNull();
      expect(rt.failures).toBe(0);
      expect(rt.nextAt.getTime()).toBe(start + MINUTE);
    } finally {
      await w.close();
    }
  });

  it('a paid request found failed at the relay on reconcile logs the refund and does not buy a replacement in the same run', async () => {
    const w = await makeWorld();
    const refund = vi.spyOn(w.ctx.log, 'error');
    try {
      await seedAgent(w);
      const key = 'inference:lost';
      const payment = { x402Version: 2, scheme: 'exact', network: 'eip155:84532', payload: { signature: '0xsig', authorization: { from: '0xk', to: '0xp', value: '1000', validAfter: '0', validBefore: '9', nonce: '0xn' } } };
      await w.db.insert(inferenceTable).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 0, requestHash: '0x00', request: {}, status: 'unknown', receipt: { payment }, createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      const rt = await runtimeRow(w);
      await w.db.update(runtimes).set({ state: { ...stateOf(rt), inferenceKey: key } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, AGENT_ID));
      w.inference.state.requests = { status: 'failed', refundDue: true, retrySafe: false, statusReason: 'credit_exhausted: upstream_status_503' };
      const start = w.ctx.now();
      await tick(w.ctx);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      expect(refund).toHaveBeenCalledWith(expect.objectContaining({ key, agentId: AGENT_ID, chargedMicroUsdc: '1000' }), expect.stringContaining('refund due to the agent: 1000 micro-USDC'));
      const after = await runtimeRow(w);
      expect(stateOf(after).inferenceKey).toBeNull();
      expect(after.cycle).toBe(1);
      expect(after.failures).toBe(1);
      expect(after.nextAt.getTime()).toBe(start + 2 * MINUTE);
      await minutes(w, 1);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('an image kept as a credit is an unknown outcome, so the action resumes under its own key', async () => {
    const w = await makeWorld({ script: [json({ error: { code: 'upstream_rejected' }, status: 'credit', credit: { microUsdc: '9', attemptsLeft: 2 } }, 502)] });
    try {
      const agent = await seedAgent(w);
      const pending = { id: 'act_img' } as Parameters<typeof generateImage>[3];
      const config = agentConfig(w.ctx.now()) as unknown as Parameters<typeof generateImage>[2];
      expect(await generateImage(w.ctx, agent, config, pending, { prompt: 'a fox', altText: 'a fox' }, 0)).toEqual({ kind: 'unknown', error: 'upstream_rejected' });
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, 'image:act_img') }))?.status).toBe('unknown');
    } finally {
      await w.close();
    }
  });
});

/** A model that never finishes: every thought is paid and asks for one more read. */
const neverFinishes = () =>
  jsonResponse({
    id: 'gen',
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_market', type: 'function', function: { name: 'read_market', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.00001 },
  });

const mention = (postId: string, verified = true) => ({
  postId,
  authorId: `3${postId}`,
  conversationId: postId,
  status: 'pending',
  observedAt: '2026-10-24T11:59:00Z',
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId: `3${postId}`, text: `@bootr_agent gm ${postId}`, conversationId: postId, author: { id: `3${postId}`, username: `user${postId}`, verified, verifiedType: (verified ? 'blue' : 'none') as 'blue' | 'none' } },
});

const setState = async (w: TestWorld, patch: Partial<AgentState>, row: Record<string, unknown> = {}) => {
  const rt = await runtimeRow(w);
  await w.db.update(runtimes).set({ state: { ...stateOf(rt), ...patch } as unknown as Record<string, unknown>, ...row }).where(eq(runtimes.agentId, AGENT_ID));
};

describe('a turn the runtime ended waits for its nextAt', () => {
  it('repeated step_cap turns buy 96 thoughts an hour, ticking every 30 s with a due post and an unanswered mention waiting', async () => {
    const { w, sim } = await outage(neverFinishes);
    try {
      await seedAgent(w);
      w.sender.items = [mention('1001')];
      const started: number[] = [];
      let before = 0;
      const start = w.ctx.now();
      for (let t = 0; t < 120; t++) {
        w.setNow(start + t * 30_000);
        const report = await tick(w.ctx);
        expect(report.errors).toEqual([]);
        if (sim.signed > before) started.push(t * 30);
        before = sim.signed;
      }
      expect(sim.signed).toBe(96);
      expect(started).toEqual(Array.from({ length: 12 }, (_, i) => i * 300));
      const rt = await runtimeRow(w);
      expect(stateOf(rt).continuation?.progress).toContain('step cap reached');
    } finally {
      await w.close();
    }
  });

  it('wakes early only for what the ended turn did not see: a new mention, a post that came due since', async () => {
    const { w, sim } = await outage(neverFinishes);
    try {
      const agent = await seedAgent(w);
      w.sender.items = [mention('1001')];
      await setState(w, { lastPostAt: w.ctx.now() - 60_000 }); // no post due in the first turn
      await tick(w.ctx);
      expect(sim.signed).toBe(8);

      await minutes(w, 1);
      expect(sim.signed).toBe(8);

      w.sender.items = [mention('1001'), mention('1002')];
      w.setNow(w.ctx.now() + MINUTE);
      const woken = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(woken?.ran).toBe(true);
      expect(woken?.reasons).toEqual(['continuation', 'pending_mention']);
      expect(sim.signed).toBe(16);
      await minutes(w, 1);
      expect(sim.signed).toBe(16);

      await setState(w, { lastPostAt: w.ctx.now() - 3 * 3_600_000 }); // the post came due after that turn began
      w.setNow(w.ctx.now() + MINUTE);
      const due = await processAgent(w.ctx, agent, await runtimeRow(w));
      expect(due?.reasons).toContain('original_post_due');
      expect(sim.signed).toBe(24);
      // that turn had the post in front of it: it does not buy itself again before its nextAt
      await minutes(w, 4);
      expect(sim.signed).toBe(24);
      await minutes(w, 1);
      expect(sim.signed).toBe(32);
    } finally {
      await w.close();
    }
  });

  it('does not strand an action waiting to resume: continuation or not, it runs at its own nextAt', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T20:00:00Z'))] });
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      const pending = { id: 'act_market', cycleKey: 'cycle:act_market', action: { tool: 'read_market', input: {} }, status: 'sent', createdAt: now, attempts: 1, nextAt: now + 2 * MINUTE };
      await w.db.insert(actions).values({ actionId: pending.id, agentId: AGENT_ID, cycleKey: pending.cycleKey, action: pending.action, status: 'sent', createdAt: new Date(now), updatedAt: new Date(now) });
      await setState(w, { lastPostAt: now, continuation: { progress: 'interrupted', recentSteps: [] } }, { pending, nextAt: new Date(now + 2 * MINUTE) });
      await minutes(w, 1);
      expect((await runtimeRow(w)).pending).toMatchObject({ status: 'sent' });
      await minutes(w, 1);
      const rt = await runtimeRow(w);
      expect(rt.pending).toBeNull();
      expect(stateOf(rt).continuation).toBeNull();
      expect((await w.db.query.actions.findFirst({ where: eq(actions.actionId, pending.id) }))?.status).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('does not strand a held action: its receipt reconciles and the turn goes on at once', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'hello world from a test' }), finishResponse(Date.parse('2026-10-24T20:00:00Z'))] });
    try {
      await seedAgent(w);
      w.sender.publishStatus = 'held';
      await tick(w.ctx);
      const held = await runtimeRow(w);
      expect(held.status).toBe('held');
      await setState(w, { continuation: { progress: 'interrupted', recentSteps: [] } }, { nextAt: new Date(w.ctx.now() + 3_600_000) });
      w.sender.receipts[(held.pending as { id: string }).id] = { status: 'sent', providerPostId: '777' };
      await minutes(w, 1);
      const rt = await runtimeRow(w);
      expect(rt.status).toBe('waiting');
      expect(rt.pending).toBeNull();
      expect(stateOf(rt).continuation).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('does not strand an unresolved response: an unknown key is reconciled at its nextAt with continuation set', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T20:00:00Z'))] });
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      const key = 'inference:open';
      const payment = { x402Version: 2, scheme: 'exact', network: 'eip155:84532', payload: { signature: '0xsig', authorization: { from: '0xk', to: '0xp', value: '1000', validAfter: '0', validBefore: '9', nonce: '0xn' } } };
      await w.db.insert(inferenceTable).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 0, requestHash: '0x00', request: { model: 'm', messages: [] }, status: 'unknown', receipt: { payment }, createdAt: new Date(now), updatedAt: new Date(now) });
      await setState(w, { inferenceKey: key, lastPostAt: now, continuation: { progress: 'interrupted', recentSteps: [] } }, { nextAt: new Date(now + 2 * MINUTE) });
      w.inference.state.requests = { status: 'succeeded' };
      const relayCalls = () => w.inference.calls.filter((c) => c.url.includes('/v1/requests/')).length;
      await minutes(w, 1);
      expect(relayCalls()).toBe(0);
      await minutes(w, 1);
      expect(relayCalls()).toBe(1);
      const rt = await runtimeRow(w);
      expect(stateOf(rt).inferenceKey).toBeNull();
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))?.status).toBe('succeeded');
    } finally {
      await w.close();
    }
  });
});

describe('mention auto-close and a held credit', () => {
  it('leaves the inbox alone while the key is held and closes once the credit is settled', async () => {
    const { w, sim, relay } = await outage(refused);
    try {
      await seedAgent(w);
      const resolved: string[] = [];
      (w.sender.client as unknown as { resolve: unknown }).resolve = async (body: { postId: string }) => {
        resolved.push(body.postId);
        w.sender.items = w.sender.items.filter((i) => i.postId !== body.postId);
        return { item: {} };
      };
      await tick(w.ctx);
      const key = stateOf(await runtimeRow(w)).inferenceKey!;
      w.sender.items = [mention('2001', false)];

      // the retained turn retries the credit: no fresh turn, no close, no payment
      await minutes(w, 2);
      expect(relay.upstreamFetch).toHaveBeenCalledTimes(2);
      expect(stateOf(await runtimeRow(w)).inferenceKey).toBe(key);
      expect(resolved).toEqual([]);

      // a fresh turn with the key still held (the turn was lost to a crash): the guard holds, the credit is what runs
      await w.db.update(runtimes).set({ turn: null }).where(eq(runtimes.agentId, AGENT_ID));
      sim.provider = completion;
      await minutes(w, 4);
      expect(resolved).toEqual([]);
      expect(sim.signed).toBe(1);
      const settled = await runtimeRow(w);
      expect(stateOf(settled).inferenceKey).toBeNull();
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))?.status).toBe('succeeded');
      expect(settled.failures).toBe(0);

      // the key is gone: the next fresh turn closes it before paying for a thought
      await w.db.update(runtimes).set({ nextAt: new Date(w.ctx.now()) }).where(eq(runtimes.agentId, AGENT_ID));
      await minutes(w, 1);
      expect(resolved).toEqual(['2001']);
    } finally {
      await w.close();
    }
  });
});

describe('the daily image cap counts paid attempts', () => {
  it('stops new payments at the cap while the provider fails, and still lets an open credit resume', async () => {
    const { w, sim, relay } = await outage(refused);
    try {
      const agent = await seedAgent(w);
      const config = agentConfig(w.ctx.now()) as unknown as Parameters<typeof generateImage>[2];
      const attempt = (id: string) => generateImage(w.ctx, agent, config, { id } as Parameters<typeof generateImage>[3], { prompt: 'a fox', altText: 'a fox' }, 0);
      for (let i = 1; i <= MAX_IMAGES_PER_DAY; i++) {
        expect(await attempt(`act_${i}`)).toEqual({ kind: 'unknown', error: 'upstream_rejected' });
        expect(sim.signed).toBe(i);
      }
      expect(await attempt('act_new')).toEqual({ kind: 'failed', error: `image_daily_cap: at most ${MAX_IMAGES_PER_DAY} images per 24 hours` });
      expect(sim.signed).toBe(MAX_IMAGES_PER_DAY);

      // the action's own key costs nothing: resumed at the cap, it spends its credit
      const upstream = relay.upstreamFetch.mock.calls.length;
      expect((await attempt('act_1')).kind).toBe('unknown');
      expect(relay.upstreamFetch.mock.calls.length).toBe(upstream + 1);
      expect(sim.signed).toBe(MAX_IMAGES_PER_DAY);

      // the window moves on
      w.setNow(w.ctx.now() + IMAGE_WINDOW_MS + 1000);
      expect(await attempt('act_tomorrow')).toEqual({ kind: 'unknown', error: 'upstream_rejected' });
      expect(sim.signed).toBe(MAX_IMAGES_PER_DAY + 1);
    } finally {
      await w.close();
    }
  });
});
