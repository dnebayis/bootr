/**
 * The security review of 2026-11-15, finding M4: a record built from @bankrbot's post (or @clanker_world's) carried
 * `https://x.com/i/status/<id>`, the model could post it, and the gate could not see whose post it was. On a real
 * Postgres (PGlite): such a record is served without its link, and a text that links the post is refused before a send,
 * while the same accounts stay read sources and another account's post on X may still be linked.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { Db } from '../src/db/client.js';
import { dsSources } from '../src/db/schema.js';
import { executionPostIds, executionPostRefusal, executionSource } from '../src/dataset/execution-posts.js';
import { recordsFor } from '../src/dataset/serve.js';
import { ingestSighting } from '../src/dataset/store.js';
import { buildXSighting, xPostLink, xSourceInfo } from '../src/dataset/x-build.js';
import { pinX, syncXSources } from '../src/dataset/x-pin.js';
import { X_SOURCES, type XSource } from '../src/dataset/x-sources.js';
import type { XPost } from '../src/dataset/sender-x.js';
import { NOW, quietLog } from './dataset-helpers.js';
import { tick } from '../src/tick.js';
import { finishResponse, makeWorld, seedAgent, testDb, toolCallResponse } from './helpers.js';

let db: Db;
let close: () => Promise<void>;
const ctx = () => ({ db, now: () => NOW.getTime(), log: quietLog });

beforeEach(async () => {
  ({ db, close } = await testDb());
  await syncXSources(db, NOW);
});
afterEach(async () => {
  await close();
});

const listed = (handle: string): XSource => X_SOURCES.find((s) => s.handle === handle)!;

/** Pins the listed account to `userId` and reads one post of it into the dataset; the post's id. */
async function read(handle: string, userId: string, postId: string, text: string): Promise<string> {
  const [row] = await db.select().from(dsSources).where(eq(dsSources.id, `x:@${handle}`));
  expect(await pinX(db, row!, listed(handle), { id: userId, handle, followers: 1_000_000 }, NOW)).toBe(`x:${userId}`);
  const post: XPost = { id: postId, text, createdAt: new Date(NOW.getTime() - 60_000).toISOString(), urls: [], quotedId: null };
  const built = buildXSighting(userId, listed(handle), post, NOW);
  if (!('sighting' in built)) throw new Error(`dropped: ${built.dropped}`);
  const result = await ingestSighting(db, xSourceInfo(userId, listed(handle)), built.sighting, { now: NOW });
  expect(result.outcome).toBe('created');
  return postId;
}

describe("an execution account's post in the dataset", () => {
  it('both execution accounts of the list are known as such, and the others are not', () => {
    expect(executionSource({ id: 'x:1', xHandle: 'bankrbot' })).toBe(true);
    expect(executionSource({ id: 'x:2', xHandle: 'clanker_world' })).toBe(true);
    expect(executionSource({ id: 'x:@clanker_world' })).toBe(true);
    expect(executionSource({ id: 'x:3', xHandle: 'base' })).toBe(false);
    // they stay read sources: reading their posts is useful
    expect(X_SOURCES.map((s) => s.handle)).toEqual(expect.arrayContaining(['bankrbot', 'clanker_world']));
  });

  it('is served without its link, while another account keeps its own', async () => {
    const bankr = await read('bankrbot', '5001', '1857000000000000001', 'Bankr shipped a new trading tool for agents on Base today, with limits per wallet.');
    const base = await read('base', '5002', '1857000000000000002', 'Base shipped a new block explorer for agent payments today, with receipts per call.');
    const served = await recordsFor(ctx(), { agentId: '1153600', beat: { topics: 'all', coin: null }, minGrade: 1, limit: 10 });
    const bySource = (name: string) => served.find((r) => r.sources.some((s) => s.name.startsWith(name)));
    expect(bySource('bankrbot')).toBeDefined();
    expect(bySource('bankrbot')!.link).toBeNull();
    expect(bySource('base')!.link).toBe(xPostLink(base));
    expect(JSON.stringify(served)).not.toContain(bankr);
  });

  it('is refused when a text links it, by any path to the post; a post of another account is not', async () => {
    const bankr = await read('bankrbot', '5001', '1857000000000000001', 'Bankr shipped a new trading tool for agents on Base today, with limits per wallet.');
    const clanker = await read('clanker_world', '5003', '1857000000000000003', 'Clanker shipped v5 today: creators earn in ETH or USDC on every launch.');
    const base = await read('base', '5002', '1857000000000000002', 'Base shipped a new block explorer for agent payments today, with receipts per call.');
    expect(await executionPostIds(ctx(), [`bankr launched a new tool today, x.com/i/status/${bankr}`, `and https://twitter.com/someone/status/${clanker}`, `base too: https://x.com/base/status/${base}`])).toEqual(expect.arrayContaining([bankr, clanker]));
    expect(await executionPostRefusal(ctx(), [`bankr launched a new tool today, x.com/i/status/${bankr}`])).toMatch(/^social_execution_account_forbidden: "x\.com\/i\/status\/1857000000000000001" links an account that acts on what posts tell it/);
    expect(await executionPostRefusal(ctx(), ['clanker shipped v5.', `details: https://x.com/i/web/status/${clanker}`])).toMatch(/^social_execution_account_forbidden: part 2 of the thread: /);
    expect(await executionPostRefusal(ctx(), [`base shipped an explorer: https://x.com/i/status/${base}`])).toBeNull();
    expect(await executionPostRefusal(ctx(), ['bankr shipped a new trading tool today.'])).toBeNull();
  });

  it('a publish that links it is refused before it reaches the sender; one that names Bankr in words goes out', async () => {
    const H = 3_600_000;
    const w = await makeWorld({
      script: [
        toolCallResponse('publish_post', { text: 'bankr launched a new trading tool today, x.com/i/status/1857000000000000001' }),
        toolCallResponse('publish_post', { text: 'bankr launched a new trading tool for agents today, with limits per wallet.' }),
        finishResponse(Date.now() + H),
      ],
    });
    try {
      const saved = db;
      db = w.db;
      await syncXSources(db, NOW);
      await read('bankrbot', '5001', '1857000000000000001', 'Bankr shipped a new trading tool for agents on Base today, with limits per wallet.');
      db = saved;
      await seedAgent(w, { config: { socialStartedAt: new Date(w.ctx.now() - 10 * H).toISOString() } });
      await tick(w.ctx);
      const calls = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      const tools = (calls[calls.length - 1]!.body as { messages: { role: string; content: string }[] }).messages.filter((m) => m.role === 'tool').map((m) => m.content);
      expect(tools[0]).toMatch(/social_execution_account_forbidden/);
      expect(w.sender.published.map((p) => (p as { text: string }).text)).toEqual(['bankr launched a new trading tool for agents today, with limits per wallet.']);
    } finally {
      await w.close();
    }
  });
});
