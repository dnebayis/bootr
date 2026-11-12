/**
 * Own agents, after the security review of the engine (docs/design/byo-agent.md "Limits added after review"): the tick.
 * Its own sweep is split so that coins with an open turn cannot take every slot from the idle ones, and it writes
 * nothing from a runtime row it read before a client's call changed it.
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { parseUnits } from 'viem';
import { runtimes } from '../src/db/schema.js';
import { usedInWindow } from '../src/own/budget.js';
import { ownSweep, tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, makeWorld, seedAgent, type TestWorld } from './helpers.js';
import { connectClient, openSocial, ownWorld, quietRuntime, runtimeOf, seedOwn, stateOf, turnOf } from './own-helpers.js';

const MIN = 60_000;

async function seedOwnCoin(w: TestWorld, n: number, since: number, status: 'waiting' | 'running' | 'held') {
  const agentId = `own-${n}`;
  const hex = n.toString(16).padStart(2, '0');
  const kernel = `0x${'e'.repeat(38)}${hex}`;
  const token = `0x${'f'.repeat(38)}${hex}`;
  await seedAgent(w, {
    agent: { agentId, kernel, token },
    config: agentConfig(w.ctx.now(), { runner: 'own', agentId, kernel: { address: kernel }, token: { address: token, symbol: `ZZ${n}`, name: `Own ${n}`, chainId: 84532 }, xHandle: `own_${n}`, xUserId: `${2000 + n}` }),
    runtime: { agentId, status, nextAt: new Date(since), updatedAt: new Date(since) },
  });
}

describe('own agents: the sweep is split between open turns and idle coins', () => {
  it('gives each group its half, and a half its group does not fill to the other', () => {
    const row = (id: string, at: number) => ({ id, runtime: { updatedAt: new Date(at) } });
    const busy = [1, 2, 3, 4, 5, 6].map((n) => row(`b${n}`, n));
    const idle = [1, 2, 3].map((n) => row(`i${n}`, n));
    const ids = (rows: { id: string }[]) => rows.map((r) => r.id);
    expect(ids(ownSweep(busy, idle, 4))).toEqual(['b1', 'b2', 'i1', 'i2']);
    expect(ids(ownSweep(busy, idle.slice(0, 1), 4))).toEqual(['b1', 'b2', 'b3', 'i1']);
    expect(ids(ownSweep(busy.slice(0, 1), idle, 4))).toEqual(['b1', 'i1', 'i2', 'i3']);
    expect(ids(ownSweep(busy, [], 4))).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect(ids(ownSweep([], idle, 2))).toEqual(['i1', 'i2']);
    expect(ids(ownSweep(busy, idle, 5))).toEqual(['b1', 'b2', 'b3', 'i1', 'i2']);
    // One slot: whichever of the two was checked longest ago.
    expect(ids(ownSweep([row('b', 5)], [row('i', 3)], 1))).toEqual(['i']);
    expect(ids(ownSweep([row('b', 2)], [row('i', 3)], 1))).toEqual(['b']);
    expect(ownSweep(busy, idle, 0)).toEqual([]);
  });

  it('six own coins that keep a turn open do not keep the tick from the idle own coins', async () => {
    const w = await makeWorld({ config: { MAX_AGENTS_PER_TICK: '4' } });
    try {
      const dayAgo = w.ctx.now() - 86_400_000;
      for (let n = 1; n <= 6; n++) await seedOwnCoin(w, n, dayAgo + n * MIN, 'running');
      for (let n = 7; n <= 9; n++) await seedOwnCoin(w, n, dayAgo + n * MIN, 'waiting');
      const seen = new Map<string, number>();
      for (let i = 0; i < 3; i++) {
        const report = await tick(w.ctx);
        expect(report.errors).toEqual([]);
        const busy = report.processed.filter((id) => Number(id.slice(4)) <= 6);
        const idle = report.processed.filter((id) => Number(id.slice(4)) >= 7);
        expect([busy.length, idle.length]).toEqual([2, 2]);
        for (const id of report.processed) seen.set(id, (seen.get(id) ?? 0) + 1);
        w.setNow(w.ctx.now() + MIN);
      }
      // Three ticks of four slots: every one of the nine was looked at, and the idle three had half of all the slots.
      expect([...seen.keys()].sort()).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `own-${n}`));
      expect(['own-7', 'own-8', 'own-9'].reduce((sum, id) => sum + (seen.get(id) ?? 0), 0)).toBe(6);
    } finally {
      await w.close();
    }
  });
});

describe('own agents: the tick and a lease it lost', () => {
  it('writes nothing from the row it read when a client\'s call ran while the fee policy was still waiting', async () => {
    // Fees wait to be claimed, so the fee policy asks for the kernel client: that is where this test makes it slow.
    const w = await ownWorld({ chain: { usdc: 0n, spenderUsdc: 0n, claimableWeth: parseUnits('0.01', 18) } });
    try {
      const t0 = w.ctx.now();
      const quiet = quietRuntime(t0);
      // The coin was asleep when it became own, and a quota hold on its state ran out: two things the tick would write.
      await seedOwn(w, {
        config: quiet.config,
        runtime: { ...quiet.runtime, status: 'sleeping', state: { phase: 'social', memory: '', agenda: '', summary: '', postQuotaUntil: t0 - MIN, postHoldEndedNote: { reason: 'x_quota', until: t0 - MIN, at: null } } },
      });
      const { credential } = await connectClient(w);
      const kernelFor = w.ctx.kernelFor;
      let opened: string | null = null;
      w.ctx.kernelFor = async (agent) => {
        if (!opened) {
          // Minutes pass inside the fee policy; the creator's client asks for a turn meanwhile and gets it.
          w.setNow(t0 + 5 * MIN);
          opened = (await openSocial(w, credential, { reason: 'creator_asked' })).turnId;
        }
        return kernelFor(agent);
      };
      const report = await tick(w.ctx);
      expect(report.errors).toEqual([]);
      expect(report.processed).toEqual([AGENT_ID]);
      expect(opened).not.toBeNull();
      // The turn the client opened is as the client's call left it: open, running, counted.
      const runtime = await runtimeOf(w);
      expect(runtime.status).toBe('running');
      expect((await turnOf(w))?.own?.turnId).toBe(opened);
      const state = await stateOf(w);
      expect(usedInWindow(state, 'turns', w.ctx.now())).toBe(1);
      expect(state.ownForced).toMatchObject({ count: 1 });
      expect(runtime.leaseToken).toBeNull();
      // The next tick starts from the row as it is and leaves the open turn alone.
      w.setNow(w.ctx.now() + MIN);
      expect((await tick(w.ctx)).errors).toEqual([]);
      expect((await turnOf(w))?.own?.turnId).toBe(opened);
      expect((await runtimeOf(w)).status).toBe('running');
      expect(usedInWindow(await stateOf(w), 'turns', w.ctx.now())).toBe(1);
      expect(await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID))).toHaveLength(1);
      expect(w.modelCalls()).toBe(0);
    } finally {
      await w.close();
    }
  });
});
