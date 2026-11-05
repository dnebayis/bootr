import { describe, expect, it } from 'vitest';
import { buildObservation, DEFAULT_OBSERVATION_BYTES, postValidation } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { coinFeeSplit, coinFeesSection } from '../src/coin-fees.js';
import { runtimes } from '../src/db/schema.js';
import type { IndexerClient } from '../src/indexer-client.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, mockIndexer, seedAgent, type TestWorld } from './helpers.js';

// The presets as they sit on chain, and what the docs say a trade pays (apps/web/components/docs/content.ts, fee tables).
const RWAGMI_STANDARD = { source: 'bootr', lpFeeBps: 10_000, agentBps: 450, creatorBps: 5_850, burnBps: 0, platformBps: 2_700, protocolBps: 1_000 };
const RWAGMI_BUYBACK = { source: 'bootr', lpFeeBps: 10_000, agentBps: 450, creatorBps: 4_500, burnBps: 1_350, platformBps: 2_700, protocolBps: 1_000 };
const CLANKER_STANDARD = { source: 'clanker', lpFeeBps: 10_000, agentBps: 500, creatorBps: 6_500, burnBps: 0, platformBps: 3_000, protocolBps: 2_000 };
const BOOTR_COIN = { source: 'clanker', lpFeeBps: 20_000, agentBps: 500, creatorBps: 5_000, burnBps: 1_500, platformBps: 3_000, protocolBps: 2_000 };

function coinFeesOf(w: TestWorld): Record<string, unknown> | undefined {
  const call = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
  const body = call.body as { messages: { role: string; content: string }[] };
  return (JSON.parse(body.messages.find((m) => m.role === 'user')!.content) as { coinFees?: Record<string, unknown> }).coinFees;
}

async function observed(market: Record<string, unknown> | null, config: Record<string, unknown> = {}) {
  const w = await makeWorld({ script: [finishResponse(Date.parse('2026-10-24T15:00:00Z'))] });
  try {
    const indexer = mockIndexer(market);
    let reads = 0;
    (w.ctx as { indexer: IndexerClient }).indexer = {
      ...(indexer.client as object),
      async market() {
        reads += 1;
        return market;
      },
      platformFeed: async () => null,
      platformFees: async () => null,
    } as unknown as IndexerClient;
    await seedAgent(w, { config: { requireApproval: false, ...config } });
    await tick(w.ctx);
    expect((await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, AGENT_ID) }))?.turn).toBeNull();
    return { coinFees: coinFeesOf(w), reads };
  } finally {
    await w.close();
  }
}

describe('coinFeeSplit', () => {
  it('matches the docs on RWAGMI: the fee is all a trader pays, RWAGMI inside it', () => {
    expect(coinFeeSplit(RWAGMI_STANDARD)).toEqual({
      launchedThrough: 'RWAGMI',
      traderPaysPct: 1,
      launcherTakesPct: 0.1,
      recipientsPct: { agent: 5, creator: 65, burn: 0, platform: 30 },
      ofEachTradePct: { agent: 0.045, creator: 0.585, burn: 0, platform: 0.27 },
      hasBurn: false,
    });
    expect(coinFeeSplit(RWAGMI_BUYBACK)).toMatchObject({
      traderPaysPct: 1,
      recipientsPct: { agent: 5, creator: 50, burn: 15, platform: 30 },
      ofEachTradePct: { agent: 0.045, creator: 0.45, burn: 0.135, platform: 0.27 },
      hasBurn: true,
    });
  });

  it('matches the docs on Clanker: the recipients share the whole fee, Clanker comes on top', () => {
    expect(coinFeeSplit(CLANKER_STANDARD)).toEqual({
      launchedThrough: 'Clanker',
      traderPaysPct: 1.2,
      launcherTakesPct: 0.2,
      recipientsPct: { agent: 5, creator: 65, burn: 0, platform: 30 },
      ofEachTradePct: { agent: 0.05, creator: 0.65, burn: 0, platform: 0.3 },
      hasBurn: false,
    });
    expect(coinFeeSplit(BOOTR_COIN)).toEqual({
      launchedThrough: 'Clanker',
      traderPaysPct: 2.4,
      launcherTakesPct: 0.4,
      recipientsPct: { agent: 5, creator: 50, burn: 15, platform: 30 },
      ofEachTradePct: { agent: 0.1, creator: 1, burn: 0.3, platform: 0.6 },
      hasBurn: true,
    });
  });

  it('is null without the numbers, never a guess', () => {
    expect(coinFeeSplit(null)).toBeNull();
    expect(coinFeeSplit({ priceUsd: 0.01, source: 'bootr', lpFeeBps: 10_000, protocolBps: 1_000 })).toBeNull();
    for (const key of Object.keys(RWAGMI_BUYBACK).filter((k) => k !== 'source')) expect(coinFeeSplit({ ...RWAGMI_BUYBACK, [key]: null })).toBeNull();
    expect(coinFeeSplit({ ...RWAGMI_BUYBACK, lpFeeBps: 0 })).toBeNull();
    expect(coinFeeSplit({ ...RWAGMI_BUYBACK, agentBps: 0, creatorBps: 0, burnBps: 0, platformBps: 0 })).toBeNull();
  });
});

describe('what the rules ask for and the publish gate', () => {
  const gate = (text: string) => postValidation(text, [], 'original', false, { platform: true });

  it('lets a post explain a locked split in the third person', () => {
    expect(gate("$BOOTR trades pay 2.4%. 15% of what reaches its recipients goes to the coin's own buyback and burn, and that split is locked.")).toEqual({ ok: true });
    expect(gate('Each coin on Bootr has its own fee split, locked at launch, and only some coins chose a burn.')).toEqual({ ok: true });
  });

  it('refuses the first person next to fees, which the platform rule warns about', () => {
    expect(gate('Our fees fund the burn.')).toEqual({ ok: false, code: 'platform_treasury_talk_forbidden' });
  });
});

describe('the coinFees section', () => {
  it('is empty when the snapshot has no split', () => {
    const config = { token: { address: '0x0', symbol: 'OWL', name: 'Owl', chainId: 8453 } } as never;
    expect(coinFeesSection(config, null)).toEqual({});
    expect(coinFeesSection(config, { priceUsd: 0.01 })).toEqual({});
  });

  it('survives compaction of an observation over the budget, and is small', () => {
    const section = coinFeesSection({ token: { address: '0x0', symbol: 'BOOTR', name: 'Bootr', chainId: 8453 } } as never, BOOTR_COIN);
    expect(Buffer.byteLength(JSON.stringify(section))).toBeLessThan(800);
    const big = 'x'.repeat(DEFAULT_OBSERVATION_BYTES);
    const view = buildObservation({ now: 0, treasury: { balances: {}, recent: [big] }, lastResults: [big], extra: section });
    expect(view.contextWindow?.compacted.length).toBeGreaterThan(0);
    expect(view.coinFees).toEqual(section.coinFees);
  });

  it("reaches a coin agent's observation on the RWAGMI path from the one market read a turn already makes, burn included", async () => {
    const { coinFees, reads } = await observed({ priceUsd: 0.01, ...RWAGMI_BUYBACK });
    expect(reads).toBe(1);
    expect(coinFees).toMatchObject({ instructionAuthority: false, coin: 'TEST', launchedThrough: 'RWAGMI', traderPaysPct: 1, recipientsPct: { burn: 15 }, hasBurn: true });
    expect(String(coinFees?.meaning)).toMatch(/this coin's trades only/);
  });

  it('says a coin with no burn has none', async () => {
    const { coinFees } = await observed({ priceUsd: 0.01, ...RWAGMI_STANDARD });
    expect(coinFees).toMatchObject({ hasBurn: false, recipientsPct: { burn: 0 }, ofEachTradePct: { burn: 0 } });
  });

  it('reaches the observation on the Clanker path', async () => {
    const { coinFees } = await observed({ priceUsd: 0.01, ...CLANKER_STANDARD });
    expect(coinFees).toMatchObject({ launchedThrough: 'Clanker', traderPaysPct: 1.2, launcherTakesPct: 0.2, hasBurn: false });
  });

  it('is left out, not guessed, when the indexer has no answer or an older snapshot', async () => {
    expect((await observed(null)).coinFees).toBeUndefined();
    expect((await observed({ priceUsd: 0.01, source: 'clanker', lpFeeBps: 20_000, protocolBps: 2_000 })).coinFees).toBeUndefined();
  });

  it("the platform agent's $BOOTR split is its own coin's, like any other agent's", async () => {
    const { coinFees } = await observed({ priceUsd: 0.01, ...BOOTR_COIN }, { platform: true, xHandle: 'AgentBootr', token: { address: '0x3000000000000000000000000000000000000003', symbol: 'BOOTR', name: 'Bootr', chainId: 84532 } });
    expect(coinFees).toMatchObject({ coin: 'BOOTR', traderPaysPct: 2.4, ofEachTradePct: { burn: 0.3 }, recipientsPct: { agent: 5, creator: 50, burn: 15, platform: 30 } });
  });
});
