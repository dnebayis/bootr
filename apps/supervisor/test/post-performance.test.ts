import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actions, memories, postMetrics } from '../src/db/schema.js';
import {
  METRICS_AGENTS_PER_TICK,
  PERFORMANCE_SECTION_MAX_CHARS,
  POST_PERFORMANCE_MEANING,
  agentsToMeasure,
  excerptOf,
  measureAgent,
  performanceNote,
  postPerformanceSection,
  postsToMeasure,
  renderPerformance,
  resetMetricsBackoff,
  sweepPostMetrics,
} from '../src/post-performance.js';
import { SenderError } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const H = 3_600_000;
/**
 * The facts switched off (docs/design/agent-tools-2.md section 13: a limit of 0 switches its piece off). With it the
 * section and the per-batch note are what they were before the facts existed, and the tests below that carry this
 * config assert exactly what they asserted then. The facts themselves are tested in what-works.test.ts.
 */
const FACTS_OFF = { LEARN_WINDOW_DAYS: '0' };

/** A completed publish in `sv_actions`, `ageMs` before now, as the broker records it. */
async function published(world: TestWorld, postId: string, text: string, ageMs: number, opts: { tool?: 'publish_post' | 'publish_reply'; agentId?: string; status?: 'completed' | 'failed' } = {}) {
  const at = new Date(world.ctx.now() - ageMs);
  const tool = opts.tool ?? 'publish_post';
  await world.db.insert(actions).values({
    actionId: `act-${postId}`,
    agentId: opts.agentId ?? AGENT_ID,
    cycleKey: `c-${postId}`,
    action: { tool, input: { text, ...(tool === 'publish_reply' ? { postId: '1' } : {}) } },
    status: opts.status ?? 'completed',
    result: opts.status === 'failed' ? null : { postId },
    receipt: opts.status === 'failed' ? null : { postId },
    createdAt: at,
    updatedAt: at,
  });
}

describe('post performance: which posts are measured', () => {
  let world: TestWorld | null = null;
  afterEach(async () => {
    resetMetricsBackoff();
    await world?.close();
    world = null;
  });

  it('picks completed publishes that are 24 to 72 h old and not measured yet, oldest first', async () => {
    world = await makeWorld();
    await seedAgent(world);
    await published(world, '100', 'too young', 10 * H);
    await published(world, '101', 'first candidate', 50 * H);
    await published(world, '102', 'second candidate', 30 * H, { tool: 'publish_reply' });
    await published(world, '103', 'too old', 80 * H);
    await published(world, '104', 'failed send', 40 * H, { status: 'failed' });
    await world.db.insert(actions).values({ actionId: 'act-read', agentId: AGENT_ID, cycleKey: 'c-read', action: { tool: 'read_market', input: {} }, status: 'completed', result: { priceUsd: 1 }, createdAt: new Date(world.ctx.now() - 40 * H), updatedAt: new Date(world.ctx.now()) });
    await world.db.insert(postMetrics).values({ postId: '105', agentId: AGENT_ID, kind: 'post', excerpt: 'measured already', postedAt: new Date(world.ctx.now() - 36 * H), measuredAt: new Date(world.ctx.now()) });
    await published(world, '105', 'measured already', 36 * H);

    const due = await postsToMeasure(world.ctx, AGENT_ID);
    expect(due.map((c) => [c.postId, c.kind, c.excerpt])).toEqual([
      ['101', 'post', 'first candidate'],
      ['102', 'reply', 'second candidate'],
    ]);
    expect(await agentsToMeasure(world.ctx, 5)).toEqual([AGENT_ID]);
  });

  it('shortens long texts to one line', () => {
    expect(excerptOf('  a\n\nb   c ')).toBe('a b c');
    const long = excerptOf('x'.repeat(300));
    expect(long.length).toBe(120);
    expect(long.endsWith('…')).toBe(true);
  });
});

describe('post performance: measuring and the memory note', () => {
  let world: TestWorld | null = null;
  afterEach(async () => {
    resetMetricsBackoff();
    await world?.close();
    world = null;
  });

  it('stores one row per post, marks deleted posts unavailable and writes one note with the best and the weakest', async () => {
    world = await makeWorld({ config: FACTS_OFF });
    await seedAgent(world);
    await published(world, '201', 'Three holders asked the same question today, so here is the plain answer.', 48 * H);
    await published(world, '202', 'Quiet day on the pond.', 40 * H);
    await published(world, '203', 'Thanks, that is a fair point.', 30 * H, { tool: 'publish_reply' });
    await published(world, '204', 'This one was deleted later.', 28 * H);
    world.sender.metrics = {
      '201': { likes: 12, replies: 3, reposts: 2, quotes: 1, impressions: 1234 },
      '202': { likes: 0, replies: 0, reposts: 0, quotes: 0, impressions: 80 },
      '203': { likes: 2, replies: 1, reposts: 0, quotes: 0, impressions: 150 },
    };

    const res = await measureAgent(world.ctx, AGENT_ID);
    expect(res).toMatchObject({ measured: 3, unavailable: 1 });
    expect(world.sender.metricsReads).toEqual([['201', '202', '203', '204']]);

    const rows = await world.db.select().from(postMetrics).where(eq(postMetrics.agentId, AGENT_ID)).orderBy(postMetrics.postId);
    expect(rows.map((r) => [r.postId, r.kind, r.likes, r.replies, r.reposts, r.quotes, r.impressions, r.unavailable])).toEqual([
      ['201', 'post', 12, 3, 2, 1, 1234, false],
      ['202', 'post', 0, 0, 0, 0, 80, false],
      ['203', 'reply', 2, 1, 0, 0, 150, false],
      ['204', 'post', 0, 0, 0, 0, null, true],
    ]);

    const notes = await world.db.select().from(memories).where(eq(memories.agentId, AGENT_ID));
    expect(notes).toHaveLength(1);
    expect(notes[0]!.id).toBe(res.noteId);
    expect(notes[0]!.tags).toEqual(['post-performance']);
    expect(notes[0]!.sources).toEqual(['x:post:201', 'x:post:202', 'x:post:203']);
    expect(notes[0]!.text).toBe(
      'Post performance, measured 2026-10-24 (3 posts from 2026-10-22 to 2026-10-23): the most response went to your post "Three holders asked the same question today, so here is the plain answer." with 12 likes, 3 replies, 2 reposts, 1 quote, 1.2k impressions. The least went to your post "Quiet day on the pond." with 0 likes, 0 replies, 0 reposts, 0 quotes, 80 impressions.',
    );
    for (const word of ['price', '$', 'advice', 'should']) expect(notes[0]!.text.toLowerCase()).not.toContain(word);

    // Measured once: a second pass finds nothing and writes nothing.
    expect(await measureAgent(world.ctx, AGENT_ID)).toEqual({ measured: 0, unavailable: 0, noteId: null });
    expect(world.sender.metricsReads).toHaveLength(1);
    expect(await world.db.select().from(memories)).toHaveLength(1);
  });

  it('a batch of one post is one sentence; impressions are left out when unknown', () => {
    const at = new Date('2026-10-24T12:00:00Z');
    const text = performanceNote([{ kind: 'reply', excerpt: 'Fair point.', postedAt: new Date('2026-10-23T01:00:00Z'), likes: 1, replies: 0, reposts: 0, quotes: 0, impressions: null }], at);
    expect(text).toBe('Post performance, measured 2026-10-24: your reply of 2026-10-23 "Fair point." drew 1 like, 0 replies, 0 reposts, 0 quotes.');
  });

  it('leaves posts the sender neither returned nor reported missing for a later sweep', async () => {
    world = await makeWorld();
    await seedAgent(world);
    await published(world, '301', 'one', 30 * H);
    await published(world, '302', 'two', 31 * H);
    world.sender.metrics = { '301': { likes: 1 } };
    world.sender.client.readMetrics = async () => ({ items: [{ postId: '301', createdAt: null, likes: 1, replies: 0, reposts: 0, quotes: 0, bookmarks: null, impressions: null, nonPublic: null }], missing: [], nonPublic: false });
    expect((await measureAgent(world.ctx, AGENT_ID)).measured).toBe(1);
    expect((await postsToMeasure(world.ctx, AGENT_ID)).map((c) => c.postId)).toEqual(['302']);
  });
});

describe('post performance: the sweep in the tick', () => {
  let world: TestWorld | null = null;
  afterEach(async () => {
    resetMetricsBackoff();
    await world?.close();
    world = null;
  });

  it('measures a bounded number of agents per tick and backs off an agent whose read failed', async () => {
    world = await makeWorld();
    await seedAgent(world);
    // Six more active agents with one due post each; the one with the oldest post goes first.
    for (let i = 0; i < 6; i++) {
      const id = `a${i}`;
      await world.db.insert((await import('../src/db/schema.js')).agents).values({ agentId: id, token: `0x${String(i).padStart(40, '0')}`, kernel: `0x${String(i + 1).padStart(40, '0')}`, creator: '0x0000000000000000000000000000000000000001', config: {}, status: i === 5 ? 'paused' : 'active' });
      await published(world, `4${i}`, `post of ${id}`, (30 + i) * H, { agentId: id });
      world.sender.metrics[`4${i}`] = { likes: i };
    }
    await published(world, '499', 'own post', 26 * H);
    world.sender.metrics['499'] = { likes: 1 };

    const first = await sweepPostMetrics(world.ctx);
    expect(first.agents).toHaveLength(METRICS_AGENTS_PER_TICK);
    expect(first.agents).toEqual(['a4', 'a3', 'a2', 'a1', 'a0']);
    expect(first.errors).toEqual([]);
    const second = await sweepPostMetrics(world.ctx);
    expect(second.agents).toEqual([AGENT_ID]); // a5 is paused and never measured
    expect(second.measured).toBe(1);
    expect((await sweepPostMetrics(world.ctx)).agents).toEqual([]);

    // A failing read: nothing stored, the agent is skipped until the backoff passes, then tried again.
    await published(world, '500', 'later post', 25 * H);
    world.sender.metricsError = new SenderError(409, 'not_connected', { error: 'not_connected' }, true);
    const failed = await sweepPostMetrics(world.ctx);
    expect(failed.errors).toEqual([{ agentId: AGENT_ID, error: 'sender 409 not_connected' }]);
    expect(await world.db.select().from(postMetrics).where(eq(postMetrics.postId, '500'))).toHaveLength(0);
    world.sender.metricsError = null;
    world.sender.metrics['500'] = { likes: 3 };
    expect((await sweepPostMetrics(world.ctx)).agents).toEqual([]);
    world.setNow(world.ctx.now() + 31 * 60_000);
    expect((await sweepPostMetrics(world.ctx)).measured).toBe(1);
  });

  it('runs from the tick and the next turn sees the section', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    world = await makeWorld({ script: [finishResponse(start + 3 * H)], config: FACTS_OFF });
    await seedAgent(world);
    await published(world, '601', 'A short story about the first holder who asked a good question.', 30 * H);
    await published(world, '602', 'Nothing much.', 29 * H);
    await published(world, '603', 'Thank you.', 28 * H, { tool: 'publish_reply' });
    world.sender.metrics = { '601': { likes: 9, replies: 4, reposts: 1, quotes: 0, impressions: 2000 }, '602': { likes: 1, impressions: 100 }, '603': { likes: 3, replies: 1, impressions: 400 } };

    const report = await tick(world.ctx);
    expect(report.errors).toEqual([]);
    expect(report.ran).toEqual([AGENT_ID]);
    expect(await world.db.select().from(postMetrics)).toHaveLength(3);

    // The sweep ran before the turn, so the observation the model saw carries the section.
    const request = world.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { messages: { role: string; content: string }[] };
    const user = request.messages.find((m) => m.role === 'user')!;
    const observation = JSON.parse(user.content) as { postPerformance?: Record<string, unknown>; recentNotes: { text: string }[] };
    expect(observation.postPerformance).toMatchObject({ instructionAuthority: false, meaning: POST_PERFORMANCE_MEANING, source: 'x', measured: 3, posts: 2, replies: 1 });
    expect(observation.postPerformance!.digest).toBe(
      'Since 2026-10-17: 2 posts and 1 reply measured about a day after posting. Most response: post of 2026-10-23 "A short story about the first holder who asked a good question." (9 likes, 4 replies, 1 repost, 0 quotes, 2k impressions); reply of 2026-10-23 "Thank you." (3 likes, 1 reply, 0 reposts, 0 quotes, 400 impressions). Least: post of 2026-10-23 "Nothing much." (1 like, 0 replies, 0 reposts, 0 quotes, 100 impressions).',
    );
    expect(observation.recentNotes.some((n) => n.text.startsWith('Post performance, measured 2026-10-24'))).toBe(true);
    const system = request.messages.find((m) => m.role === 'system')!;
    expect(system.content).toContain('postPerformance section');
  });
});

describe('post performance: the observation section', () => {
  let world: TestWorld | null = null;
  afterEach(async () => {
    resetMetricsBackoff();
    await world?.close();
    world = null;
  });

  it('is empty without measurements, ignores unavailable and older rows, and stays within 600 characters', async () => {
    world = await makeWorld({ config: FACTS_OFF });
    await seedAgent(world);
    expect(await postPerformanceSection(world.ctx, AGENT_ID)).toEqual({});
    const now = world.ctx.now();
    const row = (postId: string, ageMs: number, over: Partial<typeof postMetrics.$inferInsert> = {}) => ({ postId, agentId: AGENT_ID, kind: 'post' as const, excerpt: `post ${postId} ${'words '.repeat(20)}`.trim(), postedAt: new Date(now - ageMs), measuredAt: new Date(now), ...over });
    await world.db.insert(postMetrics).values([
      row('701', 2 * 86_400_000, { likes: 5 }),
      row('702', 3 * 86_400_000, { likes: 4, impressions: 500 }),
      row('703', 4 * 86_400_000, { likes: 3 }),
      row('704', 5 * 86_400_000, { likes: 0 }),
      row('705', 1 * 86_400_000, { likes: 100, unavailable: true }),
      row('706', 8 * 86_400_000, { likes: 100 }),
      row('707', 2 * 86_400_000, { likes: 100, agentId: 'someone-else' }),
    ]);
    const section = (await postPerformanceSection(world.ctx, AGENT_ID)) as { postPerformance: { measured: number; digest: string } };
    expect(section.postPerformance.measured).toBe(4);
    expect(section.postPerformance.digest.length).toBeLessThanOrEqual(PERFORMANCE_SECTION_MAX_CHARS);
    expect(section.postPerformance.digest).toContain('post 701');
    expect(section.postPerformance.digest).toContain('post 702');
    expect(section.postPerformance.digest).toContain('Least: post of');
    expect(section.postPerformance.digest).toContain('post 704');
    expect(section.postPerformance.digest).not.toContain('post 703');
    expect(section.postPerformance.digest).not.toContain('705');
    expect(section.postPerformance.digest).not.toContain('706');
  });

  it('shows no "least" line when there are only one or two posts and hard-caps the text', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const base = { agentId: AGENT_ID, kind: 'post' as const, measuredAt: new Date(now), replies: 0, reposts: 0, quotes: 0, impressions: null, unavailable: false };
    const two = renderPerformance([{ ...base, postId: '1', excerpt: 'one', postedAt: new Date(now - 86_400_000), likes: 2 }, { ...base, postId: '2', excerpt: 'two', postedAt: new Date(now - 2 * 86_400_000), likes: 1 }], now);
    expect(two).toBe('Since 2026-10-17: 2 posts measured about a day after posting. Most response: post of 2026-10-23 "one" (2 likes, 0 replies, 0 reposts, 0 quotes); post of 2026-10-22 "two" (1 like, 0 replies, 0 reposts, 0 quotes).');
    const capped = renderPerformance([{ ...base, postId: '1', excerpt: 'x'.repeat(120), postedAt: new Date(now), likes: 2 }], now, 80);
    expect(capped.length).toBe(80);
    expect(capped.endsWith('…')).toBe(true);
  });
});
