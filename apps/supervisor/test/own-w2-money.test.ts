/**
 * What fuel means for an own-agent coin (services.ts, treasury.ts `runFeePolicy`, fuel.ts; docs/design/byo-agent.md
 * sections 1.4 and 13.9): paid services are the only thing it pays for. With no fuel `x402_fetch` refuses before
 * anything is signed, with fuel a call pays once inside the creator's caps; the fee policy turns fees into fuel only
 * while the paid-services power is on; the `fuel` section carries no thought figure. A hosted coin is as it was in
 * every case here. The x402 stub is the one of services.test.ts; no model is called.
 */
import { DEFAULT_SERVICES_POLICY, parseAgentConfig, type AgentConfig } from '@bootr/agent-core';
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader } from '@x402/core/http';
import type { PaymentPayload, PaymentRequired } from '@x402/core/types';
import { eq } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { parseUnits } from 'viem';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import { inference as inferenceTable, serviceCalls, treasuryOps } from '../src/db/schema.js';
import { fuelSection, fuelView, OWN_FUEL_MEANING, ownFuelView } from '../src/fuel.js';
import { SERVICES_INSUFFICIENT_FUEL, servicesBudget, signedAmountOf } from '../src/services.js';
import { runFeePolicy } from '../src/treasury.js';
import { ADDR, AGENT_ID, agentConfig, makeWorld, seedAgent, SPENDER, type TestWorld } from './helpers.js';
import { forbidThoughts, ownConfig, setOwnFlag } from './own-w2-engine.js';

const SERVICE_PAYTO = '0x7777777777777777777777777777777777777777';
const SERVICE_TX = `0x${'ab'.repeat(32)}`;
const CAPS = { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: false };

const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, cycleKey: 'cycle:test', action: { tool, input }, status: 'sending', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof executeAction>[3];
const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map() });

/** The seeded agent's stored config: services on or off, hosted or own. */
function rawConfig(now: number, opts: { own: boolean; services: boolean; policy?: Partial<AgentConfig['services']> }): Record<string, unknown> {
  const raw = agentConfig(now, { capabilities: { ...CAPS, services: opts.services }, services: { ...DEFAULT_SERVICES_POLICY, ...opts.policy } });
  return opts.own ? ownConfig(raw) : raw;
}

function required(amount: string): PaymentRequired {
  return { x402Version: 2, resource: { url: 'https://data.example/price', description: 'a price', mimeType: 'application/json' }, accepts: [{ scheme: 'exact', network: 'eip155:84532', asset: ADDR.usdc, amount, payTo: SERVICE_PAYTO, maxTimeoutSeconds: 300, extra: { name: 'USDC', version: '2' } }] };
}

/** An x402 stub behind `ctx.fetch` (as in services.test.ts): 402 with `amount` until a payment arrives, then the answer and the settlement. */
function stubService(w: TestWorld, amount: string) {
  const stub: { calls: { url: string; signed: boolean }[]; payments: PaymentPayload[] } = { calls: [], payments: [] };
  const inner = w.ctx.fetch;
  w.ctx.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname !== 'data.example') return inner(input, init);
    const signature = req.headers.get('PAYMENT-SIGNATURE');
    stub.calls.push({ url: req.url, signed: !!signature });
    if (!signature) return new Response(JSON.stringify({ error: 'payment required' }), { status: 402, headers: { 'PAYMENT-REQUIRED': encodePaymentRequiredHeader(required(amount)), 'content-type': 'application/json' } });
    const payload = decodePaymentSignatureHeader(signature);
    stub.payments.push(payload);
    (w.state.spentNonces ??= new Set()).add((payload.payload as { authorization: { nonce: string } }).authorization.nonce.toLowerCase());
    return new Response(JSON.stringify({ price: 1.23 }), { status: 200, headers: { 'content-type': 'application/json', 'payment-response': Buffer.from(JSON.stringify({ success: true, transaction: SERVICE_TX, network: 'eip155:84532', payer: SPENDER })).toString('base64') } });
  }) as typeof fetch;
  return stub;
}

/** Counts every signature the agent's spender is asked for: the proof that nothing was signed. */
function watchSpender(w: TestWorld): { signatures: number } {
  const seen = { signatures: 0 };
  const inner = w.ctx.spenderFor;
  w.ctx.spenderFor = (agent) => {
    const account = inner(agent);
    return { ...account, signTypedData: async (typedData: never) => ((seen.signatures += 1), account.signTypedData(typedData)) } as ReturnType<typeof inner>;
  };
  return seen;
}

const rowOf = async (w: TestWorld, id: string) => (await w.db.query.serviceCalls.findFirst({ where: eq(serviceCalls.id, id) }))!;
const FETCH = { url: 'https://data.example/price', reason: 'the price' };

describe.each([{ flag: true }, { flag: false }])('paid services of an own coin with the flag $flag', ({ flag }) => {
  it('with no fuel x402_fetch refuses in the fixed words before anything is signed, and everything else works', async () => {
    const w = await makeWorld({ chain: { spenderUsdc: 0n, usdc: 0n } });
    try {
      setOwnFlag(w, flag);
      forbidThoughts(w);
      const raw = rawConfig(w.ctx.now(), { own: true, services: true });
      const agent = await seedAgent(w, { config: raw });
      const config = parseAgentConfig(raw);
      const stub = stubService(w, '5000');
      const spender = watchSpender(w);
      const out = await executeAction(w.ctx, agent, config, pending('act_no_fuel', 'x402_fetch', FETCH), env());
      expect(out).toEqual({ kind: 'failed', error: 'services_insufficient_fuel: your spendable fuel is below the price of this call' });
      expect(SERVICES_INSUFFICIENT_FUEL).toBe('services_insufficient_fuel: your spendable fuel is below the price of this call');
      // the price was asked for, nothing was signed and nothing was sent
      expect(stub.calls).toEqual([{ url: 'https://data.example/price', signed: false }]);
      expect(stub.payments).toHaveLength(0);
      expect(spender.signatures).toBe(0);
      expect(await rowOf(w, 'act_no_fuel')).toMatchObject({ status: 'failed', payment: null, quoteMicroUsdc: null, error: SERVICES_INSUFFICIENT_FUEL });
      // nothing counts against the day, and the same action asked again replays the refusal without a second request
      expect((await servicesBudget(w.ctx, AGENT_ID, DEFAULT_SERVICES_POLICY)).spentTodayMicroUsdc).toBe(0n);
      expect(await executeAction(w.ctx, agent, config, pending('act_no_fuel', 'x402_fetch', FETCH), env())).toEqual(out);
      expect(stub.calls).toHaveLength(1);
      // a little fuel, less than the price: still nothing signed
      w.state.spenderUsdc = 4_999n;
      expect(await executeAction(w.ctx, agent, config, pending('act_short', 'x402_fetch', FETCH), env())).toEqual(out);
      expect(spender.signatures).toBe(0);
      expect(stub.payments).toHaveLength(0);
      // every other tool works without fuel: a treasury read, a note
      expect(await executeAction(w.ctx, agent, config, pending('act_read', 'treasury_read', {}), env())).toMatchObject({ kind: 'completed' });
      expect(await executeAction(w.ctx, agent, config, pending('act_note', 'remember', { text: 'no fuel today' }), env())).toMatchObject({ kind: 'completed' });
      expect(await w.db.select().from(inferenceTable)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('with fuel a call pays once, inside the creator’s caps, and counts against the day', async () => {
    const w = await makeWorld({ chain: { spenderUsdc: 2_000_000n } });
    try {
      setOwnFlag(w, flag);
      forbidThoughts(w);
      const raw = rawConfig(w.ctx.now(), { own: true, services: true, policy: { perCallMicroUsdc: 10_000, dailyMicroUsdc: 12_000 } });
      const agent = await seedAgent(w, { config: raw });
      const config = parseAgentConfig(raw);
      const stub = stubService(w, '5000');
      const spender = watchSpender(w);
      const out = await executeAction(w.ctx, agent, config, pending('act_paid', 'x402_fetch', FETCH), env());
      expect(out).toMatchObject({ kind: 'completed', result: { status: 200, paidUsdc: '0.005', payTo: SERVICE_PAYTO, untrusted: true, instructionAuthority: false, settlement: 'confirmed on chain', budget: { perCallUsdc: '0.01', dailyUsdc: '0.012', spentTodayUsdc: '0.005', remainingTodayUsdc: '0.007' } }, receipt: { txHash: SERVICE_TX } });
      expect(spender.signatures).toBe(1);
      expect(stub.payments).toHaveLength(1);
      expect(stub.payments[0]!.accepted).toMatchObject({ scheme: 'exact', amount: '5000', payTo: SERVICE_PAYTO });
      // the same action again replays the stored answer: no second signature, no second payment
      expect(await executeAction(w.ctx, agent, config, pending('act_paid', 'x402_fetch', FETCH), env())).toMatchObject({ kind: 'completed', result: { paidUsdc: '0.005' } });
      expect(spender.signatures).toBe(1);
      // a second call fits the day; a third would pass the daily cap and is refused before any request
      expect(await executeAction(w.ctx, agent, config, pending('act_paid_2', 'x402_fetch', FETCH), env())).toMatchObject({ kind: 'completed' });
      const calls = stub.calls.length;
      const third = await executeAction(w.ctx, agent, config, pending('act_paid_3', 'x402_fetch', FETCH), env());
      expect(third).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^services_price_refused/) });
      expect(stub.payments).toHaveLength(2);
      expect(spender.signatures).toBe(2);
      // the day is used up to within what the third call was refused for
      const fourth = await executeAction(w.ctx, agent, config, pending('act_paid_4', 'x402_fetch', { ...FETCH, maxPriceMicroUsdc: 1_000_000 }), env());
      expect(fourth.kind).toBe('failed');
      expect(stub.payments).toHaveLength(2);
      expect(stub.calls.length).toBeGreaterThanOrEqual(calls);
      // a price above the per-call cap is never signed, whatever the client asks for
      const dear = stubService(w, '60000');
      expect(await executeAction(w.ctx, agent, parseAgentConfig(rawConfig(w.ctx.now(), { own: true, services: true })), pending('act_dear', 'x402_fetch', { ...FETCH, maxPriceMicroUsdc: 50_000_000 }), env())).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^services_price_refused/) });
      expect(dear.payments).toHaveLength(0);
      expect(await w.db.select().from(inferenceTable)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('with the power off the tool refuses, with or without fuel', async () => {
    const w = await makeWorld();
    try {
      setOwnFlag(w, flag);
      const raw = rawConfig(w.ctx.now(), { own: true, services: false });
      const agent = await seedAgent(w, { config: raw });
      const stub = stubService(w, '5000');
      const spender = watchSpender(w);
      expect(await executeAction(w.ctx, agent, parseAgentConfig(raw), pending('act_off', 'x402_fetch', FETCH), env())).toEqual({ kind: 'failed', error: 'services_power_off: paid services are switched off for this agent' });
      expect(stub.calls).toHaveLength(0);
      expect(spender.signatures).toBe(0);
    } finally {
      await w.close();
    }
  });
});

describe('a hosted coin’s paid services are as they were', () => {
  it('too little fuel is caught between the signature and the send, with the same words, and nothing leaves', async () => {
    const w = await makeWorld({ chain: { spenderUsdc: 100n } });
    try {
      const raw = rawConfig(w.ctx.now(), { own: false, services: true });
      const agent = await seedAgent(w, { config: raw });
      const stub = stubService(w, '5000');
      const spender = watchSpender(w);
      const out = await executeAction(w.ctx, agent, parseAgentConfig(raw), pending('act_poor', 'x402_fetch', FETCH), env());
      expect(out).toEqual({ kind: 'failed', error: SERVICES_INSUFFICIENT_FUEL });
      expect(stub.payments).toHaveLength(0);
      // the hosted path signs in memory and then checks: unchanged, and the reason an own coin is checked earlier
      expect(spender.signatures).toBe(1);
      expect(await rowOf(w, 'act_poor')).toMatchObject({ status: 'failed', payment: null });
    } finally {
      await w.close();
    }
  });
});

describe('signedAmountOf', () => {
  it('reads the amount of an EIP-3009 authorization or a Permit2 transfer, and nothing else', () => {
    const base = { domain: {}, types: {}, primaryType: 'TransferWithAuthorization' };
    expect(signedAmountOf({ ...base, message: { value: '5000' } })).toBe(5000n);
    expect(signedAmountOf({ ...base, message: { value: 5000n } })).toBe(5000n);
    expect(signedAmountOf({ ...base, message: { permitted: { amount: '70' } } })).toBe(70n);
    expect(signedAmountOf({ ...base, message: {} })).toBeNull();
    expect(signedAmountOf({ ...base, message: { value: 'a lot' } })).toBeNull();
    expect(signedAmountOf({ ...base, message: { value: { amount: 1 } } })).toBeNull();
  });
});

describe('the fee policy', () => {
  /** Fees to claim, WETH on the kernel, USDC under the fuel target and an empty spender: a hosted agent claims, swaps and tops up. */
  const chain = { claimableWeth: parseUnits('0.01', 18), usdc: 5_000_000n, weth: parseUnits('0.1', 18), spenderUsdc: 0n };
  const kinds = async (w: TestWorld) => (await w.db.select().from(treasuryOps)).map((o) => o.kind).sort();

  it('a hosted agent claims, swaps for fuel and tops the spender up, as before', async () => {
    const w = await makeWorld({ chain });
    try {
      const agent = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: false, services: false }) });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      expect(out.fund?.status).toBe('confirmed');
      expect(await kinds(w)).toEqual(['claim_fees', 'fund_model', 'swap']);
    } finally {
      await w.close();
    }
  });

  it.each([{ flag: true }, { flag: false }])('an own coin with paid services off keeps claiming and neither swaps nor tops up (flag $flag)', async ({ flag }) => {
    const w = await makeWorld({ chain });
    try {
      setOwnFlag(w, flag);
      const agent = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: true, services: false }) });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap).toBeUndefined();
      expect(out.fund).toBeUndefined();
      expect(out.skipped).toBeUndefined();
      expect(await kinds(w)).toEqual(['claim_fees']);
      // again, with nothing left to claim: nothing at all is prepared, however empty the spender
      w.state.claimableWeth = 0n;
      const again = await runFeePolicy(w.ctx, agent);
      expect(again).toEqual({});
      expect(await kinds(w)).toEqual(['claim_fees']);
      expect(w.kernel.submitted).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('an own coin with paid services on gets the swap and the top-up: its spender pays for the services', async () => {
    const w = await makeWorld({ chain });
    try {
      const agent = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: true, services: true }) });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      expect(out.fund?.status).toBe('confirmed');
      expect(await kinds(w)).toEqual(['claim_fees', 'fund_model', 'swap']);
    } finally {
      await w.close();
    }
  });

  it('a capabilities block that is missing or not what it should be counts as services off for an own coin', async () => {
    for (const capabilities of [undefined, null, 'yes', [], { services: 'true' }, { services: 1 }]) {
      const w = await makeWorld({ chain: { ...chain, claimableWeth: 0n } });
      try {
        const agent = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: true, services: false }) });
        const out = await runFeePolicy(w.ctx, { ...agent, config: { ...agent.config, capabilities: capabilities as never } });
        expect(out, JSON.stringify(capabilities)).toEqual({});
        expect(await kinds(w)).toEqual([]);
      } finally {
        await w.close();
      }
    }
  });

  it('gas is kept for an own coin whatever its powers: WETH is unwrapped when the kernel runs low, and that is where it stops', async () => {
    const low = { ...chain, claimableWeth: 0n, deposit: 10n ** 14n, eth: 0n };
    const hosted = await makeWorld({ chain: low });
    const own = await makeWorld({ chain: low });
    try {
      const h = await runFeePolicy(hosted.ctx, await seedAgent(hosted, { config: rawConfig(hosted.ctx.now(), { own: false, services: false }) }));
      expect(h.gas?.status).toBe('confirmed');
      expect(h.swap?.status).toBe('confirmed');
      expect(await kinds(hosted)).toEqual(['fund_gas', 'fund_model', 'swap']);
      const o = await runFeePolicy(own.ctx, await seedAgent(own, { config: rawConfig(own.ctx.now(), { own: true, services: false }) }));
      expect(o.gas?.status).toBe('confirmed');
      expect(o.swap).toBeUndefined();
      expect(o.fund).toBeUndefined();
      expect(await kinds(own)).toEqual(['fund_gas']);
      // the unwrap is the same operation for both
      const gasOp = async (w: TestWorld) => (await w.db.select().from(treasuryOps)).find((op) => op.kind === 'fund_gas')!.calls;
      expect(await gasOp(own)).toEqual(await gasOp(hosted));
    } finally {
      await hosted.close();
      await own.close();
    }
  });
});

describe('the fuel section', () => {
  const usd = { usdc: 12.5, spenderUsdc: 1.784, weth: 0, claimableWeth: 0 };
  const log = { warn: vi.fn() } as never;

  it('an own coin: the two balances and what they are for, no thought figure, no "low"', async () => {
    const w = await makeWorld();
    try {
      const own = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: true, services: true }) });
      // paid thoughts from its hosted days must not turn into an estimate
      for (let i = 0; i < 12; i++) await w.db.insert(inferenceTable).values({ idempotencyKey: `inference:${i}`, agentId: AGENT_ID, cycle: 1, requestHash: 'h', request: { model: 'm' }, status: 'succeeded', receipt: { relay: { chargedMicroUsdc: '90000' } }, createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      const expected = { fuel: { meaning: 'what you can spend on paid services; nothing else of yours costs fuel', spendableUsdc: '1.78', reserveUsdc: '12.50' } };
      // by the row (the treasury turn) and by the id alone (the social turn's call), with the flag on and off
      for (const flag of [true, false]) {
        setOwnFlag(w, flag);
        expect(await fuelSection(w.ctx, own, { usd })).toEqual(expected);
        expect(await fuelSection(w.ctx, AGENT_ID, { usd })).toEqual(expected);
      }
      expect(ownFuelView(usd)).toEqual(expected.fuel);
      expect(OWN_FUEL_MEANING).not.toMatch(/think|thought/);
      expect(await fuelSection(w.ctx, own, null)).toEqual({});
    } finally {
      await w.close();
    }
  });

  it('a hosted coin: the section it always had, by the row and by the id', async () => {
    const w = await makeWorld();
    try {
      const hosted = await seedAgent(w, { config: rawConfig(w.ctx.now(), { own: false, services: true }) });
      for (let i = 0; i < 12; i++) await w.db.insert(inferenceTable).values({ idempotencyKey: `inference:${i}`, agentId: AGENT_ID, cycle: 1, requestHash: 'h', request: { model: 'm' }, status: 'succeeded', receipt: { relay: { chargedMicroUsdc: '90000' } }, createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
      const expected = { fuel: fuelView(usd, { thoughts: 12, spentMicroUsdc: 1_080_000 }) };
      expect(expected.fuel).toMatchObject({ avgThoughtUsdc: '0.0900', thoughtsLeft: 19 });
      expect(expected.fuel).toHaveProperty('low');
      expect(await fuelSection(w.ctx, hosted, { usd })).toEqual(expected);
      expect(await fuelSection(w.ctx, AGENT_ID, { usd })).toEqual(expected);
      // an agent the table does not know is read as hosted, and a database that fails leaves the section out
      expect(await fuelSection(w.ctx, 'nobody', { usd })).toMatchObject({ fuel: { spendableUsdc: '1.78', low: false, meaning: expect.stringMatching(/thinking/) } });
      expect(await fuelSection({ db: { select: () => { throw new Error('db down'); } } as never, log }, AGENT_ID, { usd })).toEqual({});
    } finally {
      await w.close();
    }
  });
});
