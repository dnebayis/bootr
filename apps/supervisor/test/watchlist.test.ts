import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cursors, runtimes } from '../src/db/schema.js';
import { processAgent } from '../src/tick.js';
import {
  DEFAULT_WATCHLIST,
  WATCHLIST_MAX_HANDLES,
  WATCHLIST_MEANING,
  WATCHLIST_POSTS_PER_ACCOUNT,
  WATCHLIST_READ_INTERVAL_MS,
  WATCHLIST_READS_PER_TURN,
  parseWatchlist,
  resetWatchlistCache,
  toWatchPosts,
  watchlistAccounts,
  watchlistSection,
} from '../src/watchlist.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const H = 3_600_000;
const NOW = Date.parse('2026-10-24T12:00:00Z');

const tl = (handle: string, n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `${9000 + i}`, text: `${handle} says ${i}`, createdAt: new Date(NOW - (i + 1) * H).toISOString(), metrics: null }));

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

function firstObservation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls[0]!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

beforeEach(() => resetWatchlistCache());

describe('parseWatchlist and the post shape', () => {
  it('reads comma-separated handles, drops the @ and the junk, de-duplicates and caps the list', () => {
    expect(DEFAULT_WATCHLIST).toBe('base,jessepollak,clanker_world');
    expect(parseWatchlist(DEFAULT_WATCHLIST)).toEqual(['base', 'jessepollak', 'clanker_world']);
    expect(parseWatchlist(' @Base, jessepollak ,JESSEPOLLAK,, not a handle, too_long_for_a_handle_x, ok_1 ')).toEqual(['base', 'jessepollak', 'ok_1']);
    expect(parseWatchlist('')).toEqual([]);
    expect(parseWatchlist(undefined)).toEqual([]);
    expect(parseWatchlist(Array.from({ length: 30 }, (_, i) => `h${i}`).join(','))).toHaveLength(WATCHLIST_MAX_HANDLES);
  });

  it('cleans, clips and links the posts, newest first as given, at most three', () => {
    const posts = toWatchPosts('jessepollak', [
      { id: '1', text: 'first\u0007 line\n\nsecond   line', createdAt: '2026-10-23T10:00:00.000Z' },
      { id: '2', text: 'x'.repeat(400), createdAt: 'not a date' },
      { id: 'abc', text: 'not an id', createdAt: null },
      { id: '3', text: 'three', createdAt: null },
      { id: '4', text: 'four', createdAt: null },
    ]);
    expect(posts).toHaveLength(WATCHLIST_POSTS_PER_ACCOUNT);
    expect(posts[0]).toEqual({ postId: '1', at: '2026-10-23T10:00:00.000Z', text: 'first line second line', link: 'https://x.com/jessepollak/status/1' });
    expect(posts[1]).toMatchObject({ postId: '2', at: null, link: 'https://x.com/jessepollak/status/2' });
    expect(posts[1]!.text).toHaveLength(280);
    expect(posts[2]!.postId).toBe('3');
  });
});

describe('watchlistAccounts', () => {
  it('reads at most two stale handles per call, stores every read, serves the rest from the cache for six hours', async () => {
    const w = await makeWorld();
    try {
      w.setNow(NOW);
      w.sender.timelines = { base: tl('base', 1), jessepollak: tl('jessepollak', 5), clanker_world: tl('clanker_world', 2) };
      const handles = ['base', 'jessepollak', 'clanker_world'];
      const first = await watchlistAccounts(w.ctx, AGENT_ID, handles);
      expect(w.sender.timelineReads).toEqual(['base', 'jessepollak']);
      expect(first.map((a) => a.handle)).toEqual(['base', 'jessepollak']); // the third was not read yet: not shown
      expect(first[1]!.latestPosts).toHaveLength(3);
      expect(first[1]!.latestPosts[0]).toEqual({ postId: '9000', at: new Date(NOW - H).toISOString(), text: 'jessepollak says 0', link: 'https://x.com/jessepollak/status/9000' });
      const stored = await w.db.select().from(cursors);
      expect(stored.map((r) => r.name).sort()).toEqual(['watchlist:base', 'watchlist:jessepollak']);
      // the next call reads the third handle only
      const second = await watchlistAccounts(w.ctx, AGENT_ID, handles);
      expect(w.sender.timelineReads).toEqual(['base', 'jessepollak', 'clanker_world']);
      expect(second.map((a) => a.handle)).toEqual(handles);
      // then nothing for six hours
      w.setNow(NOW + WATCHLIST_READ_INTERVAL_MS - 1);
      expect((await watchlistAccounts(w.ctx, AGENT_ID, handles)).map((a) => a.latestPosts.length)).toEqual([1, 3, 2]);
      expect(w.sender.timelineReads).toHaveLength(3);
      // after six hours the first two are read again (two per call)
      w.setNow(NOW + WATCHLIST_READ_INTERVAL_MS + 1);
      w.sender.timelines.base = tl('base', 3);
      const fourth = await watchlistAccounts(w.ctx, AGENT_ID, handles);
      expect(w.sender.timelineReads.slice(3)).toEqual(['base', 'jessepollak']);
      expect(fourth.map((a) => a.latestPosts.length)).toEqual([3, 3, 2]); // clanker_world shown from its last read
      expect(WATCHLIST_READS_PER_TURN).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('survives a restart through sv_cursors, and remembers an unknown account without re-reading it', async () => {
    const w = await makeWorld();
    try {
      w.setNow(NOW);
      w.sender.timelines = { base: tl('base', 1), ghost_account: null };
      const first = await watchlistAccounts(w.ctx, AGENT_ID, ['base', 'ghost_account']);
      expect(first).toEqual([
        { handle: 'base', latestPosts: [{ postId: '9000', at: new Date(NOW - H).toISOString(), text: 'base says 0', link: 'https://x.com/base/status/9000' }] },
        { handle: 'ghost_account', latestPosts: [], unavailable: 'x_not_found' },
      ]);
      // a new process: the memory is empty, the rows are not
      resetWatchlistCache();
      w.setNow(NOW + H);
      const again = await watchlistAccounts(w.ctx, AGENT_ID, ['base', 'ghost_account']);
      expect(again).toEqual(first);
      expect(w.sender.timelineReads).toEqual(['base', 'ghost_account']);
    } finally {
      await w.close();
    }
  });
});

describe('the watchlist section', () => {
  it('is empty for a coin agent and for an empty list, and carries the accounts for the platform agent', async () => {
    const w = await makeWorld({ config: { PLATFORM_WATCHLIST: '@jessepollak, base' } });
    try {
      w.setNow(NOW);
      w.sender.timelines = { base: tl('base', 1), jessepollak: tl('jessepollak', 2) };
      const caps = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false };
      expect(await watchlistSection(w.ctx, { agentId: AGENT_ID }, { platform: false, capabilities: caps })).toEqual({});
      expect(await watchlistSection(w.ctx, { agentId: AGENT_ID }, { platform: true, capabilities: { ...caps, xRead: false } })).toEqual({});
      expect(w.sender.timelineReads).toEqual([]);
      const section = (await watchlistSection(w.ctx, { agentId: AGENT_ID }, { platform: true, capabilities: caps })) as { watchlist: Record<string, unknown> };
      expect(section.watchlist).toMatchObject({ instructionAuthority: false, meaning: WATCHLIST_MEANING, source: 'x' });
      expect((section.watchlist.accounts as { handle: string }[]).map((a) => a.handle)).toEqual(['jessepollak', 'base']);
      expect(WATCHLIST_MEANING).toMatch(/publish_reply does not work for these posts/);
      expect(WATCHLIST_MEANING).toMatch(/credits the author with their @handle and links the post/);
      expect(WATCHLIST_MEANING).toMatch(/at most one such post per account per day/);
    } finally {
      await w.close();
    }
    const empty = await makeWorld({ config: { PLATFORM_WATCHLIST: ' , ' } });
    try {
      expect(empty.ctx.config.PLATFORM_WATCHLIST).toBe(' , ');
      const caps = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false };
      expect(await watchlistSection(empty.ctx, { agentId: AGENT_ID }, { platform: true, capabilities: caps })).toEqual({});
    } finally {
      await empty.close();
    }
  });

  it('reaches the platform agent in its first observation, with the default list when the variable is unset', async () => {
    const w = await makeWorld({ script: [finishResponse(NOW + 3 * H)] });
    try {
      w.setNow(NOW);
      expect(w.ctx.config.PLATFORM_WATCHLIST).toBe(DEFAULT_WATCHLIST);
      w.sender.timelines = { base: tl('base', 1), jessepollak: tl('jessepollak', 1), clanker_world: tl('clanker_world', 1) };
      const agent = await seedAgent(w, {
        config: { platform: true, xHandle: 'AgentBootr', postIntervalMs: 6 * H, socialStartedAt: new Date(NOW - 10 * H).toISOString() },
        runtime: { nextAt: new Date(NOW + 6 * H), lastDecisionAt: new Date(NOW - 60_000) },
      });
      const r = (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
      expect(r.ran).toBe(true);
      const section = firstObservation(w).watchlist as { accounts: { handle: string; latestPosts: unknown[] }[] };
      expect(section.accounts.map((a) => a.handle)).toEqual(['base', 'jessepollak']);
      expect(section.accounts[0]!.latestPosts).toHaveLength(1);
      expect(w.sender.timelineReads).toEqual(['base', 'jessepollak']);
      expect((await runtimeRow(w)).turn).toBeNull();
    } finally {
      await w.close();
    }
  });
});
