/**
 * The platform account's quiet slot (src/platform-quiet.ts, rule R9): a due slot with nothing new buys no turn, but
 * only while the dataset is on and really handed the account a record in the last day, never while a mention, an
 * update, the numbers post, the digest or the watchlist has something, and never past the ceiling of a day.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { cursors, recordsServed, runtimes } from '../src/db/schema.js';
import { noteServed } from '../src/dataset/served.js';
import { ingestSighting, syncSources } from '../src/dataset/store.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { PLATFORM_QUIET_SERVED_WITHIN_MS, platformPostDue, platformQuietOn, platformQuietSlot, watchlistHasNews } from '../src/platform-quiet.js';
import { initialState, type AgentState } from '../src/runtime.js';
import { processAgent } from '../src/tick.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { infoOf, sighting } from './dataset-helpers.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const H = 3_600_000;
/** A Saturday morning: no numbers post (15:00) and no digest (Sunday 16:00) is due, and no platform update is dated yet. */
const T0 = Date.parse('2026-10-24T09:00:00Z');
const PLATFORM = { platform: true, capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false, services: false, bounties: false } };
const due = { due: true, mentionWaiting: false, configChanged: false, creatorRequest: false };
type State = Parameters<typeof platformQuietSlot>[3];
/** A runtime state with `over` on it. */
const stateOf = (over: Record<string, unknown>): State => ({ ...initialState(), ...over }) as unknown as State;

let w: TestWorld;

async function setup(config: Record<string, string> = { DATASET_ENABLED: 'true' }) {
  w = await makeWorld({ script: [finishResponse(T0 + 3 * H), finishResponse(T0 + 6 * H)], config });
  w.setNow(T0);
  (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), platformFeed: async () => null, platformFees: async () => null, graphql: async () => null } as unknown as IndexerClient;
  await seedAgent(w, { config: { platform: true, xHandle: 'AgentBootr', requireApproval: false, socialStartedAt: new Date(T0 - 30 * H).toISOString() }, runtime: { lastDecisionAt: new Date(T0 - 60_000) } });
  await syncSources(w.db, new Date(T0 - 2 * H));
}

/** The watchlist as read `ago` ms before now, every handle, with posts of `postedAt`. */
async function watchlistRead(ago: number, postedAt: number | null = null) {
  for (const handle of ['bootrfun', 'base', 'jessepollak', 'clanker_world']) {
    const value = JSON.stringify({ at: T0 - ago, posts: postedAt === null ? [] : [{ postId: '1', at: new Date(postedAt).toISOString(), text: 'x', link: `https://x.com/${handle}/status/1` }] });
    await w.db.insert(cursors).values({ name: `watchlist:${handle}`, value, updatedAt: new Date(T0 - ago) }).onConflictDoUpdate({ target: cursors.name, set: { value } });
  }
}

/** A state whose last slot was used three hours ago, and that was handed a record two hours ago. */
async function quietState(over: Record<string, unknown> = {}): Promise<State> {
  await noteServed(w.ctx, AGENT_ID, ['r_000000000001'], { slotDue: true });
  await w.db.update(recordsServed).set({ lastServedAt: new Date(T0 - 2 * H) });
  return stateOf({ lastPostAt: T0 - 3 * H, quietMark: { at: T0 - 3 * H, holders: null }, ...over });
}

const ask = (state: State, signals: Partial<typeof due> = {}) => platformQuietSlot(w.ctx, { agentId: AGENT_ID, token: '0x3000000000000000000000000000000000000003' }, PLATFORM, state, { ...due, ...signals });

beforeEach(() => resetWatchlistCache());
afterEach(async () => {
  await w.close();
});

describe('when the rule is on', () => {
  it('only for the platform account, with the deployment\'s quiet slot and the dataset on', async () => {
    await setup();
    expect(platformQuietOn(w.ctx, PLATFORM)).toBe(true);
    expect(platformQuietOn(w.ctx, { ...PLATFORM, platform: false })).toBe(false);
    expect(platformQuietOn({ config: { ...w.ctx.config, DATASET_ENABLED: false } }, PLATFORM)).toBe(false);
    expect(platformQuietOn({ config: { ...w.ctx.config, QUIET_SLOT: false } }, PLATFORM)).toBe(false);
    expect(platformQuietOn({ config: { ...w.ctx.config, PLATFORM_RECORDS: 0 } }, PLATFORM)).toBe(false);
  });

  it('with the dataset off, a slot with nothing new is a turn, as before', async () => {
    await setup({});
    await watchlistRead(H);
    expect(await ask(await quietState())).toEqual({ skipped: false, reasons: [] });
  });

  it('with the dataset on but no record handed to the account in the last day, a slot is a turn', async () => {
    await setup();
    await watchlistRead(H);
    const state = stateOf({ lastPostAt: T0 - 3 * H, quietMark: { at: T0 - 3 * H, holders: null } });
    expect(await ask(state)).toMatchObject({ skipped: false, reasons: ['records_unserved'] });
    await noteServed(w.ctx, AGENT_ID, ['r_000000000001'], { slotDue: true });
    w.setNow(T0 + PLATFORM_QUIET_SERVED_WITHIN_MS + 1);
    expect(await ask(state)).toMatchObject({ skipped: false, reasons: ['records_unserved'] });
  });
});

describe('a due slot with nothing new buys no turn', () => {
  it('is spent the way a passed slot is, with no model call', async () => {
    await setup();
    await watchlistRead(H, T0 - 5 * H);
    const state = await quietState();
    const outcome = await ask(state);
    expect(outcome).toEqual({ skipped: true, reasons: [], records: [] });
    expect(state).toMatchObject({ lastSlotSkippedAt: T0, quietSeen: null, quietSkipped: { count: 1, lastAt: T0 } });
  });

  it('end to end: the tick skips the slot and buys no thought', async () => {
    await setup();
    await watchlistRead(H);
    const state = await quietState();
    await w.db.update(runtimes).set({ state: state as never, nextAt: new Date(T0 - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
    const agent = (await w.db.query.agents.findFirst())!;
    await processAgent(w.ctx, agent, (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!);
    expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
    expect(((await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState).lastSlotSkippedAt).toBe(T0);
  });
});

describe('what is new keeps the slot', () => {
  it('end to end: a new record buys the turn, and the turn is shown the records the check found', async () => {
    await setup();
    await watchlistRead(H);
    const state = await quietState();
    await w.db.update(runtimes).set({ state: state as never, nextAt: new Date(T0 - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
    const r = await ingestSighting(w.db, infoOf('b:base-node'), sighting('b:base-node', { title: 'Base node v0.14.2 is out', link: 'https://github.com/base/node/releases/tag/v0.14.2' }, new Date(T0 - H)), { now: new Date(T0 - H) });
    const agent = (await w.db.query.agents.findFirst())!;
    await processAgent(w.ctx, agent, (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!);
    const call = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
    const observation = JSON.parse((call.body as { messages: { role: string; content: string }[] }).messages[1]!.content) as { records?: { suggested: { id: string } } };
    expect(observation.records?.suggested.id).toBe(r.outcome === 'capped' ? '' : r.recordId);
  });

  it('a record in its beat it has not posted: the turn is bought and handed the records the check found', async () => {
    await setup();
    await watchlistRead(H);
    const state = await quietState();
    const r = await ingestSighting(w.db, infoOf('b:base-node'), sighting('b:base-node', { title: 'Base node v0.14.2 is out', link: 'https://github.com/base/node/releases/tag/v0.14.2' }, new Date(T0 - H)), { now: new Date(T0 - H) });
    const outcome = await ask(state);
    expect(outcome).toMatchObject({ skipped: false, reasons: ['new_record'] });
    expect(outcome.records!.map((x) => x.id)).toEqual([r.outcome === 'capped' ? '' : r.recordId]);
    expect(state.lastSlotSkippedAt).toBeUndefined();
  });

  it('a mention, a changed setting, an ended hold, a platform update, the numbers post or the digest: no read at all', async () => {
    await setup();
    const state = stateOf({ lastPostAt: T0 - 3 * H, quietMark: { at: T0 - 3 * H, holders: null } });
    expect((await ask(state, { mentionWaiting: true })).reasons).toEqual(['mention']);
    expect((await ask(state, { configChanged: true })).reasons).toEqual(['config_changed']);
    expect((await ask(stateOf({ ...state, postHoldEndedNote: { at: T0 - H } }))).reasons).toEqual(['hold_ended']);
    w.setNow(Date.parse('2026-11-05T09:00:00Z'));
    expect((await ask(state)).reasons).toEqual(['platform_update']);
    expect(platformPostDue(w.ctx, {}, Date.parse('2026-10-24T16:00:00Z'))).toBe('numbers_due');
    expect(platformPostDue(w.ctx, { lastNumbersDay: '2026-10-24' }, Date.parse('2026-10-24T16:00:00Z'))).toBeNull();
    expect(platformPostDue(w.ctx, { lastNumbersDay: '2026-10-25' }, Date.parse('2026-10-25T17:00:00Z'))).toBe('digest_due');
    expect(platformPostDue({ config: { PLATFORM_NUMBERS_AT: 'noon' } }, {}, T0)).toBe('numbers_due');
  });

  it('the watchlist: a handle never read or due for a read, or a watched post newer than the last slot', async () => {
    await setup();
    const since = T0 - 3 * H;
    expect(await watchlistHasNews(w.ctx, PLATFORM, since)).toBe(true);
    await watchlistRead(H, T0 - 5 * H);
    expect(await watchlistHasNews(w.ctx, PLATFORM, since)).toBe(false);
    await watchlistRead(H, T0 - 2 * H);
    expect(await watchlistHasNews(w.ctx, PLATFORM, since)).toBe(true);
    await watchlistRead(7 * H, T0 - 5 * H);
    expect(await watchlistHasNews(w.ctx, PLATFORM, since)).toBe(true);
    expect(await watchlistHasNews(w.ctx, { capabilities: { ...PLATFORM.capabilities, xRead: false } }, since)).toBe(false);
    await watchlistRead(H, T0 - 2 * H);
    const state = await quietState();
    expect(await ask(state)).toMatchObject({ skipped: false, reasons: ['watchlist'] });
  });

  it('the first slot after the rule switched on, and any slot past the ceiling of a day', async () => {
    await setup();
    await watchlistRead(H);
    expect((await ask(await quietState({ quietMark: null }))).reasons).toEqual(['first_slot']);
    expect((await ask(await quietState({ lastPostAt: T0 - 25 * H, quietMark: { at: T0 - 25 * H, holders: null } }))).reasons).toEqual(['quiet_ceiling']);
  });

  it('a check that fails keeps the slot', async () => {
    await setup();
    const broken = { ...w.ctx, db: { select: () => { throw new Error('down'); } } as never };
    expect(await platformQuietSlot(broken, { agentId: AGENT_ID, token: '0x3' }, PLATFORM, stateOf({ lastPostAt: T0 - 3 * H, quietMark: { at: T0 - 3 * H, holders: null } }), due)).toEqual({ skipped: false, reasons: ['check_failed'] });
  });
});
