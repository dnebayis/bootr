/**
 * The fleet-wide hold while the model provider is down (src/provider-hold.ts): the second agent to fail the same way
 * trips it, and from then on no agent buys a thought until it ends; one answer clears it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { agents, runtimes } from '../src/db/schema.js';
import { isProviderOutage, noteInferenceFailure, noteInferenceSuccess, PROVIDER_HOLD_MS, PROVIDER_OUTAGE_WINDOW_MS, providerHold, resetProviderHold } from '../src/provider-hold.js';
import { initialState, type AgentState } from '../src/runtime.js';
import { processAgent } from '../src/tick.js';
import { AGENT_ID, agentConfig, finishResponse, KERNEL, makeWorld, seedAgent, type TestWorld } from './helpers.js';

afterEach(() => resetProviderHold());

const T0 = Date.parse('2026-11-08T10:00:00Z');
const MINUTE = 60_000;

describe('provider hold (pure)', () => {
  it('recognises outage-shaped errors and not an agent\'s own trouble', () => {
    for (const e of ['upstream_rejected', 'upstream_failed_credited', 'http_403', 'http_429', 'http_502', 'relay_unreachable', 'direct_unavailable: blockrun 503', 'TimeoutError: The operation was aborted', 'TypeError: fetch failed']) expect(isProviderOutage(e), e).toBe(true);
    for (const e of ['insufficient_float', 'credit_exhausted', 'no_payment_signed', 'X402PaymentRefusedError: quote above max', 'context_too_large', null, undefined, '']) expect(isProviderOutage(e), String(e)).toBe(false);
  });

  it('holds everyone once two distinct agents fail the same way inside the window, extends while it lasts, clears on a success', () => {
    expect(noteInferenceFailure('7', 'http_403', T0)).toBeNull();
    expect(noteInferenceFailure('7', 'http_403', T0 + MINUTE)).toBeNull(); // the same agent again is one agent
    expect(providerHold(T0 + MINUTE)).toBeNull();
    const hold = noteInferenceFailure('8', 'upstream_rejected', T0 + 2 * MINUTE);
    expect(hold).toMatchObject({ reason: 'provider_down', until: T0 + 2 * MINUTE + PROVIDER_HOLD_MS, error: 'upstream_rejected' });
    expect(hold!.message).toMatch(/^provider_down: the model provider is failing for every agent \(upstream_rejected\); no thoughts are bought until 2026-11-08T10:12:00.000Z$/);
    expect(providerHold(T0 + 5 * MINUTE)).toEqual(hold);
    // a failure during the hold moves its end; an agent-specific failure does not
    expect(noteInferenceFailure('9', 'http_503', T0 + 11 * MINUTE)!.until).toBe(T0 + 21 * MINUTE);
    expect(noteInferenceFailure('9', 'insufficient_float', T0 + 12 * MINUTE)!.until).toBe(T0 + 21 * MINUTE);
    expect(providerHold(T0 + 21 * MINUTE)).toBeNull();
    noteInferenceSuccess();
    expect(providerHold(T0 + 13 * MINUTE)).toBeNull();
    // after a success the count starts over: one new failure is not an outage
    expect(noteInferenceFailure('7', 'http_403', T0 + 14 * MINUTE)).toBeNull();
  });

  it('forgets failures older than the window', () => {
    expect(noteInferenceFailure('7', 'http_403', T0)).toBeNull();
    expect(noteInferenceFailure('8', 'http_403', T0 + PROVIDER_OUTAGE_WINDOW_MS + MINUTE)).toBeNull();
    expect(noteInferenceFailure('9', 'http_403', T0 + PROVIDER_OUTAGE_WINDOW_MS + 2 * MINUTE)).not.toBeNull();
  });
});

const refused = () => new Response(JSON.stringify({ error: { code: 'upstream_rejected', message: 'Forbidden' } }), { status: 502, headers: { 'content-type': 'application/json' } });

/** A second agent on its own kernel; the chain mock keys balances on KERNEL, so its kernel reads as KERNEL (fuelled). */
async function seedSecondAgent(w: TestWorld) {
  const now = w.ctx.now();
  const kernel = '0x2000000000000000000000000000000000000008';
  const token = '0x3000000000000000000000000000000000000008';
  const client = w.ctx.chain.publicClient as unknown as { readContract: (p: { functionName: string; args?: unknown[] }) => Promise<unknown> };
  const read = client.readContract.bind(client);
  client.readContract = (p) => read(p.functionName === 'balanceOf' && String(p.args?.[0]).toLowerCase() === kernel ? { ...p, args: [KERNEL, ...(p.args ?? []).slice(1)] } : p);
  const config = agentConfig(now, { agentId: '8', token: { address: token, symbol: 'TWO', name: 'Second Coin', chainId: 84532 }, kernel: { address: kernel }, xHandle: 'second_agent', xUserId: '2000' });
  await w.db.insert(agents).values({ agentId: '8', token, kernel, creator: '0x4000000000000000000000000000000000000004', config, permissionId: '0x11223344', sessionKeyInstalledAt: new Date(now), status: 'active' });
  await w.db.insert(runtimes).values({ agentId: '8', state: initialState() as unknown as Record<string, unknown>, cycle: 0, nextAt: new Date(now - 1000), status: 'waiting', configRevision: 1, lastDecisionAt: new Date(now - 60_000), lastDecisionRevision: 1 });
}

const rt = async (w: TestWorld, id: string) => (await w.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, id) }))!;
const stateOf = (r: { state: unknown }) => r.state as AgentState;

describe('provider hold (runtime)', () => {
  it('the second agent to hit the outage trips the hold; the next agent buys nothing and waits until it ends; one answer clears it', async () => {
    // Two refusals, then an answer for whoever asks next.
    const w = await makeWorld({ script: [refused(), refused(), finishResponse(Date.parse('2026-10-24T20:00:00Z'))] });
    try {
      await seedAgent(w);
      await seedSecondAgent(w);
      const start = w.ctx.now();
      const agent7 = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const agent8 = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!;

      // agent 7 fails on its own: its own backoff, no fleet hold yet
      expect((await processAgent(w.ctx, agent7, await rt(w, AGENT_ID)))?.turn?.outcome).toBe('inference_failed');
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(1);
      expect(providerHold(w.ctx.now())).toBeNull();
      expect(stateOf(await rt(w, AGENT_ID)).inferenceRetryAt).toBe(start + 2 * MINUTE);

      // agent 8 fails the same way: the hold trips, and its own wait is the hold (longer than its backoff)
      expect((await processAgent(w.ctx, agent8, await rt(w, '8')))?.turn?.outcome).toBe('inference_failed');
      const hold = providerHold(w.ctx.now());
      expect(hold).toMatchObject({ reason: 'provider_down', until: start + PROVIDER_HOLD_MS });
      expect(stateOf(await rt(w, '8')).inferenceRetryAt).toBe(start + PROVIDER_HOLD_MS);
      expect((await rt(w, '8')).failures).toBe(1);

      // agent 7's own backoff (set before the hold tripped) ends after two minutes: it wakes, and the runtime ends the
      // turn before buying a thought; from then on its own wait is the hold, so tick.ts does not wake it again
      w.setNow(start + 3 * MINUTE);
      const held = await processAgent(w.ctx, agent7, await rt(w, AGENT_ID));
      expect(held?.ran).toBe(true);
      expect(held?.turn?.outcome).toBe('provider_hold');
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(2);
      const after = await rt(w, AGENT_ID);
      expect(stateOf(after).inferenceRetryAt).toBe(start + PROVIDER_HOLD_MS);
      expect(after.nextAt.getTime()).toBe(start + PROVIDER_HOLD_MS);
      expect(after.failures).toBe(1); // not this agent's failure
      expect(after.lastError).toMatch(/^provider_down: the model provider is failing for every agent/);
      expect(after.turn).toBeNull();
      w.setNow(start + 6 * MINUTE);
      expect((await processAgent(w.ctx, agent7, await rt(w, AGENT_ID)))?.reasons).toEqual(['inference_backoff']);
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(2);

      // the hold ends: the first agent through gets an answer and the hold is cleared for everyone
      w.setNow(start + PROVIDER_HOLD_MS + 1000);
      expect((await processAgent(w.ctx, agent8, await rt(w, '8')))?.turn?.outcome).toBe('finished');
      expect(providerHold(w.ctx.now())).toBeNull();
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(3);
    } finally {
      await w.close();
    }
  });
});
