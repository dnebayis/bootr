/**
 * A coin agent's own wake (the `nextAt` of its `finish`) never comes before its cadence. On 2026-11-08 two coin agents
 * on Haiku woke every five to seven minutes, each wake a read_mentions and a finish (about $0.04), with nothing due:
 * the sender's mention reads are throttled to one per five minutes and answer `nextReadAt`, and the model wrote that
 * time into its finish. Mentions wake the agent through the tick and a due post through the schedule, so the floor is
 * the next original-post slot, or the cadence; a mention deferred to a `reviewAt` is the one reason to come back
 * sooner. The platform agent keeps its own choice.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig } from '@bootr/agent-core';
import { pino } from 'pino';
import { actions, runtimes } from '../src/db/schema.js';
import { jitterMs } from '../src/rhythm.js';
import { coinWakeFloor, errorCodeOf, initialState } from '../src/runtime.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, KERNEL, agentConfig, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const JITTER = jitterMs(KERNEL, 2 * H);

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function captureLog(w: TestWorld): Record<string, unknown>[] {
  const lines: Record<string, unknown>[] = [];
  (w.ctx as { log: unknown }).log = pino({ level: 'info' }, { write: (s: string) => void lines.push(JSON.parse(s) as Record<string, unknown>) });
  return lines;
}

const thoughts = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;

function mention(postId: string, at: number): SenderInboxItem {
  return {
    postId,
    authorId: '42',
    conversationId: postId,
    status: 'pending' as const,
    observedAt: new Date(at).toISOString(),
    seenAt: null,
    deferredUntil: null,
    post: { id: postId, authorId: '42', text: '@bootr_agent hello?', createdAt: new Date(at).toISOString(), conversationId: postId, author: { id: '42', username: 'user42', verified: true, verifiedType: 'blue' } },
  };
}

describe('coinWakeFloor', () => {
  const config = parseAgentConfig(agentConfig(T0, { socialStartedAt: new Date(T0 - 3 * H).toISOString() }));
  it('is the next slot when one lies ahead, one cadence when none does, the deferred reviewAt when sooner, nothing for the platform agent', () => {
    // posted just now: the next slot is now + interval + jitter
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 }, {}, T0)).toEqual({ at: T0 + 2 * H + JITTER, reason: 'next_slot' });
    // woke for a mention half way through the cycle: the slot that was already ahead
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 - H }, {}, T0)).toEqual({ at: T0 + H + JITTER, reason: 'next_slot' });
    // the slot is due (held by the platform, say): the tick wakes it when it opens; its own wake is a cadence away
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 - 5 * H }, {}, T0)).toEqual({ at: T0 + 2 * H, reason: 'cadence' });
    // publishing off: the cadence still paces it
    const noPublish = parseAgentConfig(agentConfig(T0, { capabilities: { xRead: true, xReply: true, xPublish: false, research: false, memory: true, treasury: true, images: false } }));
    expect(coinWakeFloor(noPublish, initialState(), {}, T0)).toEqual({ at: T0 + 2 * H, reason: 'cadence' });
    // a mention deferred to half an hour from now is a concrete reason; one past the slot is not
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 }, { reviewAt: new Date(T0 + 30 * MIN).toISOString() }, T0)).toEqual({ at: T0 + 30 * MIN, reason: 'review_at' });
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 }, { reviewAt: new Date(T0 + 5 * H).toISOString() }, T0)).toEqual({ at: T0 + 2 * H + JITTER, reason: 'next_slot' });
    expect(coinWakeFloor(config, { ...initialState(), lastPostAt: T0 }, { reviewAt: 'soon' }, T0)).toEqual({ at: T0 + 2 * H + JITTER, reason: 'next_slot' });
    // the platform agent's rhythm is its own
    expect(coinWakeFloor({ ...config, platform: true }, { ...initialState(), lastPostAt: T0 }, {}, T0)).toBeNull();
  });

  it('moves past a slot a scheduled post covers, to the slot after that post, and past each further one in turn', () => {
    const posted = { ...initialState(), lastPostAt: T0 };
    const slot = T0 + 2 * H + JITTER;
    const after = (at: number) => at + 2 * H + JITTER;
    // nothing scheduled, or only posts that are already past: the floor of before
    expect(coinWakeFloor(config, posted, {}, T0, [])).toEqual({ at: slot, reason: 'next_slot' });
    expect(coinWakeFloor(config, posted, {}, T0, [T0 - H, T0])).toEqual({ at: slot, reason: 'next_slot' });
    // a post scheduled for the slot, a little before it or within one interval after it holds that slot: the wake is the slot after the post
    for (const at of [slot, slot - 20 * MIN, T0 + 2 * H, slot + 90 * MIN, slot + 2 * H]) expect([at, coinWakeFloor(config, posted, {}, T0, [at])]).toEqual([at, { at: after(at), reason: 'after_scheduled' }]);
    // one further away than an interval after the slot leaves the slot to the agent
    expect(coinWakeFloor(config, posted, {}, T0, [slot + 2 * H + MIN])).toEqual({ at: slot, reason: 'next_slot' });
    // a queue of posts one interval apart: the wake is the slot after the last of them, whatever order they are given in
    const queue = [T0 + 2 * H, T0 + 4 * H, T0 + 6 * H];
    expect(coinWakeFloor(config, posted, {}, T0, queue)).toEqual({ at: after(T0 + 6 * H), reason: 'after_scheduled' });
    expect(coinWakeFloor(config, posted, {}, T0, [...queue].reverse())).toEqual({ at: after(T0 + 6 * H), reason: 'after_scheduled' });
    // a gap in the queue of more than an interval stops it there: the slot in the gap is the agent's
    expect(coinWakeFloor(config, posted, {}, T0, [T0 + 2 * H, T0 + 9 * H])).toEqual({ at: after(T0 + 2 * H), reason: 'after_scheduled' });
    // a deferred mention is still the one reason to come back sooner, and the platform agent keeps its own choice
    expect(coinWakeFloor(config, posted, { reviewAt: new Date(T0 + 30 * MIN).toISOString() }, T0, queue)).toEqual({ at: T0 + 30 * MIN, reason: 'review_at' });
    expect(coinWakeFloor({ ...config, platform: true }, posted, {}, T0, queue)).toBeNull();
  });

  it('errorCodeOf keeps the code at the head of a tool error and drops the explanation', () => {
    expect(errorCodeOf('sender_rejected:forbidden(403): You are not permitted to perform this action.')).toBe('sender_rejected:forbidden(403)');
    expect(errorCodeOf('sender_rejected:policy:social_execution_command_forbidden')).toBe('sender_rejected:policy:social_execution_command_forbidden');
    expect(errorCodeOf('mention_unknown_account: @nobody is not an account on X; name the source instead')).toBe('mention_unknown_account');
    expect(errorCodeOf("quiet_hours: original posts wait during Bootr's quiet hours")).toBe('quiet_hours');
    expect(errorCodeOf(null)).toBe('');
  });
});

describe('the wake floor in a turn', () => {
  it("reproduces the churn and bounds it: a finish at the sender's nextReadAt is moved to the next slot, and the agent is not bought again before it", async () => {
    // a throttled mention read answers nextReadAt five minutes out (SENDER_DEFAULT_MENTION_INTERVAL_SEC); the model echoes it
    const nextReadAt = new Date(T0 + 5 * MIN).toISOString();
    const w = await makeWorld({ script: [toolCallResponse('read_mentions', {}), finishResponse(T0 + 5 * MIN), toolCallResponse('read_mentions', {}), finishResponse(T0 + 10 * H)] });
    try {
      const lines = captureLog(w);
      const now = w.ctx.now();
      w.sender.nextReadAt = nextReadAt;
      // the slot is due (started 3 h ago, 2 h cadence): the agent passes on it and finishes, as the two agents did
      await seedAgent(w);
      const r1 = await tick(w.ctx);
      expect(r1.ran).toEqual([AGENT_ID]);
      // the model saw the five-minute nextReadAt it then asked for
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      const seen = (calls[1]!.body as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === 'tool').map((m) => m.content).join('');
      expect(seen).toContain(nextReadAt);
      // before: nextAt = now + 5 min, a wake every six minutes. Now: the passed slot is spent and the wake is the next one.
      const slot = now + 2 * H + JITTER;
      const rt = await runtimeRow(w);
      expect(rt.nextAt.getTime()).toBe(slot);
      expect(rt.state).toMatchObject({ lastSlotSkippedAt: now });
      expect(lines.find((l) => l.msg === 'wake moved to the cadence floor')).toMatchObject({ level: 30, agentId: AGENT_ID, requestedAt: nextReadAt, nextAt: new Date(slot).toISOString(), floor: 'next_slot' });
      const finish = (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).find((a) => (a.action as { tool: string }).tool === 'finish')!;
      expect(finish.result).toMatchObject({ result: { nextAt: new Date(slot).toISOString(), note: expect.stringContaining('moved to') } });
      // the next two hours of ticks buy nothing
      const bought = thoughts(w);
      for (const at of [6 * MIN, 12 * MIN, 30 * MIN, H, 2 * H + JITTER - MIN]) {
        w.setNow(now + at);
        expect((await tick(w.ctx)).ran).toEqual([]);
      }
      expect(thoughts(w)).toBe(bought);
      // the slot: one wake
      w.setNow(slot);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(thoughts(w)).toBe(bought + 2);
    } finally {
      await w.close();
    }
  });

  it('a mention deferred to a reviewAt sooner than the slot is a reason to wake then', async () => {
    const reviewAt = new Date(T0 + 30 * MIN).toISOString();
    const w = await makeWorld({ script: [toolCallResponse('resolve_mention', { postId: '3001', outcome: 'defer', reason: 'answer when the pool settles', reviewAt }), finishResponse(T0 + 2 * MIN)] });
    try {
      const now = w.ctx.now();
      w.sender.items = [mention('3001', now - MIN)];
      await seedAgent(w, { config: { socialStartedAt: new Date(now - H).toISOString() } });
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect((await runtimeRow(w)).nextAt.getTime()).toBe(Date.parse(reviewAt));
    } finally {
      await w.close();
    }
  });

  it('a wake asked for after the slot stays as asked; the platform agent keeps any wake it chooses', async () => {
    const coin = await makeWorld({ script: [finishResponse(T0 + 10 * H)] });
    try {
      await seedAgent(coin, { config: { socialStartedAt: new Date(T0 - H).toISOString() } });
      expect((await tick(coin.ctx)).ran).toEqual([AGENT_ID]);
      expect((await runtimeRow(coin)).nextAt.getTime()).toBe(T0 + 10 * H);
    } finally {
      await coin.close();
    }
    const platform = await makeWorld({ script: [finishResponse(T0 + 5 * MIN)] });
    try {
      const lines = captureLog(platform);
      await seedAgent(platform, { config: { platform: true, socialStartedAt: new Date(T0 - H).toISOString() } });
      expect((await tick(platform.ctx)).ran).toEqual([AGENT_ID]);
      expect((await runtimeRow(platform)).nextAt.getTime()).toBe(T0 + 5 * MIN);
      expect(lines.some((l) => l.msg === 'wake moved to the cadence floor')).toBe(false);
    } finally {
      await platform.close();
    }
  });

  it('a tool call the runtime refuses before it runs is logged by tool, code and paths, never with the text', async () => {
    const w = await makeWorld({ script: [toolCallResponse('publish_post', { text: 'x'.repeat(4001) }), finishResponse(T0 + 10 * H)] });
    try {
      const lines = captureLog(w);
      await seedAgent(w);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      const refused = lines.find((l) => l.msg === 'tool call refused before it ran')!;
      expect(refused).toMatchObject({ level: 30, tool: 'publish_post', code: 'invalid_tool_call', issues: ['input.text:too_big'] });
      expect(JSON.stringify(refused)).not.toContain('xxxxx');
    } finally {
      await w.close();
    }
  });
});
