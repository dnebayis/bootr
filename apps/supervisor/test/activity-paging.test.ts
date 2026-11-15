/**
 * The activity tape's paging (activity.ts `agentActivityPage`, `cutActivityPage`). Before the fix each source gave its
 * `limit` newest rows and the merge kept the newest `limit`, with failed and queued publishes dropped after the read:
 * a page's oldest row could be older than rows not shown yet, and the next page started below them. The behaviour
 * check (docs/dev/behaviour-check.md section 6) found 46 of the platform account's 119 originals of a week in a paged
 * read. Here a week of the same shape is read page by page and every row comes back once.
 */
import { describe, expect, it } from 'vitest';
import { agentActivityPage, cutActivityPage, type ActivityItem } from '../src/activity.js';
import { actions, serviceCalls, treasuryOps } from '../src/db/schema.js';
import { AGENT_ID, makeWorld, seedAgent } from './helpers.js';

describe('the activity tape, paged', () => {
  it('gives all 119 originals of a week with 127 refused publishes between them, every item once and in order', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w);
      const end = w.ctx.now() - 60_000;
      const week = 7 * 86_400_000;
      const rows: (typeof actions.$inferInsert)[] = [];
      // 119 originals and 127 refused attempts spread over the week; refusals come in bursts, as retries do.
      for (let i = 0; i < 119; i++) rows.push({ actionId: `post-${i}`, agentId: AGENT_ID, cycleKey: `c${i}`, action: { tool: 'publish_post', input: { text: 'x' } }, status: 'completed', result: { status: 'ok', result: { postId: String(9000 + i) } }, createdAt: new Date(end - Math.floor((i * week) / 119)) });
      for (let i = 0; i < 127; i++) rows.push({ actionId: `refused-${i}`, agentId: AGENT_ID, cycleKey: `r${i}`, action: { tool: 'publish_post', input: { text: 'y' } }, status: 'failed', result: { error: 'gate' }, createdAt: new Date(end - 3_600_000 - Math.floor(i / 10) * 9 * 3_600_000 - (i % 10) * 1000) });
      // A post queued for the creator's review is the review queue's row, not a post.
      for (let i = 0; i < 20; i++) rows.push({ actionId: `queued-${i}`, agentId: AGENT_ID, cycleKey: `q${i}`, action: { tool: 'publish_post', input: { text: 'z' } }, status: 'completed', result: { status: 'ok', result: { queued: true } }, createdAt: new Date(end - 7_200_000 - i * 60_000) });
      await w.db.insert(actions).values(rows);
      // Money rows between them, some of them inside one millisecond with a post.
      for (let i = 0; i < 30; i++) {
        const at = new Date(i < 5 ? end - Math.floor((10 * week) / 119) : end - i * 4 * 3_600_000 - 17);
        await w.db.insert(treasuryOps).values({ opId: `op-${i}`, agentId: AGENT_ID, kind: 'claim_fees', calls: [], callHash: '0x', description: 'claim 0.001 WETH of settled swap fees (~$2) via claimQuote', origin: 'policy', status: i % 7 === 0 ? 'prepared' : 'confirmed', txHash: `0x${String(i).padStart(64, '0')}`, confirmedAt: at, createdAt: at, updatedAt: at });
        await w.db.insert(serviceCalls).values({ id: `svc-${i}`, agentId: AGENT_ID, url: 'https://data.example/a', host: 'data.example', method: 'GET', reason: `a price ${i}`, status: 'succeeded', capMicroUsdc: '50000', quoteMicroUsdc: '1000', chargedMicroUsdc: '1000', createdAt: at, updatedAt: at });
      }

      const whole = (await agentActivityPage(w.ctx, agent, null, { limit: 200 })).items.length;
      for (const limit of [50, 7]) {
        const seen: ActivityItem[] = [];
        let before: Date | undefined;
        for (let pages = 0; pages < 500; pages++) {
          const page = await agentActivityPage(w.ctx, agent, null, { limit, before });
          // A page goes over the limit only to show one millisecond whole.
          expect(page.items.length <= limit || new Set(page.items.map((i) => i.at)).size === 1).toBe(true);
          seen.push(...page.items);
          if (!page.next) break;
          before = new Date(page.next);
        }
        expect([limit, seen.filter((i) => i.kind === 'post').length]).toEqual([limit, 119]);
        expect(seen.filter((i) => i.kind === 'claim')).toHaveLength(30 - 5);
        expect(seen.filter((i) => i.kind === 'service')).toHaveLength(30);
        const keys = seen.map((i) => `${i.kind}|${i.at}|${i.url ?? i.txHash ?? i.summary}`);
        expect(new Set(keys).size).toBe(keys.length);
        expect([...seen].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))).toEqual(seen);
        // The whole read past the 200 cap is no shorter than any page of it.
        expect(seen.length).toBeGreaterThanOrEqual(Math.min(whole, 200));
      }
    } finally {
      await w.close();
    }
  });
});

describe('cutActivityPage', () => {
  const item = (ms: number, n: number): ActivityItem => ({ at: new Date(ms).toISOString(), kind: 'post', summary: `p${n}` });

  it('keeps only what is certain below a full source, and the next page starts at that bound', () => {
    const items = [item(1000, 1), item(900, 2), item(800, 3), item(700, 4)];
    const page = cutActivityPage(items, [850], 10);
    expect(page.items.map((i) => i.summary)).toEqual(['p1', 'p2']);
    expect(page.next).toBe(new Date(851).toISOString());
  });

  it('never splits a millisecond between two pages', () => {
    const items = [item(1000, 1), item(900, 2), item(900, 3), item(900, 4), item(800, 5)];
    const page = cutActivityPage(items, [], 3);
    expect(page.items.map((i) => i.summary)).toEqual(['p1']);
    expect(page.next).toBe(new Date(901).toISOString());
    // A page that is one millisecond whole is shown whole.
    const busy = cutActivityPage([item(900, 2), item(900, 3), item(900, 4), item(800, 5)], [], 2);
    expect(busy.items.map((i) => i.summary)).toEqual(['p2', 'p3', 'p4']);
    expect(busy.next).toBe(new Date(900).toISOString());
  });

  it('ends when no source was full and everything fits', () => {
    expect(cutActivityPage([item(5, 1)], [], 3)).toEqual({ items: [item(5, 1)], next: null });
  });

  it('always moves forward, even below a full source inside one millisecond', () => {
    const page = cutActivityPage([item(999, 1), item(999, 2)], [999], 2, new Date(1000));
    expect(page.items.map((i) => i.summary)).toEqual(['p1', 'p2']);
    expect(Date.parse(page.next!)).toBeLessThan(1000);
  });
});
