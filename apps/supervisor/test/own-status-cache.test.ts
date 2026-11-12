/**
 * Own agents, `run/status` (security review L5): a client may ask for its status 120 times a minute, and every one of
 * those used to cost a request to the sender and several reads on the chain. The quota and the treasury are now read
 * at most once in half a minute per agent; what they bound is still enforced on the calls that spend it.
 */
import { describe, expect, it } from 'vitest';
import type { AgentStatus } from '@bootr/shared/own-agent';
import { STATUS_CACHE_MS } from '../src/own/status-cache.js';
import { OTHER_AGENT_ID, OTHER_CREATOR, OTHER_KERNEL, connectClient, ownWorld, seedOther, seedOwn, type OwnWorld } from './own-helpers.js';

/** Counts the sender's quota reads and every read on the chain, and lets a test say what the sender answers. */
function instrument(w: OwnWorld) {
  const seen = { quota: [] as string[], chain: 0, used: 3, senderDown: false };
  const sender = w.ctx.sender as unknown as { quota: (agentId: string) => Promise<unknown> };
  sender.quota = async (agentId: string) => {
    seen.quota.push(agentId);
    if (seen.senderDown) throw new Error('sender unreachable');
    return { agentId, postsPerDay: 24, postsUsed24h: seen.used, readsPerDay: 200, readsUsedToday: 10, mentionReadIntervalSec: 900, lastMentionsReadAt: null };
  };
  const client = w.ctx.chain.publicClient as unknown as Record<string, unknown>;
  for (const name of ['readContract', 'multicall', 'getBalance']) {
    const inner = client[name];
    if (typeof inner !== 'function') continue;
    client[name] = (...args: unknown[]) => {
      seen.chain += 1;
      return (inner as (...a: unknown[]) => unknown).apply(client, args);
    };
  }
  return seen;
}

describe('own agent: status reads are kept for half a minute per agent', () => {
  it('asks the sender and the chain once for many status calls, and again when the half minute is over', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      const { credential } = await connectClient(w);
      const seen = instrument(w);
      const t0 = w.ctx.now();
      const status = async () => (await w.run<AgentStatus>('status', credential)).body;

      const first = await status();
      expect(first).toMatchObject({ postsLeftToday: 21, xReadsLeftToday: 190, fuel: { spendableUsdc: '20.00', reserveUsdc: '50.00' } });
      const chainReadsOfOne = seen.chain;
      expect(seen.quota).toHaveLength(1);
      expect(chainReadsOfOne).toBeGreaterThan(0);

      // A hundred and twenty more, as fast as the route's limit lets a client ask: nothing more is read anywhere.
      seen.used = 9;
      for (let i = 0; i < 120; i++) expect(await status()).toMatchObject({ postsLeftToday: 21, fuel: first.fuel });
      w.setNow(t0 + STATUS_CACHE_MS - 1);
      expect((await status()).postsLeftToday).toBe(21);
      expect([seen.quota.length, seen.chain]).toEqual([1, chainReadsOfOne]);

      // Half a minute on, the next status reads both again and shows what has changed since.
      w.setNow(t0 + STATUS_CACHE_MS);
      expect((await status()).postsLeftToday).toBe(15);
      expect(seen.quota).toHaveLength(2);
      expect(seen.chain).toBeGreaterThan(chainReadsOfOne);
      const chainReadsOfTwo = seen.chain;
      for (let i = 0; i < 10; i++) await status();
      expect([seen.quota.length, seen.chain]).toEqual([2, chainReadsOfTwo]);
      // What is not behind another service is as it is now, every time: the client and its own last use.
      expect((await status()).client.lastUsedAt).not.toBeNull();
    } finally {
      await w.close();
    }
  });

  it('keeps each agent\'s reads apart, and does not keep a read that failed', async () => {
    const w = await ownWorld();
    try {
      await seedOwn(w);
      await seedOther(w);
      const mine = await connectClient(w);
      const theirs = await connectClient(w, { creator: OTHER_CREATOR, agentId: OTHER_AGENT_ID, kernel: OTHER_KERNEL });
      const seen = instrument(w);
      await w.run('status', mine.credential);
      await w.run('status', theirs.credential);
      await w.run('status', mine.credential);
      expect(seen.quota).toEqual(['7', OTHER_AGENT_ID]);

      // The sender does not answer: the status says so (null), and the very next one asks again instead of
      // repeating the failure for half a minute.
      w.setNow(w.ctx.now() + STATUS_CACHE_MS);
      seen.senderDown = true;
      const down = (await w.run<AgentStatus>('status', mine.credential)).body;
      expect([down.postsLeftToday, down.xReadsLeftToday]).toEqual([null, null]);
      expect(down.fuel).not.toBeNull();
      seen.senderDown = false;
      const chainBefore = seen.chain;
      expect((await w.run<AgentStatus>('status', mine.credential)).body.postsLeftToday).toBe(21);
      // The treasury, which was read a moment ago, was not read again for it.
      expect(seen.chain).toBe(chainBefore);
    } finally {
      await w.close();
    }
  });
});
