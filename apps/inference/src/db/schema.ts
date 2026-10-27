import {
  bigint,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * - `in_flight`: being processed.
 * - `succeeded`: paid and delivered; replays return the completion.
 * - `failed`: terminal for this key (nothing charged, or a spent credit that needs an operator refund).
 * - `unknown`: the settlement outcome is uncertain; the reconciler resolves it.
 * - `credit`: paid, but no completion was produced (upstream timeout/5xx/abort, or an interrupted
 *   relay). A retry with the same payer + Idempotency-Key + body is served without a new payment.
 */
export type RequestStatus = 'in_flight' | 'succeeded' | 'failed' | 'unknown' | 'credit';

/** A response as returned to the client, stored for idempotent replay. */
export interface StoredResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;
}

/** EIP-3009 `transferWithAuthorization` parameters signed by the payer (exact scheme). */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface PaymentRecord {
  scheme: string;
  network: string;
  asset: string;
  payTo: string;
  /** Authorized amount (atomic USDC == micro-USDC). */
  amount: string;
  payer?: string;
  authorization?: Eip3009Authorization;
  /** Unix seconds after which the authorization can no longer be settled by anyone. */
  expiresAt?: number;
  settlementAttempted: boolean;
  settled?: boolean;
  transaction?: string;
  settleError?: string;
}

/**
 * One row per (payer, Idempotency-Key): keys are namespaced by the paying address, so nobody can
 * occupy or read another payer's keys (M-1). `(payer, payment_nonce)` is unique, so one signed
 * authorization funds at most one request (M-2 / H-3b).
 */
export const inferenceRequests = pgTable(
  'inference_requests',
  {
    /** Lower-case payer address (EIP-3009 / Permit2 `from`). */
    payer: text('payer').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestId: text('request_id').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    status: text('status').$type<RequestStatus>().notNull(),
    statusReason: text('status_reason'),
    model: text('model').notNull(),
    quoteMicroUsdc: bigint('quote_micro_usdc', { mode: 'number' }).notNull(),
    chargedMicroUsdc: bigint('charged_micro_usdc', { mode: 'number' }),
    /** Authorization nonce (lower-case) of the payment that opened this row. */
    paymentNonce: text('payment_nonce').notNull(),
    /** sha256 of the signed payment payload: the proof a caller presents to read or replay the row. */
    proofHash: text('proof_hash').notNull(),
    /** Upstream calls made for this row (first call plus credit replays). */
    upstreamAttempts: integer('upstream_attempts').notNull().default(0),
    payment: jsonb('payment').$type<PaymentRecord>(),
    response: jsonb('response').$type<StoredResponse>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ name: 'inference_requests_payer_key_pk', columns: [t.payer, t.idempotencyKey] }),
    uniqueIndex('inference_requests_payer_nonce_idx').on(t.payer, t.paymentNonce),
    index('inference_requests_status_updated_idx').on(t.status, t.updatedAt),
  ],
);

export type InferenceRequest = typeof inferenceRequests.$inferSelect;
export type NewInferenceRequest = typeof inferenceRequests.$inferInsert;
