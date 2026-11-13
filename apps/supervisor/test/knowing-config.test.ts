/**
 * The two config fields of this round (docs/design/agent-tools-2.md section 17.4: `comments` and `replyAudience`) in
 * the schema, the view and the update; the third the round first carried, a coin's own `watchlist`, was taken out
 * again by the owner, and a stored config that still has it is read with the field ignored. And the proof that every
 * limit of the knowing workstream at 0 leaves a Bootr agent's turn as it was before the round.
 */
import { REPLY_AUDIENCES, agentConfigSchema, parseAgentConfig } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentActivity } from '../src/activity.js';
import { commentsOf, replyAudienceOf } from '../src/agent-config.js';
import { createApp } from '../src/api.js';
import { agents, memories, postMetrics, runtimes, whatWorks } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { agentConfigOf } from '../src/onboarding.js';
import { POST_PERFORMANCE_MEANING, resetMetricsBackoff } from '../src/post-performance.js';
import { tick } from '../src/tick.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { AGENT_ID, CREATOR, SUPERVISOR_KEY, agentConfig, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const H = 3_600_000;
const DAY = 24 * H;

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  return {
    get: async (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    put: async (path: string, body: unknown) => {
      const text = JSON.stringify(body);
      return app.request(path, { method: 'PUT', body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, 'PUT', path, text, nowSec()) } });
    },
  };
}

const PATH = `/internal/agents/${AGENT_ID}/config`;
type View = { comments: boolean; replyAudience: string; revision: number };

describe('the two config fields in the schema', () => {
  it('are optional, and a stored config with them parses', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    const bare = parseAgentConfig(agentConfig(now));
    expect(bare.comments).toBeUndefined();
    expect(bare.replyAudience).toBeUndefined();
    const set = parseAgentConfig(agentConfig(now, { comments: false, replyAudience: 'own_threads' }));
    expect(set).toMatchObject({ comments: false, replyAudience: 'own_threads' });
    expect(REPLY_AUDIENCES).toEqual(['verified', 'own_threads']);
    for (const bad of [{ replyAudience: 'everyone' }, { comments: 'yes' }]) {
      expect(agentConfigSchema.safeParse(agentConfig(now, bad)).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('a stored config that still carries a coin\'s watched accounts parses, and the field is dropped whatever it holds', () => {
    const now = Date.parse('2026-10-24T12:00:00Z');
    for (const stored of [['alice', 'bob_1'], [], ['@Alice', 'not a handle'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], 'alice', 42, null, { handles: ['alice'] }]) {
      const parsed = agentConfigSchema.safeParse(agentConfig(now, { watchlist: stored, comments: false }));
      expect(parsed.success, JSON.stringify(stored)).toBe(true);
      expect(parsed.success && parsed.data, JSON.stringify(stored)).not.toHaveProperty('watchlist');
      expect(parsed.success && parsed.data.comments).toBe(false);
    }
  });

  it('are read from a stored config with safe defaults: comments on, replies to verified accounts', () => {
    expect([commentsOf({}), replyAudienceOf({})]).toEqual([true, 'verified']);
    expect(commentsOf({ comments: false })).toBe(false);
    expect(commentsOf({ comments: 'no' })).toBe(true);
    expect(replyAudienceOf({ replyAudience: 'own_threads' })).toBe('own_threads');
    expect(replyAudienceOf({ replyAudience: 'anyone' })).toBe('verified');
  });
});

describe('PUT /internal/agents/:id/config for comments and the reply audience', () => {
  let world: TestWorld | null = null;
  afterEach(async () => {
    await world?.close();
    world = null;
  });

  it('shows the defaults, stores each change, counts the revision and puts it on the tape in plain words', async () => {
    world = await makeWorld();
    await seedAgent(world);
    const before = (await (await api(world).get(PATH)).json()) as View;
    expect(before).toMatchObject({ comments: true, replyAudience: 'verified' });
    expect(before).not.toHaveProperty('watchlist');

    const res = await api(world).put(PATH, { by: CREATOR, comments: false, replyAudience: 'own_threads' });
    expect(res.status).toBe(200);
    const after = (await res.json()) as View;
    expect(after).toMatchObject({ comments: false, replyAudience: 'own_threads', revision: before.revision + 1 });

    // what the next turn parses carries both, and the posting rules read them from the same stored record
    const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
    expect(agent.config).toMatchObject({ comments: false, replyAudience: 'own_threads' });
    expect(agentConfigOf(agent)).toMatchObject({ comments: false, replyAudience: 'own_threads' });

    const runtime = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
    const tape = await agentActivity(world.ctx, agent, runtime);
    expect(tape.find((i) => i.kind === 'config')?.summary).toBe('Config updated: comments, reply audience');

    // switching back
    const back = await api(world).put(PATH, { by: CREATOR, comments: true, replyAudience: 'verified' });
    expect(await back.json()).toMatchObject({ comments: true, replyAudience: 'verified' });
    const stored = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!.config;
    expect(stored.comments).toBe(true);
    // the same values again change nothing
    expect((await api(world).put(PATH, { by: CREATOR, comments: true, replyAudience: 'verified' })).status).toBe(409);
  });

  it('refuses what is not a switch or an audience, and anyone but the creator', async () => {
    world = await makeWorld();
    await seedAgent(world);
    const refused: [Record<string, unknown>, string][] = [
      [{ comments: 'off' }, 'invalid_comments'],
      [{ replyAudience: 'everyone' }, 'invalid_reply_audience'],
      [{ replyAudience: null }, 'invalid_reply_audience'],
    ];
    for (const [body, error] of refused) {
      const res = await api(world).put(PATH, { by: CREATOR, ...body });
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe(error);
    }
    expect((await api(world).put(PATH, { by: '0x9999999999999999999999999999999999999999', comments: false })).status).toBe(403);
    expect((await (await api(world).get(PATH)).json()) as View).toMatchObject({ comments: true, replyAudience: 'verified' });
  });

  it('a coin whose stored config still carries watched accounts: the view leaves the field out, an update of another field goes through, and a list sent now changes nothing', async () => {
    for (const stored of [['alice', 'bob_1'], 'not a list']) {
      world = await makeWorld();
      const seeded = await seedAgent(world, { config: { watchlist: stored } });
      expect(seeded.config.watchlist).toEqual(stored);
      // the turn's parse and the creator's view both read it without the field
      expect(agentConfigOf(seeded)).not.toBeNull();
      expect(agentConfigOf(seeded)).not.toHaveProperty('watchlist');
      const view = await api(world).get(PATH);
      expect(view.status).toBe(200);
      const shown = (await view.json()) as View;
      expect(shown).toMatchObject({ comments: true, replyAudience: 'verified' });
      expect(shown).not.toHaveProperty('watchlist');

      // a list sent by an old page is not a change: alone it is "nothing changed", beside a real change it is passed over
      expect((await api(world).put(PATH, { by: CREATOR, watchlist: ['carol'] })).status).toBe(409);
      const res = await api(world).put(PATH, { by: CREATOR, comments: false, watchlist: ['carol'] });
      expect(res.status).toBe(200);
      const after = (await res.json()) as View;
      expect(after).toMatchObject({ comments: false, revision: shown.revision + 1 });
      expect(after).not.toHaveProperty('watchlist');
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      // what was stored stays as it was and is read by nothing; the tape names the one field that changed
      expect(agent.config.watchlist).toEqual(stored);
      expect(agentConfigOf(agent)).toMatchObject({ comments: false });
      const runtime = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      expect((await agentActivity(world.ctx, agent, runtime)).find((i) => i.kind === 'config')?.summary).toBe('Config updated: comments');
      await world.close();
      world = null;
    }
  });
});

describe('every limit of the knowing workstream at 0', () => {
  const OFF = { LEARN_WINDOW_DAYS: '0', WHAT_WORKS_MAX_CHARS: '0', COIN_BRIEF_MAX_CHARS: '0' };
  const MARKET = { priceUsd: 0.01, marketCapUsd: 1000, holders: 132, trades24h: 37, volume24hUsd: 1234.5, fees24hUsd: 12.4 };

  beforeEach(() => {
    resetWatchlistCache();
    resetMetricsBackoff();
  });

  /** One turn of a coin agent that has measured posts, a market with holders and, in its stored config, watched accounts from before they were removed. */
  async function turn(config: Record<string, string>) {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const world = await makeWorld({ script: [finishResponse(start + 3 * H)], config });
    let feedReads = 0;
    Object.assign(world.indexer.client as object, {
      market: async () => MARKET,
      platformFeed: async () => {
        feedReads += 1;
        return null;
      },
    });
    world.sender.timelines = { alice: [{ id: '9000', text: 'alice says hello', createdAt: new Date(start - H).toISOString(), metrics: null }] };
    await seedAgent(world, { config: { watchlist: ['alice'] } });
    await world.db.insert(postMetrics).values(
      Array.from({ length: 24 }, (_, i) => ({ postId: String(5000 + i), agentId: AGENT_ID, kind: 'post' as const, excerpt: `post ${i}`, postedAt: new Date(start - 2 * DAY - i * 1000), measuredAt: new Date(start - H), likes: i % 2 ? 9 : 2, features: { form: 'post' as const, picture: i % 2 === 1, chars: 'medium' as const, hour: 12, scheduled: false } })),
    );
    const report = await tick(world.ctx);
    expect(report.errors).toEqual([]);
    expect(report.ran).toEqual([AGENT_ID]);
    const request = world.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!.body as { messages: { role: string; content: string }[]; tools: { function: { name: string } }[] };
    const observation = JSON.parse(request.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
    const state = (await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as Record<string, unknown>;
    return { world, tools: request.tools.map((t) => t.function.name), system: request.messages.find((m) => m.role === 'system')!.content, observation, state, feedReads: () => feedReads };
  }

  it('offers no new tool, adds no section, reads nothing more and keeps the section of before', async () => {
    const on = await turn({});
    const off = await turn(OFF);
    try {
      // with the defaults the round's pieces are there...
      expect(on.tools).toContain('note_what_works');
      expect(Object.keys(on.observation)).toEqual(expect.arrayContaining(['whatWorks', 'coinToday']));
      // a coin's stored watched accounts are read by nothing, with the defaults as with every limit at 0
      expect(on.observation).not.toHaveProperty('watchlist');
      expect(on.world.sender.timelineReads).toEqual([]);
      expect(on.observation.postPerformance).toBeUndefined();
      // ...and with every limit at 0 none of them is: the tools are the same list without the note
      expect(off.tools).toEqual(on.tools.filter((t) => t !== 'note_what_works'));
      for (const key of ['whatWorks', 'coinToday', 'watchlist']) expect(off.observation, key).not.toHaveProperty(key);
      // what is left of the observation is, key for key and value for value, what the same turn shows without the
      // two sections of the round (the list of tools aside, which is compared above)
      const without = (o: Record<string, unknown>, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));
      const postPerformance = off.observation.postPerformance;
      expect(without(off.observation, ['postPerformance', 'tools'])).toEqual(without(on.observation, ['whatWorks', 'coinToday', 'tools']));
      expect(postPerformance).toMatchObject({ instructionAuthority: false, meaning: POST_PERFORMANCE_MEANING, source: 'x', measured: 24, posts: 24, replies: 0 });
      expect(Object.keys(postPerformance as object).sort()).toEqual(['digest', 'instructionAuthority', 'meaning', 'measured', 'posts', 'replies', 'source', 'window']);
      // the pinned prompt is the same text either way
      expect(off.system).toBe(on.system);
      // nothing of the round was read or kept
      expect(off.world.sender.timelineReads).toEqual([]);
      expect(off.feedReads()).toBe(0);
      expect(off.state).not.toHaveProperty('briefAt');
      expect(await off.world.db.select().from(whatWorks)).toHaveLength(0);
      expect(on.state).toHaveProperty('briefAt');
      // neither turn wrote a note into memory on its own
      expect(await off.world.db.select().from(memories)).toHaveLength(0);
    } finally {
      await on.world.close();
      await off.world.close();
    }
  });
});
