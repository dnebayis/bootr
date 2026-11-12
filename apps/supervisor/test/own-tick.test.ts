/**
 * Own agents (docs/design/byo-agent.md sections 2.4 and 13.2): what the supervisor's tick does for a coin whose stored
 * config says `runner: 'own'`. It gets everything a coin gets above the wake decision (reconciliation, the fee
 * policy, the hold bookkeeping, the social line) and nothing below it: no sleep rule, no background mention read, no
 * wake decision, no turn, no model call. The flag is not asked: with it off an own coin is silent, never hosted. Every
 * test here runs with a fetch that throws when a model is asked for anything.
 */
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseUnits } from 'viem';
import { type OwnErrorBody } from '@bootr/shared/own-agent';
import { actions, inference, runtimes, treasuryOps } from '../src/db/schema.js';
import { processAgent, tick } from '../src/tick.js';
import type { Turn } from '../src/runtime.js';
import { AGENT_ID, seedAgent } from './helpers.js';
import { act, connectClient, mention, openSocial, ownWorld, patchState, runtimeOf, seedOwn, stateOf, turnOf, type OwnWorld } from './own-helpers.js';

const MIN = 60_000;
/** No fuel at all, fees waiting to be claimed (0.01 WETH at $3000), a mention waiting and an original post due. */
const NO_FUEL = { usdc: 0n, spenderUsdc: 0n, claimableWeth: parseUnits('0.01', 18) };

function countMentionReads(w: OwnWorld): () => number {
  const read = w.sender.client.readMentions.bind(w.sender.client);
  let n = 0;
  w.sender.client.readMentions = (async (...args: Parameters<typeof read>) => {
    n += 1;
    return read(...args);
  }) as typeof read;
  return () => n;
}

describe('own agent: the tick', () => {
  for (const flag of [true, false]) {
    it(`an own coin never reaches a hosted turn and is never put to sleep, with the flag ${flag ? 'on' : 'off'}`, async () => {
      const w = await ownWorld({ flag, chain: NO_FUEL });
      try {
        await seedOwn(w);
        w.sender.items = [mention('1001')];
        const mentionReads = countMentionReads(w);
        for (let n = 0; n < 4; n++) {
          const report = await tick(w.ctx);
          expect(report.errors).toEqual([]);
          expect(report.processed).toEqual([AGENT_ID]);
          // No turn ran: not a social one for the mention or the due post, not a treasury one.
          expect(report.ran).toEqual([]);
          w.setNow(w.ctx.now() + 2 * MIN);
        }
        const runtime = await runtimeOf(w);
        // Under 1 USDC a hosted coin sleeps; an own coin thinks for free and never does.
        expect(runtime.status).toBe('waiting');
        expect(runtime.turn).toBeNull();
        expect(runtime.leaseToken).toBeNull();
        // No model was called and nothing was bought, read from X or published.
        expect(w.modelCalls()).toBe(0);
        expect(await w.db.select().from(inference)).toHaveLength(0);
        expect(mentionReads()).toBe(0);
        expect(w.sender.published).toHaveLength(0);
        expect((await w.db.select().from(actions)).filter((r) => 'tool' in r.action)).toHaveLength(0);
        // What every coin gets still ran: the fee policy claimed the fees.
        // (The mocked chain keeps its claimable fees after a claim, so each chain read of the four ticks claims again.)
        const ops = await w.db.select().from(treasuryOps);
        expect(ops.length).toBeGreaterThanOrEqual(1);
        expect(ops.every((o) => o.kind === 'claim_fees' && o.status === 'confirmed' && o.origin === 'policy')).toBe(true);
        // The coin page is told who thinks, and never "sleeping".
        expect(w.indexer.posted.length).toBeGreaterThan(0);
        for (const line of w.indexer.posted) expect(line).toMatchObject({ status: 'awake', model: 'own-agent' });
        const direct = await processAgent(w.ctx, (await w.db.query.agents.findFirst())!, runtime);
        expect(direct).toMatchObject({ ran: false, skipped: 'own_agent', reasons: ['own_agent'] });
      } finally {
        await w.close();
      }
    });
  }

  it('the same coin run by Bootr does go to sleep without fuel, and with fuel its model is called: the own path is what makes the difference', async () => {
    const asleep = await ownWorld({ chain: NO_FUEL });
    try {
      await seedAgent(asleep);
      asleep.sender.items = [mention('1001')];
      await tick(asleep.ctx);
      expect((await runtimeOf(asleep)).status).toBe('sleeping');
      expect(asleep.indexer.posted.at(-1)).toMatchObject({ status: 'sleeping' });
      expect(asleep.modelCalls()).toBe(0);
    } finally {
      await asleep.close();
    }
    const awake = await ownWorld();
    try {
      await seedAgent(awake);
      awake.sender.items = [mention('1001')];
      const report = await tick(awake.ctx);
      // The hosted turn ran into the throwing model client: this is the call an own coin must never make.
      expect(report.ran).toEqual([AGENT_ID]);
      expect(awake.modelCalls()).toBeGreaterThan(0);
    } finally {
      await awake.close();
    }
  });

  it('a coin that was asleep when it became own is awake from the next tick, whatever its fuel', async () => {
    const w = await ownWorld({ flag: false, chain: { usdc: 0n, spenderUsdc: 0n } });
    try {
      await seedOwn(w, { runtime: { status: 'sleeping' } });
      await tick(w.ctx);
      expect((await runtimeOf(w)).status).toBe('waiting');
      expect(w.indexer.posted.at(-1)).toMatchObject({ status: 'awake', model: 'own-agent' });
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('asks the chain as seldom as a resting agent while no turn is open, and every tick while one is', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const pc = w.ctx.chain.publicClient as unknown as { multicall: (a: unknown) => Promise<unknown> };
      const inner = pc.multicall.bind(pc);
      let multicalls = 0;
      pc.multicall = async (a) => {
        multicalls += 1;
        return inner(a);
      };
      await tick(w.ctx);
      expect(multicalls).toBe(1);
      expect((await stateOf(w)).chainCheckedAt).toBe(w.ctx.now());
      // Within REST_CHECK_MS: no chain read, and still no hosted turn.
      for (let n = 0; n < 3; n++) {
        w.setNow(w.ctx.now() + MIN);
        const report = await tick(w.ctx);
        expect(report.ran).toEqual([]);
        expect(report.errors).toEqual([]);
      }
      expect(multicalls).toBe(1);
      w.setNow(w.ctx.now() + w.ctx.config.REST_CHECK_MS);
      await tick(w.ctx);
      expect(multicalls).toBe(2);

      // With a turn open the coin is at work: the pauses and the treasury are read every tick, as for an awake agent.
      const turn = await openSocial(w, credential);
      const before = multicalls;
      for (let n = 0; n < 2; n++) {
        w.setNow(w.ctx.now() + MIN);
        await tick(w.ctx);
      }
      expect(multicalls).toBeGreaterThanOrEqual(before + 2);
      // The tick left the open turn alone.
      expect((await turnOf(w))?.own?.turnId).toBe(turn.turnId);
      expect((await runtimeOf(w)).status).toBe('running');
    } finally {
      await w.close();
    }
  });

  it('mirrors the creator\'s on-chain pause into an own coin, and a turn opened before it runs nothing', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      w.state.paused = true;
      w.setNow(w.ctx.now() + MIN);
      await tick(w.ctx);
      const runtime = await runtimeOf(w);
      expect(runtime).toMatchObject({ status: 'paused', pausedBy: 'guardian' });
      const res = await act(w, credential, turn.turnId, 'publish_post', { text: 'a post after the creator paused the agent' });
      expect(res.status).toBe(409);
      expect((res.body as unknown as OwnErrorBody).error).toBe('agent_paused');
      expect(w.sender.published).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('with the flag off an own turn left open is closed by the idle rule, and the X hold bookkeeping still runs', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const turn = await openSocial(w, credential);
      await act(w, credential, turn.turnId, 'read_market');
      // The flag goes off while the turn is open. The coin stays own; its run routes are closed.
      (w.ctx.config as { OWN_AGENT_ENABLED: boolean }).OWN_AGENT_ENABLED = false;
      expect(((await act(w, credential, turn.turnId, 'read_market')).body as unknown as OwnErrorBody).error).toBe('own_agent_disabled');
      await tick(w.ctx);
      expect((await turnOf(w))?.own?.turnId).toBe(turn.turnId);
      // A quota hold that ran out is marked ended by the tick, as for a hosted coin.
      await patchState(w, { postQuotaUntil: w.ctx.now() + 5 * MIN, postHoldEndedNote: { reason: 'x_quota', until: w.ctx.now() + 5 * MIN, at: null } });

      w.setNow(w.ctx.now() + 10 * MIN);
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.ran).toEqual([]);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      const state = await stateOf(w);
      expect(state.ownClosed).toMatchObject({ turnId: turn.turnId, why: 'expired' });
      expect(state.continuation?.progress).toBe('Turn ended by the runtime (expired). Continue from the agenda.');
      expect(state.postHoldEndedNote).toMatchObject({ reason: 'x_quota', how: 'expired' });
      expect(state.postHoldEndedNote?.at).toBe(w.ctx.now());
      // Still no hosted turn for it afterwards, tick after tick.
      for (let n = 0; n < 3; n++) {
        w.setNow(w.ctx.now() + 6 * MIN);
        expect((await tick(w.ctx)).ran).toEqual([]);
      }
      expect(w.modelCalls()).toBe(0);
      expect(await w.db.select().from(inference)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('drops a hosted turn found stored on an own coin with a continuation note, and never resumes it', async () => {
    const w = await ownWorld({ flag: false });
    try {
      // A hosted turn mid-conversation, as a switch would find it; the coin's config now says own.
      const hosted: Turn = { role: 'social', startedAt: Date.parse('2026-10-24T11:58:00Z'), steps: 2, nudged: false, reasons: ['scheduled'], messages: [{ role: 'system', content: 'prompt' }, { role: 'user', content: '{}' }], inbox: {}, recentSteps: [{ tool: 'read_market', status: 'completed', summary: '{}' }] };
      await seedOwn(w, { runtime: { status: 'running', turn: hosted as unknown as Record<string, unknown> } });
      const report = await tick(w.ctx);
      expect(report.ran).toEqual([]);
      const runtime = await runtimeOf(w);
      expect(runtime.turn).toBeNull();
      expect(runtime.status).toBe('waiting');
      expect((await stateOf(w)).continuation?.recentSteps).toEqual([{ tool: 'read_market', status: 'completed', summary: '{}' }]);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });

  it('leaves a hosted coin\'s tick exactly as it was: a config without a runner, or with runner hosted, takes the hosted path', async () => {
    for (const config of [{}, { runner: 'hosted' }, { runner: 'OWN' }, { runner: null }] as Record<string, unknown>[]) {
      const w = await ownWorld({ flag: true, chain: { usdc: 0n, spenderUsdc: 0n } });
      try {
        await seedAgent(w, { config });
        await tick(w.ctx);
        // The sleep rule is the hosted path's own: reaching it proves the own path was not taken.
        expect([config, (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!.status]).toEqual([config, 'sleeping']);
        expect(w.indexer.posted.at(-1)).toMatchObject({ status: 'sleeping', model: 'openai/gpt-4.1-mini' });
      } finally {
        await w.close();
      }
    }
  });
});
