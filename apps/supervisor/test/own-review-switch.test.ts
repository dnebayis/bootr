/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): the
 * runner switch and what runs beside it. A row read before a switch must not buy a thought after it (the bounty judge,
 * the chat), a settings update must not put the old runner back, the hosted loop must not resume a client's turn, and a
 * switch request sent a second time must do nothing.
 */
import { DEFAULT_BOUNTIES_POLICY, parseAgentConfig } from '@bootr/agent-core';
import { OWN_ERRORS, runnerOf, type OwnErrorBody } from '@bootr/shared/own-agent';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { updateAgentConfig } from '../src/agent-config.js';
import { createApp } from '../src/api.js';
import { sweepBounties } from '../src/bounties.js';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import { sendChatMessage } from '../src/chat.js';
import { agents, bountyJobs, chatMessages, inference, runtimes } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { judgeJob } from '../src/judge.js';
import { agentConfigOf } from '../src/onboarding.js';
import { switchRunner } from '../src/own/runner-switch.js';
import { acquireLease, continueTurn, initialState, releaseLease, type AgentState, type Turn } from '../src/runtime.js';
import type { SenderConversationReply } from '../src/sender-client.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, agentConfig, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const H = 3_600_000;
const MODEL = 'openai/gpt-4.1-mini';
const ALLOWED = [MODEL, 'anthropic/claude-haiku-4.5'];
const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
const agentRow = async (w: TestWorld) => (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
/** The switch as it lands in the database, without the route: the stored config says who runs the coin. */
async function storeRunner(w: TestWorld, runner: 'own' | 'hosted'): Promise<void> {
  const row = await agentRow(w);
  await w.db.update(agents).set({ config: { ...row.config, runner, revision: (typeof row.config.revision === 'number' ? row.config.revision : 0) + 1 } }).where(eq(agents.agentId, AGENT_ID));
}
const say = (text: string) =>
  new Response(JSON.stringify({ id: 'cmpl', choices: [{ message: { role: 'assistant', content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 60 } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r', quoteMicroUsdc: '12000', chargedMicroUsdc: '12000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) },
  });

function api(w: TestWorld) {
  const nowSec = () => Math.floor(w.ctx.now() / 1000);
  const app = createApp(w.ctx, nowSec);
  return async (path: string, body: unknown) => {
    const text = JSON.stringify(body);
    const res = await app.request(path, { method: 'POST', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'POST', path, text, nowSec()) } });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };
}

describe('a coin that became own while a row read earlier was still in hand buys no thought', () => {
  it('the bounty sweep: a switch during the collection leaves the job waiting, unjudged and unpaid for', async () => {
    const ruling = JSON.stringify({ winner: 1, perCriterion: { '1': ['pass', 'pass'] }, reason: 'A single round dot in a small red hat on a plain background.' });
    const w = await makeWorld({ script: [say(ruling)] });
    try {
      createApp(w.ctx);
      const t0 = w.ctx.now();
      const base = agentConfig(t0);
      const raw = { ...base, capabilities: { ...(base.capabilities as object), bounties: true }, bounties: { ...DEFAULT_BOUNTIES_POLICY } };
      const agent = await seedAgent(w, { config: raw, runtime: { state: { ...initialState(), lastPostAt: t0 - 60_000, treasuryNextAt: t0 + 24 * H, lastTreasuryTurnAt: t0 - 60_000 } as unknown as Record<string, unknown>, nextAt: new Date(t0 + 24 * H) } });
      const pending = { id: 'act-post-1', cycleKey: 'cycle:test', action: { tool: 'bounty_post', input: { task: 'A square picture of a dot wearing a tiny hat, flat colours', criteria: ['It shows a single dot', 'The dot wears a hat'], deliverable: 'image', amountUsdc: 0.5 } }, status: 'sending', createdAt: 0, attempts: 1 } as never;
      const env: BrokerEnv = { inbox: new Map(), eligibility: new Map() };
      expect((await executeAction(w.ctx, agent, parseAgentConfig(agent.config), pending, env)).kind).toBe('completed');
      const png = Buffer.concat([Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex'), Buffer.alloc(17, 1)]);
      const entry: SenderConversationReply = {
        id: '7002',
        text: 'my entry 0x1111111111111111111111111111111111111111',
        authorId: '32',
        createdAt: new Date(t0 + 2 * 60_000).toISOString(),
        conversationId: '9001',
        inReplyToId: '9001',
        author: { id: '32', username: 'user32', createdAt: '2024-01-01T00:00:00.000Z', verified: false, verifiedType: 'none' },
        urls: [],
        media: [{ mediaKey: '3_7002', type: 'photo', url: 'https://pbs.twimg.com/media/7002.png', previewImageUrl: null }],
      };
      // The collection reads the replies at the sender; while it does, the creator's switch to their own agent lands.
      (w.sender.client as unknown as { readReplies: (agentId: string, conversationId: string) => Promise<unknown> }).readReplies = async () => {
        await storeRunner(w, 'own');
        return { items: [entry], fetched: 1, truncated: false };
      };
      const next = w.ctx.fetch;
      w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
        return url === 'https://pbs.twimg.com/media/7002.png' ? new Response(png, { status: 200, headers: { 'content-type': 'image/png' } }) : next(input, init);
      }) as typeof fetch;
      w.setNow(t0 + 6 * H + 1);
      await sweepBounties(w.ctx);
      expect(runnerOf((await agentRow(w)).config)).toBe('own');
      expect(thoughts(w)).toHaveLength(0);
      expect(await w.db.select().from(inference)).toHaveLength(0);
      const [job] = await w.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, AGENT_ID));
      expect(job).toMatchObject({ status: 'judging', entriesConsidered: 1 });
      expect(job!.verdict ?? null).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('the judge itself asks the stored config, not only the row it was handed', async () => {
    const w = await makeWorld({ script: [say('{}')] });
    try {
      const stale = await seedAgent(w);
      await storeRunner(w, 'own');
      const verdict = await judgeJob(w.ctx, stale, parseAgentConfig(stale.config), { jobId: `0x${'a'.repeat(64)}`, task: 'A public page that explains how Base fees are set', criteria: ['It explains the base fee'], entries: [{ n: 1, kind: 'link', excerpt: 'a page' }] });
      expect(verdict).toMatchObject({ winner: null, invalid: 'thought_pending' });
      expect(thoughts(w)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('the chat: a message whose request was read before the switch is answered chat_not_available, and nothing is reserved or bought', async () => {
    const w = await makeWorld({ script: [say('We posted twice today.')] });
    try {
      const stale = await seedAgent(w, { config: { model: 'anthropic/claude-sonnet-4.6' } });
      await storeRunner(w, 'own');
      const res = await sendChatMessage(w.ctx, stale, { by: CREATOR, text: 'When did the pool open?' });
      expect(res).toMatchObject({ ok: false, status: 409, error: 'chat_not_available', message: OWN_ERRORS.chat_not_available.message });
      expect(thoughts(w)).toHaveLength(0);
      expect(await w.db.select().from(chatMessages)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });
});

describe('a settings update and a runner switch that overlap', () => {
  it('the update writes its own fields onto the settings as they are stored, so the switch that landed meanwhile stands', async () => {
    const w = await makeWorld();
    try {
      (w.ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED = true;
      // The config route read the row; the switch to the creator's own agent completes before the update writes.
      const stale = await seedAgent(w);
      const before = typeof stale.config.revision === 'number' ? stale.config.revision : 0;
      const switched = await switchRunner(w.ctx, stale, { runner: 'own', by: CREATOR, allowedModels: ALLOWED }, { leaseWaitMs: 60, leasePollMs: 10 });
      expect(switched).toMatchObject({ ok: true, response: { runner: 'own', revision: before + 1 } });
      const result = await updateAgentConfig(w.ctx, stale, { by: CREATOR, instructions: 'Speak plainly, post about the coin and answer every honest question.' });
      expect(result).toMatchObject({ ok: true, fields: ['instructions'], config: { runner: 'own', revision: before + 2 } });
      const stored = (await agentRow(w)).config;
      expect(runnerOf(stored)).toBe('own');
      expect(stored.revision).toBe(before + 2);
      expect(stored.creatorIdentity).toBe('Speak plainly, post about the coin and answer every honest question.');
      // ...and the other way round: a switch decided on a row from before the update keeps what the update wrote.
      const back = await switchRunner(w.ctx, stale, { runner: 'own', by: CREATOR, allowedModels: ALLOWED }, { leaseWaitMs: 60, leasePollMs: 10 });
      expect(back).toMatchObject({ ok: false, body: { error: 'runner_unchanged' } });
      await storeRunner(w, 'hosted');
      const again = await switchRunner(w.ctx, stale, { runner: 'own', by: CREATOR, allowedModels: ALLOWED }, { leaseWaitMs: 60, leasePollMs: 10 });
      expect(again).toMatchObject({ ok: true, response: { runner: 'own', revision: before + 4 } });
      expect((await agentRow(w)).config.creatorIdentity).toBe('Speak plainly, post about the coin and answer every honest question.');
    } finally {
      await w.close();
    }
  });

  it('the hosted loop does not resume a turn a client opened: it is dropped with a continuation note and no thought is bought on it', async () => {
    const w = await makeWorld({ script: [say('a thought nobody should buy')] });
    try {
      const now = w.ctx.now();
      const turn = { role: 'social', startedAt: now - 60_000, steps: 1, nudged: false, reasons: ['pending_mention'], messages: [], inbox: {}, recentSteps: [{ tool: 'read_mentions', status: 'completed', summary: 'one mention' }], own: { turnId: `otn_${'a'.repeat(32)}`, clientId: 'cli_x', openedAt: now - 60_000, lastCallAt: now - 30_000, forced: false }, ownOpen: { brief: 'b', observation: {}, tools: ['read_mentions'] }, ownCalls: [] } as unknown as Turn;
      // A hosted coin with an own turn stored on it: what an undone switch used to leave behind.
      const agent = await seedAgent(w, { runtime: { status: 'running', turn: turn as unknown as Record<string, unknown> } });
      const lease = 'test-lease';
      const leased = (await acquireLease(w.ctx, AGENT_ID, lease))!;
      try {
        expect(await continueTurn(w.ctx, agent, leased, agentConfigOf(agent)!, lease)).toBeNull();
      } finally {
        await releaseLease(w.ctx, AGENT_ID, lease);
      }
      expect(thoughts(w)).toHaveLength(0);
      const after = await runtimeRow(w);
      expect(after.turn).toBeNull();
      expect(after.status).toBe('waiting');
      expect((after.state as unknown as AgentState).continuation).toMatchObject({ progress: expect.stringContaining('Turn ended by the runtime'), recentSteps: [{ tool: 'read_mentions' }] });
    } finally {
      await w.close();
    }
  });
});

describe('a runner switch request sent twice', () => {
  it('names the revision it was decided on, so the second copy does nothing once the first has been taken', async () => {
    const w = await makeWorld();
    try {
      (w.ctx.config as unknown as Record<string, unknown>).OWN_AGENT_ENABLED = true;
      const seeded = await seedAgent(w, { config: { model: MODEL } });
      const r0 = typeof seeded.config.revision === 'number' ? seeded.config.revision : 0;
      const post = api(w);
      const path = `/internal/agents/${AGENT_ID}/runner`;
      const toOwn = { runner: 'own', by: CREATOR, allowedModels: ALLOWED, expectedRevision: r0 };
      expect(await post(path, toOwn)).toMatchObject({ status: 200, body: { runner: 'own', revision: r0 + 1 } });
      // The creator switches back.
      expect(await post(path, { runner: 'hosted', by: CREATOR, allowedModels: ALLOWED, expectedRevision: r0 + 1 })).toMatchObject({ status: 200, body: { runner: 'hosted', revision: r0 + 2 } });
      // The captured first request, byte for byte, inside the HMAC window: refused, and the coin stays with Bootr.
      const replay = await post(path, toOwn);
      expect(replay.status).toBe(409);
      expect(replay.body as unknown as OwnErrorBody).toEqual({ error: 'settings_changed', message: OWN_ERRORS.settings_changed.message });
      const stored = (await agentRow(w)).config;
      expect(runnerOf(stored)).toBe('hosted');
      expect(stored.revision).toBe(r0 + 2);
      // A revision that is not one is refused as a bad request; a request without one is taken as before (an older web).
      expect((await post(path, { runner: 'own', by: CREATOR, allowedModels: ALLOWED, expectedRevision: 'latest' })).body).toMatchObject({ error: 'invalid_request', field: 'expectedRevision' });
      expect(runnerOf((await agentRow(w)).config)).toBe('hosted');
      expect(await post(path, { runner: 'own', by: CREATOR, allowedModels: ALLOWED })).toMatchObject({ status: 200, body: { runner: 'own', revision: r0 + 3 } });
    } finally {
      await w.close();
    }
  });
});
