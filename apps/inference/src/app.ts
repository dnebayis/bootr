import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Network } from '@x402/core/types';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
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
import {
  paymentIdentity,
  presentedPayment,
  readEip3009Authorization,
  type PaymentGate,
  type VerifiedPayment,
} from './x402.js';

export const QUOTE_HEADER = 'x-bootr-quote-micro-usdc';
export const REPLAY_HEADER = 'x-bootr-idempotent-replay';
/** Request bodies above this are refused with 413 before parsing (M-6). */
export const MAX_BODY_BYTES = 1024 * 1024;
/** Upstream calls one payment can fund: the first call plus credit replays (H-3). */
export const MAX_UPSTREAM_ATTEMPTS = 3;

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

/** View of a row for `GET /v1/requests/:key` (no completion body). Only shown to the payer. */
export function requestView(row: InferenceRequest) {
  const p = row.payment;
  const settled = p?.settled ?? false;
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
          settled,
          transaction: p.transaction ?? null,
        }
      : null,
    usage: row.usage,
    /**
     * Present while the row is a `credit`: the payment was collected but no completion exists yet.
     * Replay the POST with the same Idempotency-Key, body and PAYMENT-SIGNATURE (no new payment).
     */
    credit:
      row.status === 'credit'
        ? {
            microUsdc: String(row.chargedMicroUsdc ?? row.quoteMicroUsdc),
            attemptsLeft: Math.max(0, MAX_UPSTREAM_ATTEMPTS - row.upstreamAttempts),
          }
        : null,
    /** A paid request that ended without a completion: the operator owes a refund. */
    refundDue: row.status === 'failed' && settled,
    /** True only when nothing was (or can still be) charged: a new key may be used to retry. */
    retrySafe: row.status === 'failed' && !settled,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function sameProof(row: InferenceRequest, proofHash: string): boolean {
  const a = Buffer.from(row.proofHash, 'utf8');
  const b = Buffer.from(proofHash, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
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
        /** `['text', 'image']` for models that take `modalities: ["image", "text"]`. */
        output_modalities: p.imageOutputMicroUsdcPerKTokens ? ['text', 'image'] : ['text'],
        pricing: {
          input_micro_usdc_per_1k_tokens: p.inputMicroUsdcPerKTokens,
          output_micro_usdc_per_1k_tokens: p.outputMicroUsdcPerKTokens,
          ...(p.imageOutputMicroUsdcPerKTokens
            ? {
                image_output_micro_usdc_per_1k_tokens: p.imageOutputMicroUsdcPerKTokens,
                image_output_tokens_per_image: p.imageOutputTokensPerImage,
              }
            : {}),
        },
      })),
    }),
  );

  /**
   * GET /v1/requests/:key with `PAYMENT-SIGNATURE: <the payload that opened the request>`.
   * Keys are namespaced per payer, and a row is only shown to whoever presents the signed payment
   * that opened it (M-1). Anything else is a 404, so keys cannot be probed.
   */
  app.get('/v1/requests/:key', async (c) => {
    const key = c.req.param('key');
    const presented = presentedPayment((n) => c.req.header(n));
    if (!presented) {
      return respond(
        c,
        401,
        errorBody(
          'payment_proof_required',
          'send the PAYMENT-SIGNATURE header of the payment that opened this request',
        ),
      );
    }
    const row = await deps.store.get(presented.identity.payer, key);
    if (!row || !sameProof(row, presented.identity.proofHash))
      return respond(c, 404, errorBody('not_found', 'no request with this Idempotency-Key'));
    return c.json(requestView(await deps.reconcile(row)));
  });

  app.post(
    '/v1/chat/completions',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        respond(
          c,
          413,
          errorBody('payload_too_large', `request body exceeds ${MAX_BODY_BYTES} bytes`),
        ),
    }),
    async (c) => {
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

      // 1. Idempotent replay: only for the payer, proven by the payment that opened the row. A known
      //    key never triggers a new charge.
      const presented = presentedPayment((n) => c.req.header(n));
      if (presented) {
        const existing = await deps.store.get(presented.identity.payer, key);
        if (existing && sameProof(existing, presented.identity.proofHash)) {
          return handleExisting(c, existing, requestHash, req);
        }
      }

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
          errorBody(
            'max_quote_required',
            `the ${MAX_QUOTE_HEADER} header (micro-USDC) is required`,
            {
              quoteMicroUsdc: quote.quoteMicroUsdc.toString(),
            },
          ),
          quoteHeaders,
        );
      }
      const quoteDetails = {
        quoteMicroUsdc: quote.quoteMicroUsdc.toString(),
        model: quote.model,
        estimatedInputTokens: quote.estimatedInputTokens,
        maxOutputTokens: quote.maxOutputTokens,
        ...(quote.imageOutputTokens ? { imageOutputTokens: quote.imageOutputTokens } : {}),
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
      const identity = paymentIdentity(payment.payload);
      if (!identity) {
        return respond(
          c,
          400,
          errorBody(
            'unsupported_payment_payload',
            'the payment names no payer; nothing was charged',
          ),
        );
      }

      // The facilitator verified this payer's signature. A key the payer already used is replayed;
      // this second authorization is never settled.
      const known = await deps.store.get(identity.payer, key);
      if (known) return handleExisting(c, known, requestHash, req);

      // 4. Claim (payer, key). One authorization can open only one row (unique payer + nonce), so
      //    replaying a signed authorization under another key never reaches the upstream.
      const requestId = randomUUID();
      const paymentRecord = buildPaymentRecord(payment, identity.payer);
      const claimed = await deps.store.insertIfAbsent({
        payer: identity.payer,
        idempotencyKey: key,
        requestId,
        requestHash,
        status: 'in_flight',
        model: req.model,
        quoteMicroUsdc: Number(quote.quoteMicroUsdc),
        paymentNonce: identity.nonce,
        proofHash: identity.proofHash,
        payment: paymentRecord,
      });
      if (claimed === 'nonce_reused') {
        return respond(
          c,
          409,
          errorBody(
            'payment_authorization_reused',
            'this payment authorization already funded another request; sign a new one',
          ),
        );
      }
      if (claimed === 'key_exists') {
        const row = await deps.store.get(identity.payer, key);
        if (row) return handleExisting(c, row, requestHash, req);
        return respond(c, 409, errorBody('request_in_progress', 'retry later'));
      }

      const ref = { payer: identity.payer, key, requestId };
      return guarded(c, ref, () =>
        payment.requirements.scheme === 'upto'
          ? executeUpstreamFirst(c, {
              ...ref,
              req,
              quote: quote.quoteMicroUsdc,
              payment,
              paymentRecord,
            })
          : executeSettleFirst(c, {
              ...ref,
              req,
              quote: quote.quoteMicroUsdc,
              payment,
              paymentRecord,
            }),
      );
    },
  );

  function buildPaymentRecord(payment: VerifiedPayment, payer: string): PaymentRecord {
    const authorization = readEip3009Authorization(payment.payload);
    const fallbackExpiry = Math.floor(now() / 1000) + payment.requirements.maxTimeoutSeconds;
    return {
      scheme: payment.requirements.scheme,
      network: payment.requirements.network,
      asset: payment.requirements.asset,
      payTo: payment.requirements.payTo,
      amount: payment.requirements.amount,
      payer,
      ...(authorization ? { authorization } : {}),
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

  type RowRef = { payer: string; key: string; requestId: string };

  /** Unexpected errors: a paid row becomes a credit, an unpaid one `unknown`. */
  async function guarded(c: Context, ref: RowRef, fn: () => Promise<Response>): Promise<Response> {
    try {
      return await fn();
    } catch (err) {
      log.error(`request ${ref.requestId} failed unexpectedly: ${String(err)}`);
      const row = await deps.store.get(ref.payer, ref.key).catch(() => null);
      const paid = row?.payment?.settled === true;
      await deps.store
        .update(
          ref.payer,
          ref.key,
          paid
            ? { status: 'credit', statusReason: 'internal_error' }
            : { status: 'unknown', statusReason: 'internal_error' },
          'in_flight',
        )
        .catch(() => undefined);
      return respond(c, 502, unknownBody(ref.requestId, ref.key, 'internal_error'));
    }
  }

  interface PaidArgs extends RowRef {
    req: ChatRequest;
    quote: bigint;
    payment: VerifiedPayment;
    paymentRecord: PaymentRecord;
  }

  /** Records the settlement intent, settles, and classifies the outcome. */
  async function settle(a: PaidArgs, amount: bigint) {
    const attempted: PaymentRecord = { ...a.paymentRecord, settlementAttempted: true };
    await deps.store.update(a.payer, a.key, { payment: attempted }, 'in_flight');
    const outcome = await deps.gate.settle(a.payment, amount);
    return { outcome, attempted };
  }

  function settlementRejected(
    c: Context,
    a: PaidArgs,
    attempted: PaymentRecord,
    reason: string,
    headers: Record<string, string>,
  ) {
    const stored: StoredResponse = {
      status: 402,
      headers,
      body: errorBody(
        'settlement_failed',
        `payment settlement was refused (${reason}); nothing was charged`,
        { requestId: a.requestId },
      ),
    };
    return deps.store
      .update(
        a.payer,
        a.key,
        {
          status: 'failed',
          statusReason: `settlement_rejected: ${reason}`,
          payment: { ...attempted, settled: false, settleError: reason },
          response: stored,
        },
        'in_flight',
      )
      .then(() => respond(c, stored.status, stored.body, stored.headers));
  }

  /**
   * `exact` (H-3): collect the payment BEFORE calling the paid upstream. The quote is the charge. If
   * the upstream then fails, the payment stays as a credit for this payer + key.
   */
  async function executeSettleFirst(c: Context, a: PaidArgs) {
    const { outcome, attempted } = await settle(a, a.quote);
    if (outcome.kind === 'unknown') {
      log.warn(`request ${a.requestId}: settlement outcome unknown: ${outcome.reason}`);
      await deps.store.update(
        a.payer,
        a.key,
        { status: 'unknown', statusReason: `settlement_unknown: ${outcome.reason}` },
        'in_flight',
      );
      return respond(c, 502, unknownBody(a.requestId, a.key, 'settlement_unknown'));
    }
    if (outcome.kind === 'rejected') {
      return settlementRejected(c, a, attempted, outcome.reason, outcome.headers);
    }
    const row = await deps.store.update(
      a.payer,
      a.key,
      {
        chargedMicroUsdc: Number(a.quote),
        payment: {
          ...attempted,
          settled: true,
          transaction: outcome.result.transaction,
          payer: (outcome.result.payer ?? a.payer).toLowerCase(),
        },
      },
      'in_flight',
    );
    if (!row) throw new Error('row changed state during settlement');
    return runUpstream(c, row, a.req, outcome.headers);
  }

  /**
   * `upto`: the charge depends on actual usage, so the upstream runs first. When the upstream
   * outcome is unknown the provider may have billed, so the full quote is settled and kept as a
   * credit (never a free generation).
   */
  async function executeUpstreamFirst(c: Context, a: PaidArgs) {
    await deps.store.update(a.payer, a.key, { upstreamAttempts: 1 }, 'in_flight');
    const upstream = await deps.upstream.complete(a.req, { requestId: a.requestId });

    if (upstream.kind === 'rejected') {
      const status = upstream.status === 400 || upstream.status === 422 ? 422 : 502;
      const stored: StoredResponse = {
        status,
        headers: {},
        body: errorBody(
          'upstream_rejected',
          'the model provider rejected the request; nothing was charged',
          { requestId: a.requestId, upstreamStatus: upstream.status, upstream: upstream.body },
        ),
      };
      await deps.store.update(
        a.payer,
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

    if (upstream.kind === 'unknown') {
      const { outcome, attempted } = await settle(a, a.quote);
      if (outcome.kind === 'settled') {
        const row = await deps.store.update(
          a.payer,
          a.key,
          {
            chargedMicroUsdc: Number(a.quote),
            payment: { ...attempted, settled: true, transaction: outcome.result.transaction },
          },
          'in_flight',
        );
        if (!row) throw new Error('row changed state during settlement');
        return creditOrExhaust(c, row, upstream.reason, null);
      }
      if (outcome.kind === 'rejected') {
        return settlementRejected(c, a, attempted, outcome.reason, outcome.headers);
      }
      await deps.store.update(
        a.payer,
        a.key,
        {
          status: 'unknown',
          statusReason: `${upstream.reason}; settlement_unknown: ${outcome.reason}`,
        },
        'in_flight',
      );
      return respond(c, 502, unknownBody(a.requestId, a.key, upstream.reason));
    }

    // Persist the completion and the intent to settle BEFORE settling, so a crash in between
    // leaves a row that reconciliation can resolve.
    const usage = upstream.usage ?? null;
    await deps.store.update(
      a.payer,
      a.key,
      { usage, response: { status: 200, headers: {}, body: upstream.body } },
      'in_flight',
    );
    const charge = actualChargeMicroUsdc(
      deps.priceTable,
      a.req.model,
      upstream.usage as Usage | undefined,
      a.quote,
      a.req.modalities,
    );
    const { outcome, attempted } = await settle(a, charge);
    if (outcome.kind === 'unknown') {
      log.warn(`request ${a.requestId}: settlement outcome unknown: ${outcome.reason}`);
      await deps.store.update(
        a.payer,
        a.key,
        { status: 'unknown', statusReason: `settlement_unknown: ${outcome.reason}` },
        'in_flight',
      );
      return respond(c, 502, unknownBody(a.requestId, a.key, 'settlement_unknown'));
    }
    if (outcome.kind === 'rejected') {
      return settlementRejected(c, a, attempted, outcome.reason, outcome.headers);
    }
    const row = await deps.store.update(
      a.payer,
      a.key,
      {
        status: 'succeeded',
        statusReason: null,
        chargedMicroUsdc: Number(charge),
        payment: {
          ...attempted,
          settled: true,
          transaction: outcome.result.transaction,
          payer: (outcome.result.payer ?? a.payer).toLowerCase(),
        },
        response: { status: 200, headers: outcome.headers, body: upstream.body },
      },
      'in_flight',
    );
    if (!row) throw new Error('row changed state during settlement');
    return respond(c, 200, upstream.body, {
      ...outcome.headers,
      [RECEIPT_HEADER]: JSON.stringify(buildReceipt(row)),
    });
  }

  /** One upstream call for a paid `in_flight` row (first call, or a credit replay). */
  async function runUpstream(
    c: Context,
    row: InferenceRequest,
    req: ChatRequest,
    paymentHeaders: Record<string, string>,
  ) {
    const attempts = row.upstreamAttempts + 1;
    await deps.store.update(
      row.payer,
      row.idempotencyKey,
      { upstreamAttempts: attempts },
      'in_flight',
    );
    const upstream = await deps.upstream.complete(req, { requestId: row.requestId });
    if (upstream.kind === 'ok') {
      const done = await deps.store.update(
        row.payer,
        row.idempotencyKey,
        {
          status: 'succeeded',
          statusReason: null,
          usage: upstream.usage ?? null,
          response: { status: 200, headers: paymentHeaders, body: upstream.body },
        },
        'in_flight',
      );
      if (!done) throw new Error('row changed state during the upstream call');
      return respond(c, 200, upstream.body, {
        ...paymentHeaders,
        [RECEIPT_HEADER]: JSON.stringify(buildReceipt(done)),
      });
    }
    const reason =
      upstream.kind === 'unknown' ? upstream.reason : `upstream_rejected_${upstream.status}`;
    log.warn(`request ${row.requestId}: paid upstream call failed (${reason}); kept as credit`);
    return creditOrExhaust(
      c,
      { ...row, upstreamAttempts: attempts },
      reason,
      upstream.kind === 'rejected' ? upstream : null,
    );
  }

  /** After a paid upstream failure: keep the payment as a credit, or give up after the last attempt. */
  async function creditOrExhaust(
    c: Context,
    row: InferenceRequest,
    reason: string,
    rejected: { status: number; body: unknown } | null,
  ) {
    const charged = String(row.chargedMicroUsdc ?? row.quoteMicroUsdc);
    const attemptsLeft = Math.max(0, MAX_UPSTREAM_ATTEMPTS - row.upstreamAttempts);
    if (attemptsLeft === 0) {
      const stored: StoredResponse = {
        status: 502,
        headers: {},
        body: errorBody(
          'credit_exhausted',
          `the paid request failed upstream ${row.upstreamAttempts} times (${reason}); a refund of ${charged} micro-USDC is due`,
          {
            requestId: row.requestId,
            status: 'failed',
            refundDue: true,
            chargedMicroUsdc: charged,
          },
        ),
      };
      await deps.store.update(
        row.payer,
        row.idempotencyKey,
        { status: 'failed', statusReason: `credit_exhausted: ${reason}`, response: stored },
        'in_flight',
      );
      return respond(c, stored.status, stored.body);
    }
    const credit = { microUsdc: charged, attemptsLeft };
    const retry =
      'retry with the same Idempotency-Key, body and PAYMENT-SIGNATURE; no new payment is taken';
    const stored: StoredResponse = rejected
      ? {
          status: rejected.status === 400 || rejected.status === 422 ? 422 : 502,
          headers: {},
          body: errorBody(
            'upstream_rejected',
            `the model provider rejected the request; the payment is kept as a credit (${retry})`,
            {
              requestId: row.requestId,
              upstreamStatus: rejected.status,
              upstream: rejected.body,
              status: 'credit',
              credit,
            },
          ),
        }
      : {
          status: 502,
          headers: {},
          body: errorBody(
            'upstream_failed_credited',
            `the model provider did not answer (${reason}); the payment is kept as a credit (${retry})`,
            { requestId: row.requestId, status: 'credit', credit },
          ),
        };
    await deps.store.update(
      row.payer,
      row.idempotencyKey,
      { status: 'credit', statusReason: reason, response: stored },
      'in_flight',
    );
    return respond(c, stored.status, stored.body);
  }

  async function handleExisting(
    c: Context,
    row: InferenceRequest,
    requestHash: string,
    req: ChatRequest,
  ): Promise<Response> {
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
      case 'credit': {
        // Spend the credit: exactly one replay at a time (compare-and-set credit -> in_flight).
        const claimed = await deps.store.update(
          current.payer,
          current.idempotencyKey,
          { status: 'in_flight', statusReason: 'credit_replay' },
          'credit',
        );
        if (!claimed) {
          return respond(
            c,
            409,
            errorBody('request_in_progress', 'this request is still being processed', {
              status: 'in_flight',
              requestId: current.requestId,
            }),
          );
        }
        const ref = {
          payer: current.payer,
          key: current.idempotencyKey,
          requestId: current.requestId,
        };
        return guarded(c, ref, () => runUpstream(c, claimed, req, {}));
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
