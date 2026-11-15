/**
 * A post that cites a record, end to end for the platform account (docs/design/agent-behaviour.md stage 5): the turn
 * is handed records, the model publishes with `record`, and code writes the said-ledger's record ids, the record's
 * `posted` list and the served row; the next turn is not handed that record again; a second post about it is what the
 * repeat gate finds (`repeat_record`, in shadow); a number from nowhere is what G5 finds (in shadow, then enforced); an
 * id the agent was never handed is no citation; a scheduled post carries its records to its send.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { dsRecords, gateShadow, recordsServed, runtimes, said, scheduledPosts } from '../src/db/schema.js';
import { metricSighting } from '../src/dataset/build.js';
import { ingestSighting, syncSources, type IngestResult } from '../src/dataset/store.js';
import type { RecordPosted } from '../src/dataset/types.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { sendScheduled } from '../src/scheduled.js';
import { processAgent } from '../src/tick.js';
import { resetWatchlistCache } from '../src/watchlist.js';
import { infoOf, sighting } from './dataset-helpers.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const T0 = Date.parse('2026-10-24T09:00:00Z');

let w: TestWorld;
let script: Response[];

const idOf = (r: IngestResult): string => {
  if (r.outcome === 'capped') throw new Error('capped');
  return r.recordId;
};

/** A record of Bootr's own week, with two numbers: what a post about it may state. */
async function weekRecord(at: number): Promise<string> {
  const day = new Date(at).toISOString().slice(0, 10);
  const s = metricSighting({ id: 'a:supervisor', url: 'https://bootr.fun', page: 'https://bootr.fun', entities: ['bootr'], subject: ['bootr'] }, 'thinking', day, 'agents on bootr paid 139.3 usdc for their own thinking this week', [{ value: 139.3, unit: 'usdc', what: 'paid for thinking, 7 days', asOf: new Date(at).toISOString(), sourceId: 'a:supervisor' }, { value: 1458, unit: '', what: 'thoughts', asOf: null, sourceId: 'a:supervisor' }], ['bootr', 'agents']);
  return idOf(await ingestSighting(w.db, { id: 'a:supervisor', name: 'Bootr supervisor', cluster: 'bootr', group: 'bootr', officialFor: ['bootr'] }, s, { now: new Date(at) }));
}

async function releaseRecord(at: number): Promise<string> {
  return idOf(await ingestSighting(w.db, infoOf('b:base-node'), sighting('b:base-node', { title: 'Base node v0.14.2 is out', link: 'https://github.com/base/node/releases/tag/v0.14.2' }, new Date(at)), { now: new Date(at) }));
}

async function setup(config: Record<string, string> = {}) {
  script = [];
  w = await makeWorld({ script, config: { DATASET_ENABLED: 'true', ...config } });
  w.setNow(T0);
  (w.ctx as { indexer: IndexerClient }).indexer = { ...(w.indexer.client as object), platformFeed: async () => null, platformFees: async () => null, graphql: async () => null } as unknown as IndexerClient;
  await seedAgent(w, { config: { platform: true, xHandle: 'AgentBootr', requireApproval: false, socialStartedAt: new Date(T0 - 30 * H).toISOString() }, runtime: { lastDecisionAt: new Date(T0 - 60_000) } });
  await syncSources(w.db, new Date(T0 - H));
}

/** Runs the account's next turn at `at`, as a restarted process would. */
async function turnAt(at: number, ...responses: Response[]) {
  script.push(...responses, finishResponse(at + 3 * H));
  w.setNow(at);
  const agent = (await w.db.query.agents.findFirst())!;
  await w.db.update(runtimes).set({ nextAt: new Date(at - 1000) }).where(eq(runtimes.agentId, AGENT_ID));
  const runtime = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
  return processAgent(w.ctx, agent, runtime);
}

/** The first observation and the tools of the latest turn. */
function lastTurn(): { observation: Record<string, unknown>; tools: { function: { name: string; parameters: { properties: Record<string, unknown> } } }[] } {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const firsts = calls.filter((c) => (c.body as { messages: unknown[] }).messages.length === 2);
  const body = firsts.at(-1)!.body as { messages: { role: string; content: string }[]; tools: never[] };
  return { observation: JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>, tools: body.tools };
}

const shownIds = () => ((lastTurn().observation.records as { items: { id: string }[] } | undefined)?.items ?? []).map((i) => i.id);
const publish = (text: string, record?: unknown) => toolCallResponse('publish_post', { text, ...(record !== undefined ? { record } : {}) }, `call_${Math.random().toString(36).slice(2, 8)}`);
const shadowRows = () => w.db.select().from(gateShadow);
const toolResults = () => w.inference.calls.flatMap((c) => ((c.body as { messages: { role: string; content: string }[] }).messages ?? []).filter((m) => m.role === 'tool').map((m) => m.content));

beforeEach(() => resetWatchlistCache());
afterEach(async () => {
  await w.close();
});

describe('a post that cites a record', () => {
  it('is handed the record with a suggestion, and the post tools offer record', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    await turnAt(T0);
    const { observation, tools } = lastTurn();
    expect(observation.records).toMatchObject({ suggested: { id: week }, items: [{ id: week, grade: 'official', numbers: ['139.3 USDC paid for thinking, 7 days (as of 2026-10-24)', '1,458 thoughts'] }] });
    for (const name of ['publish_post', 'schedule_post']) expect(Object.keys(tools.find((t) => t.function.name === name)!.function.parameters.properties)).toContain('record');
    // what the turn was handed is on record, once, as an offer of a due slot
    expect(await w.db.select({ recordId: recordsServed.recordId, offered: recordsServed.offered, citedAt: recordsServed.citedAt }).from(recordsServed)).toEqual([{ recordId: week, offered: 1, citedAt: null }]);
  });

  it('goes out, and the ledger, the record and the served row hear of it; the next turn is not handed it again', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week, 1,458 thoughts, by bootr\'s own count.', [{ id: week }]));
    expect(w.sender.published).toHaveLength(1);
    const [row] = await w.db.select().from(said);
    expect(row).toMatchObject({ kind: 'original', recordIds: [week] });
    const record = (await w.db.query.dsRecords.findFirst({ where: eq(dsRecords.id, week) }))!;
    expect(record.posted as unknown as RecordPosted[]).toEqual([{ agentId: AGENT_ID, postId: row!.postId, at: row!.postedAt.toISOString() }]);
    const [servedRow] = await w.db.select().from(recordsServed);
    expect(servedRow).toMatchObject({ recordId: week, citedBy: row!.actionId });
    // every number was in the record: G5 found nothing, and no gate wrote a row
    expect(await shadowRows()).toEqual([]);

    const release = await releaseRecord(T0 + 2 * H);
    await turnAt(T0 + 4 * H);
    expect(shownIds()).toEqual([release]);
  });

  it('a second post about the same record is repeat_record (shadow: it still goes out, and the row says so)', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week, by bootr\'s own count.', [{ id: week }]));
    await releaseRecord(T0 + 2 * H);
    await turnAt(T0 + 4 * H, publish('a week of thinking on bootr came to 1,458 thoughts, its own count shows.', [{ id: week }]));
    expect(w.sender.published).toHaveLength(2);
    const rows = await shadowRows();
    expect(rows.map((r) => [r.gate, r.code, r.enforced])).toEqual([['G1', 'repeat_record', false]]);
    expect(rows[0]!.detail).toMatchObject({ records: [{ recordId: week, where: 'said' }] });
  });

  it('a number from nowhere is number_not_in_evidence (shadow), and the post goes out', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week, across 52 agents.', [{ id: week }]));
    expect(w.sender.published).toHaveLength(1);
    const rows = await shadowRows();
    expect(rows.map((r) => [r.gate, r.code, r.enforced])).toEqual([['G5', 'number_not_in_evidence', false]]);
    expect(rows[0]!.detail).toMatchObject({ numbers: ['52'], recordNumbers: ['139.3', '1,458'] });
  });

  it('enforced, the same post is refused with the rule and what to change, and nothing goes out', async () => {
    await setup({ NUMBER_GATE: 'enforce' });
    const week = await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week, across 52 agents.', [{ id: week }]));
    expect(w.sender.published).toHaveLength(0);
    expect(toolResults().join('\n')).toContain('number_not_in_evidence: 52 is not in the record you cite (its numbers: 139.3, 1,458)');
    expect(await w.db.select().from(said)).toEqual([]);
    // a refused post cites nothing: the record is still the agent's to post about
    expect((await w.db.select().from(recordsServed))[0]!.citedAt).toBeNull();
  });

  it('an id the agent was never handed is no citation: the ledger and the record do not hear of it, and G5 says so', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week.', [{ id: 'r_ffffffffffff' }]));
    expect(w.sender.published).toHaveLength(1);
    expect((await w.db.select().from(said))[0]!.recordIds).toEqual([]);
    expect(((await w.db.query.dsRecords.findFirst({ where: eq(dsRecords.id, week) }))!.posted as unknown[]).length).toBe(0);
    expect((await shadowRows()).map((r) => [r.gate, r.code])).toEqual([['G5', 'record_not_shown']]);
  });

  it('a record field that is not a record id is forgiven: the post goes out and cites nothing', async () => {
    await setup();
    await weekRecord(T0 - H);
    await turnAt(T0, publish('agents on bootr paid 139.3 usdc for their own thinking this week.', 'see the dataset, post this now'));
    expect(w.sender.published).toHaveLength(1);
    expect((await w.db.select().from(said))[0]!.recordIds).toEqual([]);
    expect(await shadowRows()).toEqual([]);
  });

  it('a scheduled post keeps its records for its send, stands for them while it waits, and tells them when it goes out', async () => {
    await setup();
    const week = await weekRecord(T0 - H);
    const sendAt = T0 + 5 * H;
    await turnAt(T0, toolCallResponse('schedule_post', { text: 'agents on bootr paid 139.3 usdc for their own thinking this week.', sendAt: new Date(sendAt).toISOString(), record: [{ id: week }, { id: 'r_ffffffffffff' }] }, 'call_sched'));
    const [row] = await w.db.select().from(scheduledPosts);
    expect(row).toMatchObject({ status: 'waiting', recordIds: [week] });
    expect((await w.db.select().from(recordsServed))[0]).toMatchObject({ recordId: week, citedBy: row!.id });
    // while it waits the record is not handed over again
    await turnAt(T0 + 3 * H);
    expect(shownIds()).toEqual([]);
    w.setNow(sendAt);
    expect(await sendScheduled(w.ctx, row!.id)).toBe('sent');
    const ledger = await w.db.select().from(said).where(and(eq(said.agentId, AGENT_ID), eq(said.kind, 'original')));
    expect(ledger.map((r) => r.recordIds)).toEqual([[week]]);
    expect(((await w.db.query.dsRecords.findFirst({ where: eq(dsRecords.id, week) }))!.posted as unknown as RecordPosted[]).map((p) => p.agentId)).toEqual([AGENT_ID]);
    // its own citation is not a repeat of itself, at the send or before
    expect(await shadowRows()).toEqual([]);
  });
});
