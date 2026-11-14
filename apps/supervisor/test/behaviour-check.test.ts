/**
 * The weekly behaviour check (src/behaviour-check, scripts/behaviour-check.ts; docs/design/agent-behaviour.md section 5):
 * the measures as arithmetic, the database read (read only, and whole when `sv_turns` or `sv_gate_shadow` is missing),
 * the same read as a psql script, and the public read against stub endpoints.
 */
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/pglite/migrator';
import { describe, expect, it } from 'vitest';
import { AGENT_RE, READ_COMPLETE, STATEMENT_TIMEOUT, parseAnswers, printScript, runQueries, statements, toInput } from '../src/behaviour-check/database.js';
import { DAY_MS, NEEDS_DATABASE, asSection22, errorCode, measure, namesSource, percentile, renderTable, repeatRate, sameOpener, shapesOf, turnsFromSteps, type CheckInput, type PostRow } from '../src/behaviour-check/measures.js';
import { embedToken, findCoin, readPublic, readTape, type PublicDeps } from '../src/behaviour-check/public.js';
import { actions, approvals, inference, memories, turns } from '../src/db/schema.js';
import { thoughtsByModel } from '../src/inference.js';
import { errorCodeOf } from '../src/runtime.js';
import { STOPPED_EARLY, USAGE, parseArgs, run } from '../scripts/behaviour-check.js';
import { AGENT_ID, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const FROM = Date.parse('2026-11-08T00:00:00Z');
const TO = Date.parse('2026-11-15T00:00:00Z');
const at = (iso: string) => Date.parse(iso);
const post = (iso: string, text: string, over: Partial<PostRow> = {}): PostRow => ({ at: at(iso), kind: 'post', status: 'completed', text, ...over });
const base = (over: Partial<CheckInput> = {}): CheckInput => ({ mode: 'database', agent: { id: '7', handle: 'bootr_agent', symbol: 'TEST', platform: false }, from: FROM, to: TO, readAt: TO, posts: [], fuel: null, turns: null, steps: null, approvals: null, senderRejected: null, mentions: null, shadow: null, ...over });
const line = (input: CheckInput, id: string) => measure(input).find((l) => l.id === id)!;

describe('the measures', () => {
  it('M1: an original repeats when an earlier original of the last 7 days carried one of its facts', () => {
    const posts = [
      // before the window, inside the look-back of the first post of the window
      post('2026-11-03T10:00:00Z', 'We are at 112 holders today.'),
      post('2026-11-08T10:00:00Z', 'Still 112 holders, and quiet.'),
      post('2026-11-09T10:00:00Z', 'The fee pool holds 0.0475 WETH.'),
      post('2026-11-10T10:00:00Z', 'Nothing to report but the weather.'),
      post('2026-11-12T10:00:00Z', 'A newcomer sees 0.0475 WETH in the fee pool.'),
      // the same number under another subject word: a repeat by number, not by fingerprint
      post('2026-11-13T10:00:00Z', 'Six people, 0.0475 WETH settled, last trade on Tuesday.'),
      // 112 holders again, but the earlier ones are more than 7 days back by now
      post('2026-11-16T12:00:00Z', 'out of the window: 112 holders'),
      post('2026-11-14T10:00:00Z', '0.0475 WETH', { kind: 'reply' }),
      post('2026-11-14T11:00:00Z', '112 holders', { status: 'failed' }),
      post('2026-11-14T12:00:00Z', '112 holders', { queued: true }),
    ];
    expect(repeatRate(posts, FROM, TO)).toEqual({ originals: 5, repeats: 2, repeatsByNumber: 3 });
    const m1 = line(base({ posts }), 'M1');
    expect(m1.value).toBe('40% (2 of 5)');
    expect(m1.detail).toContain('60% (3 of 5)');
    // a post more than 7 days after the last one that said it is not a repeat
    expect(repeatRate([post('2026-11-01T00:00:00Z', '112 holders'), post('2026-11-08T00:00:01Z', '112 holders')], FROM, TO)).toMatchObject({ originals: 1, repeats: 0 });
    expect(line(base(), 'M1').value).toBe('no originals');
  });

  it('M2: of originals stating a number, those that name where it comes from', () => {
    const posts = [
      post('2026-11-08T10:00:00Z', 'Eco says 1.15M agents registered an identity on Base.'),
      post('2026-11-08T11:00:00Z', '600 agents now pay with USDC https://base.org/blog'),
      post('2026-11-08T12:00:00Z', '112 holders and counting.'),
      post('2026-11-08T13:00:00Z', 'Volume was $840 yesterday.', { attributed: true }),
      post('2026-11-08T14:00:00Z', 'A post with no number at all, per nobody.'),
      post('2026-11-08T15:00:00Z', '@base shipped 3 upgrades this week.'),
    ];
    expect(line(base({ posts }), 'M2').value).toBe('80% (4 of 5)');
    expect(namesSource({ text: 'email me at a@b.c about 5 things' })).toBe(false);
    expect(namesSource({ text: 'According to L2BEAT, 5 chains.' })).toBe(true);
  });

  it('M3: refusals per 100 publish attempts, by the code at the head of the error', () => {
    const posts = [
      post('2026-11-08T10:00:00Z', 'ok'),
      post('2026-11-08T11:00:00Z', 'ok', { kind: 'reply' }),
      post('2026-11-08T12:00:00Z', 'x', { status: 'failed', error: 'question_quota: at most one question in five posts' }),
      post('2026-11-08T13:00:00Z', 'x', { status: 'failed', error: 'sender_rejected:policy:social_execution_command_forbidden the text was "buy now"' }),
      post('2026-11-08T14:00:00Z', 'x', { status: 'failed', error: 'question_quota: again' }),
      post('2026-11-08T15:00:00Z', 'x', { status: 'open' }),
      post('2026-11-01T15:00:00Z', 'before the window', { status: 'failed', error: 'old' }),
    ];
    const m3 = line(base({ posts, senderRejected: [{ error: 'policy:invalid_short_post', n: 2 }] }), 'M3');
    expect(m3.value).toBe('60.0 per 100 attempts (3 of 5)');
    expect(m3.detail).toBe('by code: question_quota 2, sender_rejected:policy:social_execution_command_forbidden 1; the sender\'s own refusals: policy:invalid_short_post 2');
    // The same rule as the runtime's own log line.
    for (const error of ['sender_rejected:policy:x the text', 'quiet_hours', 'mention_unknown_account: @x', '  spaced  out ', '', null, undefined, 'a'.repeat(300)]) expect(errorCode(error)).toBe(errorCodeOf(error));
  });

  it('M4: rejected of decided, with the notes; an expiry is not a decision', () => {
    const m4 = line(base({ approvals: [{ status: 'approved', decidedBy: '0xabc', note: null }, { status: 'rejected', decidedBy: '0xabc', note: 'too much price talk' }, { status: 'rejected', decidedBy: 'system', note: 'expired' }] }), 'M4');
    expect(m4.value).toBe('50% (1 of 2)');
    expect(m4.detail).toContain('1 expired unseen');
    expect(m4.detail).toContain('"too much price talk"');
    expect(line(base({ approvals: [] }), 'M4').value).toMatch(/^no decisions/);
  });

  it('M5: exact from sv_turns, an estimate from the steps while it has no rows', () => {
    const turn = (posted: number, replied: number, role = 'social', outcome = 'finished') => ({ role, thoughts: 3, outcome, posted, replied, chargedMicroUsdc: 1000 });
    const exact = line(base({ turns: [turn(1, 0), turn(0, 0), turn(0, 1), turn(0, 0, 'social', 'step_cap'), turn(0, 0, 'treasury')], steps: [] }), 'M5');
    expect(exact.value).toBe('50% (2 of 4)');
    expect(exact.detail).toMatch(/^exact, from sv_turns; 1 of them ended without a finish/);
    const steps = [
      { at: 1, tool: 'recall', status: 'completed' },
      { at: 2, tool: 'remember', status: 'completed' },
      { at: 3, tool: 'finish', status: 'completed' },
      { at: 4, tool: 'publish_post', status: 'completed' },
      { at: 5, tool: 'finish', status: 'completed' },
      { at: 6, tool: 'treasury_read', status: 'completed', role: 'treasury' },
      { at: 7, tool: 'finish', status: 'completed', role: 'treasury' },
      { at: 8, tool: 'publish_post', status: 'failed' },
      { at: 9, tool: 'finish', status: 'failed' },
      { at: 10, tool: 'finish', status: 'completed' },
      { at: 11, tool: 'read_mentions', status: 'completed' },
    ];
    expect(turnsFromSteps(steps)).toEqual({ turns: 4, withoutPost: 3 });
    expect(line(base({ turns: [], steps }), 'M5').value).toBe('75% (3 of 4), estimated');
    expect(line(base({ turns: null, steps }), 'M5').detail).toContain('sv_turns is not there yet');
  });

  it('M6 and M7: fuel per publish, and how fast a mention was answered', () => {
    const posts = [post('2026-11-08T10:00:00Z', 'a'), post('2026-11-09T10:00:00Z', 'b'), post('2026-11-09T11:00:00Z', 'c', { kind: 'reply' })];
    const m6 = line(base({ posts, fuel: { thoughts: 40, chargedMicroUsdc: 780_000 } }), 'M6');
    expect(m6.value).toBe('0.39 USDC per original');
    expect(m6.detail).toContain('0.78 USDC for 40 thoughts; 2 originals, 1 replies; 0.78 USDC per reply, 0.26 USDC per publish; 20.0 thoughts per original');
    const t = at('2026-11-10T10:00:00Z');
    const mentions = [
      { observedAt: t, status: 'answered', reason: null, sentAt: t + 4 * 60_000 },
      { observedAt: t, status: 'answered', reason: null, sentAt: t + 10 * 60_000 },
      { observedAt: t, status: 'answered', reason: null, sentAt: t + 3 * 3_600_000 },
      { observedAt: t, status: 'pending', reason: null, sentAt: null },
      { observedAt: t, status: 'skipped', reason: 'not relevant', sentAt: null },
      // closed by code before any turn: never the agent's to answer
      { observedAt: t, status: 'skipped', reason: 'verified_audience_required', sentAt: null },
      { observedAt: t, status: 'skipped', reason: 'bounty_entry', sentAt: null },
    ];
    const m7 = line(base({ mentions }), 'M7');
    expect(m7.value).toBe('median 10 min, 90th percentile 3.0 h');
    expect(m7.detail).toContain('40% (2 of 5) of eligible mentions answered within 15 minutes; 3 answered, 2 closed by code before a turn');
    expect(percentile([], 0.5)).toBeNull();
    expect(percentile([5, 1, 3], 0.5)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 0.9)).toBe(9);
  });

  it('M8 and M9: the same opener, and the shapes a careful account avoids', () => {
    const originals = [
      post('2026-11-08T10:00:00Z', 'Five days of silence teaches you what a fee pool is.'),
      post('2026-11-08T12:00:00Z', 'Five days of quiet, and the floor held at -9%. What do you think?'),
      post('2026-11-08T14:00:00Z', 'I like how this works on Bootr 🚀'),
      post('2026-11-08T16:00:00Z', 'day 7 still here https://example.com/A?b=1'),
      post('2026-11-08T18:00:00Z', 'day 8 still here'),
    ];
    expect(sameOpener(originals)).toBe(4);
    expect(line(base({ posts: originals }), 'M8').value).toBe('80% (4 of 5)');
    const m9 = line(base({ posts: originals, agent: { id: '1', handle: 'AgentBootr', symbol: 'BOOTR', platform: true } }), 'M9');
    expect(m9.value).toBe('1 trading words, 1 "I like", 1 closing questions');
    expect(m9.detail).toBe('of 5 originals: feeling opener 1, "on Bootr" 1, emoji 1, capitals 3 (the platform account writes lowercase)');
    expect(shapesOf('lowercase only, with @Base and $BOOTR and https://X.com/A')).toMatchObject({ capitals: false, closingQuestion: false });
    expect(shapesOf('what brought you here? 🙂')).toMatchObject({ closingQuestion: true, emoji: true });
    expect(shapesOf('Shallow entries got out; conviction is back after the rebound.').tradingWords).toBe(true);
    expect(shapesOf('The entryway is closed and volume is up 5%.').tradingWords).toBe(false);
    expect(shapesOf("I'm excited to share this").feelingOpener).toBe(true);
  });

  it('M10: counts what the gates would have refused, and says so when the table is not there', () => {
    const m10 = line(base({ shadow: [{ gate: 'G1', code: 'repeat_fact', enforced: false, n: 12 }, { gate: 'G3', code: 'fee_claim', enforced: true, n: 2 }] }), 'M10');
    expect(m10.value).toBe('12 in shadow, 2 enforced');
    expect(m10.detail).toContain('G1:repeat_fact (shadow) 12, G3:fee_claim 2');
    expect(line(base({ shadow: [] }), 'M10').value).toBe('no gate fired');
    expect(line(base({ shadow: null }), 'M10').value).toBe('needs the table sv_gate_shadow');
  });

  it('a public read prints what it could see and marks the rest "needs the database"', () => {
    const input = base({ mode: 'public', posts: [post('2026-11-08T10:00:00Z', '112 holders', { cut: true })], fuel: { thoughts: 4, chargedMicroUsdc: 80_000, label: 'the last 7 days' }, caveats: ['A thread is one row.'] });
    const lines = measure(input);
    expect(lines.slice(0, 10).map((l) => l.id)).toEqual(['M1', 'M2', 'M3', 'M4', 'M5', 'M6', 'M7', 'M8', 'M9', 'M10']);
    for (const id of ['M3', 'M4', 'M5', 'M7', 'M10']) expect(lines.find((l) => l.id === id)!.value).toBe(NEEDS_DATABASE);
    for (const id of ['M1', 'M2', 'M6', 'M8', 'M9']) expect(lines.find((l) => l.id === id)!.value).not.toBe(NEEDS_DATABASE);
    const table = renderTable(input);
    expect(table.split('\n')[0]).toBe('Behaviour check: @bootr_agent, agent 7, $TEST; 2026-11-08 to 2026-11-15 (UTC, the end day not included); public mode; read 2026-11-15T00:00Z');
    expect(table).toContain('| M1 | Repeat rate | no originals |'.replace('no originals', '0% (0 of 1)'));
    expect(table).toContain('- A thread is one row.');
    expect(table).toContain('1 texts were cut by the embed');
  });

  it('holds the two figures of section 2.2 beside the measures, counted the way that table counted', () => {
    const originals = [post('2026-11-08T10:00:00Z', '24h volume: $0.05 WETH'), post('2026-11-09T10:00:00Z', 'Day 10: $0.05 WETH, per the index'), post('2026-11-10T10:00:00Z', '$0.05 WETH settled'), post('2026-11-11T10:00:00Z', 'no figure here')];
    expect(asSection22(originals)).toEqual({ withNumber: 3, numberInThree: 3, sourced: 1 });
    expect(measure(base({ posts: originals })).find((l) => l.measure === 'As section 2.2 counted')!.value).toBe('75% (3 of 4) carry a number that 3 or more originals carry');
  });
});

// ---------------------------------------------------------------------------
// The database read
// ---------------------------------------------------------------------------

/** What `runQueries` asks of a connection, over the test database; every statement is kept. */
function connection(w: TestWorld) {
  const ran: string[] = [];
  return {
    ran,
    client: {
      query: async (text: string) => {
        ran.push(text);
        const res = (await w.db.execute(sql.raw(text))) as unknown as { rows?: Record<string, unknown>[] };
        return { rows: res.rows ?? [] };
      },
    } as never,
  };
}

async function seedWeek(w: TestWorld): Promise<void> {
  await seedAgent(w, { config: { xHandle: 'bootr_agent' } });
  // The sender's tables share the database, as on the server.
  await migrate(w.db as never, { migrationsFolder: fileURLToPath(new URL('../../sender/drizzle', import.meta.url)), migrationsTable: 'sender_migrations', migrationsSchema: 'public' });
  let n = 0;
  const action = (iso: string, tool: string, input: Record<string, unknown>, status: 'completed' | 'failed', result: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({ actionId: `act_${++n}`, agentId: AGENT_ID, cycleKey: `c${n}`, action: { tool, input, ...extra }, status, result, createdAt: new Date(iso), updatedAt: new Date(iso) });
  await w.db.insert(actions).values([
    action('2026-11-05T10:00:00Z', 'publish_post', { text: 'We are at 112 holders.' }, 'completed', { status: 'completed', result: { postId: '1' } }),
    action('2026-11-08T10:00:00Z', 'publish_post', { text: 'Still 112 holders.', thread: [{ text: 'And the fee pool holds 0.0475 WETH.' }] }, 'completed', { status: 'completed', result: { postId: '2' } }),
    action('2026-11-09T10:00:00Z', 'publish_post', { text: 'Eco says 1.15M agents registered.', attributions: [{ handle: 'eco', source: 'https://x.com/eco/status/1' }] }, 'completed', { status: 'completed', result: { postId: '3' } }),
    action('2026-11-09T12:00:00Z', 'publish_post', { text: 'Is it a question?' }, 'failed', { status: 'failed', error: 'question_quota: one in five' }),
    action('2026-11-10T10:00:00Z', 'publish_post', { text: 'Waiting for my creator.' }, 'completed', { status: 'completed', result: { queued: true, approvalId: 'a1' } }),
    action('2026-11-10T11:00:00Z', 'publish_reply', { postId: '900', text: 'The burn is 20% of the fee.' }, 'completed', { status: 'completed', result: { postId: '4' } }),
    action('2026-11-10T11:01:00Z', 'finish', { memory: 'm' }, 'completed'),
    action('2026-11-11T09:00:00Z', 'remember', { text: 'a note' }, 'completed'),
    action('2026-11-11T09:01:00Z', 'remember', { text: 'a third call' }, 'failed', { status: 'failed', error: 'remember_turn_cap: at most 2' }),
    action('2026-11-11T09:02:00Z', 'finish', { memory: 'm' }, 'completed'),
    action('2026-11-12T09:00:00Z', 'treasury_read', {}, 'completed', {}, { role: 'treasury' }),
    action('2026-11-20T10:00:00Z', 'publish_post', { text: 'After the window: 112 holders.' }, 'completed'),
  ]);
  const paid = (key: string, iso: string, charged: string, over: Record<string, unknown> = {}) => ({ idempotencyKey: key, agentId: AGENT_ID, cycle: 0, requestHash: 'h', request: { model: 'm', messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'x'.repeat(key.length * 100) }] }, status: 'succeeded' as const, receipt: { relay: { chargedMicroUsdc: charged } }, createdAt: new Date(iso), updatedAt: new Date(iso), ...over });
  await w.db.insert(inference).values([
    paid('inference:1', '2026-11-08T10:00:00Z', '20000'),
    paid('inference:22', '2026-11-09T10:00:00Z', '30000'),
    paid('inference:333', '2026-11-10T10:00:00Z', '10000'),
    // a paid failure: what it signed for counts
    paid('inference:4444', '2026-11-10T12:00:00Z', '0', { status: 'failed', error: 'credit_exhausted', receipt: { payment: { accepted: { scheme: 'exact', amount: '5000' } } } }),
    // an unpaid failure, a chat message, a picture and a thought outside the window: none of them is a thought of the window
    paid('inference:5', '2026-11-10T13:00:00Z', '0', { status: 'failed', error: 'no_payment_signed', receipt: null }),
    paid(`chat:${AGENT_ID}:1`, '2026-11-10T14:00:00Z', '900'),
    paid('image:act_1', '2026-11-10T15:00:00Z', '40000', { request: { model: 'img', modalities: ['image'], messages: [] } }),
    paid('inference:6', '2026-11-02T10:00:00Z', '70000'),
  ]);
  await w.db.insert(approvals).values([
    { id: 'a1', agentId: AGENT_ID, kind: 'post', text: 'Waiting for my creator.', textHash: 'h1', status: 'rejected', decision: 'reject', decidedBy: '0xcreator', note: 'not this one', createdAt: new Date('2026-11-10T10:00:00Z'), decidedAt: new Date('2026-11-10T12:00:00Z') },
    { id: 'a2', agentId: AGENT_ID, kind: 'post', text: 'Fine.', textHash: 'h2', status: 'approved', decision: 'approve', decidedBy: '0xcreator', createdAt: new Date('2026-11-11T10:00:00Z'), decidedAt: new Date('2026-11-11T12:00:00Z') },
  ]);
  await w.ctx.memories.remember(AGENT_ID, { text: 'a note' }, new Date('2026-11-11T09:00:00Z'));
  await w.db.insert(memories).values({ id: 'req_1', agentId: AGENT_ID, text: 'a creator request is no note', sources: ['creator-chat'], tags: ['creator-request'], createdAt: new Date('2026-11-11T09:00:00Z') });
  await w.db.execute(sql`insert into sender_inbox (agent_id, post_id, author_id, post, observed_at, status, reason) values
    (${AGENT_ID}, '900', '42', '{}'::jsonb, '2026-11-10T10:50:00Z', 'answered', null),
    (${AGENT_ID}, '901', '43', '{}'::jsonb, '2026-11-10T10:50:00Z', 'skipped', 'verified_audience_required'),
    (${AGENT_ID}, '902', '44', '{}'::jsonb, '2026-11-10T10:50:00Z', 'pending', null)`);
  await w.db.execute(sql`insert into sender_actions (action_id, agent_id, kind, text, reply_to, body_hash, status, error, created_at, sent_at) values
    ('s1', ${AGENT_ID}, 'reply', 'The burn is 20% of the fee.', '900', 'b1', 'sent', null, '2026-11-10T11:00:00Z', '2026-11-10T11:00:05Z'),
    ('s2', ${AGENT_ID}, 'post', 'x', null, 'b2', 'rejected', 'policy:invalid_short_post', '2026-11-10T12:00:00Z', null)`);
}

describe('the database read', () => {
  it('reads one agent and one window, read only, and still answers before sv_gate_shadow exists', async () => {
    const w = await makeWorld();
    try {
      await seedWeek(w);
      await w.db.insert(turns).values([
        { id: 't1', agentId: AGENT_ID, role: 'social', wakeReasons: ['original_post_due'], startedAt: new Date('2026-11-08T10:00:00Z'), endedAt: new Date('2026-11-08T10:01:00Z'), thoughts: 3, outcome: 'finished', posted: 1, replied: 0, chargedMicroUsdc: '20000' },
        { id: 't2', agentId: AGENT_ID, role: 'social', wakeReasons: ['scheduled'], startedAt: new Date('2026-11-11T09:00:00Z'), endedAt: new Date('2026-11-11T09:02:00Z'), thoughts: 3, outcome: 'finished', posted: 0, replied: 0, chargedMicroUsdc: '10000' },
        { id: 't3', agentId: AGENT_ID, role: 'treasury', wakeReasons: ['treasury_due'], startedAt: new Date('2026-11-12T09:00:00Z'), endedAt: new Date('2026-11-12T09:01:00Z'), thoughts: 2, outcome: 'finished', posted: 0, replied: 0, chargedMicroUsdc: '0' },
      ]);
      const { ran, client } = connection(w);
      const window = { agent: 'bootr_agent', from: FROM, to: TO };
      const answers = await runQueries(client, window);
      // Read only: the read's own transaction refuses writes, and it is rolled back; every statement in between is a select.
      expect(ran[0]).toBe('begin transaction read only');
      expect(ran.at(-1)).toBe('rollback');
      for (const text of ran.slice(1, -1)) expect(text).toMatch(/^select jsonb_build_object\(/);
      expect(answers.tables).toEqual([{ sv_turns: true, sv_gate_shadow: false, sender_actions: true, sender_inbox: true }]);
      expect(answers.shadow).toBeUndefined();

      const input = toInput(answers, window, TO);
      expect(input.agent).toEqual({ id: AGENT_ID, handle: 'bootr_agent', symbol: 'TEST', platform: false });
      const lines = Object.fromEntries(measure(input).map((l) => [l.id === '-' ? l.measure : l.id, l]));
      // Two originals went out in the window (the queued one did not): the first repeats "112 holders" of 5 November.
      expect(lines.M1!.value).toBe('50% (1 of 2)');
      // The thread's second post is part of the text: both originals state a number, one names its source in a field.
      expect(lines.M2!.value).toBe('50% (1 of 2)');
      // Five attempts: two originals, the queued one, the reply, and the refused question.
      expect(lines.M3!.value).toBe('20.0 per 100 attempts (1 of 5)');
      expect(lines.M3!.detail).toBe('by code: question_quota 1; the sender\'s own refusals: policy:invalid_short_post 1');
      expect(lines.M4!.value).toBe('50% (1 of 2)');
      expect(lines.M5!.value).toBe('50% (1 of 2)');
      expect(lines.M5!.detail).toMatch(/^exact, from sv_turns/);
      // 20000 + 30000 + 10000 + the paid failure's 5000, over four paid thoughts; the chat message and the picture are not thoughts.
      expect(lines.M6!.detail).toContain('0.07 USDC for 4 thoughts; 2 originals, 1 replies');
      expect(lines.M6!.value).toBe('0.03 USDC per original');
      expect(lines.M7!.value).toBe('median 10 min, 90th percentile 10 min');
      expect(lines.M7!.detail).toContain('50% (1 of 2) of eligible mentions answered within 15 minutes; 1 answered, 1 closed by code before a turn');
      expect(lines.M10!.value).toBe('needs the table sv_gate_shadow');
      expect(lines['Originals in the window']!.value).toBe('2 (and 1 replies)');
      expect(lines['Notes written']!.value).toBe('0.1 a day (1)');
      expect(lines['Notes written']!.detail).toContain('1 remember calls stored, 1 refused after they ran');
      expect(lines['First observation size']!.value).toBe('median 1200 characters, largest 1400');
      expect(lines['Checkpoint size now']!.value).toBe('0 characters');
      expect(input.caveats).toEqual(['sv_gate_shadow is not in this database yet: M10 has nothing to read.', 'Pictures cost 0.04 USDC in the window; M6 counts thoughts only.']);

      // What the read charges is what the creator's own metering charges for the same rows (inference.ts), pictures aside.
      const metered = await thoughtsByModel(w.ctx, AGENT_ID, new Date(FROM));
      expect(metered.find((m) => m.model === 'm')).toMatchObject({ thoughts: 5, chargedMicroUsdc: '65900' });
      expect(input.fuel).toEqual({ thoughts: 4, chargedMicroUsdc: 65_000 });

      // By agent id it is the same read; an agent nobody has is an error, not a table of zeros.
      expect(toInput(await runQueries(connection(w).client, { ...window, agent: AGENT_ID }), window, TO).posts).toEqual(input.posts);
      expect(() => toInput({}, { ...window, agent: 'nobody' }, TO)).toThrow(/no agent "nobody"/);
      await expect(runQueries(connection(w).client, { ...window, agent: 'nobody' }).then((a) => toInput(a, { ...window, agent: 'nobody' }, TO))).rejects.toThrow(/no agent/);
    } finally {
      await w.close();
    }
  });

  it('reads sv_gate_shadow once it exists, and estimates M5 when sv_turns is gone or empty', async () => {
    const w = await makeWorld();
    try {
      await seedWeek(w);
      // The table as the gates' builder creates it.
      await w.db.execute(sql`create table sv_gate_shadow (id text primary key, agent_id text not null, gate text not null, code text not null, action_id text, text_hash text, detail jsonb, enforced boolean not null default false, created_at timestamptz not null default now())`);
      await w.db.execute(sql`insert into sv_gate_shadow (id, agent_id, gate, code, enforced, created_at) values
        ('g1', ${AGENT_ID}, 'G1', 'repeat_fact', false, '2026-11-09T10:00:00Z'), ('g2', ${AGENT_ID}, 'G1', 'repeat_fact', false, '2026-11-10T10:00:00Z'),
        ('g3', ${AGENT_ID}, 'G3', 'fee_claim', true, '2026-11-10T10:00:00Z'), ('g4', ${AGENT_ID}, 'G1', 'repeat_fact', false, '2026-11-20T10:00:00Z'), ('g5', '8', 'G1', 'repeat_fact', false, '2026-11-10T10:00:00Z')`);
      const window = { agent: AGENT_ID, from: FROM, to: TO };
      const withShadow = toInput(await runQueries(connection(w).client, window), window, TO);
      const m10 = measure(withShadow).find((l) => l.id === 'M10')!;
      expect(m10.value).toBe('2 in shadow, 1 enforced');
      expect(m10.detail).toContain('G1:repeat_fact (shadow) 2, G3:fee_claim 1');
      // sv_turns is there and empty for the window: the estimate, from the steps cut at each finish.
      const m5 = measure(withShadow).find((l) => l.id === 'M5')!;
      expect(m5.value).toBe('50% (1 of 2), estimated');
      expect(m5.detail).toContain('sv_turns has no row for this window');
      // A database from before migration 0014: the same estimate, and the read does not fail on the missing table.
      await w.db.execute(sql`drop table sv_turns`);
      const before = toInput(await runQueries(connection(w).client, window), window, TO);
      expect(before.turns).toBeNull();
      expect(measure(before).find((l) => l.id === 'M5')!.detail).toContain('sv_turns is not there yet');
      expect(before.caveats).toContain('sv_turns is not in this database yet (migration 0014): M5 is an estimate.');
      // A supervisor database without the sender's tables.
      await w.db.execute(sql`drop table sender_inbox`);
      const alone = toInput(await runQueries(connection(w).client, window), window, TO);
      expect(alone.mentions).toBeNull();
      expect(measure(alone).find((l) => l.id === 'M7')!.value).toBe(NEEDS_DATABASE);
    } finally {
      await w.close();
    }
  });

  it('a write inside the read\'s transaction is refused by the database itself', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await w.db.execute(sql`begin transaction read only`);
      await expect(w.db.execute(sql`delete from sv_agents`)).rejects.toThrow();
      await w.db.execute(sql`rollback`);
      expect(await w.db.query.agents.findMany()).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('takes an agent and a window of a strict shape only: both are written into the statements', () => {
    const window = { agent: 'bootr_agent', from: FROM, to: TO };
    expect(AGENT_RE.test('1153600')).toBe(true);
    for (const agent of ["x'; drop table sv_agents; --", 'a b', '', '@handle', 'a"b', 'x'.repeat(81)]) expect(() => statements({ ...window, agent })).toThrow(/agent must be/);
    expect(() => statements({ ...window, to: FROM })).toThrow(/start before its end/);
    expect(() => statements({ ...window, from: Number.NaN })).toThrow();
    expect(() => statements({ ...window, to: FROM + 93 * DAY_MS })).toThrow(/at most 92 days/);
    for (const s of statements(window)) {
      expect(s.sql.trim().toLowerCase().startsWith('select')).toBe(true);
      expect(s.sql).not.toMatch(/\b(?:insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i);
    }
  });

  it('prints the same read as a psql script for the read-only session, and reads its output back', () => {
    const script = printScript({ agent: '1153600', from: FROM, to: TO });
    const lines = script.trim().split('\n');
    expect(lines[0]).toMatch(/^-- behaviour check: read only/);
    expect(lines).toContain('begin transaction read only;');
    expect(lines.at(-1)).toBe('rollback;');
    // A statement whose table may be missing runs only when psql found the table.
    expect(script).toContain("select to_regclass('public.sv_gate_shadow') is not null as has_sv_gate_shadow \\gset");
    expect(script).toMatch(/\\if :has_sv_gate_shadow\nselect jsonb_build_object\('q', 'shadow'[^\n]+;\n\\endif/);
    expect(script).toMatch(/\\if :has_sv_turns\nselect jsonb_build_object\('q', 'turns'/);
    expect(script).toContain("agent_id = '1153600'");
    expect(script).toContain("'2026-11-08T00:00:00.000Z'::timestamptz");
    // Nothing but selects, the transaction and psql's own output settings.
    for (const l of lines) expect(l).toMatch(/^(?:--|\\set ON_ERROR_STOP on$|\\pset (?:tuples_only on|format unaligned)$|begin transaction read only;$|set local statement_timeout = '120s';$|rollback;$|\\if :has_\w+$|\\endif$|select )/);
    expect(script).not.toMatch(/\b(?:insert|update|delete|drop|alter|create|truncate|grant|copy)\b/i);

    // psql's output: one JSON line per statement, between lines that are not answers.
    const output = ['BEGIN', '{"q": "tables", "rows": [{"sv_turns": false, "sv_gate_shadow": false, "sender_actions": true, "sender_inbox": true}]}', '{"q": "agent", "rows": [{"id": "1153600", "handle": "AgentBootr", "symbol": "BOOTR", "platform": true}]}', '{"q": "posts", "rows": [{"at": 1794132000000.000, "tool": "publish_post", "status": "completed", "text": "numbers for 8 nov: 12 coins | 3 agents awake", "thread": null, "error": null, "attributed": false, "queued": false}]}', 'not json {', '', 'ROLLBACK'].join('\n');
    const answers = parseAnswers(output);
    expect(Object.keys(answers)).toEqual(['tables', 'agent', 'posts']);
    const input = toInput(answers, { agent: '1153600', from: FROM, to: TO }, TO);
    expect(input.agent).toMatchObject({ handle: 'AgentBootr', platform: true });
    expect(input.posts).toHaveLength(1);
    expect(input.turns).toBeNull();
    expect(renderTable(input)).toContain('| M5 | Social turns without a post | no social turns, estimated |');
  });
});

// ---------------------------------------------------------------------------
// The public read and the command line
// ---------------------------------------------------------------------------

function stubPublic(now: number) {
  const seen: string[] = [];
  const tape = [
    { at: '2026-11-14T20:00:00.000Z', kind: 'status', summary: 'Awake' },
    { at: '2026-11-14T10:00:00.000Z', kind: 'post', summary: 'Posted on X', url: 'https://x.com/playclankfish/status/2000000000000000004' },
    { at: '2026-11-13T10:00:00.000Z', kind: 'reply', summary: 'Replied on X', url: 'https://x.com/playclankfish/status/2000000000000000003' },
    { at: '2026-11-12T10:00:00.000Z', kind: 'post', summary: 'Posted on X', url: 'https://x.com/playclankfish/status/2000000000000000002' },
    { at: '2026-11-12T09:00:00.000Z', kind: 'fuel', summary: 'Added 20 USDC of fuel', url: 'https://basescan.org/tx/0xabc' },
    { at: '2026-11-05T10:00:00.000Z', kind: 'post', summary: 'Posted on X', url: 'https://x.com/playclankfish/status/2000000000000000001' },
    { at: '2026-10-20T10:00:00.000Z', kind: 'post', summary: 'Posted on X', url: 'https://x.com/playclankfish/status/2000000000000000000' },
  ];
  const texts: Record<string, string> = {
    '2000000000000000001': 'The fee pool holds $0.05 WETH.',
    '2000000000000000002': 'Day 10: nothing traded, $0.05 WETH settled. '.padEnd(280, 'x'),
    '2000000000000000003': '@someone thanks for asking',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
    seen.push(url.toString());
    if (url.pathname === '/tokens/list') return json({ items: [{ id: '0xtoken', kernel: '0xkernel', agentId: '1171616', symbol: 'CLANKFISH', xHandle: 'playclankfish', creator: '0xc', platformRecipient: '0xp' }, { id: '0xb', kernel: '0xkb', agentId: '1153600', symbol: 'BOOTR', xHandle: 'AgentBootr', creator: '0xP', platformRecipient: '0xp' }] });
    if (url.pathname === '/api/agent/0xkernel/activity') {
      const before = url.searchParams.get('before');
      const rows = tape.filter((r) => !before || r.at < before);
      // Two rows a page, so the read has to page back with `before`.
      return json({ items: rows.slice(0, Number(url.searchParams.get('limit')) === 100 ? 100 : 2) });
    }
    if (url.pathname === '/public/posts/1171616') return json({ agentId: '1171616', handle: 'playclankfish', items: [{ postId: '2000000000000000004', kind: 'post', text: 'The newest post, whole, with its closing question that the embed would cut off?' }] });
    if (url.pathname === '/tweet-result') {
      const id = url.searchParams.get('id')!;
      if (url.searchParams.get('token') !== embedToken(id)) return json({}, 404);
      const text = texts[id];
      return text ? json({ text: id.endsWith('3') ? `@someone ${text.replace('@someone ', '')}` : text, display_text_range: [id.endsWith('3') ? 9 : 0, 200] }) : json({}, 404);
    }
    if (url.pathname === '/api/agent/0xkernel/fuel') return json({ days: Number(url.searchParams.get('days')), byModel: [{ model: 'haiku', thoughts: 40, chargedMicroUsdc: '780000' }] });
    return json({ error: 'not_found' }, 404);
  };
  const deps: PublicDeps = { fetch: fetchImpl, now: () => now, sources: { site: 'https://site.test', indexer: 'https://indexer.test', sender: 'https://sender.test', embed: 'https://embed.test' } };
  return { deps, seen };
}

describe('the public read', () => {
  const NOW = at('2026-11-14T22:00:00Z');

  it('finds the coin by handle, symbol, id or address, and knows the platform account by its creator', async () => {
    const { deps } = stubPublic(NOW);
    for (const name of ['playclankfish', '@PlayClankFish', '$clankfish', '1171616', '0xKERNEL', '0xtoken']) expect((await findCoin(deps, name))?.agentId).toBe('1171616');
    expect(await findCoin(deps, 'nobody')).toBeNull();
    expect((await findCoin(deps, 'AgentBootr'))?.platform).toBe(true);
    expect((await findCoin(deps, 'playclankfish'))?.platform).toBe(false);
  });

  it('pages the tape back to the start of the look-back and keeps posts and replies only', async () => {
    const { deps } = stubPublic(NOW);
    const all = await readTape(deps, '0xkernel', FROM - 7 * DAY_MS);
    expect(all.complete).toBe(true);
    expect(all.posts.map((p) => p.postId).sort()).toEqual(['2000000000000000001', '2000000000000000002', '2000000000000000003', '2000000000000000004']);
    // A tape that stops answering is said to be incomplete.
    const broken: PublicDeps = { ...deps, fetch: async () => new Response('nope', { status: 502 }) };
    expect(await readTape(broken, '0xkernel', FROM)).toEqual({ posts: [], complete: false });
  });

  it('loses no post to the tape\'s own paging: a page can reach further back than its posts were read', async () => {
    // The tape as the supervisor builds it (activity.ts): every source gives its newest `limit` rows older than the
    // cursor, the page keeps the newest `limit` of them all. Here every other action row is a refused publish, which
    // is a row of its source and shows nothing, so a page of 100 holds fewer posts than the treasury rows beside them
    // reach back over.
    const t0 = at('2026-11-14T00:00:00Z');
    const actionRows = Array.from({ length: 260 }, (_, i) => ({ at: t0 - i * 600_000, visible: i % 2 === 0, id: String(3000000000000000000n + BigInt(i)) }));
    const opRows = Array.from({ length: 200 }, (_, i) => ({ at: t0 - i * 1_500_000 - 1 }));
    const pageOf = (before: number | null, limit: number) => {
      const older = <T extends { at: number }>(rows: T[]) => rows.filter((r) => before === null || r.at < before).slice(0, limit);
      const items = [
        ...older(actionRows).filter((r) => r.visible).map((r) => ({ at: new Date(r.at).toISOString(), kind: 'post', url: `https://x.com/agent/status/${r.id}` })),
        ...older(opRows).map((r) => ({ at: new Date(r.at).toISOString(), kind: 'claim', url: 'https://basescan.org/tx/0x1' })),
      ];
      return items.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit);
    };
    const asked: (string | null)[] = [];
    const deps: PublicDeps = {
      now: () => NOW,
      sources: { site: 'https://site.test', indexer: 'https://indexer.test', sender: 'https://sender.test', embed: 'https://embed.test' },
      fetch: (async (input: string) => {
        const url = new URL(input);
        asked.push(url.searchParams.get('before'));
        const before = url.searchParams.get('before');
        return new Response(JSON.stringify({ items: pageOf(before ? Date.parse(before) : null, Number(url.searchParams.get('limit'))) }), { status: 200 });
      }) as unknown as typeof fetch,
    };
    const since = t0 - 259 * 600_000;
    const visible = actionRows.filter((r) => r.visible && r.at >= since).map((r) => r.id).sort();
    const read = await readTape(deps, '0xkernel', since);
    expect(read.complete).toBe(true);
    expect(read.posts.map((p) => p.postId).sort()).toEqual(visible);
    expect(visible).toHaveLength(130);
    // Paging from each page's oldest row, as a reader would without knowing the above, loses posts on this very tape.
    const naive = new Set<string>();
    for (let before: number | null = null, guard = 0; guard < 50; guard++) {
      const items = pageOf(before, 100);
      for (const i of items) if (i.kind === 'post') naive.add(i.url.split('/').pop()!);
      if (items.length < 100) break;
      before = Date.parse(items.at(-1)!.at);
    }
    expect(naive.size).toBeLessThan(visible.length);
    expect(asked.length).toBeGreaterThan(2);

    // ...and a page shorter than the limit is not the end of the tape: with few treasury rows the first page holds
    // 50 posts and 5 claims, 55 rows, and 80 older posts are still to come (@BRIANBRAINAI's tape, 99 rows, 2026-11-14).
    opRows.length = 5;
    expect(pageOf(null, 100)).toHaveLength(55);
    const short = await readTape(deps, '0xkernel', since);
    expect(short.complete).toBe(true);
    expect(short.posts.map((p) => p.postId).sort()).toEqual(visible);
  });

  it('measures what is public and says what it could not read', async () => {
    const { deps, seen } = stubPublic(NOW);
    const input = await readPublic(deps, 'playclankfish', FROM, TO);
    expect(input.mode).toBe('public');
    expect(input.posts.map((p) => [p.kind, p.cut ?? false])).toEqual([['post', false], ['post', true], ['reply', false], ['post', false]]);
    // The reply's text is the agent's own words, without the handle X puts in front.
    expect(input.posts[2]!.text).toBe('thanks for asking');
    // The newest post came whole from Bootr's own list, not from the embed.
    expect(input.posts[3]!.text).toMatch(/closing question that the embed would cut off\?$/);
    expect(seen.some((u) => u.includes('id=2000000000000000004'))).toBe(false);
    expect(input.fuel).toMatchObject({ thoughts: 40, chargedMicroUsdc: 780_000 });
    expect(seen.find((u) => u.includes('/fuel'))).toContain('days=7');
    const table = renderTable(input);
    // "$0.05 WETH" of 5 November is said again on the 12th. The two sentences put the number beside different subject
    // words ("fee pool", "traded"), so the fingerprints differ and M1 as defined does not see it; the count that leaves
    // the subject out does. Both are printed, and the gap is what the reader should look at.
    expect(table).toContain('| M1 | Repeat rate | 0% (0 of 2) |');
    expect(table).toContain('with the subject word left out of the comparison: 50% (1 of 2)');
    expect(table).toContain('| M3 | Posts refused by the gate | needs the database |');
    expect(table).toContain('| M6 | Fuel per published post | 0.39 USDC per original |');
    expect(table).toContain('1 texts are as long as the embed shows');
    expect(table).toContain('A thread is one row on the tape and is read by its first post only.');
    // Nothing but the four public sources was asked, and no credential was sent with any of it.
    for (const url of seen) expect(url).toMatch(/^https:\/\/(?:site|indexer|sender|embed)\.test\//);
    await expect(readPublic(deps, 'nobody', FROM, TO)).rejects.toThrow(/no coin "nobody"/);
  });
});

describe('the command line', () => {
  const NOW = at('2026-11-14T22:00:00Z');
  const deps = (over: Partial<Parameters<typeof run>[2]> = {}) => ({ now: () => NOW, fetch: stubPublic(NOW).deps.fetch, readStdin: () => '', say: () => undefined, ...over });

  it('reads its arguments, with the seven whole UTC days before today as the window', () => {
    const args = parseArgs(['public', '--agent', '@playclankfish,BRIANBRAINAI'], NOW);
    expect(args).toMatchObject({ mode: 'public', agents: ['playclankfish', 'BRIANBRAINAI'], from: at('2026-11-07T00:00:00Z'), to: at('2026-11-14T00:00:00Z'), printSql: false, answers: null });
    expect(parseArgs(['database', '--agent', '7', '--from', '2026-11-08', '--to', '2026-11-15T00:00:00Z', '--print-sql'], NOW)).toMatchObject({ mode: 'database', from: FROM, to: TO, printSql: true });
    expect(parseArgs(['public', '--agent', 'x', '--site', 'https://staging.example/'], NOW).sources.site).toBe('https://staging.example');
    for (const bad of [[], ['both'], ['public'], ['public', '--agent'], ['public', '--agent', 'x', '--from', 'yesterday'], ['public', '--agent', 'x', '--from', '2026-11-15', '--to', '2026-11-08'], ['public', '--agent', 'x', '--print-sql'], ['database', '--agent', 'a,b', '--print-sql'], ['database', '--agent', 'x', '--password', 'p'], ['database', 'x']]) {
      expect(() => parseArgs(bad, NOW), bad.join(' ')).toThrow();
    }
    expect(USAGE).toContain('--print-sql');
  });

  it('prints one table per agent in public mode, the script with --print-sql, and the table from a script\'s answers', async () => {
    const tables = await run({ ...parseArgs(['public', '--agent', 'playclankfish', '--from', '2026-11-08', '--to', '2026-11-15'], NOW), sources: stubPublic(NOW).deps.sources! }, {}, deps());
    expect(tables).toHaveLength(1);
    expect(tables[0]).toMatch(/^Behaviour check: @playclankfish, agent 1171616, \$CLANKFISH; 2026-11-08 to 2026-11-15/);
    const [script] = await run(parseArgs(['database', '--agent', '1171616', '--from', '2026-11-08', '--to', '2026-11-15', '--print-sql'], NOW), {}, deps());
    expect(script).toBe(printScript({ agent: '1171616', from: FROM, to: TO }));
    const answers = '{"q": "tables", "rows": [{"sv_turns": true, "sv_gate_shadow": true, "sender_actions": true, "sender_inbox": true}]}\n{"q": "agent", "rows": [{"id": "1171616", "handle": "playclankfish", "symbol": "CLANKFISH", "platform": false}]}\n{"q": "complete", "rows": [{"complete": true}]}\n';
    const [table] = await run(parseArgs(['database', '--agent', '1171616', '--from', '2026-11-08', '--to', '2026-11-15', '--answers', '-'], NOW), {}, deps({ readStdin: () => answers }));
    expect(table).toMatch(/^Behaviour check: @playclankfish, agent 1171616, \$CLANKFISH; .* database mode/);
    expect(table).toContain('| M10 | Would-refuse counts | no gate fired |');
    // Answers without the closing line are a read that was stopped part way (a statement past the time limit, say): no
    // table, since its missing parts would read as zeros, and the message says what to look for.
    const cut = answers.split('\n').slice(0, 2).join('\n');
    await expect(run(parseArgs(['database', '--agent', '1171616', '--from', '2026-11-08', '--to', '2026-11-15', '--answers', '-'], NOW), {}, deps({ readStdin: () => cut }))).rejects.toThrow(STOPPED_EARLY);
    expect(STOPPED_EARLY).toContain('canceling statement due to statement timeout');
    // Without an address and without answers there is nothing to read from.
    await expect(run(parseArgs(['database', '--agent', '7'], NOW), {}, deps())).rejects.toThrow(/DATABASE_URL is required/);
  });
});

describe('the read cannot hold the live database (security review 2026-11-15, L5)', () => {
  const window = { agent: AGENT_ID, from: FROM, to: TO };

  it('the printed script sets a statement time limit for its own transaction, right after begin', () => {
    const lines = printScript({ agent: '1153600', from: FROM, to: TO }).trim().split('\n');
    const begin = lines.indexOf('begin transaction read only;');
    expect(lines[begin + 1]).toBe("set local statement_timeout = '120s';");
    expect(STATEMENT_TIMEOUT).toBe('120s');
    // `set local` lasts as long as the transaction: nothing of it is left on the session the owner's psql shares.
    expect(lines.filter((l) => /statement_timeout/.test(l))).toHaveLength(1);
    // The closing line comes after every statement the table needs, and only the heavy one comes after it.
    const names = lines.map((l) => /^select jsonb_build_object\('q', '(\w+)'/.exec(l)?.[1]).filter(Boolean);
    expect(names.slice(-2)).toEqual([READ_COMPLETE, 'observation']);
    expect(lines.at(-1)).toBe('rollback;');
  });

  it('one statement alone opens the stored requests, and it is the last and the one the table can do without', () => {
    const all = statements(window);
    expect(all.filter((s) => /\brequest->/.test(s.sql)).map((s) => s.name)).toEqual(['observation']);
    expect(all.filter((s) => s.optional).map((s) => s.name)).toEqual(['observation']);
    expect(all.at(-1)!.name).toBe('observation');
  });

  it('the direct read sets the same limit inside its transaction, and nothing of it outlives the transaction', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const { ran, client } = connection(w);
      const answers = await runQueries(client, window);
      expect(ran[0]).toBe('begin transaction read only');
      expect(ran.findIndex((t) => t.includes("set_config('statement_timeout', '120s', true)"))).toBe(2);
      expect(answers.timeout).toEqual([{ statement_timeout: '2min' }]);
      expect(answers[READ_COMPLETE]).toEqual([{ complete: true }]);
      // What `set_config(..., true)` does on this database: in force inside the transaction, gone after it.
      const setting = async () => ((await w.db.execute(sql`select current_setting('statement_timeout') as v`)) as unknown as { rows: { v: string }[] }).rows[0]!.v;
      const before = await setting();
      await w.db.execute(sql`begin transaction read only`);
      await w.db.execute(sql`select set_config('statement_timeout', '120s', true)`);
      expect(await setting()).toBe('2min');
      await w.db.execute(sql`rollback`);
      expect(await setting()).toBe(before);
    } finally {
      await w.close();
    }
  });

  it('when the limit stops the heavy statement the table is printed without its line; when it stops any other, the read fails', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const timeout = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });
      const stopping = (name: string) => {
        const { ran, client } = connection(w);
        const inner = client as unknown as { query: (text: string) => Promise<{ rows: Record<string, unknown>[] }> };
        return { ran, client: { query: async (text: string) => (text.includes(`'q', '${name}'`) ? Promise.reject(timeout) : inner.query(text)) } as never };
      };
      const heavy = stopping('observation');
      const answers = await runQueries(heavy.client, window);
      expect(answers.observation).toBeUndefined();
      expect(answers[READ_COMPLETE]).toEqual([{ complete: true }]);
      expect(heavy.ran.at(-1)).toBe('rollback');
      const input = toInput(answers, window, TO);
      expect(input.observation).toBeNull();
      expect(input.caveats!.some((c) => c.startsWith('The size of the first observation was not read') && c.includes('120s'))).toBe(true);
      const table = renderTable(input);
      expect(table).not.toContain('First observation size');
      expect(table).toContain('| M1 | Repeat rate |');

      const needed = stopping('posts');
      await expect(runQueries(needed.client, window)).rejects.toThrow('canceling statement due to statement timeout');
      // The transaction is rolled back all the same.
      expect(needed.ran.at(-1)).toBe('rollback');
    } finally {
      await w.close();
    }
  });
});
