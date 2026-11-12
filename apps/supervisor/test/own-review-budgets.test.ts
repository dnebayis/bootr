/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): the daily
 * budgets. Fuel was the hosted agent's rate limit; an own coin buys no thought, so its turns, its steps and the rows
 * its tools write are counted per coin over 24 hours. Through the real internal routes.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { OWN_DEFAULTS, OWN_ERRORS, type ActResult, type OwnErrorBody, type TurnOpen } from '@bootr/shared/own-agent';
import { rememberDailyCap, treasuryExecuteDailyCap, treasuryPrepareDailyCap } from '../src/broker/index.js';
import { actions, memories, treasuryOps } from '../src/db/schema.js';
import { USAGE_BUCKET_MS, USAGE_WINDOW_MS, budgetOpensAt, countUse, usedInWindow } from '../src/own/budget.js';
import { ownRole, registerOwnRole } from '../src/own/registry.js';
import { FINISH_PAST_STEP_CAP } from '../src/own/turns.js';
import type { AgentState } from '../src/runtime.js';
import { AGENT_ID } from './helpers.js';
import { act, connectClient, finishInput, openSocial, ownWorld, quietRuntime, seedOwn, stateOf, turnOf, type OwnWorld } from './own-helpers.js';

const HOUR = 3_600_000;

async function setup(config: Record<string, string> = {}, opts: { agent?: Record<string, unknown>; chain?: Record<string, unknown> } = {}) {
  const w = await ownWorld({ config: { OWN_FORCED_TURNS_PER_DAY: '50', ...config }, ...(opts.chain ? { chain: opts.chain } : {}) } as Parameters<typeof ownWorld>[0]);
  const quiet = quietRuntime(w.ctx.now());
  await seedOwn(w, { config: { ...quiet.config, ...(opts.agent ?? {}) }, runtime: quiet.runtime });
  const { credential } = await connectClient(w);
  return { w, credential };
}
const forced = (w: OwnWorld, credential: string) => w.run<TurnOpen & OwnErrorBody>('turn', credential, { role: 'social', reason: 'creator_asked' });
const finish = (w: OwnWorld, credential: string, turnId: string) => w.run<ActResult & OwnErrorBody>('finish', credential, { turnId, ...finishInput(w) });
const rowsOf = async (w: OwnWorld, tool: string) => (await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID))).filter((r) => (r.action as { tool?: string }).tool === tool);

describe('own agent: the budgets of a day, as numbers', () => {
  it('are well above what a real agent needs', () => {
    expect(OWN_DEFAULTS).toMatchObject({ OWN_TURNS_PER_DAY: 300, OWN_STEPS_PER_DAY: 2000, OWN_REMEMBER_PER_DAY: 200, OWN_TREASURY_PREPARE_PER_DAY: 100, OWN_TREASURY_EXECUTE_PER_DAY: 30, OWN_SERVICE_CALLS_PER_DAY: 100, OWN_UPLOAD_ATTEMPTS_PER_DAY: 24 });
    expect(OWN_ERRORS.daily_budget_used.status).toBe(429);
  });

  it('count by the hour, never let a 24-hour window hold more than the budget, and say when it opens again', () => {
    const state: Pick<AgentState, 'ownUsage'> = {};
    const t0 = Date.UTC(2026, 10, 12, 9, 30);
    countUse(state, 'steps', t0);
    countUse(state, 'steps', t0 + 10 * 60_000);
    countUse(state, 'steps', t0 + 2 * HOUR);
    expect(usedInWindow(state, 'steps', t0 + 2 * HOUR)).toBe(3);
    expect(usedInWindow(state, 'turns', t0)).toBe(0);
    // The first hour's two stay counted until 24 hours after that hour ended, then leave together.
    const firstHourEnds = Math.floor(t0 / USAGE_BUCKET_MS) * USAGE_BUCKET_MS + USAGE_BUCKET_MS;
    expect(usedInWindow(state, 'steps', firstHourEnds + USAGE_WINDOW_MS - 1)).toBe(3);
    expect(usedInWindow(state, 'steps', firstHourEnds + USAGE_WINDOW_MS)).toBe(1);
    expect(budgetOpensAt(state, 'steps', 3, t0 + 2 * HOUR)).toBe(firstHourEnds + USAGE_WINDOW_MS);
    expect(budgetOpensAt(state, 'steps', 1, t0 + 2 * HOUR)).toBe(firstHourEnds + 2 * HOUR + USAGE_WINDOW_MS);
    // What left the window is dropped at the next count, so the state stays a day long.
    countUse(state, 'steps', t0 + 3 * 24 * HOUR);
    expect(state.ownUsage?.steps).toHaveLength(1);
  });
});

describe('own agent: turns and steps per day', () => {
  it('opens no more turns than the day allows, whatever is due or asked, and opens again when the window moves', async () => {
    const { w, credential } = await setup({ OWN_TURNS_PER_DAY: '3' });
    try {
      for (let i = 0; i < 3; i++) {
        const turn = await forced(w, credential);
        expect(turn.status).toBe(200);
        expect((await finish(w, credential, turn.body.turnId)).body.status).toBe('completed');
        w.setNow(w.ctx.now() + 60_000);
      }
      const refused = await forced(w, credential);
      expect(refused.status).toBe(429);
      expect(refused.body.error).toBe('daily_budget_used');
      expect(refused.body.message).toBe(OWN_ERRORS.daily_budget_used.message);
      const retryAt = Date.parse(refused.body.retryAt!);
      expect(retryAt).toBeGreaterThan(w.ctx.now() + 23 * HOUR);
      expect(retryAt).toBeLessThanOrEqual(w.ctx.now() + 25 * HOUR);
      expect(await turnOf(w)).toBeNull();
      // The budget is the coin's, not the client's: a second client of the same coin is refused the same way.
      const other = await connectClient(w, { clientName: 'Cursor' });
      expect((await forced(w, other.credential)).body.error).toBe('daily_budget_used');
      // A day on, the window has moved past those three.
      w.setNow(retryAt);
      expect((await forced(w, credential)).status).toBe(200);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('takes no more steps than the day allows across turns; a refused call writes nothing, and the open turn can still be finished', async () => {
    const { w, credential } = await setup({ OWN_STEPS_PER_DAY: '5' });
    try {
      const first = await openSocial(w, credential, { reason: 'creator_asked' });
      for (let i = 0; i < 4; i++) expect((await act(w, credential, first.turnId, 'recall', { query: `q${i}` })).body.status).toBe('completed');
      expect((await finish(w, credential, first.turnId)).body.status).toBe('completed');
      expect(usedInWindow(await stateOf(w), 'steps', w.ctx.now())).toBe(5);

      w.setNow(w.ctx.now() + 60_000);
      const second = await openSocial(w, credential, { reason: 'creator_asked' });
      const refused = await act(w, credential, second.turnId, 'recall', { query: 'one more' });
      expect(refused.status).toBe(429);
      expect((refused.body as unknown as OwnErrorBody).error).toBe('daily_budget_used');
      expect(Date.parse((refused.body as unknown as OwnErrorBody).retryAt!)).toBeGreaterThan(w.ctx.now());
      expect(await rowsOf(w, 'recall')).toHaveLength(4);
      expect((await turnOf(w))?.steps).toBe(0);
      // The turn is not stranded: its finish is taken (and counted).
      expect((await finish(w, credential, second.turnId)).body).toMatchObject({ status: 'completed', turnEnded: true });
      expect(usedInWindow(await stateOf(w), 'steps', w.ctx.now())).toBe(6);
    } finally {
      await w.close();
    }
  });

  it('a finish the role refuses is a step, and one refused past the step cap closes the turn instead of leaving it open to more', async () => {
    const { w, credential } = await setup({ MAX_TOOL_STEPS: '2' });
    const real = ownRole('treasury');
    try {
      registerOwnRole({
        role: 'treasury',
        due: async () => ({ on: true, due: true, reasons: ['treasury_interval'], nextAt: null }),
        open: async (call, opts) => ({ turn: { role: 'treasury', startedAt: call.now, steps: 0, nudged: false, reasons: opts.reasons, messages: [], inbox: {}, recentSteps: [] }, brief: 'b', observation: {}, tools: ['treasury_read'] }),
        finish: async () => {
          throw new Error('checkpoint_too_large: keep concise notes and archive details with remember');
        },
      });
      const turn = await w.run<TurnOpen>('turn', credential, { role: 'treasury' });
      const turnId = turn.body.turnId;
      // Below the cap a refused finish costs a step and the turn stays open.
      const early = await finish(w, credential, turnId);
      expect(early.body).toMatchObject({ status: 'failed', turnEnded: false, stepsUsed: 1 });
      expect((await act(w, credential, turnId, 'treasury_read')).body).toMatchObject({ status: 'completed', stepsUsed: 2 });
      expect(((await act(w, credential, turnId, 'treasury_read')).body as unknown as OwnErrorBody).error).toBe('step_cap');
      // At the cap: the one finish it has left is refused by the role, and that ends the turn.
      const last = await finish(w, credential, turnId);
      expect(last.status).toBe(200);
      expect(last.body).toMatchObject({ status: 'failed', turnEnded: true, stepsUsed: 3 });
      expect(last.body.error).toBe(`checkpoint_too_large: keep concise notes and archive details with remember ${FINISH_PAST_STEP_CAP}`);
      expect(await turnOf(w)).toBeNull();
      expect((await stateOf(w)).ownClosed).toMatchObject({ turnId, why: 'step_cap' });
      const after = await finish(w, credential, turnId);
      expect([after.status, after.body.error]).toEqual([410, 'turn_closed']);
      expect(await rowsOf(w, 'finish')).toHaveLength(2);
      // Each of them was counted against the day.
      expect(usedInWindow(await stateOf(w), 'steps', w.ctx.now())).toBe(3);
    } finally {
      if (real) registerOwnRole(real);
      await w.close();
    }
  });
});

describe('own agent: rows and signatures per day', () => {
  it('keeps no more notes than the day allows', async () => {
    const { w, credential } = await setup({ OWN_REMEMBER_PER_DAY: '2' });
    try {
      const turn = await openSocial(w, credential, { reason: 'creator_asked' });
      const answers = [];
      for (let i = 0; i < 3; i++) answers.push((await act(w, credential, turn.turnId, 'remember', { text: `A note worth keeping, number ${i}.` })).body);
      expect(answers.map((a) => a.status)).toEqual(['completed', 'completed', 'failed']);
      expect(answers[2]!.error).toBe(rememberDailyCap(2));
      expect(await w.db.select().from(memories).where(eq(memories.agentId, AGENT_ID))).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('prepares and executes no more treasury operations than the day allows, and a refused execute signs nothing', async () => {
    const { w, credential } = await setup({ OWN_TREASURY_PREPARE_PER_DAY: '2', OWN_TREASURY_EXECUTE_PER_DAY: '1' }, { chain: { weth: 10n ** 17n } });
    try {
      const now = w.ctx.now();
      // One operation was executed an hour ago: the day's one is used.
      await w.db.insert(actions).values({ actionId: 'act_e0', agentId: AGENT_ID, cycleKey: 'cycle:e0', action: { tool: 'treasury_execute', input: {} }, status: 'completed', createdAt: new Date(now - HOUR), updatedAt: new Date(now - HOUR) });
      const turn = await openSocial(w, credential, { reason: 'creator_asked' });
      const one = await act(w, credential, turn.turnId, 'treasury_prepare', { operation: 'swap', asset: 'ETH', amount: '0.01' });
      expect(one.body).toMatchObject({ status: 'completed', result: { simulated: true } });
      const prepared = one.body.result as { preparedId: string; expectedHash: string };
      const executed = await act(w, credential, turn.turnId, 'treasury_execute', { preparedId: prepared.preparedId, expectedHash: prepared.expectedHash });
      expect(executed.body).toMatchObject({ status: 'failed', error: treasuryExecuteDailyCap(1) });
      expect(w.kernel.submitted).toHaveLength(0);
      expect((await act(w, credential, turn.turnId, 'treasury_prepare', { operation: 'swap', asset: 'ETH', amount: '0.02' })).body.status).toBe('completed');
      const third = await act(w, credential, turn.turnId, 'treasury_prepare', { operation: 'swap', asset: 'ETH', amount: '0.03' });
      expect(third.body).toMatchObject({ status: 'failed', error: treasuryPrepareDailyCap(2) });
      expect(await w.db.select().from(treasuryOps)).toHaveLength(2);
    } finally {
      await w.close();
    }
  });
});
