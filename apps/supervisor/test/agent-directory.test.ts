import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig, type PendingAction } from '@bootr/agent-core';
import { AGENT_REPLY_CAP, BOOTR_AGENTS_MEANING, NEW_THREAD_CAP, PLATFORM_REPLY_CAP, agentDirectory, bootrAgentOf, bootrAgentsSection, buildAgentDirectory, conversationGuard, mentionedBootrAgents, repliesToAgentInThread, threadsStartedWith } from '../src/agent-directory.js';
import { queueForApproval } from '../src/approvals.js';
import { inboxViews, type BrokerEnv } from '../src/broker/index.js';
import { actions, agents, approvals } from '../src/db/schema.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, agentConfig, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const OWL_KERNEL = '0x00000000000000000000000000000000000000aa';
const OWL_TOKEN = '0x00000000000000000000000000000000000000ab';
const FOX_KERNEL = '0x00000000000000000000000000000000000000bb';
const FOX_TOKEN = '0x00000000000000000000000000000000000000bc';

/** Another Bootr agent row (the OWL coin's agent, @OwlAgent, X user 2000) registered `ageMs` ago. */
async function seedPeer(w: TestWorld, over: { agentId?: string; kernel?: string; token?: string; handle?: string; xUserId?: string; symbol?: string; ageMs?: number; status?: 'active' | 'paused' | 'revoked' | 'onboarding'; platform?: boolean } = {}) {
  const now = w.ctx.now();
  const agentId = over.agentId ?? '8';
  const kernel = over.kernel ?? OWL_KERNEL;
  const token = over.token ?? OWL_TOKEN;
  const config = agentConfig(now, {
    agentId,
    token: { address: token, symbol: over.symbol ?? 'OWL', name: `${over.symbol ?? 'OWL'} Coin`, chainId: 84532 },
    kernel: { address: kernel },
    xHandle: over.handle ?? 'OwlAgent',
    xUserId: over.xUserId ?? '2000',
    ...(over.platform ? { platform: true } : {}),
  });
  const at = new Date(now - (over.ageMs ?? 2 * H));
  const [row] = await w.db.insert(agents).values({ agentId, token, kernel, creator: CREATOR, config, status: over.status ?? 'active', createdAt: at, updatedAt: at }).returning();
  return row!;
}

/** A mention addressed to the test agent (@bootr_agent) from X user `authorId`; unverified unless said otherwise. */
function mention(postId: string, authorId: string, text: string, over: { conversationId?: string; username?: string; verified?: boolean } = {}): SenderInboxItem {
  const conversationId = over.conversationId ?? postId;
  return {
    postId,
    authorId,
    conversationId,
    status: 'pending',
    observedAt: '2026-10-24T11:59:00Z',
    seenAt: null,
    deferredUntil: null,
    post: {
      id: postId,
      authorId,
      text,
      createdAt: '2026-10-24T11:58:00Z',
      conversationId,
      author: { id: authorId, username: over.username ?? `user${authorId}`, verified: over.verified ?? false, verifiedType: over.verified ? 'blue' : 'none' },
    },
  };
}

/** A reply this agent already gave `authorId` in thread `conversationId`, `agoMs` ago. */
async function seedReply(w: TestWorld, id: string, conversationId: string, authorId: string, agoMs: number, status: 'completed' | 'held' | 'failed' = 'completed') {
  const at = new Date(w.ctx.now() - agoMs);
  await w.db.insert(actions).values({ actionId: id, agentId: AGENT_ID, cycleKey: `k:${id}`, action: { tool: 'publish_reply', input: { postId: '1', text: 'earlier answer' } }, status, result: { postId: '9', replyAuthorId: authorId, conversationId }, createdAt: at, updatedAt: at });
}

async function seedOriginal(w: TestWorld, id: string, text: string, agoMs: number, status: 'completed' | 'sending' | 'failed' = 'completed') {
  const at = new Date(w.ctx.now() - agoMs);
  await w.db.insert(actions).values({ actionId: id, agentId: AGENT_ID, cycleKey: `k:${id}`, action: { tool: 'publish_post', input: { text } }, status, createdAt: at, updatedAt: at });
}

const pending = (id: string, tool: 'publish_post' | 'publish_reply', input: Record<string, unknown>): PendingAction => ({ id, cycleKey: `cycle:${id}`, action: { tool, input } as PendingAction['action'], status: 'sent', createdAt: 0, attempts: 1 });
const env = (...items: SenderInboxItem[]): BrokerEnv => ({ inbox: new Map(items.map((i) => [i.postId, i])), eligibility: new Map(), cycle: 1 });

function observations(w: TestWorld): Record<string, unknown>[] {
  return w.inference.calls
    .filter((c) => c.url.includes('/v1/chat/completions'))
    .map((c) => JSON.parse((c.body as { messages: { role: string; content: string }[] }).messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>);
}

function toolMessages(w: TestWorld): string[] {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
  return body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

describe('the Bootr agents directory', () => {
  it('lists every agent with an X account that is not revoked, newest first, by user id and lowercase handle', () => {
    const row = (agentId: string, handle: unknown, xUserId: unknown, ageMs: number, status: 'active' | 'paused' | 'revoked' | 'onboarding' = 'active', extra: Record<string, unknown> = {}) => ({
      agentId,
      kernel: `0x${agentId.padStart(40, '0')}`.toUpperCase().replace('0X', '0x'),
      token: `0x${agentId.padStart(39, '0')}b`,
      status,
      createdAt: new Date(T0 - ageMs),
      config: { xHandle: handle, xUserId, token: { symbol: `S${agentId}`, name: `Coin ${agentId}` }, ...extra },
    });
    const dir = buildAgentDirectory(
      [
        row('1', 'AgentBootr', '1', 10 * H, 'active', { platform: true }),
        row('2', 'OwlAgent', '2000', 2 * H),
        row('3', 'gone', '3000', 1 * H, 'revoked'),
        row('4', null, null, 1 * H, 'onboarding'),
        row('5', '@FoxAgent', '5000', 5 * H, 'paused'),
        row('6', 'bad handle!', '6000', 1 * H),
        row('7', 'nouserid', 'abc', 1 * H),
      ],
      T0,
    );
    expect(dir.entries.map((e) => e.agentId)).toEqual(['2', '5', '1']);
    expect(dir.entries[0]).toMatchObject({ handle: 'owlagent', xUserId: '2000', symbol: 'S2', name: 'Coin 2', platform: false, launchedAt: T0 - 2 * H });
    expect(dir.entries[1]).toMatchObject({ handle: 'foxagent', kernel: '0x0000000000000000000000000000000000000005' });
    expect(dir.entries[2]).toMatchObject({ handle: 'agentbootr', platform: true });
    expect(dir.byUserId.get('2000')?.agentId).toBe('2');
    expect(dir.byHandle.get('foxagent')?.agentId).toBe('5');
    expect(bootrAgentOf(dir, '2000', '1')?.handle).toBe('owlagent');
    expect(bootrAgentOf(dir, '2000', '2')).toBeNull(); // never itself
    expect(bootrAgentOf(dir, '42', '1')).toBeNull();
    expect(mentionedBootrAgents(dir, 'Hey @OwlAgent and @foxagent, also @stranger and @OwlAgent again', '1').map((e) => e.agentId)).toEqual(['2', '5']);
    expect(mentionedBootrAgents(dir, 'talking to myself @AgentBootr', '1')).toEqual([]);
  });

  it('is read once per tick from sv_agents and shared', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await seedPeer(w);
      const a = await agentDirectory(w.ctx);
      expect(a.entries.map((e) => e.handle).sort()).toEqual(['bootr_agent', 'owlagent']);
      await seedPeer(w, { agentId: '9', kernel: FOX_KERNEL, token: FOX_TOKEN, handle: 'FoxAgent', xUserId: '3000', symbol: 'FOX' });
      expect((await agentDirectory(w.ctx)).entries).toHaveLength(2); // cached within the tick
      expect((await agentDirectory(w.ctx, { fresh: true })).entries).toHaveLength(3);
      w.setNow(w.ctx.now() + 61_000);
      expect((await agentDirectory(w.ctx)).entries).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('marks inbox messages from another Bootr agent and lets it be answered without a verified badge', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await seedPeer(w);
      const config = parseAgentConfig(agentConfig(w.ctx.now()));
      const items = [mention('1001', '2000', '@bootr_agent what does your coin do?', { username: 'OwlAgent' }), mention('1002', '42', '@bootr_agent hello', { username: 'user42' }), mention('1003', '43', '@bootr_agent hi', { username: 'user43', verified: true })];
      const without = inboxViews(config, items, w.ctx.now());
      expect(without.map((v) => v.eligible)).toEqual([false, false, true]);
      expect(without[0]!.bootrAgent).toBeUndefined();
      const views = inboxViews(config, items, w.ctx.now(), await agentDirectory(w.ctx));
      expect(views.map((v) => v.eligible)).toEqual([true, false, true]);
      expect(views[0]!.bootrAgent).toEqual({ handle: 'owlagent', symbol: 'OWL', platform: false });
      expect(views[1]!.reason).toBe('verified_audience_required');
      expect(views[2]!.bootrAgent).toBeUndefined();
    } finally {
      await w.close();
    }
  });
});

describe('agent-to-agent caps', () => {
  it('counts replies by thread and author, and new threads by mentioned handle, over 24 h', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      await seedReply(w, 'r1', 'T1', '2000', 1 * H);
      await seedReply(w, 'r2', 'T1', '2000', 2 * H, 'held');
      await seedReply(w, 'r3', 'T1', '2000', 25 * H); // too old
      await seedReply(w, 'r4', 'T2', '2000', 1 * H); // other thread
      await seedReply(w, 'r5', 'T1', '3000', 1 * H); // other author
      await seedReply(w, 'r6', 'T1', '2000', 1 * H, 'failed'); // refused: never went out
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T1', '2000', now)).toBe(2);
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T2', '2000', now)).toBe(1);
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T1', '4000', now)).toBe(0);
      await seedOriginal(w, 'o1', 'Hey @OwlAgent, what are you building?', 3 * H);
      await seedOriginal(w, 'o2', 'A plain post about the weather', 1 * H);
      await seedOriginal(w, 'o3', '@owlagent again, from yesterday', 25 * H);
      await seedOriginal(w, 'o4', '@OwlAgent refused post', 1 * H, 'failed');
      await seedOriginal(w, 'o5', 'mail@owlagent.example is not a mention', 1 * H);
      expect(await threadsStartedWith(w.ctx, AGENT_ID, 'owlagent', now)).toBe(1);
      expect(await threadsStartedWith(w.ctx, AGENT_ID, 'owlagent', now, { excludeActionId: 'o1' })).toBe(0);
      expect(await threadsStartedWith(w.ctx, AGENT_ID, 'foxagent', now)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('refuses the third answer to a Bootr agent in one thread (the second for the platform account) with a clear error', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      await seedPeer(w);
      const owl = mention('1001', '2000', '@bootr_agent and then?', { conversationId: 'T1', username: 'OwlAgent' });
      const human = mention('1002', '42', '@bootr_agent and then?', { conversationId: 'T1', username: 'user42', verified: true });
      const reply = (id: string, postId: string) => pending(id, 'publish_reply', { postId, text: 'An answer.' });
      const coin = { platform: false };
      expect(await conversationGuard(w.ctx, agent, coin, reply('a1', '1001'), env(owl))).toBeNull();
      await seedReply(w, 'r1', 'T1', '2000', 2 * H);
      expect(await conversationGuard(w.ctx, agent, coin, reply('a2', '1001'), env(owl))).toBeNull();
      await seedReply(w, 'r2', 'T1', '2000', 1 * H);
      const capped = await conversationGuard(w.ctx, agent, coin, reply('a3', '1001'), env(owl));
      expect(capped).toMatchObject({ kind: 'failed' });
      expect((capped as { error: string }).error).toMatch(/^bootr_agent_reply_cap: you have already answered @owlagent \(\$OWL, another Bootr agent\) 2 times in this thread.*resolve_mention/);
      // humans are not capped; a reply to something not in the inbox is left to the sender
      expect(await conversationGuard(w.ctx, agent, coin, reply('a4', '1002'), env(owl, human))).toBeNull();
      expect(await conversationGuard(w.ctx, agent, coin, reply('a5', '1001'), env())).toBeNull();
      // another thread with the same agent starts its own count
      expect(await conversationGuard(w.ctx, agent, coin, reply('a6', '1003'), env(mention('1003', '2000', '@bootr_agent new thread', { conversationId: 'T2', username: 'OwlAgent' })))).toBeNull();
      // the platform account answers once
      const platform = { platform: true };
      expect(await conversationGuard(w.ctx, agent, platform, reply('p1', '1003'), env(mention('1003', '2000', '@bootr_agent new thread', { conversationId: 'T2', username: 'OwlAgent' })))).toBeNull();
      await seedReply(w, 'r3', 'T2', '2000', 1 * H);
      const once = await conversationGuard(w.ctx, agent, platform, reply('p2', '1003'), env(mention('1003', '2000', '@bootr_agent new thread', { conversationId: 'T2', username: 'OwlAgent' })));
      expect((once as { error: string }).error).toMatch(/^bootr_agent_reply_cap: .*once in this thread, the most allowed for the platform account/);
      expect(AGENT_REPLY_CAP).toBe(2);
      expect(PLATFORM_REPLY_CAP).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('refuses a second original post naming the same Bootr agent within 24 h', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      await seedPeer(w);
      await seedPeer(w, { agentId: '9', kernel: FOX_KERNEL, token: FOX_TOKEN, handle: 'FoxAgent', xUserId: '3000', symbol: 'FOX' });
      const post = (id: string, text: string) => pending(id, 'publish_post', { text });
      const coin = { platform: false };
      expect(await conversationGuard(w.ctx, agent, coin, post('o1', 'Hey @OwlAgent, what are you building?'), env())).toBeNull();
      await seedOriginal(w, 'o1', 'Hey @OwlAgent, what are you building?', 1000);
      // the caller's own row (resumed step) does not count against it
      expect(await conversationGuard(w.ctx, agent, coin, post('o1', 'Hey @OwlAgent, what are you building?'), env())).toBeNull();
      const capped = await conversationGuard(w.ctx, agent, coin, post('o2', 'Hey @owlagent, and what else?'), env());
      expect((capped as { error: string }).error).toMatch(/^bootr_agent_thread_cap: you already started a conversation with @owlagent \(\$OWL, another Bootr agent\) in the last 24 h/);
      // another agent, a stranger, or no mention at all: fine
      expect(await conversationGuard(w.ctx, agent, coin, post('o3', 'Hey @FoxAgent, what are you building?'), env())).toBeNull();
      expect(await conversationGuard(w.ctx, agent, coin, post('o4', 'Hey @stranger, hello'), env())).toBeNull();
      expect(await conversationGuard(w.ctx, agent, coin, post('o5', 'Just a thought.'), env())).toBeNull();
      // tomorrow it is allowed again
      w.setNow(w.ctx.now() + 24 * H + 1000);
      expect(await conversationGuard(w.ctx, agent, coin, post('o6', 'Hey @OwlAgent, a day later'), env())).toBeNull();
      expect(NEW_THREAD_CAP).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('applies to posts queued for the creator\'s review too (a queued reply counts; the capped one is refused)', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: { platform: true, requireApproval: true } });
      await seedPeer(w);
      const owl = mention('1001', '2000', '@bootr_agent we build owls', { conversationId: 'T1', username: 'OwlAgent' });
      const first = await queueForApproval(w.ctx, agent, pending('q1', 'publish_reply', { postId: '1001', text: 'Owls, noted.' }), env(owl));
      expect(first).toMatchObject({ kind: 'completed', result: { queued: true, replyAuthorId: '2000', conversationId: 'T1' } });
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T1', '2000', w.ctx.now())).toBe(0); // the runtime records the action row, not the queue
      const now = w.ctx.now();
      await w.db.insert(actions).values({ actionId: 'q1', agentId: AGENT_ID, cycleKey: 'k:q1', action: { tool: 'publish_reply', input: { postId: '1001', text: 'Owls, noted.' } }, status: 'completed', result: { actionId: 'q1', tool: 'publish_reply', status: 'completed', result: first.kind === 'completed' ? first.result : null }, createdAt: new Date(now), updatedAt: new Date(now) });
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T1', '2000', now)).toBe(1);
      const second = await queueForApproval(w.ctx, agent, pending('q2', 'publish_reply', { postId: '1001', text: 'And another thing about owls.' }), env(owl));
      expect(second.kind).toBe('failed');
      expect((second as { error: string }).error).toMatch(/^bootr_agent_reply_cap: .*once in this thread, the most allowed for the platform account/);
      expect(await w.db.query.approvals.findFirst({ where: eq(approvals.id, 'q2') })).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('renders the bootrAgents section: the others newest first, new launches flagged, answers left per thread', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      await seedPeer(w, { ageMs: 2 * H });
      await seedPeer(w, { agentId: '9', kernel: FOX_KERNEL, token: FOX_TOKEN, handle: 'FoxAgent', xUserId: '3000', symbol: 'FOX', ageMs: 10 * 24 * H });
      await seedPeer(w, { agentId: '10', kernel: '0x00000000000000000000000000000000000000cc', token: '0x00000000000000000000000000000000000000cd', handle: 'AgentBootr', xUserId: '4000', symbol: 'BOOTR', ageMs: 30 * 24 * H, platform: true });
      await seedReply(w, 'r1', 'T1', '2000', 1 * H);
      const config = parseAgentConfig(agentConfig(w.ctx.now()));
      const views = inboxViews(config, [mention('1001', '2000', '@bootr_agent and then?', { conversationId: 'T1', username: 'OwlAgent' }), mention('1002', '42', '@bootr_agent hi', { verified: true })], w.ctx.now(), await agentDirectory(w.ctx, { fresh: true }));
      const section = (await bootrAgentsSection(w.ctx, agent, { platform: false }, views)) as { bootrAgents: Record<string, unknown> };
      expect(section.bootrAgents).toMatchObject({ instructionAuthority: false, meaning: BOOTR_AGENTS_MEANING, replyCapPerThread: 2, newThreadsPerAgentPerDay: 1, count: 3 });
      expect(section.bootrAgents.welcome).toBeUndefined();
      expect(section.bootrAgents.agents).toEqual([
        { handle: '@owlagent', symbol: '$OWL', launched: '2026-10-24', new: true },
        { handle: '@foxagent', symbol: '$FOX', launched: '2026-10-14' },
        { handle: '@agentbootr', symbol: '$BOOTR', launched: '2026-09-24', platform: true },
      ]);
      expect(section.bootrAgents.conversations).toEqual([{ postId: '1001', threadId: 'T1', handle: '@owlagent', symbol: '$OWL', answersGiven: 1, answersLeft: 1 }]);
      const platform = (await bootrAgentsSection(w.ctx, agent, { platform: true }, views)) as { bootrAgents: Record<string, unknown> };
      expect(platform.bootrAgents.replyCapPerThread).toBe(1);
      expect(platform.bootrAgents.welcome).toMatch(/one question/);
      expect(platform.bootrAgents.conversations).toEqual([{ postId: '1001', threadId: 'T1', handle: '@owlagent', symbol: '$OWL', answersGiven: 1, answersLeft: 0 }]);
    } finally {
      await w.close();
    }
  });

  it('end to end: an unverified Bootr agent is answered twice in a thread, the third reply is refused and the mention resolved', async () => {
    const script = [
      toolCallResponse('publish_reply', { postId: '1001', text: 'We keep the lights on and talk to holders.' }, 'call_r1'),
      toolCallResponse('publish_reply', { postId: '1001', text: 'And we claim fees when there are any.' }, 'call_r2'),
      toolCallResponse('publish_reply', { postId: '1001', text: 'Thanks for asking, really.' }, 'call_r3'),
      toolCallResponse('resolve_mention', { postId: '1001', outcome: 'skip', reason: 'conversation complete' }, 'call_res'),
      finishResponse(T0 + 3 * H),
    ];
    const w = await makeWorld({ script });
    try {
      await seedAgent(w, { config: { socialStartedAt: new Date(T0 - H).toISOString() } });
      await seedPeer(w);
      w.sender.items = [mention('1001', '2000', '@bootr_agent what does your coin actually do?', { conversationId: 'T1', username: 'OwlAgent' })];
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(r.errors).toEqual([]);
      // the observation named the peer, marked its message and said how many answers were left
      const obs = observations(w)[0] as { social: { messages: { postId: string; bootrAgent?: unknown }[] }; bootrAgents: { agents: unknown[]; conversations: unknown[] } };
      expect(obs.social.messages).toHaveLength(1);
      expect(obs.social.messages[0]!.bootrAgent).toEqual({ handle: 'owlagent', symbol: 'OWL', platform: false });
      expect(obs.bootrAgents.agents).toEqual([{ handle: '@owlagent', symbol: '$OWL', launched: '2026-10-24', new: true }]);
      expect(obs.bootrAgents.conversations).toEqual([{ postId: '1001', threadId: 'T1', handle: '@owlagent', symbol: '$OWL', answersGiven: 0, answersLeft: 2 }]);
      // two replies went out, eligible without a badge; the third was refused with the cap error
      expect(w.sender.published).toHaveLength(2);
      expect(w.sender.published[0]).toMatchObject({ replyTo: '1001', replyAuthorId: '2000', replyEligibility: { eligible: true } });
      const tools = toolMessages(w);
      expect(tools[0]).toMatch(/"postId":"9001"/);
      expect(tools[0]).toMatch(/"conversationId":"T1"/);
      expect(tools[2]).toMatch(/bootr_agent_reply_cap/);
      expect(tools[2]).toMatch(/"status":"failed"/);
      expect(tools[3]).toMatch(/"outcome":"skip"/);
      const rows = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      const replies = rows.filter((a) => (a.action as { tool: string }).tool === 'publish_reply');
      expect(replies.map((a) => a.status).sort()).toEqual(['completed', 'completed', 'failed']);
      expect(await repliesToAgentInThread(w.ctx, AGENT_ID, 'T1', '2000', w.ctx.now())).toBe(2);
    } finally {
      await w.close();
    }
  });
});
