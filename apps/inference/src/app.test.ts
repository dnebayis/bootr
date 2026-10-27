import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createX402Payer, readReceipt } from './client/x402-payer.js';
import { actualChargeMicroUsdc, computeQuote, DEFAULT_PRICE_TABLE } from './pricing.js';
import {
  BASE_SEPOLIA_USDC,
  chatBody,
  completionBody,
  createTestApp,
  jsonResponse,
  NETWORK,
  PAY_TO,
  TX_HASH,
  URL_BASE,
} from './test/helpers.js';

const CHAT_URL = `${URL_BASE}/v1/chat/completions`;

function quoteFor(body: ReturnType<typeof chatBody>) {
  const q = computeQuote(DEFAULT_PRICE_TABLE, body as Parameters<typeof computeQuote>[1]);
  if (!q.ok) throw new Error(q.error.code);
  return q.quote.quoteMicroUsdc;
}

function post(
  t: ReturnType<typeof createTestApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return t.app.request(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

function payerFor(t: ReturnType<typeof createTestApp>, onPayment = vi.fn()) {
  const account = privateKeyToAccount(generatePrivateKey());
  const payer = createX402Payer({
    signer: account,
    maxPaymentMicroUsdc: 1_000_000n,
    networks: [NETWORK],
    payTo: PAY_TO,
    fetch: t.appFetch,
  });
  return { account, onPayment, payer };
}

function paidPost(payer: ReturnType<typeof createX402Payer>, body: unknown, key: string) {
  return payer.fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

describe('public endpoints', () => {
  it('GET /health', async () => {
    const t = createTestApp();
    const res = await t.app.request(`${URL_BASE}/health`);
    expect(await res.json()).toEqual({ ok: true, service: 'inference', network: NETWORK });
  });

  it('GET /v1/models lists allowed models with prices', async () => {
    const t = createTestApp();
    const body = (await (await t.app.request(`${URL_BASE}/v1/models`)).json()) as {
      data: Array<{ id: string; pricing: Record<string, number> }>;
    };
    const sonnet = body.data.find((m) => m.id === 'anthropic/claude-sonnet-4.5');
    expect(sonnet?.pricing).toEqual({
      input_micro_usdc_per_1k_tokens: 3000,
      output_micro_usdc_per_1k_tokens: 15000,
    });
    expect(body.data.length).toBe(Object.keys(DEFAULT_PRICE_TABLE.models).length);
  });
});

describe('request validation and quoting', () => {
  it('requires Idempotency-Key and X-Max-Quote-Micro-USDC', async () => {
    const t = createTestApp();
    const noKey = await post(t, chatBody(), { 'x-max-quote-micro-usdc': '1000000' });
    expect(noKey.status).toBe(400);
    expect(await noKey.json()).toMatchObject({ error: { code: 'idempotency_key_required' } });
    const noMax = await post(t, chatBody(), { 'idempotency-key': 'k-1' });
    expect(noMax.status).toBe(400);
    expect(await noMax.json()).toMatchObject({ error: { code: 'max_quote_required' } });
  });

  it('rejects unsupported content and streaming', async () => {
    const t = createTestApp();
    const headers = { 'idempotency-key': 'k-2', 'x-max-quote-micro-usdc': '1000000' };
    expect((await post(t, chatBody({ stream: true }), headers)).status).toBe(400);
    expect((await post(t, chatBody({ model: 'unknown/model' }), headers)).status).toBe(400);
  });

  it('returns 402 with the quote (and no x402 requirements) when the quote exceeds the client max', async () => {
    const t = createTestApp();
    const body = chatBody();
    const quote = quoteFor(body);
    const res = await post(t, body, {
      'idempotency-key': 'k-3',
      'x-max-quote-micro-usdc': String(quote - 1n),
    });
    expect(res.status).toBe(402);
    expect(res.headers.get('payment-required')).toBeNull();
    expect(res.headers.get('x-bootr-quote-micro-usdc')).toBe(quote.toString());
    expect(await res.json()).toMatchObject({
      error: { code: 'quote_exceeds_max' },
      quoteMicroUsdc: quote.toString(),
    });
    expect(t.facilitator.verify).not.toHaveBeenCalled();
    expect(t.store.rows.size).toBe(0);
  });
});

describe('x402 middleware', () => {
  it('answers an unpaid request with PAYMENT-REQUIRED for exactly the quote', async () => {
    const t = createTestApp();
    const body = chatBody();
    const quote = quoteFor(body);
    const res = await post(t, body, {
      'idempotency-key': 'k-4',
      'x-max-quote-micro-usdc': '1000000',
    });
    expect(res.status).toBe(402);
    const required = decodePaymentRequiredHeader(res.headers.get('payment-required')!);
    expect(required.x402Version).toBe(2);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      scheme: 'exact',
      network: NETWORK,
      amount: quote.toString(),
      payTo: PAY_TO,
      asset: BASE_SEPOLIA_USDC,
      maxTimeoutSeconds: 300,
      extra: { name: 'USDC', version: '2' },
    });
    expect(await res.json()).toMatchObject({
      error: { code: 'payment_required' },
      quoteMicroUsdc: quote.toString(),
    });
    expect(t.facilitator.getSupported).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).not.toHaveBeenCalled();
    expect(t.store.rows.size).toBe(0);
  });

  it('rejects a payment signed for a different amount', async () => {
    const t = createTestApp();
    const body = chatBody();
    const first = await post(t, body, {
      'idempotency-key': 'k-5',
      'x-max-quote-micro-usdc': '1000000',
    });
    const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!);
    const tampered: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: { ...required.accepts[0]!, amount: '1' },
      payload: {},
    };
    const res = await post(t, body, {
      'idempotency-key': 'k-5',
      'x-max-quote-micro-usdc': '1000000',
      'payment-signature': encodePaymentSignatureHeader(tampered),
    });
    expect(res.status).toBe(402);
    expect(t.facilitator.verify).not.toHaveBeenCalled();
    expect(t.upstreamFetch).not.toHaveBeenCalled();
  });

  it('pays via the payer helper, forwards to OpenRouter, settles, and returns a receipt', async () => {
    const t = createTestApp();
    const { payer, account } = payerFor(t);
    const body = chatBody({
      tools: [
        { type: 'function', function: { name: 'get_price', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
      temperature: 0.2,
    });
    const quote = quoteFor(body);

    const res = await paidPost(payer, body, 'k-paid');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(completionBody());

    // facilitator verified a real EIP-3009 signature for exactly the quote, then settled once
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
    const [payload, requirements] = t.facilitator.verify.mock.calls[0]!;
    expect(requirements.amount).toBe(quote.toString());
    expect(
      (payload.payload as { authorization: { from: string; value: string } }).authorization,
    ).toMatchObject({
      from: account.address,
      value: quote.toString(),
    });
    await expect(t.facilitator.verify.mock.results[0]!.value).resolves.toMatchObject({
      isValid: true,
    });
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);

    // upstream got the OpenAI-compatible subset with the platform key
    expect(t.upstreamCalls).toHaveLength(1);
    const upstreamReq = t.upstreamCalls[0]!;
    expect(upstreamReq.url).toBe('https://openrouter.test/api/v1/chat/completions');
    expect(upstreamReq.headers.get('authorization')).toBe('Bearer test-openrouter-key');
    expect(await upstreamReq.json()).toMatchObject({
      model: body.model,
      messages: body.messages,
      tools: [
        { type: 'function', function: { name: 'get_price', parameters: { type: 'object' } } },
      ],
      tool_choice: 'auto',
      max_tokens: 256,
      temperature: 0.2,
      stream: false,
    });

    const receipt = readReceipt(res);
    expect(receipt).toMatchObject({
      quoteMicroUsdc: quote.toString(),
      chargedMicroUsdc: quote.toString(),
      paymentTxOrId: TX_HASH,
      network: NETWORK,
      usage: completionBody().usage,
    });
    expect(decodePaymentResponseHeader(res.headers.get('payment-response')!)).toMatchObject({
      success: true,
      transaction: TX_HASH,
    });
    expect(t.store.rows.get('k-paid')).toMatchObject({
      status: 'succeeded',
      payer: account.address,
    });
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key + body without a new payment', async () => {
    const t = createTestApp();
    const onPayment = vi.fn();
    const account = privateKeyToAccount(generatePrivateKey());
    const payer = createX402Payer({
      signer: account,
      maxPaymentMicroUsdc: 1_000_000n,
      networks: [NETWORK],
      fetch: t.appFetch,
      onPayment,
    });
    const body = chatBody();

    const first = await paidPost(payer, body, 'k-replay');
    const firstReceipt = readReceipt(first);
    const second = await paidPost(payer, body, 'k-replay');

    expect(second.status).toBe(200);
    expect(second.headers.get('x-bootr-idempotent-replay')).toBe('true');
    expect(await second.json()).toEqual(completionBody());
    expect(readReceipt(second)).toEqual(firstReceipt);
    expect(onPayment).toHaveBeenCalledTimes(1);
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('ignores a payment header on replay (never settles twice)', async () => {
    const t = createTestApp();
    const { payer } = payerFor(t);
    const body = chatBody();
    await paidPost(payer, body, 'k-replay-2');
    const res = await post(t, body, {
      'idempotency-key': 'k-replay-2',
      'payment-signature': 'garbage',
    });
    expect(res.status).toBe(200);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when the key is reused with a different body', async () => {
    const t = createTestApp();
    const { payer } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-conflict');
    const res = await post(t, chatBody({ messages: [{ role: 'user', content: 'different' }] }), {
      'idempotency-key': 'k-conflict',
      'x-max-quote-micro-usdc': '1000000',
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'idempotency_key_conflict' } });
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('returns 409 in_progress for a concurrent duplicate and settles only once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const t = createTestApp({
      upstreamFetch: async () => {
        await gate;
        return jsonResponse(completionBody());
      },
    });
    const { payer } = payerFor(t);
    const body = chatBody();
    const firstP = paidPost(payer, body, 'k-concurrent');
    await vi.waitFor(() => expect(t.store.rows.get('k-concurrent')?.status).toBe('in_flight'));
    const dup = await paidPost(payer, body, 'k-concurrent');
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: 'request_in_progress' } });
    release();
    expect((await firstP).status).toBe(200);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe('unknown outcomes and reconciliation', () => {
  it('keeps an uncertain upstream call as unknown, never re-charges, and resolves after expiry', async () => {
    const checker = { isUsed: vi.fn(async () => false) };
    const t = createTestApp({
      checker,
      upstreamFetch: async () => {
        throw new TypeError('socket hang up');
      },
    });
    const { payer } = payerFor(t);
    const body = chatBody();

    const res = await paidPost(payer, body, 'k-unknown');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: 'request_outcome_unknown' },
      status: 'unknown',
    });
    expect(t.facilitator.settle).not.toHaveBeenCalled();

    // a retry with the same key is refused without asking for a new payment
    const retry = await paidPost(payer, body, 'k-unknown');
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ error: { code: 'request_outcome_unknown' } });
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);

    // the supervisor reconciles by key
    const view = (await (await t.app.request(`${URL_BASE}/v1/requests/k-unknown`)).json()) as {
      payment: { authorization: { from: string; nonce: string } };
    };
    expect(view).toMatchObject({
      status: 'unknown',
      statusReason: 'upstream_network_error',
      retrySafe: false,
      payment: { scheme: 'exact', settlementAttempted: false, settled: false, transaction: null },
    });
    expect(view.payment.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/);

    // once the authorization expired unused, the request is definitively unpaid
    t.clock.now += 301_000;
    const resolved = await (await t.app.request(`${URL_BASE}/v1/requests/k-unknown`)).json();
    expect(resolved).toMatchObject({
      status: 'failed',
      statusReason: 'authorization_expired_unsettled',
      retrySafe: true,
    });
    expect(checker.isUsed).toHaveBeenCalledWith({
      asset: BASE_SEPOLIA_USDC,
      authorizer: view.payment.authorization.from,
      nonce: view.payment.authorization.nonce,
    });
  });

  it('settlement timeout -> unknown; on-chain evidence of payment releases the stored completion', async () => {
    const checker = { isUsed: vi.fn(async () => false) };
    const t = createTestApp({ checker });
    t.facilitator.settle.mockRejectedValueOnce(
      new Error('Facilitator settle request timed out after 60000ms'),
    );
    const { payer } = payerFor(t);
    const body = chatBody();

    const res = await paidPost(payer, body, 'k-settle-unknown');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'request_outcome_unknown' } });
    expect(t.store.rows.get('k-settle-unknown')).toMatchObject({
      status: 'unknown',
      payment: { settlementAttempted: true },
    });

    // still unknown while the nonce is unused and not expired
    expect(
      await (await t.app.request(`${URL_BASE}/v1/requests/k-settle-unknown`)).json(),
    ).toMatchObject({ status: 'unknown' });

    checker.isUsed.mockResolvedValue(true);
    const replay = await paidPost(payer, body, 'k-settle-unknown');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(completionBody());
    expect(readReceipt(replay)?.paymentTxOrId).toMatch(/^eip3009:0x[0-9a-f]{64}$/);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('without an RPC, a submitted-but-unconfirmed settlement stays unknown even after expiry', async () => {
    const t = createTestApp();
    t.facilitator.settle.mockRejectedValueOnce(new Error('fetch failed'));
    const { payer } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-no-rpc');
    t.clock.now += 3_600_000;
    const view = await (await t.app.request(`${URL_BASE}/v1/requests/k-no-rpc`)).json();
    expect(view).toMatchObject({ status: 'unknown', retrySafe: false });
  });

  it('treats a stale in_flight row (relay crash) as unknown', async () => {
    const t = createTestApp();
    const { payer } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-stale');
    t.store.rows.set('k-stale', {
      ...t.store.rows.get('k-stale')!,
      status: 'in_flight',
      updatedAt: new Date(t.clock.now),
    });
    t.clock.now += 400_000;
    const view = await (await t.app.request(`${URL_BASE}/v1/requests/k-stale`)).json();
    expect(view).toMatchObject({ status: 'unknown', statusReason: 'relay_interrupted' });
  });

  it('GET /v1/requests/:key returns 404 for unknown keys', async () => {
    const t = createTestApp();
    expect((await t.app.request(`${URL_BASE}/v1/requests/missing`)).status).toBe(404);
  });
});

describe('definitive failures (nothing charged)', () => {
  it('upstream 4xx -> failed, no settlement, replayed for the same key', async () => {
    const t = createTestApp({
      upstreamFetch: async () => jsonResponse({ error: { message: 'tools not supported' } }, 400),
    });
    const { payer } = payerFor(t);
    const res = await paidPost(payer, chatBody(), 'k-reject');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_rejected' },
      upstreamStatus: 400,
    });
    expect(t.facilitator.settle).not.toHaveBeenCalled();
    const replay = await paidPost(payer, chatBody(), 'k-reject');
    expect(replay.status).toBe(422);
    expect(replay.headers.get('x-bootr-idempotent-replay')).toBe('true');
    const view = await (await t.app.request(`${URL_BASE}/v1/requests/k-reject`)).json();
    expect(view).toMatchObject({ status: 'failed', retrySafe: true });
  });

  it('settlement refused -> 402 settlement_failed and the completion is withheld', async () => {
    const t = createTestApp();
    t.facilitator.settle.mockResolvedValueOnce({
      success: false,
      errorReason: 'insufficient_funds',
      transaction: '',
      network: NETWORK,
    });
    const { payer } = payerFor(t);
    const res = await paidPost(payer, chatBody(), 'k-settle-fail');
    expect(res.status).toBe(402);
    const json = await res.json();
    expect(json).toMatchObject({ error: { code: 'settlement_failed' } });
    expect(json).not.toHaveProperty('choices');
    expect(t.store.rows.get('k-settle-fail')).toMatchObject({ status: 'failed' });
  });
});

describe('upto scheme', () => {
  it('advertises upto and settles the actual usage cost (capped at the quote)', async () => {
    const t = createTestApp({ schemes: ['upto'] });
    const body = chatBody({ max_tokens: 4000 });
    const quote = quoteFor(body);
    const headers = { 'idempotency-key': 'k-upto', 'x-max-quote-micro-usdc': '1000000' };

    const first = await post(t, body, headers);
    const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!);
    expect(required.accepts[0]).toMatchObject({ scheme: 'upto', amount: quote.toString() });

    const payload: PaymentPayload = {
      x402Version: 2,
      resource: required.resource,
      accepted: required.accepts[0]!,
      payload: { stub: true },
    };
    const res = await post(t, body, {
      ...headers,
      'payment-signature': encodePaymentSignatureHeader(payload),
    });
    expect(res.status).toBe(200);

    const expected = actualChargeMicroUsdc(
      DEFAULT_PRICE_TABLE,
      body.model,
      completionBody().usage,
      quote,
    );
    expect(expected).toBeLessThan(quote);
    const [, settledRequirements] = t.facilitator.settle.mock.calls[0]!;
    expect(settledRequirements.amount).toBe(expected.toString());
    expect(readReceipt(res)).toMatchObject({
      quoteMicroUsdc: quote.toString(),
      chargedMicroUsdc: expected.toString(),
    });
  });
});
