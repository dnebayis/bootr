/**
 * Scheduled posts (docs/design/agent-tools-2.md section 5): the three tools and every check a post passes when it is
 * scheduled, with the refusal texts of section 17.6, and the one rule on the side of a post sent now.
 */
import { parseAction, parseAgentConfig } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { images, scheduledPosts } from '../src/db/schema.js';
import { postHooks } from '../src/post-send.js';
import { recentPosts } from '../src/recent-posts.js';
import { roleTools } from '../src/roles.js';
import { toolsForPhase, startRouting } from '../src/routing.js';
import { initialState } from '../src/runtime.js';
import {
  SCHEDULE_CREATED_PER_DAY,
  SCHEDULE_DAILY_CAP,
  SCHEDULE_IMAGE_NOT_FROM_THIS_TURN,
  SCHEDULE_TOOLS,
  SCHEDULED_MENTION_FORBIDDEN,
  freeTimes,
  nearestFreeTime,
  postScheduledSoon,
  scheduleFull,
  scheduledIdOf,
  scheduledNotFound,
  scheduledSection,
  timeProblem,
  type TimeContext,
} from '../src/scheduled.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, finishResponse, makeWorld, seedAgent, testConfig, type TestWorld } from './helpers.js';
import { HOUR, INTERVAL, MIN, agentRow, callTool, errorOf, iso, patchConfig, resetHooks, resultOf, rowOf, rowsOf, schedule, seedCoin, seedPost, seedRow } from './scheduled-helpers.js';

const T0 = Date.parse('2026-10-24T12:00:00Z');

/** The time a `schedule_time` refusal names. */
function nearestOf(error: string): number {
  const m = /the nearest time you can take is (\S+)\. Nothing was scheduled\.$/.exec(error);
  if (!m) throw new Error(`no nearest time in: ${error}`);
  return Date.parse(m[1]!);
}

async function world(config: Record<string, string> = {}, agent: Record<string, unknown> = {}): Promise<TestWorld> {
  const w = await makeWorld({ config });
  await seedAgent(w, { config: agent, runtime: { nextAt: new Date(T0 + 6 * HOUR) } });
  return w;
}

afterEach(() => resetHooks());

describe('who holds the schedule tools', () => {
  const config = parseAgentConfig(agentConfig(T0));
  const names = (ctx: { config: ReturnType<typeof testConfig> }, raw: Record<string, unknown>) => roleTools(ctx, config, raw, 'social').map((t) => t.name);

  it('a hosted agent that may post holds all three by default, and an agent that may not post holds none', () => {
    const ctx = { config: testConfig() };
    for (const tool of SCHEDULE_TOOLS) expect(names(ctx, agentConfig(T0))).toContain(tool);
    const silent = parseAgentConfig(agentConfig(T0, { capabilities: { ...(agentConfig(T0).capabilities as object), xPublish: false } }));
    for (const tool of SCHEDULE_TOOLS) expect(roleTools(ctx, silent, agentConfig(T0), 'social').map((t) => t.name)).not.toContain(tool);
    // The treasury turn and the judge never hold them.
    for (const tool of SCHEDULE_TOOLS) expect(roleTools(ctx, config, agentConfig(T0, { treasuryTurn: true }), 'treasury').map((t) => t.name)).not.toContain(tool);
  });

  it('with SCHEDULED_POSTS_HOSTED=false only an own agent holds them', () => {
    const ctx = { config: testConfig({ SCHEDULED_POSTS_HOSTED: 'false' }) };
    for (const tool of SCHEDULE_TOOLS) expect(names(ctx, agentConfig(T0))).not.toContain(tool);
    for (const tool of SCHEDULE_TOOLS) expect(names(ctx, agentConfig(T0, { runner: 'own' }))).toContain(tool);
  });

  it('in economy mode the writer holds schedule_post; the decide model keeps the list and the cancel', () => {
    const ctx = { config: testConfig() };
    const catalog = roleTools(ctx, config, agentConfig(T0), 'social');
    const routed = { ...config, routing: { decideModel: 'openai/gpt-4.1-nano' } };
    const decide = toolsForPhase(startRouting(routed), catalog).map((t) => t.name);
    expect(decide).not.toContain('schedule_post');
    expect(decide).toContain('scheduled_list');
    expect(decide).toContain('scheduled_cancel');
    expect(decide).toContain('draft_intent');
    expect(toolsForPhase({ ...startRouting(routed)!, phase: 'write' }, catalog).map((t) => t.name)).toContain('schedule_post');
  });
});

describe('which times can be taken (pure)', () => {
  const base: TimeContext = { now: T0, limits: { minAheadMs: 10 * MIN, maxAheadMs: 36 * HOUR }, intervalMs: INTERVAL, lastOriginalAt: 0, taken: [], quiet: null };

  it('names each reason in the agent\'s words', () => {
    expect(timeProblem(T0 + 5 * MIN, base)).toBe('sendAt is less than 10 minutes from now');
    expect(timeProblem(T0 - HOUR, base)).toBe('sendAt is less than 10 minutes from now');
    expect(timeProblem(T0 + 37 * HOUR, base)).toBe('sendAt is more than 36 hours from now');
    expect(timeProblem(T0 + HOUR, { ...base, lastOriginalAt: T0 - 30 * MIN })).toBe('sendAt is less than one post interval (2 hours) after your last post');
    expect(timeProblem(T0 + 4 * HOUR, { ...base, taken: [{ id: 'sch_00000000000000aa', sendAt: T0 + 3 * HOUR }] })).toBe(`sendAt is less than one post interval (2 hours) from your scheduled post sch_00000000000000aa at ${iso(T0 + 3 * HOUR)}`);
    expect(timeProblem(Date.parse('2026-10-25T03:00:00Z'), { ...base, quiet: { start: 2, end: 6 } })).toBe("sendAt falls in Bootr's quiet hours (02:00-06:00 UTC)");
    expect(timeProblem(Number.NaN, base)).toBe('sendAt is not a time');
    expect(timeProblem(T0 + HOUR, base)).toBeNull();
    // exactly one interval away is far enough, on both sides
    expect(timeProblem(T0 + 5 * HOUR, { ...base, taken: [{ id: 'a', sendAt: T0 + 3 * HOUR }] })).toBeNull();
    expect(timeProblem(T0 + HOUR, { ...base, taken: [{ id: 'a', sendAt: T0 + 3 * HOUR }] })).toBeNull();
  });

  it('every time it offers can be taken, and the nearest one is the nearest', () => {
    const crowded: TimeContext = { ...base, lastOriginalAt: T0 - 30 * MIN, taken: [{ id: 'a', sendAt: T0 + 4 * HOUR }], quiet: { start: 22, end: 6 } };
    const free = freeTimes(crowded);
    expect(free.length).toBeGreaterThan(0);
    for (const t of free) expect(timeProblem(t, crowded), iso(t)).toBeNull();
    for (const t of free) expect(t % MIN).toBe(0);
    // the last post was at 11:30, so 13:30 is the first; 16:00 is taken, so 14:00 and 18:00 are its edges
    expect(free[0]).toBe(T0 + 90 * MIN);
    expect(nearestFreeTime(T0 + 4.5 * HOUR, crowded)).toBe(T0 + 6 * HOUR);
    expect(nearestFreeTime(T0 + 3.5 * HOUR, crowded)).toBe(T0 + 2 * HOUR);
    // quiet from 22:00 to 06:00: the minute before it starts and the moment it ends
    expect(free).toContain(Date.parse('2026-10-24T21:59:00Z'));
    expect(free).toContain(Date.parse('2026-10-25T06:00:00Z'));
    expect(nearestFreeTime(Date.parse('2026-10-25T01:00:00Z'), crowded)).toBe(Date.parse('2026-10-24T21:59:00Z'));
  });

  it('offers nothing when the window holds no free time', () => {
    const full: TimeContext = { ...base, intervalMs: 12 * HOUR, taken: [{ id: 'a', sendAt: T0 + 10 * HOUR }, { id: 'b', sendAt: T0 + 22 * HOUR }, { id: 'c', sendAt: T0 + 34 * HOUR }] };
    expect(freeTimes(full)).toEqual([]);
    expect(nearestFreeTime(T0 + 16 * HOUR, full)).toBeNull();
  });
});

describe('schedule_post: the time', () => {
  it('refuses a time that is too near and names the nearest one, which is then taken', async () => {
    const w = await world();
    try {
      const soon = await callTool(w, 'schedule_post', { text: 'A thought for later today.', sendAt: iso(T0 + 5 * MIN) });
      expect(soon.kind).toBe('failed');
      expect(errorOf(soon)).toMatch(/^schedule_time: sendAt is less than 10 minutes from now; the nearest time you can take is \S+\. Nothing was scheduled\.$/);
      expect(await rowsOf(w)).toHaveLength(0);
      const nearest = nearestOf(errorOf(soon));
      expect(nearest).toBeGreaterThanOrEqual(T0 + 10 * MIN);
      // the agent answers half a minute later with the time it was given
      w.setNow(T0 + 30_000);
      const taken = await callTool(w, 'schedule_post', { text: 'A thought for later today.', sendAt: iso(nearest) });
      expect(taken.kind).toBe('completed');
      expect(resultOf(taken)).toMatchObject({ sendAt: iso(nearest), status: 'waiting', waiting: 1, mayQueue: 5 });
      expect(resultOf<{ scheduledId: string }>(taken).scheduledId).toBe(scheduledIdOf(taken.actionId));
      expect(resultOf<{ scheduledId: string }>(taken).scheduledId).toMatch(/^sch_[0-9a-f]{16}$/);
      // nothing was sent: scheduling only stores
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('refuses a time that is too far, a time in the past and a time that is no time', async () => {
    const w = await world();
    try {
      const far = await callTool(w, 'schedule_post', { text: 'A thought for the day after tomorrow.', sendAt: iso(T0 + 37 * HOUR) });
      expect(errorOf(far)).toMatch(/^schedule_time: sendAt is more than 36 hours from now; the nearest time you can take is /);
      const nearest = nearestOf(errorOf(far));
      expect(nearest).toBeLessThanOrEqual(T0 + 36 * HOUR);
      expect((await callTool(w, 'schedule_post', { text: 'A thought for the day after tomorrow.', sendAt: iso(nearest) })).kind).toBe('completed');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A thought for yesterday.', sendAt: iso(T0 - 24 * HOUR) }))).toMatch(/^schedule_time: sendAt is less than 10 minutes from now; /);
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'x', sendAt: 'tomorrow-ish' } })).toThrow();
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'x' } })).toThrow();
    } finally {
      await w.close();
    }
  });

  it('holds a scheduled post one interval after the last original, whoever sent it', async () => {
    const w = await world();
    try {
      await seedPost(w, T0 - 30 * MIN, 'The post that went out half an hour ago.');
      const early = await callTool(w, 'schedule_post', { text: 'The next thought.', sendAt: iso(T0 + 20 * MIN) });
      expect(errorOf(early)).toMatch(/^schedule_time: sendAt is less than one post interval \(2 hours\) after your last post; the nearest time you can take is /);
      expect(nearestOf(errorOf(early))).toBe(T0 + 90 * MIN);
      expect((await callTool(w, 'schedule_post', { text: 'The next thought.', sendAt: iso(T0 + 90 * MIN) })).kind).toBe('completed');
      // a post the creator approved from the review queue is on record as an action only, and counts the same
      const w2 = await world();
      try {
        await seedPost(w2, T0 - 30 * MIN, 'Approved late by the creator.', { anchor: false });
        expect(errorOf(await callTool(w2, 'schedule_post', { text: 'The next thought.', sendAt: iso(T0 + 20 * MIN) }))).toMatch(/after your last post/);
      } finally {
        await w2.close();
      }
    } finally {
      await w.close();
    }
  });

  it('holds scheduled posts one interval apart, and names the waiting one', async () => {
    const w = await world();
    try {
      const first = await schedule(w, 'The afternoon thought.', T0 + 3 * HOUR);
      const near = await callTool(w, 'schedule_post', { text: 'The thought right after.', sendAt: iso(T0 + 4 * HOUR) });
      expect(errorOf(near)).toBe(`schedule_time: sendAt is less than one post interval (2 hours) from your scheduled post ${first} at ${iso(T0 + 3 * HOUR)}; the nearest time you can take is ${iso(T0 + 5 * HOUR)}. Nothing was scheduled.`);
      const before = await callTool(w, 'schedule_post', { text: 'The thought right before.', sendAt: iso(T0 + 2.5 * HOUR) });
      expect(nearestOf(errorOf(before))).toBe(T0 + HOUR);
      expect((await callTool(w, 'schedule_post', { text: 'The thought right after.', sendAt: iso(T0 + 5 * HOUR) })).kind).toBe('completed');
      expect((await rowsOf(w)).map((r) => r.sendAt.getTime())).toEqual([T0 + 3 * HOUR, T0 + 5 * HOUR]);
    } finally {
      await w.close();
    }
  });

  it('takes no time in the platform\'s quiet hours', async () => {
    const w = await world({ PLATFORM_QUIET_HOURS_UTC: '02-06' });
    try {
      const quiet = await callTool(w, 'schedule_post', { text: 'A thought for the small hours.', sendAt: '2026-10-25T03:00:00Z' });
      expect(errorOf(quiet)).toBe("schedule_time: sendAt falls in Bootr's quiet hours (02:00-06:00 UTC); the nearest time you can take is 2026-10-25T01:59:00.000Z. Nothing was scheduled.");
      expect(nearestOf(errorOf(await callTool(w, 'schedule_post', { text: 'A thought for the small hours.', sendAt: '2026-10-25T05:30:00Z' })))).toBe(Date.parse('2026-10-25T06:00:00Z'));
      expect((await callTool(w, 'schedule_post', { text: 'A thought for the small hours.', sendAt: '2026-10-25T06:00:00Z' })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('says so when no time is free in the whole window', async () => {
    const w = await world({}, { postIntervalMs: 12 * HOUR });
    try {
      for (const [i, h] of [10, 22, 34].entries()) await schedule(w, `One of three thoughts, number ${i + 1}.`, T0 + h * HOUR);
      const none = await callTool(w, 'schedule_post', { text: 'A fourth thought.', sendAt: iso(T0 + 16 * HOUR) });
      expect(errorOf(none)).toMatch(/^schedule_time: sendAt is less than one post interval \(12 hours\) from your scheduled post sch_[0-9a-f]{16} at \S+; no time is free in the next 36 hours\. Nothing was scheduled\.$/);
    } finally {
      await w.close();
    }
  });
});

describe('schedule_post: how many may wait', () => {
  it('six wait, the seventh is refused, and a cancel frees a place', async () => {
    const w = await world();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) ids.push(await schedule(w, `Thought ${i + 1} of the day, each its own.`, T0 + (1 + 2 * i) * HOUR));
      const seventh = await callTool(w, 'schedule_post', { text: 'A seventh thought.', sendAt: iso(T0 + 13 * HOUR) });
      expect(errorOf(seventh)).toBe('schedule_full: 6 posts are already waiting, the most allowed; nothing was scheduled. Cancel one or wait.');
      expect(errorOf(seventh)).toBe(scheduleFull(6));
      expect(await rowsOf(w)).toHaveLength(6);
      const list = resultOf<{ items: { id: string; status: string }[]; mayQueue: number; nextFreeAt: string | null }>(await callTool(w, 'scheduled_list', {}));
      expect(list.items.map((i) => i.id)).toEqual(ids);
      expect(list.mayQueue).toBe(0);
      const cancelled = await callTool(w, 'scheduled_cancel', { id: ids[5]! });
      expect(cancelled).toMatchObject({ kind: 'completed', result: { id: ids[5], cancelled: true } });
      expect((await callTool(w, 'schedule_post', { text: 'A seventh thought.', sendAt: iso(T0 + 13 * HOUR) })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('a coin schedules at most as many posts a day as a coin can post, whatever became of them', async () => {
    const w = await world();
    try {
      for (let i = 0; i < SCHEDULE_CREATED_PER_DAY; i++) await seedRow(w, AGENT_ID, T0 + HOUR, { status: 'cancelled', createdAt: new Date(T0 - (i + 1) * MIN) });
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'One more for today.', sendAt: iso(T0 + HOUR) }))).toBe(SCHEDULE_DAILY_CAP);
      // a day later the count is open again
      w.setNow(T0 + 25 * HOUR);
      expect((await callTool(w, 'schedule_post', { text: 'One more for today.', sendAt: iso(T0 + 26 * HOUR) })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('the same call again makes no second row and answers the same id', async () => {
    const w = await world();
    try {
      const first = await callTool(w, 'schedule_post', { text: 'Said once.', sendAt: iso(T0 + HOUR) }, { actionId: 'act_same' });
      const again = await callTool(w, 'schedule_post', { text: 'Said once.', sendAt: iso(T0 + HOUR) }, { actionId: 'act_same' });
      expect(again.kind).toBe('completed');
      expect(resultOf<{ scheduledId: string }>(again).scheduledId).toBe(resultOf<{ scheduledId: string }>(first).scheduledId);
      expect(await rowsOf(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});

describe('schedule_post: the gate when it is scheduled', () => {
  it('a scheduled post names nobody: any @ is refused, in every part', async () => {
    const w = await world();
    try {
      for (const text of ['Thanks @jessepollak for the idea.', 'gm ＠base, a thought for later.', 'mail me at a@b']) {
        expect(errorOf(await callTool(w, 'schedule_post', { text, sendAt: iso(T0 + HOUR) })), text).toBe(SCHEDULED_MENTION_FORBIDDEN);
      }
      expect(SCHEDULED_MENTION_FORBIDDEN).toBe('scheduled_mention_forbidden: a scheduled post names nobody; nothing was scheduled. Remove the @.');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A thread that starts clean.', thread: [{ text: 'And names @someone later.' }], sendAt: iso(T0 + HOUR) }))).toBe(SCHEDULED_MENTION_FORBIDDEN);
      // the schema takes no credits and no post to comment on
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'x', sendAt: iso(T0 + HOUR), attributions: [] } })).toThrow();
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'x', sendAt: iso(T0 + HOUR), about: { postId: '1' } } })).toThrow();
      expect(await rowsOf(w)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('runs the publish gate now, so the agent hears the refusal while it can rewrite', async () => {
    const w = await world();
    try {
      const gate = await callTool(w, 'schedule_post', { text: 'Two tickers in one post: $TEST and $OTHER.', sendAt: iso(T0 + HOUR) });
      expect(errorOf(gate)).toBe('x_post_requires_at_most_one_cashtag: the post does not pass the publish gate; rewrite it. Nothing was scheduled.');
      // an account without Premium cannot send more than 280 characters: said now, not at 3 in the morning
      w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000', premium: false } };
      const long = await callTool(w, 'schedule_post', { text: 'word '.repeat(70).trim(), sendAt: iso(T0 + HOUR) });
      expect(errorOf(long)).toMatch(/^post_too_long_for_account: this X account has no Premium: posts are limited to 280 characters \(this one is 349\)\. Shorten it\. Nothing was scheduled\.$/);
      w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000', premium: true } };
      expect((await callTool(w, 'schedule_post', { text: 'word '.repeat(70).trim(), sendAt: iso(T0 + HOUR) })).kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('counts the waiting posts as if sent for the question quota, before and after the new post', async () => {
    const w = await world();
    try {
      await schedule(w, 'What would you build first with this?', T0 + 5 * HOUR);
      const after = await callTool(w, 'schedule_post', { text: 'And what comes after that?', sendAt: iso(T0 + 7 * HOUR) });
      expect(errorOf(after)).toMatch(/^question_quota: .* Nothing was scheduled\.$/);
      const before = await callTool(w, 'schedule_post', { text: 'Before all that: why now?', sendAt: iso(T0 + 3 * HOUR) });
      expect(errorOf(before)).toMatch(/^question_quota: /);
      expect((await callTool(w, 'schedule_post', { text: 'A statement fits between any two questions.', sendAt: iso(T0 + 7 * HOUR) })).kind).toBe('completed');
      // a question the agent already asked on X counts too
      const w2 = await world();
      try {
        await seedPost(w2, T0 - 3 * HOUR, 'Builders, what is yours?');
        expect(errorOf(await callTool(w2, 'schedule_post', { text: 'And what about tomorrow?', sendAt: iso(T0 + HOUR) }))).toMatch(/^question_quota: /);
        expect((await callTool(w2, 'schedule_post', { text: 'Tomorrow the coin page gets a new section.', sendAt: iso(T0 + HOUR) })).kind).toBe('completed');
      } finally {
        await w2.close();
      }
    } finally {
      await w.close();
    }
  });

  it('refuses a text that is already in the queue or went out in the last day', async () => {
    const w = await world();
    try {
      const id = await schedule(w, 'The coin page got a new look.', T0 + HOUR);
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'the coin page  got a new look.', sendAt: iso(T0 + 4 * HOUR) }))).toBe(`schedule_duplicate: the same text is already scheduled as ${id}; nothing was scheduled. Say something new.`);
      await seedPost(w, T0 - 5 * HOUR, 'Fees claimed this morning.');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'Fees claimed this morning.', sendAt: iso(T0 + 4 * HOUR) }))).toBe('schedule_duplicate: you posted the same text in the last day; nothing was scheduled. Say something new.');
      expect(await rowsOf(w)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('holds a thread to the thread rules: its size, its parts, one link, no repeat, two a day', async () => {
    const w = await world();
    try {
      const ok = await callTool(w, 'schedule_post', { text: 'A thought that needs room, part one.', thread: [{ text: 'Part two goes on.' }, { text: 'Part three adds the detail.' }, { text: 'Part four closes it.' }], topic: 'coin-page', sendAt: iso(T0 + HOUR) });
      expect(ok.kind).toBe('completed');
      const row = await rowOf(w, resultOf<{ scheduledId: string }>(ok).scheduledId);
      expect(row.thread).toEqual([{ text: 'Part two goes on.' }, { text: 'Part three adds the detail.' }, { text: 'Part four closes it.' }]);
      expect(row.topic).toBe('coin-page');
      // the schema bounds the rest of the thread: three more parts of 280 at most
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'a', thread: [{ text: 'b' }, { text: 'c' }, { text: 'd' }, { text: 'e' }], sendAt: iso(T0 + HOUR) } })).toThrow();
      expect(() => parseAction({ tool: 'schedule_post', input: { text: 'a', thread: [{ text: 'b'.repeat(281) }], sendAt: iso(T0 + HOUR) } })).toThrow();
      const at = iso(T0 + 4 * HOUR);
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'x'.repeat(300), thread: [{ text: 'A short second part.' }], sendAt: at }))).toBe('thread_part_too_long: part 1 has 300 characters; every part of a thread is 280 at most. Nothing was scheduled.');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'The same words twice.', thread: [{ text: 'the same words  twice.' }], sendAt: at }))).toBe('thread_repeat: two parts of the thread say the same; nothing was scheduled.');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'Read it at https://bootr.fun/docs today.', thread: [{ text: 'And the rest at bootr.fun/token later.' }], sendAt: at }))).toBe('thread_links: only one part of a thread may carry a link; nothing was scheduled.');
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A fine first part.', thread: [{ text: 'Tickers $TEST and $OTHER in part two.' }], sendAt: at }))).toBe('x_post_requires_at_most_one_cashtag: part 2 does not pass the publish gate; rewrite it. Nothing was scheduled.');
      // two threads a day: one waits, one went out; a third is refused, a single post is not
      await seedPost(w, T0 - 4 * HOUR, 'A thread from this morning.', { thread: ['Its second part.'] });
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A third thread today.', thread: [{ text: 'With a second part.' }], sendAt: at }))).toBe('thread_daily_cap: at most 2 threads per 24 hours; nothing was scheduled. Schedule it as one post.');
      expect((await callTool(w, 'schedule_post', { text: 'The same thought as one post.', sendAt: at })).kind).toBe('completed');
      // with threads switched off by the posting side's own limit, no thread is scheduled either
      (w.ctx.config as unknown as Record<string, unknown>).THREAD_MAX_PARTS = 1;
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'Another try.', thread: [{ text: 'With a part.' }], sendAt: iso(T0 + 7 * HOUR) }))).toBe('thread_not_available: threads are switched off; nothing was scheduled. Schedule it as one post.');
    } finally {
      await w.close();
    }
  });

  it('checks the picture: it must exist, be the coin\'s own, and for an own agent be from this turn', async () => {
    const w = await world();
    try {
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A post with a picture.', imageId: 'img_missing', sendAt: iso(T0 + HOUR) }))).toMatch(/^image_not_found: img_missing .*nothing was scheduled\. Schedule your post without an imageId\.$/);
      const picture = { agentId: AGENT_ID, alt: 'A drawing of a small coin.', mime: 'image/png', bytes: Buffer.from([1, 2, 3]), sizeBytes: 3, model: 'test' };
      await w.db.insert(images).values({ id: 'img_old', actionId: 'act_img_old', ...picture, createdAt: new Date(T0 - HOUR) });
      await w.db.insert(images).values({ id: 'img_new', actionId: 'act_img_new', ...picture, createdAt: new Date(T0 + 1000) });
      // another coin's picture is no picture
      await seedCoin(w, 1);
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A post with a picture.', imageId: 'img_old', sendAt: iso(T0 + HOUR) }, { agentId: 'coin1' }))).toMatch(/^image_not_found: /);
      // an own agent's turn that opened now attaches only what it uploaded since
      await patchConfig(w, { runner: 'own' });
      const own = { own: { openedAt: T0, postAllowed: false, nextSlotAt: null } };
      expect(errorOf(await callTool(w, 'schedule_post', { text: 'A post with a picture.', imageId: 'img_old', sendAt: iso(T0 + HOUR) }, { env: own }))).toBe(SCHEDULE_IMAGE_NOT_FROM_THIS_TURN);
      const ok = await callTool(w, 'schedule_post', { text: 'A post with a picture.', imageId: 'img_new', sendAt: iso(T0 + HOUR) }, { env: own });
      expect(ok.kind).toBe('completed');
      expect((await rowOf(w, resultOf<{ scheduledId: string }>(ok).scheduledId)).imageId).toBe('img_new');
      const list = resultOf<{ items: { picture: boolean; parts: number }[] }>(await callTool(w, 'scheduled_list', {}));
      expect(list.items).toMatchObject([{ picture: true, parts: 1 }]);
    } finally {
      await w.close();
    }
  });
});

describe('scheduled_list and scheduled_cancel', () => {
  it('lists what waits with the next free time, and cancels only the agent\'s own waiting post', async () => {
    const w = await world();
    try {
      const id = await schedule(w, 'A thought for three o\'clock.', T0 + 3 * HOUR);
      const list = resultOf<{ items: Record<string, unknown>[]; mayQueue: number; nextFreeAt: string }>(await callTool(w, 'scheduled_list', {}));
      expect(list.items).toEqual([{ id, sendAt: iso(T0 + 3 * HOUR), status: 'waiting', text: "A thought for three o'clock.", parts: 1, picture: false }]);
      expect(list.mayQueue).toBe(5);
      // the soonest time that can be taken: twelve minutes from now, on the minute (the post at three is far enough)
      expect(list.nextFreeAt).toBe(iso(T0 + 12 * MIN));
      expect((await callTool(w, 'schedule_post', { text: 'And one for the next free time.', sendAt: list.nextFreeAt })).kind).toBe('completed');

      expect(errorOf(await callTool(w, 'scheduled_cancel', { id: 'sch_0123456789abcdef' }))).toBe('scheduled_not_found: you have no waiting post sch_0123456789abcdef.');
      expect(scheduledNotFound('sch_x')).toBe('scheduled_not_found: you have no waiting post sch_x.');
      expect(() => parseAction({ tool: 'scheduled_cancel', input: { id: 'approval-1' } })).toThrow();
      // another coin cannot cancel it, and cannot see it
      await seedCoin(w, 2);
      expect(errorOf(await callTool(w, 'scheduled_cancel', { id }, { agentId: 'coin2' }))).toBe(scheduledNotFound(id));
      expect(resultOf<{ items: unknown[] }>(await callTool(w, 'scheduled_list', {}, { agentId: 'coin2' })).items).toEqual([]);
      expect((await rowOf(w, id)).status).toBe('waiting');

      expect((await callTool(w, 'scheduled_cancel', { id })).kind).toBe('completed');
      const row = await rowOf(w, id);
      expect(row.status).toBe('cancelled');
      // its own cancel is nothing the agent needs to be told again
      expect(row.feedbackAt).not.toBeNull();
      expect(errorOf(await callTool(w, 'scheduled_cancel', { id }))).toBe(scheduledNotFound(id));
      // a post that is on its way cannot be cancelled: it may already be on X
      const going = await seedRow(w, AGENT_ID, T0 + 9 * HOUR, { status: 'sending' });
      expect(errorOf(await callTool(w, 'scheduled_cancel', { id: going }))).toBe(scheduledNotFound(going));
      expect((await rowOf(w, going)).status).toBe('sending');
    } finally {
      await w.close();
    }
  });
});

describe('what the agent is shown', () => {
  it('the scheduled section lists the waiting posts, how many more may wait and the next free time; recentPosts lists them too', async () => {
    const w = await world();
    try {
      const empty = (await scheduledSection(w.ctx, AGENT_ID)) as { scheduled: { waiting: unknown[]; mayQueue: number; nextFreeAt: string } };
      expect(empty.scheduled).toMatchObject({ waiting: [], mayQueue: 6, nextFreeAt: iso(T0 + 12 * MIN) });
      const long = `${'A long thought about the coin and its page. '.repeat(5)}The end.`;
      const id = await schedule(w, long, T0 + HOUR);
      const thread = await schedule(w, 'A thread opens here.', T0 + 4 * HOUR, { more: { thread: [{ text: 'And goes on.' }] } });
      const section = (await scheduledSection(w.ctx, AGENT_ID)) as { scheduled: { meaning: string; waiting: Record<string, unknown>[]; mayQueue: number; nextFreeAt: string; notSent?: unknown } };
      expect(section.scheduled.waiting).toEqual([
        { id, sendAt: iso(T0 + HOUR), status: 'waiting', text: long.slice(0, 140) },
        { id: thread, sendAt: iso(T0 + 4 * HOUR), status: 'waiting', text: 'A thread opens here.', parts: 2 },
      ]);
      expect(section.scheduled.mayQueue).toBe(4);
      expect(section.scheduled.nextFreeAt).toBe(iso(T0 + 6 * HOUR));
      expect(section.scheduled).not.toHaveProperty('notSent');
      expect(section.scheduled.meaning).toContain('schedule_post');
      const recent = await recentPosts(w.ctx, AGENT_ID);
      expect(recent.filter((p) => p.status === 'scheduled').map((p) => [p.at, p.kind, p.text])).toEqual([
        [iso(T0 + 4 * HOUR), 'post', 'A thread opens here.'],
        [iso(T0 + HOUR), 'post', long.slice(0, 140)],
      ]);
      // an agent that may not post has no section
      await patchConfig(w, { capabilities: { ...((await agentRow(w)).config.capabilities as object), xPublish: false } });
      expect(await scheduledSection(w.ctx, AGENT_ID)).toEqual({});
      expect(await scheduledSection(w.ctx, 'nobody')).toEqual({});
    } finally {
      await w.close();
    }
  });
});

describe('the one rule on the side of a post sent now', () => {
  it('an original sent now is refused while a scheduled post is due within one interval', async () => {
    const w = await world();
    try {
      createApp(w.ctx); // mounting registers the hook the broker asks before an original is sent now
      const agent = await agentRow(w);
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0)).toBeNull();
      const far = await schedule(w, 'A thought for much later.', T0 + 5 * HOUR);
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0)).toBeNull();
      const near = await schedule(w, 'A thought for soon.', T0 + 90 * MIN);
      const refusal = await postHooks.beforeOriginalNow(w.ctx, agent, T0);
      expect(refusal).toBe(`post_scheduled_soon: your next post is already scheduled for ${iso(T0 + 90 * MIN)}; nothing was posted. Replies may still go out.`);
      expect(refusal).toBe(postScheduledSoon(T0 + 90 * MIN));
      // exactly one interval away still covers the slot; a moment more does not
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0 - 30 * MIN)).toBe(postScheduledSoon(T0 + 90 * MIN));
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0 - 30 * MIN - 1)).toBeNull();
      // cancelled, it covers nothing; the later one does once its time is near
      await callTool(w, 'scheduled_cancel', { id: near });
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0)).toBeNull();
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0 + 4 * HOUR)).toBe(postScheduledSoon(T0 + 5 * HOUR));
      // a post whose send is under way, or of unknown outcome, covers the slot until it is known
      await w.db.update(scheduledPosts).set({ status: 'sending' }).where(eq(scheduledPosts.id, far));
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0 + 9 * HOUR)).toBe(postScheduledSoon(T0 + 5 * HOUR));
      // one that missed its time covers nothing: the slot is the agent's again
      await w.db.update(scheduledPosts).set({ status: 'waiting' }).where(eq(scheduledPosts.id, far));
      expect(await postHooks.beforeOriginalNow(w.ctx, agent, T0 + 6 * HOUR + MIN)).toBeNull();
      // another coin's queue is none of this coin's business
      await seedCoin(w, 3);
      expect(await postHooks.beforeOriginalNow(w.ctx, await agentRow(w, 'coin3'), T0 + 4 * HOUR)).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('a covered slot wakes no hosted agent: no thought is bought for a post that is already scheduled', async () => {
    // The slot is due (the agent never posted) and the agent's own wake is hours away.
    const due = { runtime: { nextAt: new Date(T0 + 6 * HOUR), lastDecisionAt: new Date(T0 - HOUR), state: initialState() as unknown as Record<string, unknown> } };
    const plain = await makeWorld({ script: [finishResponse(T0 + 2 * HOUR)] });
    try {
      await seedAgent(plain, due);
      const report = await tick(plain.ctx);
      // as today: the due slot buys a turn
      expect(report.ran).toEqual([AGENT_ID]);
      expect(plain.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(1);
    } finally {
      await plain.close();
    }
    const covered = await makeWorld({ script: [finishResponse(T0 + 2 * HOUR)] });
    try {
      await seedAgent(covered, due);
      await seedRow(covered, AGENT_ID, T0 + 90 * MIN);
      const report = await tick(covered.ctx);
      expect(report.ran).toEqual([]);
      expect(covered.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      // nothing was sent either: the post waits for its own time
      expect((await rowsOf(covered))[0]!.status).toBe('waiting');
    } finally {
      await covered.close();
    }
  });
});
