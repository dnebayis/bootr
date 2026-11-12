/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): one
 * agent making the others think. An own agent's reply costs it nothing, and every other Bootr agent it names gets a
 * mention it may be woken for; a hosted one pays for that thought. So an own agent's replies may name other agents
 * only so often, and no agent, hosted or own, is woken by the same Bootr agent's mentions more than a few times a day.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { DueView } from '@bootr/shared/own-agent';
import { PEER_WAKE_CAP, PEER_WAKE_CAP_REASON, REPLY_NAMING_CAP, REPLY_NAMING_DAY_CAP, agentDirectory, recordPeerWakes, wakeViews } from '../src/agent-directory.js';
import { actions, runtimes } from '../src/db/schema.js';
import { initialState, type AgentState } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';
import { OTHER_AGENT_ID, act, connectClient, mention, openSocial, ownWorld, quietRuntime, seedOther, seedOwn, stateOf } from './own-helpers.js';

const HOUR = 3_600_000;
const MIN = 60_000;

/** One more Bootr agent in the directory: `@peer_<n>`, X user id 3000 + n. */
async function seedPeer(w: TestWorld, n: number) {
  const agentId = `peer-${n}`;
  const kernel = `0x${'c'.repeat(39)}${n.toString(16)}`;
  const token = `0x${'d'.repeat(39)}${n.toString(16)}`;
  await seedAgent(w, {
    agent: { agentId, kernel, token },
    config: agentConfig(w.ctx.now(), { agentId, kernel: { address: kernel }, token: { address: token, symbol: `PP${n}`, name: `Peer ${n}`, chainId: 84532 }, xHandle: `peer_${n}`, xUserId: `${3000 + n}` }),
    runtime: { agentId, status: 'paused', pausedBy: 'operator', nextAt: new Date(w.ctx.now() + 24 * HOUR) },
  });
}

describe('own agent: naming other Bootr agents in replies', () => {
  it('names the same agent in two replies a day and no more; a reply that names nobody goes out as ever', async () => {
    const w = await ownWorld();
    try {
      const quiet = quietRuntime(w.ctx.now());
      await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
      await seedPeer(w, 1);
      w.sender.items = [1, 2, 3, 4, 5].map((n) => mention(`100${n}`));
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      const reply = (postId: string, text: string) => act(w, credential, turn.turnId, 'publish_reply', { postId, text });
      expect(REPLY_NAMING_CAP).toBe(2);
      expect((await reply('1001', 'Good question. @peer_1 what would you say to that?')).body.status).toBe('completed');
      expect((await reply('1002', 'Another one for @peer_1 to weigh in on, I think.')).body.status).toBe('completed');
      const third = await reply('1003', 'And once more: @peer_1 any thoughts on this one?');
      expect(third.body.status).toBe('failed');
      expect(third.body.error).toMatch(/^bootr_agent_reply_naming_cap: your replies of the last 24 h already named @peer_1 \(\$PP1, another Bootr agent\) 2 times/);
      // A reply that names nobody goes out as ever.
      expect((await reply('1003', 'It is a test coin, thanks for asking.')).body.status).toBe('completed');
      expect(w.sender.published).toHaveLength(3);
      // A day on the count has moved past them.
      w.setNow(w.ctx.now() + 25 * HOUR);
      const guard = await import('../src/agent-directory.js');
      const pending = { id: 'act_later', cycleKey: 'cycle:later', action: { tool: 'publish_reply', input: { postId: '1004', text: '@peer_1 hello again' } }, status: 'sent', createdAt: 0, attempts: 1 } as never;
      expect(await guard.replyNamingGuard(w.ctx, { agentId: AGENT_ID }, pending, { inbox: new Map() })).toBeNull();
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('names six other agents across a day\'s replies and no more', async () => {
    const w = await ownWorld();
    try {
      const quiet = quietRuntime(w.ctx.now());
      await seedOwn(w, { config: quiet.config, runtime: quiet.runtime });
      for (let n = 1; n <= 8; n++) await seedPeer(w, n);
      w.sender.items = [1, 2, 3].map((n) => mention(`100${n}`));
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      const reply = (postId: string, text: string) => act(w, credential, turn.turnId, 'publish_reply', { postId, text });
      expect(REPLY_NAMING_DAY_CAP).toBe(6);
      expect((await reply('1001', 'Asking around: @peer_1 @peer_2 @peer_3 @peer_4 what do you make of it?')).body.status).toBe('completed');
      // Two more names would be six; three would be seven.
      const over = await reply('1002', 'And also @peer_5 @peer_6 @peer_7 while we are at it.');
      expect(over.body.status).toBe('failed');
      expect(over.body.error).toMatch(/^bootr_agent_reply_naming_day_cap: your replies of the last 24 h already named other Bootr agents 4 times, and at most 6 are allowed per day/);
      expect((await reply('1002', 'And also @peer_5 @peer_6 while we are at it.')).body.status).toBe('completed');
      expect((await reply('1003', 'One last voice: @peer_8 over to you.')).body.status).toBe('failed');
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('a hosted agent\'s replies are not held to it', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      await seedPeer(w, 1);
      const { executeAction } = await import('../src/broker/index.js');
      const config = (await import('../src/onboarding.js')).agentConfigOf(agent)!;
      const item = mention('1001');
      for (let n = 0; n < 4; n++) {
        const pending = { id: `act_h${n}`, cycleKey: `cycle:h${n}`, action: { tool: 'publish_reply', input: { postId: '1001', text: `Reply ${n} that names @peer_1 again.` } }, status: 'sent', createdAt: 0, attempts: 1 } as never;
        const out = await executeAction(w.ctx, agent, config, pending, { inbox: new Map([['1001', item]]), eligibility: new Map([['1001', { eligible: true }]]) });
        expect(out.kind).toBe('completed');
        await w.db.insert(actions).values({ actionId: `act_h${n}`, agentId: AGENT_ID, cycleKey: `cycle:h${n}`, action: { tool: 'publish_reply', input: { postId: '1001', text: `Reply ${n} that names @peer_1 again.` } }, status: 'completed', createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      }
      expect(w.sender.published).toHaveLength(4);
    } finally {
      await w.close();
    }
  });
});

describe('every agent: wakes one Bootr agent may cause another in a day', () => {
  it('marks a capped peer\'s mention not eligible for the wake only, counts a wake once per peer, and forgets after a day', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await seedPeer(w, 1);
      const directory = await agentDirectory(w.ctx, { fresh: true });
      const now = w.ctx.now();
      const views: { postId: string; authorId: string; eligible: boolean; reason?: string }[] = [
        { postId: 'a', authorId: '3001', eligible: true },
        { postId: 'b', authorId: '3001', eligible: true },
        { postId: 'c', authorId: '42', eligible: true },
      ];
      expect(PEER_WAKE_CAP).toBe(3);
      const first = recordPeerWakes(views, directory, AGENT_ID, undefined, now);
      expect(first).toEqual({ wakes: { 'peer-1': [now] }, counted: ['peer-1'] });
      const used = { 'peer-1': [now - 3 * HOUR, now - 2 * HOUR, now - HOUR] };
      expect(wakeViews(views, directory, AGENT_ID, used, now).map((v) => [v.postId, v.eligible, v.reason])).toEqual([['a', false, PEER_WAKE_CAP_REASON], ['b', false, PEER_WAKE_CAP_REASON], ['c', true, undefined]]);
      expect(wakeViews(views, directory, AGENT_ID, { 'peer-1': used['peer-1'].slice(1) }, now).every((v) => v.eligible)).toBe(true);
      // A day after the first of the three, one is free again; old entries are dropped when the next is counted.
      expect(wakeViews(views, directory, AGENT_ID, used, now + 21 * HOUR + 1).every((v) => v.eligible)).toBe(true);
      expect(recordPeerWakes(views, directory, AGENT_ID, used, now + 25 * HOUR).wakes).toEqual({ 'peer-1': [now + 25 * HOUR] });
    } finally {
      await w.close();
    }
  });

  it('a hosted agent is woken by the same Bootr agent three times a day; after that its mentions buy no thought, and a person\'s still do', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T18:00:00Z')), finishResponse(Date.parse('2026-10-24T19:00:00Z'))] });
    try {
      const now = w.ctx.now();
      const quiet = quietRuntime(now);
      // Two wakes by @peer_1 already today.
      await seedAgent(w, { config: quiet.config, runtime: { ...quiet.runtime, state: { ...initialState(), peerWakes: { 'peer-1': [now - 3 * HOUR, now - 2 * HOUR] } } as unknown as Record<string, unknown> } });
      await seedPeer(w, 1);
      const thoughts = () => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;
      const state = async () => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState;
      // Its third mention wakes the agent, and is counted.
      w.sender.items = [mention('2001', '@bootr_agent what do you think of this?', { authorId: '3001', verified: false })];
      const first = await tick(w.ctx);
      expect(first.errors).toEqual([]);
      expect(first.ran).toEqual([AGENT_ID]);
      expect(thoughts()).toBe(1);
      expect((await state()).peerWakes).toEqual({ 'peer-1': [now - 3 * HOUR, now - 2 * HOUR, now] });
      // A fourth: no turn, no thought. It waits in the inbox.
      w.setNow(now + 10 * MIN);
      w.sender.items = [mention('2002', '@bootr_agent and what about this?', { authorId: '3001', verified: false, createdAt: new Date(now + 9 * MIN).toISOString() })];
      const second = await tick(w.ctx);
      expect(second.errors).toEqual([]);
      expect(second.ran).toEqual([]);
      expect(thoughts()).toBe(1);
      // A person's mention still wakes it, and that turn is not counted against the peer again.
      w.sender.items = [...w.sender.items, mention('2003', '@bootr_agent a question from a person', { createdAt: new Date(now + 9 * MIN).toISOString() })];
      const third = await tick(w.ctx);
      expect(third.ran).toEqual([AGENT_ID]);
      expect(thoughts()).toBe(2);
      expect((await state()).peerWakes?.['peer-1']).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('an own agent\'s social turn is not made due by a capped peer either', async () => {
    const w = await ownWorld();
    try {
      const now = w.ctx.now();
      const quiet = quietRuntime(now);
      await seedOwn(w, { config: quiet.config, runtime: { ...quiet.runtime, state: { ...initialState(), peerWakes: { [OTHER_AGENT_ID]: [now - 3 * HOUR, now - 2 * HOUR] } } as unknown as Record<string, unknown> } });
      await seedOther(w, { runtime: { status: 'paused', pausedBy: 'operator' } });
      const { credential } = await connectClient(w);
      w.sender.items = [mention('2001', '@bootr_agent what do you think of this?', { authorId: '2000', verified: false })];
      expect((await w.run<DueView>('due', credential)).body.social).toMatchObject({ due: true, reasons: ['pending_mention'] });
      const turn = await openSocial(w, credential);
      expect((await stateOf(w)).peerWakes?.[OTHER_AGENT_ID]).toHaveLength(3);
      await w.run('finish', credential, { turnId: turn.turnId, memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(now + HOUR).toISOString() });
      w.setNow(now + 10 * MIN);
      w.sender.items = [mention('2002', '@bootr_agent and this?', { authorId: '2000', verified: false, createdAt: new Date(now + 9 * MIN).toISOString() })];
      expect((await w.run<DueView>('due', credential)).body.social).toMatchObject({ due: false, reasons: [] });
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});
