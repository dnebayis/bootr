/**
 * The platform agent's sections through an own turn (docs/design/byo-agent.md sections 1.3 and 13.9): the weekly
 * digest, the daily numbers, the platform update, the watchlist and "Bootr today" are observation sections built by
 * code with their bookkeeping in the runtime state, so an own social turn must show what the hosted turn shows and
 * close what the hosted turn closes (the digest and the numbers post by the post or the finish, the update by the post
 * that carries its link).
 *
 * Each test runs the hosted turn first (one scripted thought that posts, one that finishes) and keeps its first
 * observation and its final state; then the same coin as an own agent takes the same steps through the registry's
 * social role, and the two are compared. The social role is another workstream's (own/social.ts): until it is merged
 * the hosted half runs, which proves the fixtures, and the own half is skipped with the test.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/api.js';
import { approvals, runtimes } from '../src/db/schema.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { ownRole } from '../src/own/registry.js';
import { NUMBERS_WAKE_REASON } from '../src/platform-numbers.js';
import { PLATFORM_UPDATES } from '../src/platform-updates.js';
import type { AgentState } from '../src/runtime.js';
import { processAgent } from '../src/tick.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { DIGEST_WAKE_REASON } from '../src/weekly-digest.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';
import { fakeEngine, forbidThoughts, ownConfig, setOwnFlag } from './own-w2-engine.js';

const H = 3_600_000;
/** Mid-morning UTC on a weekday: no digest, no numbers post, every seeded update inside its window. */
const WEEKDAY = Date.parse('2026-11-05T10:00:00Z');
/** Sunday 16:05 UTC: five minutes into the default digest slot of ISO week 2026-W45. */
const SUNDAY = Date.parse('2026-11-08T16:05:00Z');
const sec = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const UPDATE = PLATFORM_UPDATES[0]!;
const UPDATE_POST = `Something new on Bootr, and it is small and useful. ${UPDATE.url}`;
const DIGEST_POST = 'This week on Bootr: Fox Coin launched on 3 November and its agent @foxagent posted for the first time the same day.';
/** The sections only the platform agent gets. */
const PLATFORM_SECTIONS = ['bootrToday', 'weeklyDigest', 'platformNumbers', 'platformUpdate', 'watchlist'] as const;
/** What those sections leave in the state when a turn closes them. */
const bookkeeping = (s: AgentState) => ({ lastDigestWeek: s.lastDigestWeek ?? null, lastNumbersDay: s.lastNumbersDay ?? null, lastUpdateDay: s.lastUpdateDay ?? null, announcedUpdates: s.announcedUpdates ?? [], lastPostAt: s.lastPostAt ?? null, lastSlotSkippedAt: s.lastSlotSkippedAt ?? null });

const runtimeRow = async (w: TestWorld) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
const stateOf = async (w: TestWorld) => (await runtimeRow(w)).state as unknown as AgentState;
const sections = (observation: Record<string, unknown>) => Object.fromEntries(PLATFORM_SECTIONS.filter((key) => key in observation).map((key) => [key, observation[key]]));

function firstObservation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[0]!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

/** One week of platform events for the digest, dated for SUNDAY. */
function week(): Record<string, unknown> {
  return {
    now: SUNDAY / 1000,
    since: SUNDAY / 1000 - 7 * 86_400,
    totals: { tokens: 9, agentsTotal: 9, agentsAwake: 4, volume24hUsd: 12_345, volume7dUsd: 80_100, fees24hUsd: 120, updatedAt: sec('2026-11-08T16:00:00Z') },
    launches: [{ token: '0x1', kernel: '0x00000000000000000000000000000000000000aa', name: 'Fox Coin', symbol: '$FOX', creator: '0x1234567890abcdef1234567890abcdef12345678', launchedAt: sec('2026-11-03T09:00:00Z'), xHandle: 'foxagent' }],
    firstPosts: [{ kernel: '0x00000000000000000000000000000000000000aa', symbol: 'FOX', xHandle: 'foxagent', firstPostAt: sec('2026-11-03T12:00:00Z'), lastPostAt: sec('2026-11-07T08:00:00Z'), postsCount24h: 2 }],
  };
}

/** The same platform coin in a fresh world, hosted or own, with the indexer answering `feed`. */
async function host(at: number, opts: { own: boolean; script?: Response[]; feed: Record<string, unknown> | null; config?: Record<string, unknown>; runtime?: Record<string, unknown> }) {
  const w = await makeWorld({ script: opts.script ?? [] });
  w.setNow(at);
  resetWatchlistCache();
  (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), platformFeed: async () => opts.feed, platformFees: async () => null, graphql: async () => null } as unknown as IndexerClient;
  createApp(w.ctx);
  const base = { platform: true, xHandle: 'AgentBootr', socialStartedAt: new Date(at - 30 * H).toISOString(), ...opts.config };
  const agent = await seedAgent(w, { config: opts.own ? ownConfig(base) : base, runtime: { lastDecisionAt: new Date(at - 60_000), ...opts.runtime } });
  return { w, agent };
}

describe('the platform agent as an own agent', () => {
  it('the platform update, the numbers, the watchlist and Bootr today: shown as to the hosted turn, and the update closes on the post that carries it', async (t) => {
    const config = { requireApproval: false };
    const hosted = await host(WEEKDAY, { own: false, feed: null, config, script: [toolCallResponse('publish_post', { text: UPDATE_POST }, 'call_post'), finishResponse(WEEKDAY + 3 * H)] });
    try {
      const run = await processAgent(hosted.w.ctx, hosted.agent, await runtimeRow(hosted.w));
      expect(run?.turn?.outcome).toBe('finished');
      const shown = sections(firstObservation(hosted.w));
      expect((shown.platformUpdate as { update: { id: string } }).update.id).toBe(UPDATE.id);
      expect(shown).toHaveProperty('watchlist');
      expect(shown).toHaveProperty('bootrToday');
      const closed = bookkeeping(await stateOf(hosted.w));
      expect(closed).toMatchObject({ lastUpdateDay: '2026-11-05', announcedUpdates: [UPDATE.id], lastPostAt: WEEKDAY });
      expect(hosted.w.sender.published).toHaveLength(1);

      if (!ownRole('social')) return t.skip();
      const own = await host(WEEKDAY, { own: true, feed: null, config });
      try {
        setOwnFlag(own.w, true);
        forbidThoughts(own.w);
        const engine = fakeEngine(own.w);
        const opened = await engine.open('social');
        expect(sections(opened.observation)).toEqual(shown);
        expect(await engine.act('publish_post', { text: UPDATE_POST })).toMatchObject({ status: 'completed' });
        await engine.finish({ memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(WEEKDAY + 3 * H).toISOString() });
        expect(bookkeeping(await stateOf(own.w))).toEqual(closed);
        expect(own.w.sender.published).toHaveLength(1);
        // the next own turn is not shown the same update again
        own.w.setNow(WEEKDAY + 30 * H);
        const next = await engine.open('social', { forced: true });
        expect((next.observation.platformUpdate as { update: { id: string } } | undefined)?.update.id).not.toBe(UPDATE.id);
      } finally {
        await own.w.close();
      }
    } finally {
      await hosted.w.close();
    }
  });

  it('the weekly digest: due at its slot, handed the same week, closed by the post without moving the cadence anchor', async (t) => {
    const cadence = { postIntervalMs: 6 * H, socialStartedAt: new Date(SUNDAY - H).toISOString() };
    const runtime = { nextAt: new Date(SUNDAY + 6 * H) };
    const hosted = await host(SUNDAY, { own: false, feed: week(), config: cadence, runtime, script: [toolCallResponse('publish_post', { text: DIGEST_POST }, 'call_post'), finishResponse(SUNDAY + 3 * H)] });
    try {
      const run = await processAgent(hosted.w.ctx, hosted.agent, await runtimeRow(hosted.w));
      // at this hour the daily numbers post is due as well: the turn carries both, as the hosted one does
      expect(run).toMatchObject({ ran: true, reasons: [DIGEST_WAKE_REASON, NUMBERS_WAKE_REASON] });
      const shown = sections(firstObservation(hosted.w));
      expect(shown.weeklyDigest).toMatchObject({ due: true, week: '2026-W45' });
      expect(shown).toHaveProperty('platformNumbers');
      const closed = bookkeeping(await stateOf(hosted.w));
      expect(closed).toMatchObject({ lastDigestWeek: '2026-W45', lastNumbersDay: '2026-11-08', lastPostAt: null });
      // the platform agent's posts wait for the creator's review: queued counts as posted
      expect(await hosted.w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);

      if (!ownRole('social')) return t.skip();
      const own = await host(SUNDAY, { own: true, feed: week(), config: cadence, runtime });
      try {
        setOwnFlag(own.w, true);
        forbidThoughts(own.w);
        const engine = fakeEngine(own.w);
        expect(await engine.due('social')).toMatchObject({ due: true, reasons: expect.arrayContaining([DIGEST_WAKE_REASON, NUMBERS_WAKE_REASON]) });
        const opened = await engine.open('social');
        expect(sections(opened.observation)).toEqual(shown);
        expect(await engine.act('publish_post', { text: DIGEST_POST })).toMatchObject({ status: 'completed' });
        await engine.finish({ memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(SUNDAY + 3 * H).toISOString() });
        expect(bookkeeping(await stateOf(own.w))).toEqual(closed);
        expect(await own.w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);
        // not due again this week
        own.w.setNow(SUNDAY + 60_000);
        expect((await engine.due('social')).reasons).not.toContain(DIGEST_WAKE_REASON);
      } finally {
        await own.w.close();
      }
    } finally {
      await hosted.w.close();
    }
  });

  it('a digest turn the own agent ends with finish and no post closes the week too, as the hosted one does', async (t) => {
    const cadence = { postIntervalMs: 6 * H, socialStartedAt: new Date(SUNDAY - H).toISOString() };
    const runtime = { nextAt: new Date(SUNDAY + 6 * H) };
    const hosted = await host(SUNDAY, { own: false, feed: week(), config: cadence, runtime, script: [finishResponse(SUNDAY + 3 * H)] });
    try {
      await processAgent(hosted.w.ctx, hosted.agent, await runtimeRow(hosted.w));
      const closed = bookkeeping(await stateOf(hosted.w));
      expect(closed).toMatchObject({ lastDigestWeek: '2026-W45', lastNumbersDay: '2026-11-08', lastPostAt: null });
      if (!ownRole('social')) return t.skip();
      const own = await host(SUNDAY, { own: true, feed: week(), config: cadence, runtime });
      try {
        setOwnFlag(own.w, true);
        forbidThoughts(own.w);
        const engine = fakeEngine(own.w);
        await engine.open('social');
        await engine.finish({ memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(SUNDAY + 3 * H).toISOString() });
        expect(bookkeeping(await stateOf(own.w))).toEqual(closed);
      } finally {
        await own.w.close();
      }
    } finally {
      await hosted.w.close();
    }
  });
});
