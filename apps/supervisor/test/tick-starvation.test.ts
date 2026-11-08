import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';
import { runtimes } from '../src/db/schema.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, agentConfig, finishResponse, makeWorld, seedAgent, type TestWorld } from './helpers.js';

/**
 * The tick used to take MAX_AGENTS_PER_TICK runtimes by `nextAt`, and a sleeping agent never moves its `nextAt`, so
 * ten sleeping coins filled every slot of every tick for good and the awake agents behind them never ran again.
 * Awake and sleeping runtimes are now selected apart.
 */

const hex = (n: number, fill: string) => `0x${fill.repeat(39)}${n.toString(16)}` as Address;

/** A coin whose kernel holds nothing (the mock chain answers 0 for any kernel but the test agent's): it stays asleep. */
async function seedSleeper(w: TestWorld, n: number, sleptSince: number) {
  const agentId = `sleeper-${n}`;
  const kernel = hex(n, 'e');
  const token = hex(n, 'f');
  await seedAgent(w, {
    agent: { agentId, kernel, token },
    config: agentConfig(w.ctx.now(), { agentId, kernel: { address: kernel }, token: { address: token, symbol: `ZZ${n}`, name: `Sleeper ${n}`, chainId: 84532 }, xHandle: `sleeper_${n}`, xUserId: `${2000 + n}` }),
    runtime: { agentId, status: 'sleeping', nextAt: new Date(sleptSince), updatedAt: new Date(sleptSince) },
  });
}

describe('sleeping agents and the tick', () => {
  it('ten sleeping coins do not keep the one due agent from running', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T13:00:00Z'))], config: { MAX_AGENTS_PER_TICK: '10' } });
    try {
      const dayAgo = w.ctx.now() - 86_400_000;
      for (let n = 1; n <= 10; n++) await seedSleeper(w, n, dayAgo - n * 60_000);
      await seedAgent(w); // the awake agent, due since a second ago, with fuel
      const report = await tick(w.ctx);
      expect(report.ran).toEqual([AGENT_ID]);
      expect(report.errors).toEqual([]);
      // the sleepers were checked too, and stayed asleep
      expect(report.processed.filter((id) => id.startsWith('sleeper-'))).toHaveLength(10);
      const rows = await w.db.select().from(runtimes);
      expect(rows.filter((r) => r.status === 'sleeping')).toHaveLength(10);
    } finally {
      await w.close();
    }
  });

  it('checks sleeping agents in turn, least recently checked first, within MAX_SLEEPING_PER_TICK', async () => {
    const w = await makeWorld({ config: { MAX_AGENTS_PER_TICK: '10', MAX_SLEEPING_PER_TICK: '3' } });
    try {
      const dayAgo = w.ctx.now() - 86_400_000;
      for (let n = 1; n <= 5; n++) await seedSleeper(w, n, dayAgo + n * 60_000); // 1 is the stalest
      const first = await tick(w.ctx);
      expect(first.processed).toEqual(['sleeper-1', 'sleeper-2', 'sleeper-3']);
      w.setNow(w.ctx.now() + 60_000);
      const second = await tick(w.ctx);
      expect(second.processed).toEqual(['sleeper-4', 'sleeper-5', 'sleeper-1']);
      // a check touches the row, which is what the order follows
      const touched = await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, 'sleeper-1') });
      expect(touched?.updatedAt.getTime()).toBe(w.ctx.now());
    } finally {
      await w.close();
    }
  });

  it('with MAX_SLEEPING_PER_TICK=0 sleeping agents are left alone', async () => {
    const w = await makeWorld({ config: { MAX_SLEEPING_PER_TICK: '0' } });
    try {
      await seedSleeper(w, 1, w.ctx.now() - 86_400_000);
      expect((await tick(w.ctx)).processed).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
