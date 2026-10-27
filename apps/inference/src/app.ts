import { randomUUID } from 'node:crypto';
import type { Network } from '@x402/core/types';
import { Hono, type Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { InferenceRequest, PaymentRecord, StoredResponse } from './db/schema.js';
import { actualChargeMicroUsdc, computeQuote, type PriceTable, type Usage } from './pricing.js';
import type { Reconciler } from './reconcile.js';
import {
  chatRequestSchema,
  hashRequest,
  IDEMPOTENCY_HEADER,
  idempotencyKeySchema,
  MAX_QUOTE_HEADER,
  maxQuoteSchema,
  RECEIPT_HEADER,
  type ChatRequest,
} from './request.js';
import type { RequestStore } from './store.js';
import type { UpstreamClient } from './upstream.js';
import { readEip3009Authorization, type PaymentGate, type VerifiedPayment } from './x402.js';

export const QUOTE_HEADER = 'x-bootr-quote-micro-usdc';
export const REPLAY_HEADER = 'x-bootr-idempotent-replay';

export interface Receipt {
  requestId: string;
  quoteMicroUsdc: string;
  chargedMicroUsdc: string | null;
  paymentTxOrId: string | null;
  network: string;
  usage: Record<string, unknown> | null;
}

export interface AppDeps {
  store: RequestStore;
  gate: PaymentGate;
  upstream: UpstreamClient;
  priceTable: PriceTable;
  network: Network;
  payTo: string;
  reconcile: Reconciler;
  /** x402 `maxTimeoutSeconds`, used to bound authorizations whose expiry we cannot read. */
  paymentTimeoutSeconds: number;
  now?: () => number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

function errorBody(code: string, message: string, extra: Record<string, unknown> = {}) {
  return { error: { code, message }, ...extra };
}

function respond(c: Context, status: number, body: unknown, headers: Record<string, string> = {}) {
  return c.json(body as object, status as ContentfulStatusCode, headers);
}

export function buildReceipt(row: InferenceRequest): Receipt {
  const p = row.payment;
  return {
    requestId: row.requestId,
    quoteMicroUsdc: String(row.quoteMicroUsdc),
    chargedMicroUsdc: row.chargedMicroUsdc === null ? null : String(row.chargedMicroUsdc),
    paymentTxOrId: p?.transaction || (p?.authorization ? `eip3009:${p.authorization.nonce}` : null),
    network: p?.network ?? '',
    usage: row.usage,
  };
}

/** Public view of a row for `GET /v1/requests/:key` (no completion body). */
export function requestView(row: InferenceRequest) {
  const p = row.payment;
  return {
    idempotencyKey: row.idempotencyKey,
    requestId: row.requestId,
    status: row.status,
    statusReason: row.statusReason,
    model: row.model,
    quoteMicroUsdc: String(row.quoteMicroUsdc),
    chargedMicroUsdc: row.chargedMicroUsdc === null ? null : String(row.chargedMicroUsdc),
    payment: p
      ? {
          scheme: p.scheme,
          network: p.network,
          asset: p.asset,
          payTo: p.payTo,
          amount: p.amount,
          payer: p.payer ?? null,
          authorization: p.authorization ?? null,
          expiresAt: p.expiresAt ?? null,
          settlementAttempted: p.settlementAttempted,
          settled: p.settled ?? false,
          transaction: p.transaction ?? null,
        }
      : null,
    usage: row.usage,
    /** True only when nothing was (or can still be) charged: a new key may be used to retry. */
    retrySafe: row.status === 'failed' && !(p?.settled ?? false),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export function createApp(deps: AppDeps): Hono {
  const app = new Hono();
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;

  app.get('/health', (c) => c.json({ ok: true, service: 'inference', network: deps.network }));

  app.get('/v1/models', (c) =>
    c.json({
      object: 'list',
      currency: 'USDC',
      unit: 'micro-USDC per 1K tokens',
      network: deps.network,
      payTo: deps.payTo,
      schemes: deps.gate.schemes,
      margin: {
        bps: deps.priceTable.marginBps,
        fixedMicroUsdc: deps.priceTable.marginFixedMicroUsdc,
      },
      data: Object.entries(deps.priceTable.models).map(([id, p]) => ({
        id,
        object: 'model',
        owned_by: id.split('/')[0],
        context_length: p.contextLength,
        max_output_tokens: p.maxOutputTokens,
        pricing: {
          input_micro_usdc_per_1k_tokens: p.inputMicroUsdcPerKTokens,
          output_micro_usdc_per_1k_tokens: p.outputMicroUsdcPerKTokens,
        },
      })),
    }),
  );

  app.get('/v1/requests/:key', async (c) => {
    const key = c.req.param('key');
    const row = await deps.store.get(key);
    if (!row)
      return respond(c, 404, errorBody('not_found', 'no request with this Idempotency-Key'));
    return c.json(requestView(await deps.reconcile(row)));
  });

  app.post('/v1/chat/completions', async (c) => {
    const keyParse = idempotencyKeySchema.safeParse(c.req.header(IDEMPOTENCY_HEADER));
    if (!keyParse.success) {
      return respond(
        c,
        400,
        errorBody('idempotency_key_required', 'a valid Idempotency-Key header is required'),
      );
    }
    const key = keyParse.data;

    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return respond(c, 400, errorBody('invalid_json', 'request body must be JSON'));
    }
    const parsed = chatRequestSchema.safeParse(raw);
    if (!parsed.success) {
      return respond(
        c,
        400,
        errorBody('invalid_request', 'request does not match the supported schema', {
          issues: parsed.error.issues,
        }),
      );
    }
    const req = parsed.data;
    const requestHash = hashRequest(req);

    // 1. Idempotency: a known key never triggers a new payment.
    const existing = await deps.store.get(key);
    if (existing) return handleExisting(c, existing, requestHash);

    // 2. Quote and the client's upper bound.
    const quoted = computeQuote(deps.priceTable, req);
    if (!quoted.ok) return respond(c, 400, { error: quoted.error });
    const quote = quoted.quote;
    const quoteHeaders = { [QUOTE_HEADER]: quote.quoteMicroUsdc.toString() };

    const maxParse = maxQuoteSchema.safeParse(c.req.header(MAX_QUOTE_HEADER));
    if (!maxParse.success) {
      return respond(
        c,
        400,
        errorBody('max_quote_required', `the ${MAX_QUOTE_HEADER} header (micro-USDC) is required`, {
          quoteMicroUsdc: quote.quoteMicroUsdc.toString(),
        }),
        quoteHeaders,
      );
    }
    const quoteDetails = {
      quoteMicroUsdc: quote.quoteMicroUsdc.toString(),
      model: quote.model,
      estimatedInputTokens: quote.estimatedInputTokens,
      maxOutputTokens: quote.maxOutputTokens,
    };
    if (quote.quoteMicroUsdc > maxParse.data) {
      // No PAYMENT-REQUIRED header: this is not payable as-is; the client decides to retry.
      return respond(
        c,
        402,
        errorBody(
          'quote_exceeds_max',
          'the quote exceeds X-Max-Quote-Micro-USDC; retry with a higher bound or a smaller request',
          {
            ...quoteDetails,
            maxQuoteMicroUsdc: maxParse.data.toString(),
          },
        ),
        quoteHeaders,
      );
    }

    // 3. x402: 402 with requirements for exactly `quote`, or a verified (unsettled) payment.
    let gate;
    try {
      gate = await deps.gate.process(
        c,
        quote.quoteMicroUsdc,
        errorBody('payment_required', 'pay the quote via x402', quoteDetails),
      );
    } catch (err) {
      log.error(`x402 verify failed: ${String(err)}`);
      return respond(
        c,
        502,
        errorBody(
          'facilitator_unavailable',
          'payment verification is unavailable; nothing was charged',
        ),
      );
    }
    if (gate.kind === 'respond') {
      const { status, headers, body } = gate.response;
      return respond(c, status, body ?? {}, { ...headers, ...quoteHeaders });
    }
    const payment = gate.payment;

    // 4. Claim the key. Losers of a race never settle their payment.
    const requestId = randomUUID();
    const paymentRecord = buildPaymentRecord(payment);
    const claimed = await deps.store.insertIfAbsent({
      idempotencyKey: key,
      requestId,
      requestHash,
      status: 'in_flight',
      model: req.model,
      quoteMicroUsdc: Number(quote.quoteMicroUsdc),
      payer: paymentRecord.payer ?? null,
      payment: paymentRecord,
    });
    if (!claimed) {
      const row = await deps.store.get(key);
      if (row) return handleExisting(c, row, requestHash);
      return respond(c, 409, errorBody('request_in_progress', 'retry later'));
    }

    try {
      return await executePaid(c, {
        key,
        requestId,
        req,
        quote: quote.quoteMicroUsdc,
        payment,
        paymentRecord,
      });
    } catch (err) {
      log.error(`request ${requestId} failed unexpectedly: ${String(err)}`);
      await deps.store
        .update(key, { status: 'unknown', statusReason: 'internal_error' }, 'in_flight')
        .catch(() => undefined);
      return respond(c, 502, unknownBody(requestId, key, 'internal_error'));
    }
  });

  function buildPaymentRecord(payment: VerifiedPayment): PaymentRecord {
    const authorization = readEip3009Authorization(payment.payload);
    const fallbackExpiry = Math.floor(now() / 1000) + payment.requirements.maxTimeoutSeconds;
    return {
      scheme: payment.requirements.scheme,
      network: payment.requirements.network,
      asset: payment.requirements.asset,
      payTo: payment.requirements.payTo,
      amount: payment.requirements.amount,
      ...(authorization ? { payer: authorization.from, authorization } : {}),
      expiresAt: authorization ? Number(authorization.validBefore) : fallbackExpiry,
      settlementAttempted: false,
    };
  }

  function unknownBody(requestId: string, key: string, reason: string) {
    return errorBody(
      'request_outcome_unknown',
      `outcome unknown (${reason}). Do not pay for a replacement; reconcile via GET /v1/requests/${encodeURIComponent(key)}`,
      { status: 'unknown', requestId },
    );
  }

  async function executePaid(
    c: Context,
    a: {
      key: string;
      requestId: string;
      req: ChatRequest;
      quote: bigint;
      payment: VerifiedPayment;
      paymentRecord: PaymentRecord;
    },
  ) {
    const upstream = await deps.upstream.complete(a.req, { requestId: a.requestId });

    if (upstream.kind === 'unknown') {
      await deps.store.update(
        a.key,
        { status: 'unknown', statusReason: upstream.reason },
        'in_flight',
      );
      return respond(c, 502, unknownBody(a.requestId, a.key, upstream.reason));
    }
    if (upstream.kind === 'rejected') {
      const status = upstream.status === 400 || upstream.status === 422 ? 422 : 502;
      const stored: StoredResponse = {
        status,
        headers: {},
        body: errorBody(
          'upstream_rejected',
          'the model provider rejected the request; nothing was charged',
          {
            requestId: a.requestId,
            upstreamStatus: upstream.status,
            upstream: upstream.body,
          },
        ),
      };
      await deps.store.update(
        a.key,
        {
          status: 'failed',
          statusReason: `upstream_rejected_${upstream.status}`,
          response: stored,
        },
        'in_flight',
      );
      return respond(c, stored.status, stored.body);
    }

    // Persist the completion and the intent to settle BEFORE settling, so a crash in between
    // leaves a row that reconciliation can resolve.
    const usage = upstream.usage ?? null;
    const attempted: PaymentRecord = { ...a.paymentRecord, settlementAttempted: true };
    await deps.store.update(
      a.key,
      { usage, payment: attempted, response: { status: 200, headers: {}, body: upstream.body } },
      'in_flight',
    );

    const charge =
      a.payment.requirements.scheme === 'upto'
        ? actualChargeMicroUsdc(
            deps.priceTable,
            a.req.model,
            upstream.usage as Usage | undefined,
            a.quote,
          )
        : a.quote;
    const settled = await deps.gate.settle(a.payment, charge);

    if (settled.kind === 'unknown') {
      log.warn(`request ${a.requestId}: settlement outcome unknown: ${settled.reason}`);
      await deps.store.update(
        a.key,
        { status: 'unknown', statusReason: `settlement_unknown: ${settled.reason}` },
        'in_flight',
      );
      return respond(c, 502, unknownBody(a.requestId, a.key, 'settlement_unknown'));
    }
    if (settled.kind === 'rejected') {
      const stored: StoredResponse = {
        status: 402,
        headers: settled.headers,
        body: errorBody(
          'settlement_failed',
          `payment settlement was refused (${settled.reason}); nothing was charged`,
          {
            requestId: a.requestId,
          },
        ),
      };
      await deps.store.update(
        a.key,
        {
          status: 'failed',
          statusReason: `settlement_rejected: ${settled.reason}`,
          payment: { ...attempted, settled: false, settleError: settled.reason },
          response: stored,
        },
        'in_flight',
      );
      return respond(c, stored.status, stored.body, stored.headers);
    }

    const row = await deps.store.update(
      a.key,
      {
        status: 'succeeded',
        statusReason: null,
        chargedMicroUsdc: Number(charge),
        payer: settled.result.payer ?? a.paymentRecord.payer ?? null,
        payment: {
          ...attempted,
          settled: true,
          transaction: settled.result.transaction,
          payer: settled.result.payer ?? attempted.payer,
        },
        response: { status: 200, headers: settled.headers, body: upstream.body },
      },
      'in_flight',
    );
    if (!row) throw new Error('row changed state during settlement');
    return respond(c, 200, upstream.body, {
      ...settled.headers,
      [RECEIPT_HEADER]: JSON.stringify(buildReceipt(row)),
    });
  }

  async function handleExisting(c: Context, row: InferenceRequest, requestHash: string) {
    if (row.requestHash !== requestHash) {
      return respond(
        c,
        409,
        errorBody(
          'idempotency_key_conflict',
          'this Idempotency-Key was already used with a different request body',
        ),
      );
    }
    const current = await deps.reconcile(row);
    const replay = { [REPLAY_HEADER]: 'true' };
    switch (current.status) {
      case 'succeeded': {
        const stored = current.response;
        if (!stored) throw new Error(`succeeded row ${current.requestId} has no response`);
        return respond(c, 200, stored.body, {
          ...stored.headers,
          ...replay,
          [RECEIPT_HEADER]: JSON.stringify(buildReceipt(current)),
        });
      }
      case 'failed': {
        const stored = current.response ?? {
          status: 502,
          headers: {},
          body: errorBody('request_failed', 'request failed'),
        };
        return respond(c, stored.status, stored.body, { ...stored.headers, ...replay });
      }
      case 'in_flight':
        return respond(
          c,
          409,
          errorBody('request_in_progress', 'this request is still being processed', {
            status: 'in_flight',
            requestId: current.requestId,
          }),
          replay,
        );
      case 'unknown':
        return respond(
          c,
          409,
          unknownBody(current.requestId, current.idempotencyKey, current.statusReason ?? 'unknown'),
          replay,
        );
    }
  }

  return app;
}
