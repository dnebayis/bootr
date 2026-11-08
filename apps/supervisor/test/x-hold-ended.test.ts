/**
 * The turn after an X hold is told that the hold is over. On 2026-11-09 agent 1170231's 403 hold was lifted by its
 * creator's reconnect and the agent woke for its due post, but its own agenda from the held turns said "X platform
 * blocker, do not post until the platform recovers", nothing in the observation said otherwise, and it passed on the
 * slot. Now: every hold message tells the model to date the block in its agenda (rhythm.ts `HOLD_AGENDA_NOTE`), the
 * state keeps the hold the model was told about (`postHoldEndedNote`), and the first observation after the hold ends
 * (ran out, cleared by hand, or lifted by a reconnect) carries one `holdEnded` line (`holdEndedMessage`), then never again.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, runtimes } from '../src/db/schema.js';
import { HOLD_AGENDA_NOTE, X_FORBIDDEN_HOLD_MS, creditsHold, forbiddenHold, holdEndedMessage, quotaHold } from '../src/rhythm.js';
import { noteHoldSet, trackHoldEnd, type AgentState } from '../src/runtime.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const H = 3_600_000;
const MIN = 60_000;
const T0 = Date.parse('2026-10-24T12:00:00Z');
const FORBIDDEN = 'forbidden(403): You are not permitted to perform this action.';
/** A fresh Response each time: a body reads once, so a shared one would be dead for the second turn. */
const POST = () => toolCallResponse('publish_post', { text: 'A post from a test agent, in its own voice.' });
const iso = (ms: number) => new Date(ms).toISOString();

async function state(w: TestWorld): Promise<AgentState> {
  return (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!.state as unknown as AgentState;
}

/** The observation of the latest turn: the first user message of the latest paid call. */
function observation(w: TestWorld): Record<string, unknown> {
  const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
  const body = calls.at(-1)!.body as { messages: { role: string; content: string }[] };
  return JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as Record<string, unknown>;
}

const turns = (w: TestWorld) => w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).length;

describe('the hold messages date the block', () => {
  it('every X hold message ends with the agenda note', () => {
    for (const hold of [quotaHold(T0 + H, T0), creditsHold(T0 + H, T0), forbiddenHold(T0 + H, T0)]) {
      expect(hold!.message.endsWith(HOLD_AGENDA_NOTE)).toBe(true);
    }
    expect(HOLD_AGENDA_NOTE).toBe('Note the time it ends in your agenda, not as a permanent fact: you will be told when it ends.');
  });

  it('holdEndedMessage: one line per reason and way out, no post text', () => {
    const tail = 'Your earlier note that posting is blocked is out of date. Posting is allowed now; if an original post is due, publish it this turn.';
    expect(holdEndedMessage({ reason: 'x_forbidden', until: T0 + 6 * H, at: T0 + 31 * MIN, how: 'reconnect', connectedAt: T0 + 30 * MIN })).toBe(
      `x_hold_ended: X accepted this account again (the 403 hold ended at 2026-10-24T12:31:00.000Z; the connection was renewed at 2026-10-24T12:30:00.000Z). ${tail}`,
    );
    expect(holdEndedMessage({ reason: 'x_forbidden', until: T0 + 6 * H, at: T0 + 6 * H + MIN, how: 'expired' })).toBe(
      `x_hold_ended: the 403 hold on this account ended at 2026-10-24T18:01:00.000Z; X may accept your posts again. ${tail} If X refuses again, the hold returns and you will be told.`,
    );
    expect(holdEndedMessage({ reason: 'x_forbidden', until: T0 + 6 * H, at: T0 + 40 * MIN, how: 'cleared' })).toContain('ended at 2026-10-24T12:40:00.000Z (lifted before its end at 2026-10-24T18:00:00.000Z)');
    expect(holdEndedMessage({ reason: 'x_quota', until: T0 + 3 * H, at: T0 + 3 * H + MIN, how: 'expired' })).toBe(`x_hold_ended: your X posting quota opened again at 2026-10-24T15:01:00.000Z. ${tail}`);
    expect(holdEndedMessage({ reason: 'x_credits', until: T0 + 30 * MIN, at: T0 + 31 * MIN, how: 'expired' })).toBe(
      `x_hold_ended: the X credits hold ended at 2026-10-24T12:31:00.000Z; X may accept your posts again. ${tail} If X refuses again, the hold returns and you will be told.`,
    );
    for (const text of [holdEndedMessage({ reason: 'x_quota', until: T0, at: T0 }), holdEndedMessage({ reason: 'x_forbidden', until: T0, at: T0, how: 'reconnect' })]) {
      expect(text.split('\n')).toHaveLength(1);
      expect(text.startsWith('x_hold_ended: ')).toBe(true);
    }
  });

  it('trackHoldEnd: a hold on the state is put on record, a hold that is gone is marked ended once, an active one says nothing', () => {
    const s: AgentState = { phase: 'social', memory: '', agenda: '', summary: '' };
    // no hold, no note: nothing
    expect(trackHoldEnd(s, null, T0)).toBe(false);
    expect(s.postHoldEndedNote ?? null).toBeNull();
    // a hold with no note (set before the field existed): on record, nothing to say yet
    expect(trackHoldEnd(s, forbiddenHold(T0 + 6 * H, T0), T0)).toBe(true);
    expect(s.postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: T0 + 6 * H, at: null });
    // the same hold on a later tick: no change
    expect(trackHoldEnd(s, forbiddenHold(T0 + 6 * H, T0 + H), T0 + H)).toBe(false);
    // the hold ran out: ended, expired
    expect(trackHoldEnd(s, null, T0 + 6 * H + MIN)).toBe(true);
    expect(s.postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: T0 + 6 * H, at: T0 + 6 * H + MIN, how: 'expired' });
    // waiting for delivery: left alone
    expect(trackHoldEnd(s, null, T0 + 7 * H)).toBe(false);
    expect(s.postHoldEndedNote!.at).toBe(T0 + 6 * H + MIN);
    // a hold cleared from the state before its time: ended, cleared
    noteHoldSet(s, 'x_quota', T0 + 3 * H);
    expect(trackHoldEnd(s, null, T0 + H)).toBe(true);
    expect(s.postHoldEndedNote).toMatchObject({ reason: 'x_quota', at: T0 + H, how: 'cleared' });
    // a new hold replaces whatever note was there
    expect(trackHoldEnd(s, quotaHold(T0 + 5 * H, T0 + 2 * H), T0 + 2 * H)).toBe(true);
    expect(s.postHoldEndedNote).toEqual({ reason: 'x_quota', until: T0 + 5 * H, at: null });
    // the platform rhythm's holds are not X holds and are not tracked
    expect(trackHoldEnd({ ...s, postHoldEndedNote: null }, { reason: 'quiet_hours', until: T0 + H, message: 'quiet_hours: ...' }, T0)).toBe(false);
  });
});

describe('the turn after a hold is told it ended', () => {
  it('a 403 hold lifted by a reconnect: the next turn opens with x_hold_ended, still wakes for the due post and posts; the turn after says nothing', async () => {
    const w = await makeWorld({ script: [POST(), finishResponse(T0 + 10 * MIN), POST(), finishResponse(T0 + 7 * H), POST(), finishResponse(T0 + 9 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      const account = { agentId: AGENT_ID, connected: true, revoked: false, handle: 'bootr_agent', xUserId: '1000', connectedAt: iso(now - 5 * 24 * H) };
      w.sender.accounts = { [AGENT_ID]: account };
      w.sender.publishError = FORBIDDEN;
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      // the hold is on record, nothing to report yet; the model heard the agenda note with the refusal's hold
      expect((await state(w)).postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: now + X_FORBIDDEN_HOLD_MS, at: null });
      expect(observation(w)).not.toHaveProperty('holdEnded');

      // inside the hold: no turn, the note stays as it is
      w.setNow(now + 20 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect((await state(w)).postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: now + X_FORBIDDEN_HOLD_MS, at: null });

      // the creator reconnects X at +30 min: the tick at +31 lifts the hold and the turn is told so, once, up front
      w.sender.accounts = { [AGENT_ID]: { ...account, connectedAt: iso(now + 30 * MIN) } };
      w.sender.publishError = null;
      w.setNow(now + 31 * MIN);
      const lifted = await tick(w.ctx);
      expect(lifted.ran).toEqual([AGENT_ID]);
      expect(lifted.errors).toEqual([]);
      const obs = observation(w);
      expect(obs.holdEnded).toBe(
        `x_hold_ended: X accepted this account again (the 403 hold ended at ${iso(now + 31 * MIN)}; the connection was renewed at ${iso(now + 30 * MIN)}). Your earlier note that posting is blocked is out of date. Posting is allowed now; if an original post is due, publish it this turn.`,
      );
      expect(obs.wakeReasons).toContain('original_post_due');
      expect((obs.social as { originalPost: { due: boolean; waiting?: unknown } }).originalPost).toMatchObject({ due: true });
      expect((obs.social as { originalPost: { waiting?: unknown } }).originalPost.waiting).toBeUndefined();
      expect(w.sender.published).toHaveLength(2);
      expect((await state(w)).postHoldEndedNote ?? null).toBeNull();

      // the next slot (two hours plus jitter after the post): an ordinary turn, nothing about the hold
      const bought = turns(w);
      w.setNow(now + 31 * MIN + 2 * H + 30 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(turns(w)).toBe(bought + 2);
      expect(observation(w)).not.toHaveProperty('holdEnded');
      expect(JSON.stringify(observation(w))).not.toContain('x_hold_ended');
      expect(w.sender.published).toHaveLength(3);
    } finally {
      await w.close();
    }
  });

  it('a quota hold that runs out: the first turn after it says the quota opened, the one after does not', async () => {
    const w = await makeWorld({ script: [POST(), finishResponse(T0 + 30 * MIN), POST(), finishResponse(T0 + 10 * H), POST(), finishResponse(T0 + 12 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      w.sender.quotaExceeded = iso(now + 3 * H);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect((await state(w)).postHoldEndedNote).toEqual({ reason: 'x_quota', until: now + 3 * H, at: null });

      // inside the hold: no turn, the note waits
      w.setNow(now + H);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect((await state(w)).postHoldEndedNote).toMatchObject({ reason: 'x_quota', at: null });

      // the quota opens: the post is due, the turn hears that the hold ran out, and posts
      w.sender.quotaExceeded = null;
      w.setNow(now + 3 * H + MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(observation(w).wakeReasons).toContain('original_post_due');
      expect(observation(w).holdEnded).toBe(`x_hold_ended: your X posting quota opened again at ${iso(now + 3 * H + MIN)}. Your earlier note that posting is blocked is out of date. Posting is allowed now; if an original post is due, publish it this turn.`);
      expect(w.sender.published).toHaveLength(1);
      expect((await state(w)).postHoldEndedNote ?? null).toBeNull();

      // the next slot: nothing about the hold
      w.setNow(now + 3 * H + MIN + 2 * H + 30 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(observation(w)).not.toHaveProperty('holdEnded');
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('a hold still on: a turn that runs anyway (a config change) carries the hold with the agenda note and no x_hold_ended', async () => {
    const w = await makeWorld({ script: [POST(), finishResponse(T0 + 10 * MIN), finishResponse(T0 + 7 * H)] });
    try {
      const now = w.ctx.now();
      const agent = await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      w.sender.publishError = FORBIDDEN;
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      // the creator saves the console at +20 min: the agent wakes for the new config while the hold stands
      await w.db.update(agents).set({ config: { ...(agent.config as Record<string, unknown>), revision: 2 } }).where(eq(agents.agentId, AGENT_ID));
      w.setNow(now + 20 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      const obs = observation(w);
      expect(obs.wakeReasons).not.toContain('original_post_due');
      expect(obs).not.toHaveProperty('holdEnded');
      const waiting = (obs.social as { originalPost: { due: boolean; waiting: { reason: string; until: string; note: string } } }).originalPost;
      expect(waiting.due).toBe(false);
      expect(waiting.waiting).toMatchObject({ reason: 'x_forbidden', until: iso(now + X_FORBIDDEN_HOLD_MS) });
      expect(waiting.waiting.note).toMatch(/^x_forbidden: .*do not call them\..*Note the time it ends in your agenda, not as a permanent fact: you will be told when it ends\.$/);
      // the hold stays on record for when it ends
      expect((await state(w)).postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: now + X_FORBIDDEN_HOLD_MS, at: null });
    } finally {
      await w.close();
    }
  });

  it('a hold cleared from the state by hand: the next turn is told it was lifted before its end', async () => {
    const w = await makeWorld({ script: [POST(), finishResponse(T0 + 10 * MIN), POST(), finishResponse(T0 + 7 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      w.sender.publishError = FORBIDDEN;
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      // the operator empties the hold in the runtime row (the strikes stay, the note is untouched)
      const row = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      await w.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), postForbiddenUntil: null } }).where(eq(runtimes.agentId, AGENT_ID));
      w.sender.publishError = null;
      w.setNow(now + 40 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(observation(w).wakeReasons).toContain('original_post_due');
      expect(observation(w).holdEnded).toMatch(new RegExp(`^x_hold_ended: the 403 hold on this account ended at ${iso(now + 40 * MIN)} \\(lifted before its end at ${iso(now + X_FORBIDDEN_HOLD_MS)}\\); X may accept your posts again\\. Your earlier note.*publish it this turn\\. If X refuses again, the hold returns and you will be told\\.$`));
      expect(w.sender.published).toHaveLength(2);
      expect((await state(w)).postHoldEndedNote ?? null).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('a hold that was on the state before the note existed is picked up by the tick and reported when it ends', async () => {
    const w = await makeWorld({ script: [POST(), finishResponse(T0 + 10 * MIN), POST(), finishResponse(T0 + 9 * H)] });
    try {
      const now = w.ctx.now();
      await seedAgent(w, { config: { socialStartedAt: iso(now - 10 * H) } });
      w.sender.publishError = FORBIDDEN;
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      // the live row of 2026-11-08: a hold with no note
      const row = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      await w.db.update(runtimes).set({ state: { ...(row.state as Record<string, unknown>), postHoldEndedNote: null } }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(now + 10 * MIN);
      expect((await tick(w.ctx)).ran).toEqual([]);
      expect((await state(w)).postHoldEndedNote).toEqual({ reason: 'x_forbidden', until: now + X_FORBIDDEN_HOLD_MS, at: null });
      // it runs out: the turn is told
      w.sender.publishError = null;
      w.setNow(now + X_FORBIDDEN_HOLD_MS + MIN);
      expect((await tick(w.ctx)).ran).toEqual([AGENT_ID]);
      expect(observation(w).holdEnded).toMatch(/^x_hold_ended: the 403 hold on this account ended at 2026-10-24T18:01:00\.000Z; X may accept your posts again\./);
      expect(w.sender.published).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});
