import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { actions, runtimes } from '../src/db/schema.js';
import { initialState, type AgentState } from '../src/runtime.js';
import { SOCIAL_HEARTBEAT_MS, SOCIAL_RECOUNT_MS, tick } from '../src/tick.js';
import { AGENT_ID, makeWorld, seedAgent, type TestWorld } from './helpers.js';

/**
 * The coin page's status line (the indexer's social store). Until 2026-11-25 every agent's tick counted its posts with
 * two queries and sent a signed POST, a minute apart, for a line that changes a few times a day.
 */
const MIN = 60_000;
const H = 3_600_000;

/** An agent with nothing due: every tick ends at the status line and buys no turn. */
async function resting(w: TestWorld) {
  const t0 = w.ctx.now();
  await seedAgent(w, { config: { socialStartedAt: new Date(t0 - H).toISOString() }, runtime: { nextAt: new Date(t0 + 48 * H), lastDecisionAt: new Date(t0 - H), lastDecisionRevision: 1, state: { ...initialState(), phase: 'social', lastPostAt: t0 - MIN } as unknown as Record<string, unknown> } });
  return t0;
}

async function post(w: TestWorld, id: string, at: number) {
  await w.db.insert(actions).values({ actionId: id, agentId: AGENT_ID, cycleKey: `k:${id}`, action: { tool: 'publish_post', input: { text: `post ${id}` } }, status: 'completed', createdAt: new Date(at), updatedAt: new Date(at) });
}

describe('the coin page status line', () => {
  it('is sent once, then only when it changes, and once an hour as a heartbeat', async () => {
    const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '' } });
    try {
      const t0 = await resting(w);
      const sent = () => w.indexer.posted as { postsCount24h: number; lastPostAt: number | null; firstPostAt: number | null; status: string }[];
      for (let m = 0; m < 60; m++) {
        w.setNow(t0 + m * MIN);
        expect((await tick(w.ctx)).ran).toEqual([]);
      }
      // sixty ticks, one line
      expect(sent()).toHaveLength(1);
      expect(sent()[0]).toMatchObject({ postsCount24h: 0, firstPostAt: null, status: 'awake' });
      // the heartbeat: the same line again after an hour
      w.setNow(t0 + SOCIAL_HEARTBEAT_MS);
      await tick(w.ctx);
      expect(sent()).toHaveLength(2);
      expect(sent()[1]).toEqual(sent()[0]);

      // a post the state says nothing of (a reply, a scheduled post) is counted at the next recount, within five minutes
      const base = t0 + SOCIAL_HEARTBEAT_MS;
      await post(w, 'act_reply', base + 30_000);
      let m = 1;
      for (; sent().length === 2 && m <= 10; m++) {
        w.setNow(base + m * MIN);
        await tick(w.ctx);
      }
      expect((m - 1) * MIN).toBeLessThanOrEqual(SOCIAL_RECOUNT_MS);
      expect(sent()).toHaveLength(3);
      expect(sent()[2]).toMatchObject({ postsCount24h: 1, firstPostAt: Math.floor((base + 30_000) / 1000) });

      // a post the state records is counted at once
      const later = base + m * MIN;
      await post(w, 'act_post', later);
      const row = (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))!;
      await w.db.update(runtimes).set({ state: { ...(row.state as unknown as AgentState), lastPostAt: later } as unknown as Record<string, unknown> }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(later + 1000);
      await tick(w.ctx);
      expect(sent()).toHaveLength(4);
      // the first post stays the first; the last one moved
      expect(sent()[3]).toMatchObject({ postsCount24h: 2, firstPostAt: Math.floor((base + 30_000) / 1000), lastPostAt: Math.floor(later / 1000) });
      w.setNow(later + MIN);
      await tick(w.ctx);
      expect(sent()).toHaveLength(4);
    } finally {
      await w.close();
    }
  });

  it('sends a line again at the next tick when the indexer did not take it', async () => {
    const w = await makeWorld({ config: { PLATFORM_QUIET_HOURS_UTC: '' } });
    try {
      const t0 = await resting(w);
      let up = false;
      let tries = 0;
      const real = w.ctx.indexer.postSocial.bind(w.ctx.indexer);
      (w.ctx.indexer as unknown as { postSocial: typeof real }).postSocial = async (k, s) => (tries++, up ? real(k, s) : false);
      await tick(w.ctx);
      w.setNow(t0 + MIN);
      await tick(w.ctx);
      expect(tries).toBe(2);
      up = true;
      w.setNow(t0 + 2 * MIN);
      await tick(w.ctx);
      w.setNow(t0 + 3 * MIN);
      await tick(w.ctx);
      expect(tries).toBe(3);
      expect(w.indexer.posted).toHaveLength(1);
    } finally {
      await w.close();
    }
  });
});
