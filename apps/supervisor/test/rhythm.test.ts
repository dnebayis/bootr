import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig } from '@bootr/agent-core';
import { actions, runtimes } from '../src/db/schema.js';
import { MAX_JITTER_FRACTION, SLOT_WINDOW_MS, applyRhythm, formatQuietHours, jitterMs, jitteredSchedule, originalPostGate, originalPostView, parseQuietHours, quietUntil, slotsUsed } from '../src/rhythm.js';
import { scheduleFor } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, KERNEL, agentConfig, finishResponse, makeWorld, seedAgent, testConfig, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const OTHER_KERNEL = '0x00000000000000000000000000000000000000aa';

/** A platform-wide original post decided `agoMs` before `now` by `agentId`, in the given status. */
async function seedPost(w: TestWorld, id: string, agoMs: number, status: 'sending' | 'sent' | 'completed' | 'failed' = 'completed', agentId = 'someone-else') {
  const at = new Date(w.ctx.now() - agoMs);
  await w.db.insert(actions).values({ actionId: id, agentId, cycleKey: `k:${id}`, action: { tool: 'publish_post', input: { text: `post ${id}` } }, status, createdAt: at, updatedAt: at });
}

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function lastToolMessages(w: TestWorld): string[] {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] };
  return body.messages.filter((m) => m.role === 'tool').map((m) => m.content);
}

function firstObservation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[0]!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

describe('jitter', () => {
  it('is deterministic per kernel, case-insensitive, and under 20 % of the interval', () => {
    const a = jitterMs(KERNEL, 2 * H);
    expect(jitterMs(KERNEL, 2 * H)).toBe(a);
    expect(jitterMs(KERNEL.toUpperCase().replace('0X', '0x'), 2 * H)).toBe(a);
    expect(jitterMs(` ${KERNEL} `, 2 * H)).toBe(a);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(MAX_JITTER_FRACTION * 2 * H);
    expect(Number.isInteger(a)).toBe(true);
    // scales with the interval: twice the interval, twice the offset (give or take flooring)
    expect(Math.abs(jitterMs(KERNEL, 4 * H) - 2 * a)).toBeLessThanOrEqual(1);
    expect(jitterMs(KERNEL, 0)).toBe(0);
  });

  it('separates agents that share a cadence', () => {
    const kernels = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333', KERNEL, OTHER_KERNEL];
    const offsets = kernels.map((k) => jitterMs(k, 2 * H));
    expect(new Set(offsets).size).toBe(kernels.length);
    for (const o of offsets) expect(o).toBeLessThan(0.2 * 2 * H);
  });

  it('pushes the slot later by the jitter and keeps the cadence (anchor, interval) intact', () => {
    const config = parseAgentConfig(agentConfig(T0, { socialStartedAt: new Date(T0).toISOString() }));
    const jitter = jitterMs(KERNEL, config.postIntervalMs);
    const s = jitteredSchedule(config, null, T0 + 2 * H)!;
    expect(s.jitterMs).toBe(jitter);
    expect(s.nextAt).toBe(T0 + 2 * H + jitter);
    expect(s.due).toBe(jitter === 0);
    expect(jitteredSchedule(config, null, T0 + 2 * H + jitter)!.due).toBe(true);
    // anchored on the last post, so two agents with the same cadence drift apart by their jitter every post
    const last = T0 + 5 * H;
    expect(jitteredSchedule(config, last, last)!.nextAt).toBe(last + 2 * H + jitter);
    const other = parseAgentConfig({ ...config, kernel: { address: OTHER_KERNEL } });
    expect(jitteredSchedule(other, last, last)!.nextAt).toBe(last + 2 * H + jitterMs(OTHER_KERNEL, 2 * H));
    expect(jitteredSchedule(other, last, last)!.nextAt).not.toBe(jitteredSchedule(config, last, last)!.nextAt);
    // runtime.scheduleFor is the same thing
    expect(scheduleFor(config, { phase: 'social', memory: '', agenda: '', summary: '', lastPostAt: last }, last)).toEqual(jitteredSchedule(config, last, last));
    // off when the channel is closed
    expect(jitteredSchedule(parseAgentConfig({ ...config, capabilities: { ...config.capabilities, xPublish: false } }), null, T0)).toBeNull();
    expect(jitteredSchedule(parseAgentConfig({ ...config, ownerRules: [{ id: 'original-posts-paused', text: 'no posts', enabled: true }] }), null, T0)).toBeNull();
  });
});

describe('quiet hours', () => {
  const at = (iso: string) => Date.parse(iso);

  it('parses HH-HH in UTC and rejects nonsense', () => {
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours('')).toBeNull();
    expect(parseQuietHours('02-06')).toEqual({ start: 2, end: 6 });
    expect(parseQuietHours('2-6')).toEqual({ start: 2, end: 6 });
    expect(parseQuietHours('22-06')).toEqual({ start: 22, end: 6 });
    expect(parseQuietHours('22-24')).toEqual({ start: 22, end: 24 });
    expect(parseQuietHours('22-00')).toEqual({ start: 22, end: 24 });
    expect(() => parseQuietHours('06-06')).toThrow(/differ/);
    expect(() => parseQuietHours('25-06')).toThrow(/0\.\.24/);
    expect(() => parseQuietHours('night')).toThrow(/HH-HH/);
    expect(formatQuietHours({ start: 2, end: 6 })).toBe('02:00-06:00 UTC');
    expect(formatQuietHours({ start: 22, end: 24 })).toBe('22:00-00:00 UTC');
  });

  it('knows when the window ends, including across midnight', () => {
    const plain = parseQuietHours('02-06');
    expect(quietUntil(plain, at('2026-10-24T01:59:59Z'))).toBeNull();
    expect(quietUntil(plain, at('2026-10-24T02:00:00Z'))).toBe(at('2026-10-24T06:00:00Z'));
    expect(quietUntil(plain, at('2026-10-24T05:59:59Z'))).toBe(at('2026-10-24T06:00:00Z'));
    expect(quietUntil(plain, at('2026-10-24T06:00:00Z'))).toBeNull();
    expect(quietUntil(plain, at('2026-10-24T12:00:00Z'))).toBeNull();
    const wrap = parseQuietHours('22-06');
    expect(quietUntil(wrap, at('2026-10-24T23:00:00Z'))).toBe(at('2026-10-25T06:00:00Z'));
    expect(quietUntil(wrap, at('2026-10-25T01:00:00Z'))).toBe(at('2026-10-25T06:00:00Z'));
    expect(quietUntil(wrap, at('2026-10-25T06:00:00Z'))).toBeNull();
    expect(quietUntil(wrap, at('2026-10-25T12:00:00Z'))).toBeNull();
    expect(quietUntil(null, at('2026-10-24T03:00:00Z'))).toBeNull();
  });

  it('is validated by the config schema', () => {
    expect(testConfig().PLATFORM_QUIET_HOURS_UTC).toBeUndefined();
    expect(testConfig({ PLATFORM_QUIET_HOURS_UTC: '' }).PLATFORM_QUIET_HOURS_UTC).toBeUndefined();
    expect(testConfig({ PLATFORM_QUIET_HOURS_UTC: '02-06' }).PLATFORM_QUIET_HOURS_UTC).toBe('02-06');
    expect(testConfig().PLATFORM_POST_SLOTS_PER_10M).toBe(3);
    expect(testConfig({ PLATFORM_POST_SLOTS_PER_10M: '5' }).PLATFORM_POST_SLOTS_PER_10M).toBe(5);
    expect(() => testConfig({ PLATFORM_QUIET_HOURS_UTC: '06-06' })).toThrow();
    expect(() => testConfig({ PLATFORM_QUIET_HOURS_UTC: 'night' })).toThrow();
    expect(() => testConfig({ PLATFORM_POST_SLOTS_PER_10M: '0' })).toThrow();
  });
});

describe('slots', () => {
  it('counts original posts of every agent in the last 10 minutes, in flight or sent, never refused ones', async () => {
    const w = await makeWorld({ config: { PLATFORM_POST_SLOTS_PER_10M: '2' } });
    try {
      const now = w.ctx.now();
      expect(await slotsUsed(w.ctx, now)).toBe(0);
      expect(await originalPostGate(w.ctx, now)).toEqual({ open: true });
      await seedPost(w, 'p1', 60_000, 'completed', 'agent-a');
      await seedPost(w, 'p2', SLOT_WINDOW_MS + 1000, 'completed', 'agent-b'); // outside the window
      await seedPost(w, 'p3', 30_000, 'failed', 'agent-c'); // refused: not a slot
      await w.db.insert(actions).values({ actionId: 'r1', agentId: 'agent-d', cycleKey: 'k:r1', action: { tool: 'publish_reply', input: { postId: '1', text: 'hi' } }, status: 'completed', createdAt: new Date(now - 1000), updatedAt: new Date(now - 1000) });
      expect(await slotsUsed(w.ctx, now)).toBe(1);
      expect(await originalPostGate(w.ctx, now)).toEqual({ open: true });
      await seedPost(w, 'p4', 5_000, 'sending', 'agent-e');
      expect(await slotsUsed(w.ctx, now)).toBe(2);
      const closed = await originalPostGate(w.ctx, now);
      expect(closed.open).toBe(false);
      if (!closed.open) {
        expect(closed.hold.reason).toBe('no_slot');
        expect(closed.hold.until).toBe(now + w.ctx.config.SUPERVISOR_TICK_MS);
        expect(closed.hold.message).toMatch(/no_slot: .*2 original posts.*limit 2/);
      }
      // the caller's own in-flight row is not a used slot
      expect(await slotsUsed(w.ctx, now, { excludeActionId: 'p4' })).toBe(1);
      expect(await originalPostGate(w.ctx, now, { excludeActionId: 'p4' })).toEqual({ open: true });
      // the window rolls
      expect(await slotsUsed(w.ctx, now + SLOT_WINDOW_MS)).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('holds a due schedule without moving it, and passes a schedule that is not due through', async () => {
    const w = await makeWorld({ config: { PLATFORM_POST_SLOTS_PER_10M: '1' } });
    try {
      const now = w.ctx.now();
      const config = parseAgentConfig(agentConfig(now, { socialStartedAt: new Date(now - 10 * H).toISOString() }));
      const due = jitteredSchedule(config, null, now)!;
      expect(due.due).toBe(true);
      expect(await applyRhythm(w.ctx, due, now)).toBe(due);
      await seedPost(w, 'p1', 1000);
      const held = (await applyRhythm(w.ctx, due, now))!;
      expect(held.due).toBe(false);
      expect(held.dueByCadence).toBe(true);
      expect(held.mayCompose).toBe(false);
      expect(held.held?.reason).toBe('no_slot');
      expect(held.nextAt).toBe(due.nextAt); // nothing in the cadence moved: still due on the next tick
      expect(held.missedIntervals).toBe(0);
      const view = originalPostView(held);
      expect(view.due).toBe(false);
      expect(view.nextAt).toBe(new Date(now + w.ctx.config.SUPERVISOR_TICK_MS).toISOString());
      expect(view.waiting).toMatchObject({ reason: 'no_slot' });
      // not due: no read, no change
      const notDue = jitteredSchedule(config, now - 1000, now)!;
      expect(await applyRhythm(w.ctx, notDue, now)).toBe(notDue);
      expect(originalPostView(notDue)).toEqual({ due: false, nextAt: notDue.nextAtIso, intervalMs: 2 * H, lastPostAt: new Date(now - 1000).toISOString() });
      expect(await applyRhythm(w.ctx, null, now)).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('quiet hours hold a due post until the window ends', async () => {
    const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '11-13' } });
    try {
      const now = w.ctx.now(); // 12:00 UTC
      const gate = await originalPostGate(w.ctx, now);
      expect(gate.open).toBe(false);
      if (!gate.open) {
        expect(gate.hold.reason).toBe('quiet_hours');
        expect(gate.hold.until).toBe(Date.parse('2026-10-24T13:00:00Z'));
        expect(gate.hold.message).toMatch(/quiet_hours: .*11:00-13:00 UTC.*2026-10-24T13:00:00\.000Z/);
      }
      expect(await originalPostGate(w.ctx, Date.parse('2026-10-24T13:00:00Z'))).toEqual({ open: true });
      const config = parseAgentConfig(agentConfig(now, { socialStartedAt: new Date(now - 10 * H).toISOString() }));
      const held = (await applyRhythm(w.ctx, jitteredSchedule(config, null, now), now))!;
      expect(held.held?.reason).toBe('quiet_hours');
      expect(originalPostView(held).nextAt).toBe('2026-10-24T13:00:00.000Z');
    } finally {
      await w.close();
    }
  });
});

describe('rhythm in the tick', () => {
  it('a due post with no free slot does not wake the agent; the slot is kept and taken once the window clears', async () => {
    const w = await makeWorld({ config: { PLATFORM_POST_SLOTS_PER_10M: '1' }, script: [toolCallResponse('publish_post', { text: 'A post from a test agent, in its own voice.' }), finishResponse(T0 + 3 * H)] });
    try {
      const now = w.ctx.now();
      // due by cadence (started 10 h ago, 2 h interval), but the runtime's own wake is far away
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() }, runtime: { nextAt: new Date(now + 6 * H) } });
      await seedPost(w, 'p1', 1000);
      const r1 = await tick(w.ctx);
      expect(r1.ran).toEqual([]);
      expect(r1.errors).toEqual([]);
      expect((await runtimeRow(w)).nextAt.getTime()).toBe(now + 6 * H);
      // next tick: still due (not a skipped slot), still held
      w.setNow(now + 60_000);
      expect((await tick(w.ctx)).ran).toEqual([]);
      // window cleared: the schedule wakes the agent and the post goes out
      w.setNow(now + SLOT_WINDOW_MS + 60_000);
      const r3 = await tick(w.ctx);
      expect(r3.ran).toEqual([AGENT_ID]);
      expect(r3.errors).toEqual([]);
      expect(w.sender.published).toHaveLength(1);
      const obs = firstObservation(w) as { social: { originalPost: { due: boolean; waiting?: unknown } } };
      expect(obs.social.originalPost.due).toBe(true);
      expect(obs.social.originalPost.waiting).toBeUndefined();
      expect(await slotsUsed(w.ctx, w.ctx.now())).toBe(1);
    } finally {
      await w.close();
    }
  });

  it('refuses an original post sent during quiet hours with a clear tool error; replies still go out', async () => {
    const reply = toolCallResponse('publish_reply', { postId: '1001', text: 'Hello there, thanks for asking.' }, 'call_reply');
    const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '11-13' }, script: [toolCallResponse('publish_post', { text: 'A post that must wait for the morning.' }), reply, finishResponse(T0 + 3 * H)] });
    try {
      const now = w.ctx.now(); // 12:00 UTC, inside the window
      await seedAgent(w, { config: { socialStartedAt: new Date(now - 10 * H).toISOString() } });
      w.sender.items = [
        {
          postId: '1001',
          authorId: '42',
          conversationId: '1001',
          status: 'pending',
          observedAt: new Date(now - 60_000).toISOString(),
          seenAt: null,
          deferredUntil: null,
          post: { id: '1001', authorId: '42', text: '@bootr_agent how are you?', createdAt: new Date(now - 120_000).toISOString(), conversationId: '1001', author: { id: '42', username: 'user42', verified: true, verifiedType: 'blue' } },
        },
      ];
      const r = await tick(w.ctx);
      expect(r.ran).toEqual([AGENT_ID]);
      expect(r.errors).toEqual([]);
      const obs = firstObservation(w) as { social: { originalPost: { due: boolean; nextAt: string; waiting?: { reason: string } } } };
      expect(obs.social.originalPost.due).toBe(false);
      expect(obs.social.originalPost.waiting?.reason).toBe('quiet_hours');
      expect(obs.social.originalPost.nextAt).toBe('2026-10-24T13:00:00.000Z');
      const tools = lastToolMessages(w);
      expect(tools[0]).toMatch(/quiet_hours/);
      expect(tools[0]).toMatch(/"status":"failed"/);
      expect(tools[1]).toMatch(/"postId"/);
      expect(w.sender.published).toHaveLength(1);
      expect((w.sender.published[0] as { replyTo?: string }).replyTo).toBe('1001');
      const posts = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(posts.find((a) => (a.action as { tool: string }).tool === 'publish_post')?.status).toBe('failed');
      expect((await runtimeRow(w)).state).toMatchObject({ lastPostAt: null });
    } finally {
      await w.close();
    }
  });
});
