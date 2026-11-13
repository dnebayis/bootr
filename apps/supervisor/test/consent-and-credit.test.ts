import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig } from '@bootr/agent-core';
import type { PaymentPayload } from '@x402/core/types';
import { paymentProofHeaders } from '@bootr/inference/client';
import { CONSENT_RETRY_MS, executeAction, type BrokerEnv } from '../src/broker/index.js';
import { inference as inferenceTable } from '../src/db/schema.js';
import { reconcileInference, storedPayment } from '../src/inference.js';
import { loadConfig } from '../src/config.js';
import { agentConfig, AGENT_ID, makeWorld, seedAgent, testConfig, toolCallResponse, type TestWorld } from './helpers.js';
import type { SenderInboxItem } from '../src/sender-client.js';

const mention = (postId: string, authorId: string, text: string): SenderInboxItem => ({
  postId,
  authorId,
  conversationId: postId,
  status: 'pending',
  observedAt: '2026-10-24T11:59:00Z',
  seenAt: null,
  deferredUntil: null,
  post: { id: postId, authorId, text, createdAt: '2026-10-24T11:58:00Z', conversationId: postId, author: { id: authorId, username: `user${authorId}`, verified: true, verifiedType: 'blue' } },
});

function env(): BrokerEnv {
  return { inbox: new Map(), eligibility: new Map() };
}

const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, action: { tool, input }, status: 'bound', boundAt: 0 }) as unknown as Parameters<typeof executeAction>[3];

describe('per-service keys (M-03)', () => {
  it('requires 32+ character sender, supervisor and indexer keys, all distinct', () => {
    expect(testConfig().INDEXER_SERVICE_KEY).toHaveLength(43);
    expect(() => testConfig({ SUPERVISOR_SERVICE_KEY: 'short' })).toThrow(/32 characters/);
    expect(() => testConfig({ SENDER_SERVICE_KEY: 'short' })).toThrow(/32 characters/);
    expect(() => testConfig({ INDEXER_SERVICE_KEY: '' })).toThrow(/INDEXER_SERVICE_KEY/);
    expect(() => testConfig({ SUPERVISOR_SERVICE_KEY: testConfig().SENDER_SERVICE_KEY })).toThrow(/must differ/);
    expect(() => testConfig({ SUPERVISOR_SERVICE_KEY: testConfig().INDEXER_SERVICE_KEY })).toThrow(/must differ/);
    // no fallback from the sender key
    const base = { DATABASE_URL: 'postgres://x', CHAIN_ID: '84532', BASE_SEPOLIA_RPC_URL: 'http://rpc.test', BUNDLER_URL: 'http://b.test', SESSION_SIGNER_PRIVATE_KEY: `0x${'11'.repeat(32)}`, SPENDER_MASTER_KEY: `0x${'22'.repeat(32)}`, BOOTR_LAUNCHER_ADDRESS: `0x${'10'.repeat(20)}`, BOOTR_GUARDIAN_ADDRESS: `0x${'10'.repeat(20)}`, SENDER_URL: 'http://s.test', SENDER_SERVICE_KEY: 'a'.repeat(40), INDEXER_SERVICE_KEY: 'b'.repeat(40), INFERENCE_PROVIDER_URL: 'http://i.test', INFERENCE_PAYTO_ADDRESS: `0x${'50'.repeat(20)}`, INDEXER_URL: 'http://idx.test' };
    expect(() => loadConfig(base)).toThrow(/SUPERVISOR_SERVICE_KEY/);
  });
});

describe('reply consent (sender contract)', () => {
  async function world(): Promise<{ w: TestWorld; config: ReturnType<typeof parseAgentConfig>; agent: Awaited<ReturnType<typeof seedAgent>> }> {
    const w = await makeWorld();
    const agent = await seedAgent(w);
    return { w, config: parseAgentConfig(agentConfig(w.ctx.now())), agent };
  }

  it('read_mentions records the eligibility decision and publish_reply sends it with the reply', async () => {
    const { w, config, agent } = await world();
    try {
      w.sender.items = [mention('1001', '42', '@bootr_agent what is your plan?'), mention('1002', '1000', 'talking to myself')]; // 1000 = own user id
      const e = env();
      const read = await executeAction(w.ctx, agent, config, pending('a1', 'read_mentions', {}), e);
      expect(read.kind).toBe('completed');
      expect(e.eligibility.get('1001')).toEqual({ eligible: true });
      expect(e.eligibility.get('1002')?.eligible).toBe(false);
      const reply = await executeAction(w.ctx, agent, config, pending('a2', 'publish_reply', { postId: '1001', text: 'Here is the plan.' }), e);
      expect(reply.kind).toBe('completed');
      const sent = w.sender.published[0] as { replyTo: string; replyAuthorId: string; replyEligibility: { eligible: boolean } };
      expect(sent.replyTo).toBe('1001');
      expect(sent.replyAuthorId).toBe('42');
      expect(sent.replyEligibility).toEqual({ eligible: true });
      // an ineligible mention is sent with its reason and the sender rejects it
      const own = await executeAction(w.ctx, agent, config, pending('a3', 'publish_reply', { postId: '1002', text: 'hi me' }), e);
      expect(own.kind).toBe('failed');
      expect((own as { error: string }).error).toMatch(/sender_rejected:policy:reply_not_eligible:/);
      expect((w.sender.published[1] as { replyEligibility: { eligible: boolean; reason?: string } }).replyEligibility.eligible).toBe(false);
      // a post the turn never observed is sent as not eligible (the sender decides, never the model)
      const unseen = await executeAction(w.ctx, agent, config, pending('a4', 'publish_reply', { postId: '9999', text: 'who?' }), e);
      expect(unseen.kind).toBe('failed');
      expect((w.sender.published[2] as { replyEligibility: unknown }).replyEligibility).toEqual({ eligible: false, reason: 'not_in_inbox' });
    } finally {
      await w.close();
    }
  });

  it('opted-out mentions are rejected by the sender and a consent lookup failure is retried, never failed for good', async () => {
    const { w, config, agent } = await world();
    try {
      w.sender.items = [mention('1001', '42', '@bootr_agent hello')];
      const e = env();
      await executeAction(w.ctx, agent, config, pending('a1', 'read_mentions', {}), e);
      // somebody who wrote to the agent once (so a reply may name them) and later asked not to be named: the sender refuses
      w.sender.accountReads.quietperson = { user: { id: '77', username: 'quietperson' }, activity: 'recent', latestPostAt: null, addressedAt: new Date(w.ctx.now() - 3_600_000).toISOString() } as never;
      w.sender.optedOutHandles.add('quietperson');
      const out = await executeAction(w.ctx, agent, config, pending('a2', 'publish_reply', { postId: '1001', text: 'cc @quietperson' }), e);
      expect(out).toEqual({ kind: 'failed', error: 'sender_rejected:policy:mention_opted_out' });
      // X unreachable for the consent check: nothing sent, retry later with the sender's retryAt
      w.sender.consentLookupFails = '2026-10-24T12:10:00Z';
      const transient = await executeAction(w.ctx, agent, config, pending('a3', 'publish_reply', { postId: '1001', text: 'still here' }), e);
      expect(transient).toEqual({ kind: 'failed', error: 'sender:consent_lookup_failed', retryAt: Date.parse('2026-10-24T12:10:00Z') });
      expect(w.sender.published).toHaveLength(1);
      expect(CONSENT_RETRY_MS).toBe(300_000);
    } finally {
      await w.close();
    }
  });
});

describe('inference reconciliation with payment proof (relay contract)', () => {
  const payment = { x402Version: 2, scheme: 'exact', network: 'eip155:84532', payload: { signature: '0xsig', authorization: { from: '0xk', to: '0xp', value: '1000', validAfter: '0', validBefore: '9', nonce: '0xn' } } } as unknown as PaymentPayload;

  async function seed(w: TestWorld, receipt: Record<string, unknown> | null, status: 'unknown' | 'pending' = 'unknown') {
    await seedAgent(w);
    const key = 'inference:7:3';
    await w.db.insert(inferenceTable).values({ idempotencyKey: key, agentId: AGENT_ID, cycle: 3, requestHash: '0x00', request: { model: 'm', messages: [] }, status, receipt, createdAt: new Date(w.ctx.now()), updatedAt: new Date(w.ctx.now()) });
    return key;
  }

  it('sends PAYMENT-SIGNATURE on the status read and replays a credit without a new payment', async () => {
    const w = await makeWorld({ script: [toolCallResponse('finish', { memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-10-24T13:00:00Z' })] });
    try {
      const key = await seed(w, { payment });
      expect(storedPayment({ receipt: { payment } })).toEqual(payment);
      w.inference.state.requests = { status: 'credit', credit: { microUsdc: '1000', attemptsLeft: 1 }, refundDue: false };
      const res = await reconcileInference(w.ctx, key);
      expect(res.kind).toBe('ok');
      // jsonb storage reorders keys, so compare the decoded proof, not the base64 string
      const decode = (h: string | null) => JSON.parse(Buffer.from(h ?? '', 'base64').toString('utf8')) as unknown;
      const proof = decode(paymentProofHeaders(payment)['PAYMENT-SIGNATURE']!);
      const [status, replay] = w.inference.calls;
      expect(status!.url).toContain('/v1/requests/inference%3A7%3A3');
      expect(decode(status!.headers.get('PAYMENT-SIGNATURE'))).toEqual(proof);
      expect(replay!.url).toContain('/v1/chat/completions');
      expect(decode(replay!.headers.get('PAYMENT-SIGNATURE'))).toEqual(proof);
      expect(replay!.headers.get('Idempotency-Key')).toBe(key);
      expect(replay!.headers.get('X-Max-Quote-Micro-USDC')).toBe('0');
      const row = await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) });
      expect(row?.status).toBe('succeeded');
      expect((row?.receipt as { payment: unknown }).payment).toEqual(payment);
    } finally {
      await w.close();
    }
  });

  it('a succeeded row is replayed with the proof; failed rows are final and refundDue is flagged', async () => {
    const w = await makeWorld({ script: [toolCallResponse('finish', { memory: 'm', agenda: 'a', summary: 's', nextAt: '2026-10-24T13:00:00Z' })] });
    try {
      const key = await seed(w, { payment });
      w.inference.state.requests = { status: 'succeeded' };
      expect((await reconcileInference(w.ctx, key)).kind).toBe('ok');
      expect(JSON.parse(Buffer.from(w.inference.calls[1]!.headers.get('PAYMENT-SIGNATURE') ?? '', 'base64').toString('utf8'))).toEqual(JSON.parse(Buffer.from(paymentProofHeaders(payment)['PAYMENT-SIGNATURE']!, 'base64').toString('utf8')));
    } finally {
      await w.close();
    }
    const w2 = await makeWorld();
    try {
      const key = await seed(w2, { payment });
      w2.inference.state.requests = { status: 'failed', refundDue: true, retrySafe: false, statusReason: 'credit_exhausted: upstream_timeout' };
      expect(await reconcileInference(w2.ctx, key)).toEqual({ kind: 'failed', key, error: 'relay_failed_refund_due' });
      expect((await w2.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))?.error).toBe('relay_failed_refund_due');
      // still unknown at the relay: stays unknown, no replay
      const key2 = 'inference:7:4';
      await w2.db.insert(inferenceTable).values({ idempotencyKey: key2, agentId: AGENT_ID, cycle: 4, requestHash: '0x00', request: {}, status: 'unknown', receipt: { payment }, createdAt: new Date(), updatedAt: new Date() });
      w2.inference.state.requests = { status: 'in_flight' };
      expect((await reconcileInference(w2.ctx, key2)).kind).toBe('unknown');
      expect(w2.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      // the relay demands the proof: a read without it would be a 401, which we never send (every read carries it)
      w2.inference.state.requests = (headers) => new Response(JSON.stringify({ error: headers.get('PAYMENT-SIGNATURE') ? { code: 'ok' } : { code: 'payment_proof_required' } }), { status: headers.get('PAYMENT-SIGNATURE') ? 200 : 401 });
      expect((await reconcileInference(w2.ctx, key2)).kind).toBe('unknown');
      expect(w2.inference.calls.at(-1)!.headers.get('PAYMENT-SIGNATURE')).toBeTruthy();
    } finally {
      await w2.close();
    }
  });

  it('a row that never signed a payment is failed without touching the relay', async () => {
    const w = await makeWorld();
    try {
      const key = await seed(w, null, 'pending');
      expect(await reconcileInference(w.ctx, key)).toEqual({ kind: 'failed', key, error: 'no_payment_signed' });
      expect(w.inference.calls).toHaveLength(0);
      expect((await w.db.query.inference.findFirst({ where: eq(inferenceTable.idempotencyKey, key) }))?.status).toBe('failed');
    } finally {
      await w.close();
    }
  });
});
