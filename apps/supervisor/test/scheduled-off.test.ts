/**
 * Scheduled posts switched off by their limit (docs/design/agent-tools-2.md section 13 and 17.1 rule 4): with
 * `SCHEDULED_MAX_WAITING=0` a hosted agent is offered what it was offered before this piece, its observation carries
 * no new section, a due slot wakes it as before, and nothing is read from or sent out of the queue, also when rows
 * were left in it.
 */
import { TOOL_LIST, parseAgentConfig } from '@bootr/agent-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { postHooks } from '../src/post-send.js';
import { applyRhythm } from '../src/rhythm.js';
import { roleTools } from '../src/roles.js';
import { initialState, scheduleFor } from '../src/runtime.js';
import { SCHEDULE_TOOLS, SCHEDULE_UNAVAILABLE, applyScheduled, scheduledSection, schedulingOn, sweepScheduled } from '../src/scheduled.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, finishResponse, makeWorld, seedAgent, testConfig } from './helpers.js';
import { HOUR, MIN, agentRow, callTool, errorOf, fakeSend, iso, resetHooks, rowOf, seedRow } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');
const OFF = { SCHEDULED_MAX_WAITING: '0' };
/** The social catalog of the test agent as it was before this piece: everything its powers give it, and no schedule tool. */
const BASE_SOCIAL = TOOL_LIST.map((t) => t.name).filter((n) => !(SCHEDULE_TOOLS as readonly string[]).includes(n) && n !== 'search_web' && n !== 'generate_image' && n !== 'discover_services' && n !== 'x402_fetch' && !n.startsWith('bootr_') && !n.startsWith('bounty_'));

type Post = { body: { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] } };

afterEach(() => resetHooks());

describe('SCHEDULED_MAX_WAITING=0 switches the piece off', () => {
  it('the tools are offered to nobody, hosted or own', () => {
    const ctx = { config: testConfig(OFF) };
    expect(schedulingOn(ctx)).toBe(false);
    expect(schedulingOn({ config: testConfig() })).toBe(true);
    expect(schedulingOn({ config: testConfig({ SCHEDULE_MAX_AHEAD_MS: '0' }) })).toBe(false);
    const config = parseAgentConfig(agentConfig(T0));
    for (const raw of [agentConfig(T0), agentConfig(T0, { runner: 'own' })]) {
      expect(roleTools(ctx, config, raw, 'social').map((t) => t.name).sort()).toEqual([...BASE_SOCIAL].sort());
    }
    // with the piece on, the only difference is the three tools
    expect(roleTools({ config: testConfig() }, config, agentConfig(T0), 'social').map((t) => t.name).sort()).toEqual([...BASE_SOCIAL, ...SCHEDULE_TOOLS].sort());
  });

  it('a hosted turn is offered and shown what it was before: no schedule tool, no scheduled section', async () => {
    const w = await makeWorld({ config: OFF, script: [finishResponse(T0 + 2 * HOUR)] });
    try {
      await seedAgent(w);
      // even with rows left in the queue from before the switch
      await seedRow(w, AGENT_ID, T0 + 90 * MIN);
      const report = await tick(w.ctx);
      expect(report.ran).toEqual([AGENT_ID]);
      const [call] = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Post[];
      expect(call!.body.tools.map((t) => t.function.name).sort()).toEqual([...BASE_SOCIAL].sort());
      const observation = JSON.parse(call!.body.messages[1]!.content) as { extra?: Record<string, unknown>; social?: { originalPost?: { due?: boolean; waiting?: unknown } } };
      expect(observation).not.toHaveProperty('scheduled');
      expect(JSON.stringify(observation)).not.toContain('schedule_post');
      expect(JSON.stringify(observation)).not.toContain('"status":"scheduled"');
      expect(observation).not.toHaveProperty('recentPosts');
      // the due slot is due, as before: the leftover row covers nothing
      expect(observation.social?.originalPost).toMatchObject({ due: true });
      expect(observation.social?.originalPost).not.toHaveProperty('waiting');
    } finally {
      await w.close();
    }
  });

  it('with the piece on, the same turn differs by the three tools and the one section, and by nothing else', async () => {
    const observe = async (config: Record<string, string>) => {
      const w = await makeWorld({ config, script: [finishResponse(T0 + 2 * HOUR)] });
      try {
        await seedAgent(w);
        await tick(w.ctx);
        const [call] = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')) as unknown as Post[];
        return { system: call!.body.messages[0]!.content, observation: JSON.parse(call!.body.messages[1]!.content) as Record<string, unknown>, tools: call!.body.tools.map((t) => t.function.name) };
      } finally {
        await w.close();
      }
    };
    const off = await observe(OFF);
    const on = await observe({});
    // the system prompt is not touched by this piece
    expect(on.system).toBe(off.system);
    expect(on.tools.filter((t) => !off.tools.includes(t)).sort()).toEqual([...SCHEDULE_TOOLS].sort());
    expect(off.tools.filter((t) => !on.tools.includes(t))).toEqual([]);
    const strip = (o: Record<string, unknown>) => {
      const copy = JSON.parse(JSON.stringify(o)) as Record<string, unknown>;
      for (const holder of [copy, (copy.extra ?? {}) as Record<string, unknown>]) {
        delete holder.scheduled;
        if (Array.isArray(holder.tools)) holder.tools = (holder.tools as string[]).filter((t) => !(SCHEDULE_TOOLS as readonly string[]).includes(t));
      }
      return copy;
    };
    expect(JSON.stringify(on.observation)).toContain('"scheduled"');
    expect(strip(on.observation)).toEqual(strip(off.observation));
  });

  it('nothing is scheduled, read or sent: the tool refuses, the hooks pass, the sweep returns at once', async () => {
    const w = await makeWorld({ config: OFF });
    try {
      await seedAgent(w, { runtime: { nextAt: new Date(T0 + 6 * HOUR), state: initialState() as unknown as Record<string, unknown> } });
      const fake = fakeSend(w);
      createApp(w.ctx);
      // a call that reaches the broker anyway (a turn opened before the switch) stores nothing
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A thought for later.', sendAt: iso(T0 + HOUR) }))).toBe(SCHEDULE_UNAVAILABLE);
      expect(await scheduledSection(w.ctx, AGENT_ID)).toEqual({});

      const due = await seedRow(w, AGENT_ID, T0 - MIN);
      const soon = await seedRow(w, AGENT_ID, T0 + 90 * MIN);
      // a post sent now is not refused, and the due slot stays due
      expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w), T0)).toBeNull();
      const config = parseAgentConfig((await agentRow(w)).config);
      const schedule = await applyRhythm(w.ctx, scheduleFor(config, initialState(), T0), T0);
      expect(schedule).toMatchObject({ due: true, mayCompose: true });
      expect(await applyScheduled(w.ctx, AGENT_ID, schedule, T0)).toBe(schedule);
      // the sweep does nothing at all: no send, no missed, the rows as they were
      for (const later of [0, 30, 120]) {
        w.setNow(T0 + later * MIN);
        expect(await sweepScheduled(w.ctx)).toEqual({ sent: 0, failed: 0, missed: 0, unknown: 0, toReview: 0 });
      }
      expect(fake.calls).toHaveLength(0);
      expect((await rowOf(w, due)).status).toBe('waiting');
      expect((await rowOf(w, soon)).status).toBe('waiting');
    } finally {
      await w.close();
    }
  });

  it('SCHEDULED_SENDS_PER_TICK=0 keeps the tools and sends nothing: what waits is missed after its grace', async () => {
    const w = await makeWorld({ config: { SCHEDULED_SENDS_PER_TICK: '0' } });
    try {
      await seedAgent(w, { runtime: { nextAt: new Date(T0 + 6 * HOUR) } });
      const fake = fakeSend(w);
      const made = await callTool(w, 'schedule_post', { text: 'A thought for later.', sendAt: iso(T0 + HOUR) });
      expect(made.kind).toBe('completed');
      w.setNow(T0 + HOUR + MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 0 });
      w.setNow(T0 + 2 * HOUR + MIN);
      expect(await sweepScheduled(w.ctx)).toMatchObject({ sent: 0, missed: 1 });
      expect(fake.calls).toHaveLength(0);
    } finally {
      await w.close();
    }
  });
});
