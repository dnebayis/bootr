/**
 * The notifier and an own-agent coin (notify-health.ts; docs/design/byo-agent.md sections 1.4 and 11). An own coin
 * thinks in its creator's client: it buys no thought and never sleeps for fuel, so the notices about paid thinking
 * (fuel low, asleep, failing turns, model not available) are never raised for it and one left from its hosted days is
 * closed. What still applies is told as for any coin: gas, the X connection, a pause or a held action, reviews, the
 * session key. A hosted coin's notices are what they were (test/notifications.test.ts is unchanged).
 */
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { agents, notifications, runtimes } from '../src/db/schema.js';
import { notificationText, raiseNotification } from '../src/notifications.js';
import { evaluateHealth, FAILING_TURNS, notifierPass, type HealthFacts } from '../src/notify-health.js';
import { AGENT_ID, makeWorld, seedAgent, type TestWorld } from './helpers.js';

const HOUR = 3_600_000;
const NOW = 1_000_000_000_000;

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  now: NOW,
  agentStatus: 'active',
  runtime: { status: 'waiting', pausedBy: null, failures: 0 },
  reviews: { pending: 0, expiring: 0, soonestExpiry: null },
  fuel: { spendableMicro: 10_000_000, reserveMicro: 40_000_000, recent: { thoughts: 40, spentMicroUsdc: 400_000 }, week: { thoughts: 40, spentMicroUsdc: 400_000, firstAt: NOW - 7 * 24 * HOUR } },
  gas: 'ok',
  x: { connected: true, revoked: false },
  key: { validUntil: NOW + 20 * 24 * HOUR, rotateBeforeMs: 3 * 24 * HOUR, outdated: false },
  ...over,
});
const EMPTY_TANK = { spendableMicro: 0, reserveMicro: 0, recent: { thoughts: 40, spentMicroUsdc: 400_000 }, week: { thoughts: 40, spentMicroUsdc: 400_000, firstAt: NOW - 7 * 24 * HOUR } };
const openEvents = async (w: TestWorld) => (await w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID))).filter((r) => r.resolvedAt === null).map((r) => r.event).sort();
const setRunner = async (w: TestWorld, runner: 'own' | 'hosted') => {
  const row = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
  await w.db.update(agents).set({ config: { ...row.config, runner } }).where(eq(agents.agentId, AGENT_ID));
};

describe('evaluateHealth for an own-agent coin', () => {
  it('never says fuel is low, the agent is asleep, its turns fail or its model is gone, whatever the tank and the row say', () => {
    const worst: Partial<HealthFacts> = { fuel: EMPTY_TANK, runtime: { status: 'sleeping', pausedBy: null, failures: FAILING_TURNS + 3 } };
    // the same facts for a hosted coin: asleep, and that says it
    expect(evaluateHealth(facts(worst))).toMatchObject({ agent_asleep: {}, fuel_low: false, agent_stopped: { reason: 'failing' } });
    expect(evaluateHealth(facts({ fuel: EMPTY_TANK }))).toMatchObject({ agent_asleep: false, fuel_low: { thoughtsLeft: 0 } });
    expect(evaluateHealth(facts(worst))).not.toHaveProperty('model_unavailable');

    const own = evaluateHealth(facts({ ...worst, own: true }));
    expect(own).toMatchObject({ agent_asleep: false, fuel_low: false, agent_stopped: false, model_unavailable: false });
    expect(evaluateHealth(facts({ fuel: EMPTY_TANK, own: true }))).toMatchObject({ agent_asleep: false, fuel_low: false });
    // fuel that could not be read changes nothing either: the answer is still "not low", so an old notice closes
    expect(evaluateHealth(facts({ fuel: null, own: true })).fuel_low).toBe(false);
    // a healthy own coin is all clear
    expect(Object.values(evaluateHealth(facts({ own: true }))).every((v) => v === false)).toBe(true);
  });

  it('is still told what applies to any coin: gas, the X connection, a pause, a held action, reviews, the key', () => {
    const own = (over: Partial<HealthFacts>) => evaluateHealth(facts({ ...over, own: true }));
    expect(own({ gas: 'empty' }).gas_out).toEqual({});
    expect(own({ gas: 'low' }).gas_out).toBe(false);
    expect(own({ x: { connected: false, revoked: true } }).x_revoked).toEqual({});
    expect(own({ x: { connected: true, revoked: false } }).x_revoked).toBe(false);
    expect(own({ x: null })).not.toHaveProperty('x_revoked');
    expect(own({ runtime: { status: 'paused', pausedBy: 'guardian', failures: 0 } }).agent_stopped).toEqual({ reason: 'paused_onchain' });
    expect(own({ runtime: { status: 'paused', pausedBy: 'operator', failures: 0 } }).agent_stopped).toEqual({ reason: 'paused_by_bootr' });
    expect(own({ runtime: { status: 'held', pausedBy: null, failures: 9 } }).agent_stopped).toEqual({ reason: 'blocked' });
    expect(own({ reviews: { pending: 2, expiring: 1, soonestExpiry: NOW + 3 * HOUR } })).toMatchObject({ review_waiting: { pending: 2 }, review_expiring: { expiring: 1, hours: 3 } });
    expect(own({ key: { validUntil: NOW + 2 * 24 * HOUR, rotateBeforeMs: 3 * 24 * HOUR, outdated: false } }).key_rotation).toEqual({ reason: 'expiring', days: 2 });
    expect(own({ key: { validUntil: null, rotateBeforeMs: 3 * 24 * HOUR, outdated: true } }).key_rotation).toEqual({ reason: 'outdated' });
    // before it is active only gas and reviews matter, as for any coin
    const onboarding = own({ agentStatus: 'onboarding', gas: 'empty', runtime: { status: 'ready', pausedBy: null, failures: 0 } });
    expect(Object.keys(onboarding).sort()).toEqual(['gas_out', 'review_expiring', 'review_waiting']);
  });

  it('the gas notice of a coin whose fees can never become gas does not speak of thinking for an own coin', () => {
    expect(evaluateHealth(facts({ gas: 'empty', gasFromCreatorOnly: true })).gas_out).toEqual({ creatorOnly: 1 });
    expect(evaluateHealth(facts({ gas: 'empty', gasFromCreatorOnly: true, own: true })).gas_out).toEqual({ creatorOnly: 1, own: 1 });
    const hosted = notificationText('gas_out', { creatorOnly: 1 });
    const own = notificationText('gas_out', { creatorOnly: 1, own: 1 });
    expect(hosted.body).toContain('pays the agent’s thinking');
    expect(own.title).toBe(hosted.title);
    expect(own.body).not.toMatch(/thinking|refuel/);
    expect(own.body).toContain('paid services');
    expect(own.body).toContain('gas comes only from you');
  });
});

describe('the notifier pass over an own-agent coin', () => {
  it('with empty tanks it tells about gas and nothing about fuel, and reads no thought figure', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n, deposit: 0n, eth: 0n } });
    try {
      await seedAgent(w, { config: { runner: 'own' } });
      w.ctx.telegram = null;
      expect(await notifierPass(w.ctx)).toEqual({ checked: 1, sent: 0, failed: 0 });
      expect(await openEvents(w)).toEqual(['gas_out']);
      // the same coin run by Bootr is low on fuel as well: the runner is what makes the difference
      await setRunner(w, 'hosted');
      w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
      await notifierPass(w.ctx);
      expect(await openEvents(w)).toEqual(['fuel_low', 'gas_out']);
      // ...and back with its own agent the fuel notice closes by itself, while the gas one stays
      await setRunner(w, 'own');
      w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
      await notifierPass(w.ctx);
      expect(await openEvents(w)).toEqual(['gas_out']);
    } finally {
      await w.close();
    }
  });

  it('closes the notices about paid thinking that were open when the coin became own, and keeps the others', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n } });
    try {
      // hosted, asleep without fuel, its X connection revoked, failing, its model gone
      await seedAgent(w, { runtime: { status: 'sleeping', failures: FAILING_TURNS } });
      w.ctx.telegram = null;
      w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: false, revoked: true, handle: 'bootr_agent', xUserId: '1000' } };
      await raiseNotification(w.ctx, AGENT_ID, 'model_unavailable', { model: 'gone/model', field: 'model', picture: 0 });
      await notifierPass(w.ctx);
      // (asleep already says the tank is empty, so a hosted coin gets no second notice about fuel)
      expect(await openEvents(w)).toEqual(['agent_asleep', 'agent_stopped', 'model_unavailable', 'x_revoked']);

      // the creator switches the coin to their own agent; the tick wakes a coin that was asleep (tick.ts `processOwn`)
      await setRunner(w, 'own');
      w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
      await notifierPass(w.ctx);
      // even before that tick, with the row still `sleeping` and five failures on it, only the X notice is left
      expect(await openEvents(w)).toEqual(['x_revoked']);

      // a held action is told to an own coin's creator like to anyone's
      await w.db.update(runtimes).set({ status: 'held' }).where(eq(runtimes.agentId, AGENT_ID));
      w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
      await notifierPass(w.ctx);
      expect(await openEvents(w)).toEqual(['agent_stopped', 'x_revoked']);
      const stopped = (await w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID))).find((r) => r.event === 'agent_stopped' && r.resolvedAt === null)!;
      expect(stopped.data).toEqual({ reason: 'blocked' });
      // nothing here asked a model for anything
      expect(w.inference.calls.filter((c) => /\/v1\/(chat\/completions|requests\/)/.test(c.url))).toEqual([]);
    } finally {
      await w.close();
    }
  });
});
