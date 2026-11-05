import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DEFAULT_OBSERVATION_BYTES, buildObservation } from '@bootr/agent-core';
import { averageThoughtCost, fuelIsLow, LOW_FUEL_THOUGHTS, runwayDays, thoughtsLeft } from '@bootr/shared/fuel';
import { createApp } from '../src/api.js';
import { inference as inferenceTable } from '../src/db/schema.js';
import { fuelSection, fuelView } from '../src/fuel.js';
import { fuelReport, recentThoughtCost, RECENT_THOUGHTS, thoughtsByModel } from '../src/inference.js';
import { signRequest } from '../src/hmac.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, SUPERVISOR_KEY, type TestWorld } from './helpers.js';

const MODEL = 'anthropic/claude-sonnet-4.6';

/** One `sv_inference` row as relayRequest leaves it; `payment` is what the x402 payer stored (`PaymentPayload.accepted`). */
async function row(w: TestWorld, over: { status: 'succeeded' | 'failed' | 'unknown' | 'pending'; error?: string; charged?: string; scheme?: 'exact' | 'upto'; amount?: string; model?: string; request?: Record<string, unknown>; at?: number }) {
  const at = new Date(over.at ?? w.ctx.now());
  await w.db.insert(inferenceTable).values({
    idempotencyKey: `inference:${randomUUID()}`,
    agentId: AGENT_ID,
    cycle: 1,
    requestHash: 'h',
    request: { model: over.model ?? MODEL, ...over.request },
    status: over.status,
    error: over.error ?? null,
    receipt: {
      ...(over.scheme ? { payment: { x402Version: 2, accepted: { scheme: over.scheme, amount: over.amount ?? '90000' }, payload: {} } } : {}),
      ...(over.charged ? { relay: { chargedMicroUsdc: over.charged } } : {}),
    },
    createdAt: at,
    updatedAt: at,
  });
}

describe('fuel arithmetic', () => {
  it('estimates thoughts left from the average cost', () => {
    expect(averageThoughtCost(900_000, 10)).toBe(90_000);
    expect(thoughtsLeft(1_780_000, 90_000)).toBe(19);
  });

  it('has no estimate with zero spend', () => {
    expect(averageThoughtCost(0, 100)).toBeNull();
    expect(thoughtsLeft(5_000_000, null)).toBeNull();
    expect(runwayDays(5_000_000, 0, 100, 86_400_000)).toBeNull();
  });

  it('has no estimate on thin data', () => {
    expect(averageThoughtCost(900_000, 9)).toBeNull();
    expect(runwayDays(5_000_000, 900_000, 9, 86_400_000)).toBeNull();
    expect(runwayDays(5_000_000, 900_000, 100, 60_000)).toBeNull();
  });

  it('answers zero for an empty wallet', () => {
    expect(thoughtsLeft(0, 90_000)).toBe(0);
    expect(thoughtsLeft(-1, 90_000)).toBe(0);
    expect(runwayDays(0, 900_000, 100, 86_400_000)).toBe(0);
    expect(fuelIsLow(0, null)).toBe(true);
    expect(fuelIsLow(0, 0)).toBe(true);
  });

  it('turns a rate into days of runway', () => {
    expect(runwayDays(15_000_000, 10_000_000, 100, 2 * 86_400_000)).toBe(3);
  });

  it('calls fuel low under the threshold only', () => {
    expect(fuelIsLow(1, LOW_FUEL_THOUGHTS - 1)).toBe(true);
    expect(fuelIsLow(1, LOW_FUEL_THOUGHTS)).toBe(false);
    expect(fuelIsLow(1_000_000, null)).toBe(false);
  });
});

describe('fuelView', () => {
  const cost = { thoughts: 40, spentMicroUsdc: 3_600_000 };

  it('is compact and flags the day $BOOTR hit $1.78', () => {
    const view = fuelView({ spenderUsdc: 1.78, usdc: 0 }, cost);
    expect(view).toMatchObject({ spendableUsdc: '1.78', reserveUsdc: '0.00', avgThoughtUsdc: '0.0900', thoughtsLeft: 19, low: true });
    expect(Buffer.byteLength(JSON.stringify(view))).toBeLessThan(300);
  });

  it('is not low with a full float', () => {
    expect(fuelView({ spenderUsdc: 20, usdc: 5 }, cost)).toMatchObject({ thoughtsLeft: 222, low: false });
  });

  it('leaves the estimate out on thin data and zero spend, and keeps the balances', () => {
    for (const thin of [{ thoughts: 3, spentMicroUsdc: 270_000 }, { thoughts: 40, spentMicroUsdc: 0 }]) {
      const view = fuelView({ spenderUsdc: 5, usdc: 1 }, thin);
      expect(view).toMatchObject({ spendableUsdc: '5.00', reserveUsdc: '1.00', low: false });
      expect(view).not.toHaveProperty('thoughtsLeft');
      expect(view).not.toHaveProperty('avgThoughtUsdc');
    }
  });

  it('reports an empty wallet as zero thoughts left', () => {
    expect(fuelView({ spenderUsdc: 0, usdc: 0 }, cost)).toMatchObject({ thoughtsLeft: 0, low: true });
  });
});

describe('fuelSection', () => {
  const log = { warn: vi.fn() } as never;
  const treasury = { usd: { usdc: 1, spenderUsdc: 2, weth: 0, claimableWeth: 0 } };

  it('is omitted without a treasury snapshot, and reads nothing', async () => {
    const db = { select: vi.fn() };
    expect(await fuelSection({ db: db as never, log }, AGENT_ID, null)).toEqual({});
    expect(db.select).not.toHaveBeenCalled();
  });

  it('is omitted when the read fails, and does not throw', async () => {
    const db = { select: () => { throw new Error('db down'); } };
    await expect(fuelSection({ db: db as never, log }, AGENT_ID, treasury)).resolves.toEqual({});
  });

  it('survives compaction of an observation far over the budget', () => {
    const fuel = fuelView({ spenderUsdc: 1.78, usdc: 0 }, { thoughts: 40, spentMicroUsdc: 3_600_000 });
    const big = 'x'.repeat(DEFAULT_OBSERVATION_BYTES);
    const view = buildObservation({ now: 0, treasury: { balances: {}, recent: [big] }, lastResults: [big], extra: { fuel } });
    expect(view.contextWindow?.compacted.length).toBeGreaterThan(0);
    expect(view.fuel).toEqual(fuel);
  });
});

describe('the turn observation', () => {
  it('carries the fuel section, read from the snapshot the tick already has', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.now() + 3_600_000)] });
    try {
      await seedAgent(w);
      for (let i = 0; i < 12; i++) await row(w, { status: 'succeeded', charged: '90000' });
      await tick(w.ctx);
      const post = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
      const observation = JSON.parse((post.body as { messages: { content: string }[] }).messages[1]!.content) as { fuel?: { avgThoughtUsdc?: string; thoughtsLeft?: number; low?: boolean } };
      expect(observation.fuel).toMatchObject({ avgThoughtUsdc: '0.0900' });
      expect(typeof observation.fuel?.thoughtsLeft).toBe('number');
    } finally {
      await w.close();
    }
  });

  it('is told the fuel rule, and that it stays private', async () => {
    const w = await makeWorld({ script: [finishResponse(Date.now() + 3_600_000)] });
    try {
      await seedAgent(w);
      await tick(w.ctx);
      const post = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
      const system = (post.body as { messages: { content: string }[] }).messages[0]!.content;
      expect(system).toMatch(/When fuel\.low is true, spend fewer steps/);
      expect(system).toMatch(/never post about it, or about your treasury or fee operations/);
    } finally {
      await w.close();
    }
  });
});

describe('metering counts what the agent paid for', () => {
  const since = (w: TestWorld) => new Date(w.ctx.now() - 86_400_000);

  it('counts a model refusal the agent paid for, at the amount it signed', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await row(w, { status: 'succeeded', charged: '90000', scheme: 'exact' });
      await row(w, { status: 'failed', error: 'upstream_rejected', scheme: 'exact', amount: '94000' });
      await row(w, { status: 'failed', error: 'credit_exhausted', scheme: 'exact', amount: '95000' });
      await row(w, { status: 'failed', error: 'relay_failed_refund_due', scheme: 'exact', amount: '96000' });
      expect(await thoughtsByModel(w.ctx, AGENT_ID, since(w))).toEqual([{ model: MODEL, thoughts: 4, chargedMicroUsdc: '375000', paidFailures: 3 }]);
    } finally {
      await w.close();
    }
  });

  it('leaves out failures that never took the money and calls still open', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await row(w, { status: 'succeeded', charged: '90000', scheme: 'exact' });
      await row(w, { status: 'failed', error: 'upstream_rejected', scheme: 'upto' });
      await row(w, { status: 'failed', error: 'settlement_rejected', scheme: 'exact' });
      await row(w, { status: 'failed', error: 'http_402' });
      await row(w, { status: 'unknown', error: 'settlement_unknown', scheme: 'exact' });
      await row(w, { status: 'pending', scheme: 'exact' });
      expect(await thoughtsByModel(w.ctx, AGENT_ID, since(w))).toEqual([{ model: MODEL, thoughts: 1, chargedMicroUsdc: '90000' }]);
    } finally {
      await w.close();
    }
  });

  it('moves with every new thought: nothing is cached between two reads', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      await row(w, { status: 'succeeded', charged: '90000' });
      expect((await thoughtsByModel(w.ctx, AGENT_ID, since(w)))[0]!.thoughts).toBe(1);
      await row(w, { status: 'succeeded', charged: '90000' });
      expect((await thoughtsByModel(w.ctx, AGENT_ID, since(w)))[0]!.thoughts).toBe(2);
    } finally {
      await w.close();
    }
  });

  it('reports when the earliest paid call was, across models', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      expect((await fuelReport(w.ctx, AGENT_ID, since(w))).firstAt).toBeNull();
      const now = w.ctx.now();
      await row(w, { status: 'succeeded', charged: '1000', at: now - 3_600_000 });
      await row(w, { status: 'succeeded', charged: '1000', model: 'openai/gpt-5.4-mini', at: now - 7_200_000 });
      await row(w, { status: 'succeeded', charged: '1000', at: now - 3 * 86_400_000 });
      const report = await fuelReport(w.ctx, AGENT_ID, since(w));
      expect(report.firstAt?.getTime()).toBe(now - 7_200_000);
      const path = `/internal/agents/${AGENT_ID}/fuel?days=1`;
      const nowSec = () => Math.floor(w.ctx.now() / 1000);
      const res = await createApp(w.ctx, nowSec).request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } });
      expect(await res.json()).toMatchObject({ firstAt: new Date(now - 7_200_000).toISOString() });
    } finally {
      await w.close();
    }
  });

  it('averages the latest thoughts only, without images, so a model switch shows at once', async () => {
    const w = await makeWorld();
    try {
      await seedAgent(w);
      const now = w.ctx.now();
      for (let i = 0; i < RECENT_THOUGHTS; i++) await row(w, { status: 'succeeded', charged: '90000', at: now - i * 1000 });
      await row(w, { status: 'succeeded', charged: '17000', model: 'openai/gpt-5.4-mini', at: now - 86_400_000 });
      await row(w, { status: 'succeeded', charged: '43000', model: 'google/gemini-3-pro-image', request: { modalities: ['image', 'text'] }, at: now });
      await row(w, { status: 'succeeded', at: now });
      expect(await recentThoughtCost(w.ctx, AGENT_ID)).toEqual({ thoughts: RECENT_THOUGHTS, spentMicroUsdc: RECENT_THOUGHTS * 90_000 });
    } finally {
      await w.close();
    }
  });
});
