import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from '@x402/core/http';
import type { PaymentPayload } from '@x402/core/types';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';
import { createX402Payer, paymentProofHeaders, readReceipt } from './client/x402-payer.js';
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
import { memoryRowKey } from './store.js';

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

function payerFor(t: ReturnType<typeof createTestApp>) {
  const account = privateKeyToAccount(generatePrivateKey());
  /** Payloads this payer signed, per Idempotency-Key (what the supervisor persists via onPayment). */
  const payments = new Map<string, PaymentPayload>();
  const onPayment = vi.fn(
    ({ payload, idempotencyKey }: { payload: PaymentPayload; idempotencyKey: string }) => {
      payments.set(idempotencyKey, payload);
    },
  );
  const payer = createX402Payer({
    signer: account,
    maxPaymentMicroUsdc: 1_000_000n,
    networks: [NETWORK],
    payTo: PAY_TO,
    fetch: t.appFetch,
    onPayment,
  });
  return { account, onPayment, payer, payments };
}

function paidPost(payer: ReturnType<typeof createX402Payer>, body: unknown, key: string) {
  return payer.fetch(CHAT_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
}

/** `GET /v1/requests/:key` presenting the payment that opened the request. */
async function getRequest(
  t: ReturnType<typeof createTestApp>,
  key: string,
  payload?: PaymentPayload,
) {
  const res = await t.app.request(`${URL_BASE}/v1/requests/${key}`, {
    headers: payload ? paymentProofHeaders(payload) : {},
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- loose JSON in assertions
  return { status: res.status, body: (await res.json()) as any };
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
    expect(t.store.byKey('k-paid')).toMatchObject({
      status: 'succeeded',
      payer: account.address.toLowerCase(),
      chargedMicroUsdc: Number(quote),
      upstreamAttempts: 1,
    });
    // H-3: the payment is collected before the paid upstream call.
    expect(t.facilitator.settle.mock.invocationCallOrder[0]!).toBeLessThan(
      t.upstreamFetch.mock.invocationCallOrder[0]!,
    );
  });
});

describe('image generation (modalities)', () => {
  const PNG = `data:image/png;base64,${Buffer.from('not really a png').toString('base64')}`;
  const imageBody = () =>
    completionBody({
      model: 'google/gemini-2.5-flash-image',
      choices: [
        {
          index: 0,
          finish_reason: 'stop',
          message: { role: 'assistant', content: 'Here is your fox.', images: [{ type: 'image_url', image_url: { url: PNG } }] },
        },
      ],
      usage: { prompt_tokens: 20, completion_tokens: 1300, completion_tokens_details: { image_tokens: 1290 } },
    });

  it('prices one image, forwards modalities, and returns the base64 image (also on replay)', async () => {
    const t = createTestApp({ upstreamFetch: async () => jsonResponse(imageBody()) });
    const { payer } = payerFor(t);
    const body = chatBody({ model: 'google/gemini-2.5-flash-image', modalities: ['image', 'text'], max_tokens: 64 });
    const textQuote = quoteFor(chatBody({ model: 'google/gemini-2.5-flash-image', max_tokens: 64 }));
    const quote = quoteFor(body);
    expect(quote).toBeGreaterThan(textQuote + 38_700n);

    const res = await paidPost(payer, body, 'k-image');
    expect(res.status).toBe(200);
    const json = (await res.json()) as { choices: { message: { images: unknown[] } }[] };
    expect(json.choices[0]!.message.images).toEqual([{ type: 'image_url', image_url: { url: PNG } }]);
    expect(t.facilitator.verify.mock.calls[0]![1].amount).toBe(quote.toString());
    expect(await t.upstreamCalls[0]!.json()).toMatchObject({ model: 'google/gemini-2.5-flash-image', modalities: ['image', 'text'], max_tokens: 64 });
    expect(readReceipt(res)).toMatchObject({ chargedMicroUsdc: quote.toString(), usage: imageBody().usage });

    const replay = await paidPost(payer, body, 'k-image');
    expect(replay.status).toBe(200);
    expect(replay.headers.get('x-bootr-idempotent-replay')).toBe('true');
    const replayed = (await replay.json()) as { choices: { message: { images: { image_url: { url: string } }[] } }[] };
    expect(replayed.choices[0]!.message.images[0]!.image_url.url).toBe(PNG);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses image output on a text model and lists image models with their modalities', async () => {
    const t = createTestApp();
    const res = await post(t, chatBody({ modalities: ['image', 'text'] }), { 'idempotency-key': 'k-img-text', 'x-max-quote-micro-usdc': '1000000' });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: 'image_output_not_supported' } });
    const models = (await (await t.app.request(`${URL_BASE}/v1/models`)).json()) as { data: { id: string; output_modalities: string[]; pricing: Record<string, number> }[] };
    const gemini = models.data.find((m) => m.id === 'google/gemini-2.5-flash-image');
    expect(gemini).toMatchObject({ output_modalities: ['text', 'image'], pricing: { image_output_micro_usdc_per_1k_tokens: 30_000, image_output_tokens_per_image: 1290 } });
    expect(models.data.find((m) => m.id === 'openai/gpt-4.1-mini')?.output_modalities).toEqual(['text']);
    // the advanced image models are listed the same way, with their per-image token allowance
    expect(models.data.find((m) => m.id === 'google/gemini-3-pro-image')).toMatchObject({ output_modalities: ['text', 'image'], pricing: { input_micro_usdc_per_1k_tokens: 2000, image_output_micro_usdc_per_1k_tokens: 120_000, image_output_tokens_per_image: 1120 } });
    expect(models.data.find((m) => m.id === 'google/gemini-3.1-flash-image')).toMatchObject({ output_modalities: ['text', 'image'], pricing: { image_output_micro_usdc_per_1k_tokens: 60_000, image_output_tokens_per_image: 1120 } });
    expect(models.data.find((m) => m.id === 'openai/gpt-5.4-image-2')).toMatchObject({ output_modalities: ['text', 'image'], pricing: { image_output_micro_usdc_per_1k_tokens: 30_000, image_output_tokens_per_image: 4160 } });
  });

  it('forwards a reference picture (image_url part) to an image model and refuses it on a text model', async () => {
    const t = createTestApp({ upstreamFetch: async () => jsonResponse({ ...imageBody(), model: 'google/gemini-3-pro-image' }) });
    const { payer } = payerFor(t);
    const messages = [
      { role: 'system', content: 'You are an illustrator.' },
      { role: 'user', content: [{ type: 'text', text: 'a fox, in the style of the reference' }, { type: 'image_url', image_url: { url: 'https://example.com/coin.png' } }] },
    ];
    const body = chatBody({ model: 'google/gemini-3-pro-image', messages, modalities: ['image', 'text'], max_tokens: 64 });
    const quote = quoteFor(body);
    expect(quote).toBeGreaterThan(134_400n);
    const res = await paidPost(payer, body, 'k-image-ref');
    expect(res.status).toBe(200);
    expect(await t.upstreamCalls[0]!.json()).toMatchObject({ model: 'google/gemini-3-pro-image', messages, modalities: ['image', 'text'] });

    const headers = { 'idempotency-key': 'k-image-ref-text', 'x-max-quote-micro-usdc': '1000000' };
    const refused = await post(t, chatBody({ messages }), headers);
    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ error: { code: 'image_input_not_supported' } });
    // only public https pictures: data URLs and http are not accepted at all
    const dataUrl = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: PNG } }] }];
    expect((await post(t, chatBody({ model: 'google/gemini-3-pro-image', messages: dataUrl }), headers)).status).toBe(400);
    const http = [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'http://example.com/coin.png' } }] }];
    expect((await post(t, chatBody({ model: 'google/gemini-3-pro-image', messages: http }), headers)).status).toBe(400);
  });
});

describe('idempotency', () => {
  it('replays the stored response for the same key + body without a new payment', async () => {
    const t = createTestApp();
    const { payer, onPayment } = payerFor(t);
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

  it('a stored result is only served to the payer that opened it (M-1 free replay)', async () => {
    const t = createTestApp();
    const { payer, payments } = payerFor(t);
    const body = chatBody();
    await paidPost(payer, body, 'k-replay-2');

    // Same key + body with no payment, or garbage: never served, just quoted.
    const variants: Record<string, string>[] = [{}, { 'payment-signature': 'garbage' }];
    for (const extra of variants) {
      const res = await post(t, body, {
        'idempotency-key': 'k-replay-2',
        'x-max-quote-micro-usdc': '1000000',
        ...extra,
      });
      expect(res.status).toBe(402);
      expect(await res.json()).not.toHaveProperty('choices');
    }

    // The original signed payment is the proof: replayed, never settled twice.
    const res = await post(t, body, {
      'idempotency-key': 'k-replay-2',
      ...paymentProofHeaders(payments.get('k-replay-2')!),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-bootr-idempotent-replay')).toBe('true');
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('a fresh authorization from the same payer for a used key replays without settling it', async () => {
    const t = createTestApp();
    const account = privateKeyToAccount(generatePrivateKey());
    const body = chatBody();
    // Same wallet, two payer instances (e.g. a restarted process that lost its payload).
    const p1 = createX402Payer({
      signer: account,
      maxPaymentMicroUsdc: 1_000_000n,
      networks: [NETWORK],
      fetch: t.appFetch,
    });
    const p2 = createX402Payer({
      signer: account,
      maxPaymentMicroUsdc: 1_000_000n,
      networks: [NETWORK],
      fetch: t.appFetch,
    });
    expect((await paidPost(p1, body, 'k-same-payer')).status).toBe(200);
    const again = await paidPost(p2, body, 'k-same-payer');
    expect(again.status).toBe(200);
    expect(again.headers.get('x-bootr-idempotent-replay')).toBe('true');
    expect(t.facilitator.verify).toHaveBeenCalledTimes(2);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('returns 409 when the payer reuses a key with a different body', async () => {
    const t = createTestApp();
    const { payer, payments } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-conflict');
    const res = await post(t, chatBody({ messages: [{ role: 'user', content: 'different' }] }), {
      'idempotency-key': 'k-conflict',
      'x-max-quote-micro-usdc': '1000000',
      ...paymentProofHeaders(payments.get('k-conflict')!),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ error: { code: 'idempotency_key_conflict' } });
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('keys are namespaced per payer: another wallet cannot squat or read a key (M-1)', async () => {
    const t = createTestApp();
    const victim = payerFor(t);
    const attacker = payerFor(t);
    const body = chatBody();
    // The attacker claims the victim's predictable next key first, with their own money.
    expect(
      (await paidPost(attacker.payer, chatBody({ max_tokens: 1 }), 'inference:predictable')).status,
    ).toBe(200);
    // The victim's request under the same key is unaffected.
    const res = await paidPost(victim.payer, body, 'inference:predictable');
    expect(res.status).toBe(200);
    expect(res.headers.get('x-bootr-idempotent-replay')).toBeNull();
    expect(t.facilitator.settle).toHaveBeenCalledTimes(2);

    // Metadata needs the payment proof; another payer's proof does not open the victim's row.
    expect((await getRequest(t, 'inference:predictable')).status).toBe(401);
    const own = await getRequest(
      t,
      'inference:predictable',
      victim.payments.get('inference:predictable'),
    );
    expect(own).toMatchObject({ status: 200, body: { status: 'succeeded' } });
    expect(own.body.payment.payer).toBe(victim.account.address.toLowerCase());
    const theirs = await getRequest(
      t,
      'inference:predictable',
      attacker.payments.get('inference:predictable'),
    );
    expect(theirs.body.payment.payer).toBe(attacker.account.address.toLowerCase());
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
    await vi.waitFor(() => expect(t.store.byKey('k-concurrent')?.status).toBe('in_flight'));
    await vi.waitFor(() => expect(t.upstreamFetch).toHaveBeenCalledTimes(1));
    const dup = await paidPost(payer, body, 'k-concurrent');
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ error: { code: 'request_in_progress' } });
    release();
    expect((await firstP).status).toBe(200);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe('one authorization funds one request (H-3b / M-2)', () => {
  it('replaying a signed authorization under other keys never reaches the upstream', async () => {
    const t = createTestApp();
    const { payer, payments } = payerFor(t);
    const body = chatBody();
    expect((await paidPost(payer, body, 'k-auth-0')).status).toBe(200);
    const proof = paymentProofHeaders(payments.get('k-auth-0')!);
    const replays = await Promise.all(
      [1, 2, 3, 4, 5].map((i) =>
        post(t, body, {
          'idempotency-key': `k-auth-${i}`,
          'x-max-quote-micro-usdc': '1000000',
          ...proof,
        }),
      ),
    );
    for (const r of replays) {
      expect(r.status).toBe(409);
      expect(await r.json()).toMatchObject({ error: { code: 'payment_authorization_reused' } });
    }
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('concurrent use of one authorization: exactly one request runs', async () => {
    let release!: () => void;
    const hold = new Promise<void>((r) => (release = r));
    const t = createTestApp({
      upstreamFetch: async () => {
        await hold;
        return jsonResponse(completionBody());
      },
    });
    const { payer, payments } = payerFor(t);
    const body = chatBody();
    const firstP = paidPost(payer, body, 'k-conc-0');
    await vi.waitFor(() => expect(payments.get('k-conc-0')).toBeDefined());
    const proof = paymentProofHeaders(payments.get('k-conc-0')!);
    const others = await Promise.all(
      [1, 2, 3].map((i) =>
        post(t, body, {
          'idempotency-key': `k-conc-${i}`,
          'x-max-quote-micro-usdc': '1000000',
          ...proof,
        }),
      ),
    );
    release();
    expect((await firstP).status).toBe(200);
    expect(others.map((r) => r.status)).toEqual([409, 409, 409]);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
  });
});

describe('settle first, credit on upstream failure (H-3)', () => {
  it('an upstream timeout after payment becomes a credit; the same key is served without a new payment', async () => {
    let fail = true;
    const t = createTestApp({
      upstreamFetch: async () => {
        if (fail)
          throw new DOMException('The operation was aborted due to timeout', 'TimeoutError');
        return jsonResponse(completionBody());
      },
    });
    const { payer, payments, onPayment } = payerFor(t);
    const body = chatBody();
    const quote = quoteFor(body);

    const res = await paidPost(payer, body, 'k-credit');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_failed_credited' },
      status: 'credit',
      credit: { microUsdc: quote.toString(), attemptsLeft: 2 },
    });
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1); // the upstream spend was paid for

    const view = await getRequest(t, 'k-credit', payments.get('k-credit'));
    expect(view.body).toMatchObject({
      status: 'credit',
      statusReason: 'upstream_timeout',
      chargedMicroUsdc: quote.toString(),
      credit: { microUsdc: quote.toString(), attemptsLeft: 2 },
      retrySafe: false,
      refundDue: false,
      payment: { settled: true, transaction: TX_HASH },
    });

    fail = false;
    const retry = await paidPost(payer, body, 'k-credit');
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual(completionBody());
    expect(readReceipt(retry)).toMatchObject({
      chargedMicroUsdc: quote.toString(),
      paymentTxOrId: TX_HASH,
    });
    expect(onPayment).toHaveBeenCalledTimes(1);
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(2);
    expect((await getRequest(t, 'k-credit', payments.get('k-credit'))).body).toMatchObject({
      status: 'succeeded',
      credit: null,
    });
  });

  it('a credit funds at most 3 upstream calls, then the request fails with a refund due', async () => {
    const t = createTestApp({
      upstreamFetch: async () => jsonResponse({ error: { message: 'overloaded' } }, 503),
    });
    const { payer, payments } = payerFor(t);
    const body = chatBody();
    expect((await paidPost(payer, body, 'k-exhaust')).status).toBe(502);
    expect((await paidPost(payer, body, 'k-exhaust')).status).toBe(502);
    const last = await paidPost(payer, body, 'k-exhaust');
    expect(await last.json()).toMatchObject({
      error: { code: 'credit_exhausted' },
      refundDue: true,
    });
    const after = await paidPost(payer, body, 'k-exhaust');
    expect(await after.json()).toMatchObject({ error: { code: 'credit_exhausted' } });
    expect(t.upstreamFetch).toHaveBeenCalledTimes(3);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect((await getRequest(t, 'k-exhaust', payments.get('k-exhaust'))).body).toMatchObject({
      status: 'failed',
      refundDue: true,
      retrySafe: false,
    });
  });

  it('an upstream 4xx after payment keeps the payment as a credit (never a free call)', async () => {
    const t = createTestApp({
      upstreamFetch: async () => jsonResponse({ error: { message: 'tools not supported' } }, 400),
    });
    const { payer, payments } = payerFor(t);
    const res = await paidPost(payer, chatBody(), 'k-reject');
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({
      error: { code: 'upstream_rejected' },
      upstreamStatus: 400,
      status: 'credit',
    });
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect((await getRequest(t, 'k-reject', payments.get('k-reject'))).body).toMatchObject({
      status: 'credit',
      statusReason: 'upstream_rejected_400',
    });
  });
});

describe('unknown outcomes and reconciliation', () => {
  it('settlement timeout -> unknown, no upstream call; on-chain evidence turns it into a credit', async () => {
    const checker = { isUsed: vi.fn(async () => false) };
    const t = createTestApp({ checker });
    t.facilitator.settle.mockRejectedValueOnce(
      new Error('Facilitator settle request timed out after 60000ms'),
    );
    const { payer, payments } = payerFor(t);
    const body = chatBody();

    const res = await paidPost(payer, body, 'k-settle-unknown');
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'request_outcome_unknown' } });
    expect(t.upstreamFetch).not.toHaveBeenCalled();
    expect(t.store.byKey('k-settle-unknown')).toMatchObject({
      status: 'unknown',
      payment: { settlementAttempted: true },
    });

    // still unknown while the nonce is unused and not expired; a retry is refused, never re-paid
    const proof = payments.get('k-settle-unknown');
    expect((await getRequest(t, 'k-settle-unknown', proof)).body).toMatchObject({
      status: 'unknown',
      retrySafe: false,
    });
    const early = await paidPost(payer, body, 'k-settle-unknown');
    expect(early.status).toBe(409);

    checker.isUsed.mockResolvedValue(true);
    expect((await getRequest(t, 'k-settle-unknown', proof)).body).toMatchObject({
      status: 'credit',
      statusReason: 'reconciled_onchain_paid',
    });
    const replay = await paidPost(payer, body, 'k-settle-unknown');
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(completionBody());
    expect(readReceipt(replay)?.paymentTxOrId).toMatch(/^eip3009:0x[0-9a-f]{64}$/);
    expect(t.facilitator.settle).toHaveBeenCalledTimes(1);
    expect(t.facilitator.verify).toHaveBeenCalledTimes(1);
    expect(t.upstreamFetch).toHaveBeenCalledTimes(1);
  });

  it('an unpaid authorization that expired becomes failed and retry-safe', async () => {
    const checker = { isUsed: vi.fn(async () => false) };
    const t = createTestApp({ checker });
    t.facilitator.settle.mockRejectedValueOnce(new Error('fetch failed'));
    const { payer, payments } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-expire');
    t.clock.now += 301_000;
    const view = await getRequest(t, 'k-expire', payments.get('k-expire'));
    expect(view.body).toMatchObject({
      status: 'failed',
      statusReason: 'authorization_expired_unsettled',
      retrySafe: true,
    });
    expect(checker.isUsed).toHaveBeenCalledWith({
      asset: BASE_SEPOLIA_USDC,
      authorizer: view.body.payment.authorization.from,
      nonce: view.body.payment.authorization.nonce,
    });
  });

  it('without an RPC, a submitted-but-unconfirmed settlement stays unknown even after expiry', async () => {
    const t = createTestApp();
    t.facilitator.settle.mockRejectedValueOnce(new Error('fetch failed'));
    const { payer, payments } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-no-rpc');
    t.clock.now += 3_600_000;
    const view = await getRequest(t, 'k-no-rpc', payments.get('k-no-rpc'));
    expect(view.body).toMatchObject({ status: 'unknown', retrySafe: false });
  });

  it('a stale in_flight row: paid -> credit; never submitted -> failed once expired', async () => {
    const t = createTestApp();
    const { payer, payments } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-stale');
    const paid = t.store.byKey('k-stale')!;
    t.store.rows.set(memoryRowKey(paid.payer, 'k-stale'), {
      ...paid,
      status: 'in_flight',
      updatedAt: new Date(t.clock.now),
    });
    await paidPost(payer, chatBody({ max_tokens: 9 }), 'k-stale-unpaid');
    const unpaid = t.store.byKey('k-stale-unpaid')!;
    t.store.rows.set(memoryRowKey(unpaid.payer, 'k-stale-unpaid'), {
      ...unpaid,
      status: 'in_flight',
      payment: { ...unpaid.payment!, settled: false, settlementAttempted: false },
      updatedAt: new Date(t.clock.now),
    });
    t.clock.now += 400_000;
    expect((await getRequest(t, 'k-stale', payments.get('k-stale'))).body).toMatchObject({
      status: 'credit',
      statusReason: 'relay_interrupted_after_payment',
    });
    // relay_interrupted -> unknown; the authorization was never submitted and has expired -> failed
    expect(
      (await getRequest(t, 'k-stale-unpaid', payments.get('k-stale-unpaid'))).body,
    ).toMatchObject({
      status: 'failed',
      statusReason: 'authorization_expired_unsettled',
      retrySafe: true,
    });
  });

  it('GET /v1/requests/:key needs a payment proof and 404s for unknown keys', async () => {
    const t = createTestApp();
    const { payer, payments } = payerFor(t);
    await paidPost(payer, chatBody(), 'k-known');
    expect((await getRequest(t, 'missing')).status).toBe(401);
    expect((await getRequest(t, 'missing', payments.get('k-known'))).status).toBe(404);
  });
});

describe('definitive failures (nothing charged)', () => {
  it('settlement refused -> 402 settlement_failed, no upstream call', async () => {
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
    expect(t.upstreamFetch).not.toHaveBeenCalled();
    expect(t.store.byKey('k-settle-fail')).toMatchObject({ status: 'failed' });
  });
});

describe('request limits (M-6)', () => {
  it('refuses bodies over 1 MB with 413 before parsing', async () => {
    const t = createTestApp();
    const res = await post(
      t,
      chatBody({ messages: [{ role: 'user', content: 'x'.repeat(1024 * 1024) }] }),
      {
        'idempotency-key': 'k-big',
        'x-max-quote-micro-usdc': '100000000',
      },
    );
    expect(res.status).toBe(413);
    expect(t.facilitator.verify).not.toHaveBeenCalled();
  });
});

describe('upto scheme', () => {
  const uptoPayload = (
    required: ReturnType<typeof decodePaymentRequiredHeader>,
    nonce: string,
  ): PaymentPayload => ({
    x402Version: 2,
    resource: required.resource,
    accepted: required.accepts[0]!,
    payload: {
      signature: '0x01',
      permit2Authorization: { from: '0x00000000000000000000000000000000000000Ab', nonce },
    },
  });

  it('advertises upto and settles the actual usage cost (capped at the quote)', async () => {
    const t = createTestApp({ schemes: ['upto'] });
    const body = chatBody({ max_tokens: 4000 });
    const quote = quoteFor(body);
    const headers = { 'idempotency-key': 'k-upto', 'x-max-quote-micro-usdc': '1000000' };

    const first = await post(t, body, headers);
    const required = decodePaymentRequiredHeader(first.headers.get('payment-required')!);
    expect(required.accepts[0]).toMatchObject({ scheme: 'upto', amount: quote.toString() });

    const res = await post(t, body, {
      ...headers,
      'payment-signature': encodePaymentSignatureHeader(uptoPayload(required, '7')),
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

  it('an unknown upstream outcome settles the full quote and keeps it as a credit', async () => {
    const t = createTestApp({
      schemes: ['upto'],
      upstreamFetch: async () => {
        throw new TypeError('socket hang up');
      },
    });
    const body = chatBody({ max_tokens: 4000 });
    const quote = quoteFor(body);
    const headers = { 'idempotency-key': 'k-upto-unknown', 'x-max-quote-micro-usdc': '1000000' };
    const required = decodePaymentRequiredHeader(
      (await post(t, body, headers)).headers.get('payment-required')!,
    );
    const res = await post(t, body, {
      ...headers,
      'payment-signature': encodePaymentSignatureHeader(uptoPayload(required, '8')),
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ status: 'credit' });
    const [, settledRequirements] = t.facilitator.settle.mock.calls[0]!;
    expect(settledRequirements.amount).toBe(quote.toString());
  });
});
