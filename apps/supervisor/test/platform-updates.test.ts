import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { postValidation, type PendingAction } from '@bootr/agent-core';
import { approvals, runtimes } from '../src/db/schema.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { PLATFORM_UPDATES, PLATFORM_UPDATE_INSTRUCTION, UPDATE_MAX_AGE_DAYS, offerPlatformUpdate, pendingUpdate, platformUpdateSection, postCarriesUpdate, settlePlatformUpdate, type PlatformUpdate } from '../src/platform-updates.js';
import { NUMBERS_WAKE_REASON } from '../src/platform-numbers.js';
import { initialState, type AgentState } from '../src/runtime.js';
import { processAgent } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const D = 24 * H;
/** Mid-morning UTC: no numbers post is due (its default slot is 15:00), and every seeded item is in its window. */
const AT = Date.parse('2026-11-05T10:00:00Z');
const FIRST = PLATFORM_UPDATES[0]!;
const SECOND = PLATFORM_UPDATES[1]!;

const item = (id: string, date: string, url = `https://bootr.fun/docs/${id}`): PlatformUpdate => ({ id, date, title: id, plain: `${id} is live.`, url });

const post = (text: string) => toolCallResponse('publish_post', { text }, 'call_post');
const announce = (update: PlatformUpdate) => post(`Something new on Bootr, and it is small and useful. ${update.url}`);
const done = (at = AT) => finishResponse(at + 3 * H);

async function runtimeRow(w: TestWorld) {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
}

/** The observation of the latest turn: the first user message of the latest paid call. */
function observation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls.at(-1)!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

const shown = (w: TestWorld) => (observation(w).platformUpdate as { update: PlatformUpdate } | undefined)?.update.id ?? null;

/** A platform agent with review off whose regular slot is due. */
async function seedHost(w: TestWorld, config: Record<string, unknown> = {}, runtime: Record<string, unknown> = {}) {
  (w.ctx as { indexer: IndexerClient }).indexer = {
    ...(w.indexer.client as object),
    platformFeed: async () => null,
    platformFees: async () => null,
    graphql: async () => null,
  } as unknown as IndexerClient;
  return seedAgent(w, { config: { platform: true, xHandle: 'AgentBootr', requireApproval: false, socialStartedAt: new Date(w.ctx.now() - 30 * H).toISOString(), ...config }, runtime: { lastDecisionAt: new Date(w.ctx.now() - 60_000), ...runtime } });
}

/** Runs the host's next turn, reading its row from the database as a restarted process would. */
async function nextTurn(w: TestWorld, at: number) {
  w.setNow(at);
  const agent = (await w.db.query.agents.findFirst())!;
  await w.db.update(runtimes).set({ nextAt: new Date(at - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
  return (await processAgent(w.ctx, agent, await runtimeRow(w)))!;
}

const stateOf = async (w: TestWorld) => (await runtimeRow(w)).state as unknown as AgentState;

describe('the list', () => {
  it('runs oldest first, with unique ids and links', () => {
    const dates = PLATFORM_UPDATES.map((u) => u.date);
    expect(dates).toEqual([...dates].sort());
    for (const date of dates) expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(new Set(PLATFORM_UPDATES.map((u) => u.id)).size).toBe(PLATFORM_UPDATES.length);
    // no post may count for two items
    for (const a of PLATFORM_UPDATES) for (const b of PLATFORM_UPDATES) if (a !== b) expect(postCarriesUpdate(a.url, b)).toBe(false);
  });

  it('is plain public copy: no internal names, no price talk, no skill, https links, and the publish gate takes it', () => {
    for (const u of PLATFORM_UPDATES) {
      const text = `${u.title} ${u.plain}`;
      expect(text).not.toMatch(/x402|session key|kernel|supervisor|spender|indexer|inference/i);
      expect(text).not.toMatch(/price|market cap|returns?\b|profit|\bbuy\b/i);
      expect(`${text} ${u.url}`).not.toMatch(/skill/i);
      expect(u.url).toMatch(/^https:\/\//);
      expect(postValidation(`${u.plain} ${u.url}`, [], 'original', false, { platform: true })).toEqual({ ok: true });
    }
  });

  it('seeds what is live today', () => {
    expect(PLATFORM_UPDATES.map((u) => u.id)).toEqual(['coin-links-edit', 'fuel-runway', 'public-endpoints-page', 'agent-skill']);
    expect(PLATFORM_UPDATES[2]!.url).toBe('https://api.bootr.fun');
    expect(PLATFORM_UPDATES[2]!.plain).toContain('https://bootr.fun/api/catalog');
  });
});

describe('pendingUpdate', () => {
  const list = [item('a', '2026-11-01'), item('b', '2026-11-02'), item('c', '2026-11-03')];
  const now = Date.parse('2026-11-05T12:00:00Z');

  it('shows the oldest unannounced, one at a time, so a first run with a backlog shows one', () => {
    expect(pendingUpdate({}, now, list)?.id).toBe('a');
    expect(pendingUpdate({ announcedUpdates: ['a'] }, now, list)?.id).toBe('b');
    expect(pendingUpdate({ announcedUpdates: ['b'] }, now, list)?.id).toBe('a');
    expect(pendingUpdate({ announcedUpdates: ['a', 'b', 'c'] }, now, list)).toBeNull();
  });

  it('allows at most one a UTC day', () => {
    const state = { announcedUpdates: ['a'], lastUpdateDay: '2026-11-05' };
    expect(pendingUpdate(state, now, list)).toBeNull();
    expect(pendingUpdate(state, Date.parse('2026-11-05T23:59:59Z'), list)).toBeNull();
    expect(pendingUpdate(state, Date.parse('2026-11-06T00:00:00Z'), list)?.id).toBe('b');
  });

  it('never shows an item older than the window, and skips past it to a newer one', () => {
    const start = Date.parse('2026-11-01T00:00:00Z');
    expect(UPDATE_MAX_AGE_DAYS).toBe(14);
    expect(pendingUpdate({}, start + 14 * D, list)?.id).toBe('a');
    expect(pendingUpdate({}, start + 14 * D + 1, list)?.id).toBe('b');
    expect(pendingUpdate({}, start + 60 * D, list)).toBeNull();
  });

  it('does not show an item dated after today', () => {
    expect(pendingUpdate({}, now, [item('later', '2026-11-06')])).toBeNull();
  });
});

describe('postCarriesUpdate', () => {
  const u: PlatformUpdate = { id: 'x', date: '2026-11-05', title: 'x', plain: 'On one page at https://api.bootr.fun, and at https://bootr.fun/api/catalog for programs.', url: 'https://api.bootr.fun' };

  it('accepts the link however it is written, and the other link the item names', () => {
    for (const text of ['See https://api.bootr.fun', 'See https://api.bootr.fun/.', 'api.bootr.fun has them all', '(https://API.bootr.fun)', 'Programs: https://bootr.fun/api/catalog']) expect(postCarriesUpdate(text, u)).toBe(true);
    expect(postCarriesUpdate('Read https://bootr.fun/docs/launch', { ...u, plain: 'x', url: 'https://bootr.fun/docs/launch#after-launch' })).toBe(true);
  });

  it('refuses a text without it, a longer path and a lookalike host', () => {
    for (const text of ['The whole list is on our api page', 'https://bootr.fun', 'https://api.bootr.fun.example.com', 'https://bootr.fun/api/catalog/extra', 'https://notapi.bootr.fun']) expect(postCarriesUpdate(text, u)).toBe(false);
  });
});

describe('settlePlatformUpdate', () => {
  const list = [item('a', '2026-11-01'), item('b', '2026-11-02')];
  const now = Date.parse('2026-11-05T12:00:00Z');
  const publish = (text: string, status: PendingAction['status'] = 'completed') => ({ status, action: { tool: 'publish_post', input: { text } } }) as unknown as PendingAction;
  const offered = (): AgentState => ({ ...initialState(), offeredUpdate: 'a' });

  it('marks the offered item on a completed post with its link, once', () => {
    const state = offered();
    expect(settlePlatformUpdate({ platform: true }, state, publish('hello https://bootr.fun/docs/a'), now, list)).toBe(true);
    expect(state).toMatchObject({ announcedUpdates: ['a'], lastUpdateDay: '2026-11-05', offeredUpdate: null });
    expect(settlePlatformUpdate({ platform: true }, state, publish('hello https://bootr.fun/docs/a'), now, list)).toBe(false);
    expect(state.announcedUpdates).toEqual(['a']);
  });

  it('marks nothing for a failed or unsettled post, a post without the link, a reply or a link not offered', () => {
    for (const status of ['failed', 'sent', 'held', 'sending'] as const) {
      const state = offered();
      expect(settlePlatformUpdate({ platform: true }, state, publish('hello https://bootr.fun/docs/a', status), now, list)).toBe(false);
      expect(state.announcedUpdates).toBeUndefined();
    }
    const state = offered();
    expect(settlePlatformUpdate({ platform: true }, state, publish('no link here'), now, list)).toBe(false);
    expect(settlePlatformUpdate({ platform: true }, state, publish('another https://bootr.fun/docs/b'), now, list)).toBe(false);
    expect(settlePlatformUpdate({ platform: true }, state, { status: 'completed', action: { tool: 'publish_reply', input: { text: 'https://bootr.fun/docs/a' } } } as unknown as PendingAction, now, list)).toBe(false);
    expect(settlePlatformUpdate({ platform: true }, state, null, now, list)).toBe(false);
    expect(state).toMatchObject({ offeredUpdate: 'a' });
    expect(state.lastUpdateDay).toBeUndefined();
  });

  it('keeps the stored ids to those that can still come up', () => {
    const state: AgentState = { ...offered(), announcedUpdates: ['gone', 'b'] };
    settlePlatformUpdate({ platform: true }, state, publish('https://bootr.fun/docs/a'), now, list);
    expect(state.announcedUpdates).toEqual(['b', 'a']);
  });

  it('does nothing for a coin agent', () => {
    const state = offered();
    expect(settlePlatformUpdate({ platform: false }, state, publish('https://bootr.fun/docs/a'), now, list)).toBe(false);
    expect(offerPlatformUpdate({ platform: false }, initialState(), now, true, list)).toBeNull();
    expect(platformUpdateSection({ platform: false }, list[0]!)).toEqual({});
    expect(platformUpdateSection({ platform: true }, null)).toEqual({});
  });
});

describe('platform updates in the tick', () => {
  it('shows the oldest item on a due slot, marks it when a post with the link goes out, and holds the rest for later days across restarts', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done(), done(), announce(SECOND), done()] });
    try {
      w.setNow(AT);
      await seedHost(w);
      expect((await nextTurn(w, AT)).turn?.outcome).toBe('finished');
      expect(observation(w).platformUpdate).toMatchObject({ instructionAuthority: false, instruction: PLATFORM_UPDATE_INSTRUCTION, update: FIRST });
      expect(w.sender.published).toHaveLength(1);
      expect(await stateOf(w)).toMatchObject({ announcedUpdates: [FIRST.id], lastUpdateDay: '2026-11-05', offeredUpdate: null, lastPostAt: AT });

      // Later the same UTC day: nothing, from the stored state alone.
      await nextTurn(w, AT + 6 * H);
      expect(shown(w)).toBeNull();

      // The next day: the next item, and never the first again.
      const next = AT + D;
      await nextTurn(w, next);
      expect(shown(w)).toBe(SECOND.id);
      expect(await stateOf(w)).toMatchObject({ announcedUpdates: [FIRST.id, SECOND.id], lastUpdateDay: '2026-11-06' });
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('a failed publish does not mark the item, and it comes back', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done(), done()] });
    try {
      w.setNow(AT);
      await seedHost(w);
      w.sender.publishStatus = 'rejected';
      await nextTurn(w, AT);
      expect(shown(w)).toBe(FIRST.id);
      const state = await stateOf(w);
      expect(state.announcedUpdates).toBeUndefined();
      expect(state.lastUpdateDay).toBeUndefined();
      w.sender.publishStatus = 'sent';
      await nextTurn(w, AT + D);
      expect(shown(w)).toBe(FIRST.id);
    } finally {
      await w.close();
    }
  });

  it('a post without the link and a turn that only finishes mark nothing', async () => {
    const w = await makeWorld({ script: [post('A note about agents on Base, no link in it.'), done(), done(), done()] });
    try {
      w.setNow(AT);
      await seedHost(w);
      await nextTurn(w, AT);
      expect(w.sender.published).toHaveLength(1);
      expect((await stateOf(w)).announcedUpdates).toBeUndefined();
      await nextTurn(w, AT + D);
      expect(shown(w)).toBe(FIRST.id);
      expect((await stateOf(w)).announcedUpdates).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('a publish whose outcome settles after its turn ended is marked before the next turn is shown anything', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done(AT + D), done(AT + 2 * D)] });
    try {
      w.setNow(AT);
      await seedHost(w);
      w.sender.publishStatus = 'held';
      expect((await nextTurn(w, AT)).turn?.outcome).toBe('held');
      const row = await runtimeRow(w);
      expect(row.turn).toBeNull();
      expect(row.state).toMatchObject({ offeredUpdate: FIRST.id });
      expect(row.state).not.toHaveProperty('announcedUpdates');
      w.sender.receipts[(row.pending as { id: string }).id] = { status: 'sent', providerPostId: '777' };
      // It settled today, so today's one is spent: the same item does not come back, and the next waits a day.
      await nextTurn(w, AT + D);
      expect(shown(w)).toBeNull();
      expect(await stateOf(w)).toMatchObject({ announcedUpdates: [FIRST.id], lastUpdateDay: '2026-11-06' });
      await nextTurn(w, AT + 2 * D);
      expect(shown(w)).toBe(SECOND.id);
    } finally {
      await w.close();
    }
  });

  it('a held publish that turns out refused does not mark the item', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done(AT + D)] });
    try {
      w.setNow(AT);
      await seedHost(w);
      w.sender.publishStatus = 'held';
      await nextTurn(w, AT);
      const row = await runtimeRow(w);
      w.sender.receipts[(row.pending as { id: string }).id] = { status: 'rejected', providerPostId: null, error: 'policy:invalid_short_post' };
      await nextTurn(w, AT + D);
      expect(shown(w)).toBe(FIRST.id);
      expect((await stateOf(w)).announcedUpdates).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('a post queued for review counts as posted, like everywhere else', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done()] });
    try {
      w.setNow(AT);
      await seedHost(w, { requireApproval: true });
      await nextTurn(w, AT);
      expect(w.sender.published).toHaveLength(0);
      expect(await w.db.select().from(approvals).where(eq(approvals.agentId, AGENT_ID))).toHaveLength(1);
      expect((await stateOf(w)).announcedUpdates).toEqual([FIRST.id]);
    } finally {
      await w.close();
    }
  });

  it('is not shown past the window: an old list does not reach the feed after downtime', async () => {
    const w = await makeWorld({ script: [done(AT + 60 * D)] });
    try {
      const late = AT + 60 * D;
      w.setNow(late);
      await seedHost(w);
      await nextTurn(w, late);
      expect(observation(w)).not.toHaveProperty('platformUpdate');
    } finally {
      await w.close();
    }
  });

  it('other agents never see it, and a post with the link marks nothing for them', async () => {
    const w = await makeWorld({ script: [announce(FIRST), done()] });
    try {
      w.setNow(AT);
      await seedAgent(w, { config: { socialStartedAt: new Date(AT - 30 * H).toISOString() } });
      await nextTurn(w, AT);
      expect(w.sender.published).toHaveLength(1);
      expect(observation(w)).not.toHaveProperty('platformUpdate');
      const state = await stateOf(w);
      for (const key of ['offeredUpdate', 'announcedUpdates', 'lastUpdateDay']) expect(state).not.toHaveProperty(key);
    } finally {
      await w.close();
    }
  });

  it('stays out of a turn without a due slot and of one that carries the numbers post, so it takes nothing\'s place', async () => {
    const w = await makeWorld({ script: [done(), done(Date.parse('2026-11-05T18:00:00Z'))] });
    try {
      w.setNow(AT);
      // Cadence not due: woken by its own `nextAt`.
      await seedHost(w, { postIntervalMs: 6 * H, socialStartedAt: new Date(AT - H).toISOString() });
      await nextTurn(w, AT);
      expect((observation(w).social as { originalPost: { due: boolean } }).originalPost.due).toBe(false);
      expect(observation(w)).not.toHaveProperty('platformUpdate');
      expect((await stateOf(w)).offeredUpdate).toBeNull();
    } finally {
      await w.close();
    }
    const n = await makeWorld({ script: [done(Date.parse('2026-11-05T18:00:00Z'))] });
    try {
      const slot = Date.parse('2026-11-05T15:05:00Z');
      n.setNow(slot);
      await seedHost(n);
      const totals = { tokens: 1, agentsTotal: 1, agentsAwake: 1, volume24hUsd: 1, volume7dUsd: 1, fees24hUsd: 1, updatedAt: slot / 1000 };
      (n.ctx as { indexer: IndexerClient }).indexer = { ...(n.ctx.indexer as object), platformFeed: async () => ({ now: slot / 1000, since: slot / 1000 - 7 * 86_400, totals }) } as unknown as IndexerClient;
      expect((await nextTurn(n, slot)).reasons).toContain(NUMBERS_WAKE_REASON);
      expect((observation(n).social as { originalPost: { due: boolean } }).originalPost.due).toBe(true);
      expect(observation(n)).not.toHaveProperty('platformUpdate');
    } finally {
      await n.close();
    }
  });
});
