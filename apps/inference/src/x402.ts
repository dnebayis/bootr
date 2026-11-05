import { createHash } from 'node:crypto';
import { createFacilitatorConfig } from '@coinbase/x402';
import { decodePaymentRequiredHeader, decodePaymentSignatureHeader } from '@x402/core/http';
import {
  HTTPFacilitatorClient,
  type FacilitatorClient,
  type HTTPRequestContext,
  type HTTPResponseInstructions,
  type RoutesConfig,
} from '@x402/core/server';
import {
  SettleError,
  type Network,
  type PaymentPayload,
  type PaymentRequirements,
  type SettleResponse,
} from '@x402/core/types';
import { ExactEvmScheme } from '@x402/evm/exact/server';
import { UptoEvmScheme } from '@x402/evm/upto/server';
import { HonoAdapter, x402HTTPResourceServer, x402ResourceServer } from '@x402/hono';
import type { Context } from 'hono';
import { boundedText } from './bounded.js';
import { FACILITATOR_TIMEOUT_MS, isCdpFacilitator } from './config.js';
import { microUsdcToDollarString } from './pricing.js';
import { stableStringify } from './request.js';

/**
 * x402 seller side, built on @x402/hono (adapter) + @x402/core (x402HTTPResourceServer).
 *
 * We drive `processHTTPRequest` / `settlePayment` ourselves instead of mounting the stock
 * `paymentMiddleware` because the relay must (a) price each request from its body, (b) skip
 * payment for idempotent replays, (c) persist the payment before settling, and (d) classify
 * settlement failures as definitive vs. unknown. The stock middleware settles after `next()`
 * and maps every facilitator error to a 402/502, which loses (c) and (d).
 */

export type PaymentScheme = 'exact' | 'upto';
export const CHAT_ROUTE = 'POST /v1/chat/completions';

export interface PaymentGateOptions {
  network: Network;
  payTo: string;
  schemes: PaymentScheme[];
  facilitator: FacilitatorClient;
  /** Lifetime of the signed authorization (EIP-3009 `validBefore = now + this`). */
  maxTimeoutSeconds: number;
}

/** Hono adapter carrying the per-request quote so the route's dynamic price can read it. */
class QuotedAdapter extends HonoAdapter {
  constructor(
    c: Context,
    readonly quoteMicroUsdc: bigint,
    readonly unpaidBody: unknown,
  ) {
    super(c);
  }
}

function quotedAdapter(ctx: HTTPRequestContext): QuotedAdapter {
  if (!(ctx.adapter instanceof QuotedAdapter)) {
    throw new Error('x402 route invoked without a quote');
  }
  return ctx.adapter;
}

export interface VerifiedPayment {
  payload: PaymentPayload;
  requirements: PaymentRequirements;
  extensions: Record<string, unknown> | undefined;
  context: HTTPRequestContext;
}

export type GateResult =
  | { kind: 'respond'; response: HTTPResponseInstructions }
  | { kind: 'verified'; payment: VerifiedPayment };

export type SettleOutcome =
  | { kind: 'settled'; result: SettleResponse; headers: Record<string, string> }
  /** The facilitator definitively refused; no funds moved. */
  | { kind: 'rejected'; reason: string; headers: Record<string, string> }
  /** We cannot tell whether funds moved (timeout, network error, 5xx, pending). */
  | { kind: 'unknown'; reason: string };

export interface PaymentGate {
  initialize(): Promise<void>;
  /** 402 instructions when unpaid/invalid, or the verified payment (not yet settled). */
  process(c: Context, quoteMicroUsdc: bigint, unpaidBody: unknown): Promise<GateResult>;
  settle(payment: VerifiedPayment, amountMicroUsdc: bigint): Promise<SettleOutcome>;
  readonly schemes: readonly PaymentScheme[];
}

export function createPaymentGate(opts: PaymentGateOptions): PaymentGate {
  const resourceServer = new x402ResourceServer(opts.facilitator);
  for (const scheme of opts.schemes) {
    resourceServer.register(
      opts.network,
      scheme === 'exact' ? new ExactEvmScheme() : new UptoEvmScheme(),
    );
  }

  const routes: RoutesConfig = {
    [CHAT_ROUTE]: {
      accepts: opts.schemes.map((scheme) => ({
        scheme,
        network: opts.network,
        payTo: opts.payTo,
        maxTimeoutSeconds: opts.maxTimeoutSeconds,
        price: (ctx: HTTPRequestContext) =>
          microUsdcToDollarString(quotedAdapter(ctx).quoteMicroUsdc),
      })),
      description: 'Bootr inference relay: one OpenAI-compatible chat completion',
      mimeType: 'application/json',
      unpaidResponseBody: (ctx) => ({
        contentType: 'application/json',
        body: quotedAdapter(ctx).unpaidBody,
      }),
    },
  };
  const httpServer = new x402HTTPResourceServer(resourceServer, routes);

  let init: Promise<void> | null = null;
  const initialize = () => {
    init ??= httpServer.initialize().catch((err: unknown) => {
      init = null;
      throw err;
    });
    return init;
  };

  return {
    schemes: opts.schemes,
    initialize,

    async process(c, quoteMicroUsdc, unpaidBody) {
      await initialize();
      const adapter = new QuotedAdapter(c, quoteMicroUsdc, unpaidBody);
      const context: HTTPRequestContext = {
        adapter,
        path: c.req.path,
        method: c.req.method,
        paymentHeader: adapter.getHeader('payment-signature') ?? adapter.getHeader('x-payment'),
      };
      const result = await httpServer.processHTTPRequest(context);
      switch (result.type) {
        case 'payment-error':
          return { kind: 'respond', response: result.response };
        case 'payment-verified': {
          // Defense in depth: the accepted requirement must be for exactly this quote.
          if (result.paymentRequirements.amount !== quoteMicroUsdc.toString()) {
            throw new Error('verified payment amount does not match the quote');
          }
          return {
            kind: 'verified',
            payment: {
              payload: result.paymentPayload,
              requirements: result.paymentRequirements,
              extensions: result.declaredExtensions,
              context,
            },
          };
        }
        case 'no-payment-required':
          // The relay must never serve without payment.
          throw new Error(`x402 route ${CHAT_ROUTE} did not require payment`);
      }
    },

    async settle(payment, amountMicroUsdc) {
      // `exact` always settles the authorized amount; `upto` may settle less (actual usage).
      const overrides =
        payment.requirements.scheme === 'upto' ? { amount: amountMicroUsdc.toString() } : undefined;
      try {
        const result = await resourceServer.settlePayment(
          payment.payload,
          payment.requirements,
          payment.extensions,
          { request: payment.context },
          overrides,
        );
        if (result.success) {
          return { kind: 'settled', result, headers: httpServer.createSettlementHeaders(result) };
        }
        const reason = result.errorReason ?? 'settlement_failed';
        if (isAmbiguousReason(reason)) return { kind: 'unknown', reason };
        return { kind: 'rejected', reason, headers: httpServer.createSettlementHeaders(result) };
      } catch (err) {
        if (err instanceof SettleError && err.statusCode >= 400 && err.statusCode < 500) {
          const reason = err.errorReason ?? err.message;
          if (!isAmbiguousReason(reason)) {
            return {
              kind: 'rejected',
              reason,
              headers: httpServer.createSettlementHeaders({
                success: false,
                errorReason: reason,
                transaction: err.transaction ?? '',
                network: payment.requirements.network,
              }),
            };
          }
        }
        return { kind: 'unknown', reason: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}

/**
 * Why the x402 library refused a presented payment. It answers such a 402 with an empty body and the reason inside
 * the PAYMENT-REQUIRED header; the relay repeats it in its error body so a client need not decode the header.
 */
export function refusedPaymentReason(headers: Record<string, string>): string {
  const header = headers['PAYMENT-REQUIRED'];
  if (!header) return 'payment_invalid';
  try {
    return boundedText(decodePaymentRequiredHeader(header).error ?? 'payment_invalid', 200);
  } catch {
    return 'payment_invalid';
  }
}

function isAmbiguousReason(reason: string): boolean {
  return /pending|timeout|timed out|unknown/i.test(reason);
}

export function createFacilitatorClient(
  url: string,
  cdp?: { keyId: string; keySecret: string },
): FacilitatorClient {
  if (isCdpFacilitator(url)) {
    if (!cdp) throw new Error('CDP facilitator requires CDP_API_KEY_ID / CDP_API_KEY_SECRET');
    const cfg = createFacilitatorConfig(cdp.keyId, cdp.keySecret);
    return new HTTPFacilitatorClient({ ...cfg, url, timeoutMs: FACILITATOR_TIMEOUT_MS });
  }
  return new HTTPFacilitatorClient({ url, timeoutMs: FACILITATOR_TIMEOUT_MS });
}

/** Extract the EIP-3009 authorization from an `exact` payload, if present. */
export function readEip3009Authorization(payload: PaymentPayload) {
  const auth = (payload.payload as { authorization?: Record<string, unknown> }).authorization;
  if (!auth) return undefined;
  const fields = ['from', 'to', 'value', 'validAfter', 'validBefore', 'nonce'] as const;
  if (!fields.every((f) => typeof auth[f] === 'string')) return undefined;
  return {
    from: auth.from as string,
    to: auth.to as string,
    value: auth.value as string,
    validAfter: auth.validAfter as string,
    validBefore: auth.validBefore as string,
    nonce: auth.nonce as string,
  };
}

/**
 * Who paid, with which authorization, and the proof hash of the signed payload. Works for EIP-3009
 * (`exact`) and Permit2 (`exact` fallback, `upto`) payloads. Null when the payload has no
 * recognisable payer.
 */
export interface PaymentIdentity {
  /** Lower-case payer address. */
  payer: string;
  /** Lower-case authorization nonce. */
  nonce: string;
  /** sha256 hex of the canonical signed payload (authorization + signature). */
  proofHash: string;
}

export function paymentIdentity(payload: PaymentPayload): PaymentIdentity | null {
  const inner = payload.payload as Record<string, unknown> | undefined;
  if (!inner || typeof inner !== 'object') return null;
  const auth = (inner.authorization ?? inner.permit2Authorization) as
    Record<string, unknown> | undefined;
  const from = typeof auth?.from === 'string' ? auth.from.toLowerCase() : '';
  const nonce =
    typeof auth?.nonce === 'string' || typeof auth?.nonce === 'number'
      ? String(auth.nonce).toLowerCase()
      : '';
  if (!/^0x[0-9a-f]{40}$/.test(from) || !nonce || nonce.length > 80) return null;
  const proofHash = createHash('sha256').update(stableStringify(inner)).digest('hex');
  return { payer: from, nonce, proofHash };
}

/**
 * The x402 payment a caller presented (`PAYMENT-SIGNATURE`, or the v1 `X-PAYMENT`), decoded but NOT
 * verified. Used as a possession proof for rows the caller opened: a stored row is only revealed or
 * replayed when the presented payload hashes to the row's `proofHash`.
 */
export function presentedPayment(
  header: (name: string) => string | undefined,
): { payload: PaymentPayload; identity: PaymentIdentity } | null {
  const raw = header('payment-signature') ?? header('x-payment');
  if (!raw || raw.length > 16_384) return null;
  try {
    const payload = decodePaymentSignatureHeader(raw);
    const identity = paymentIdentity(payload);
    return identity ? { payload, identity } : null;
  } catch {
    return null;
  }
}
