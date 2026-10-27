import { bigint, index, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';

export type RequestStatus = 'in_flight' | 'succeeded' | 'failed' | 'unknown';

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

export const inferenceRequests = pgTable(
  'inference_requests',
  {
    idempotencyKey: text('idempotency_key').primaryKey(),
    requestId: text('request_id').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    status: text('status').$type<RequestStatus>().notNull(),
    statusReason: text('status_reason'),
    model: text('model').notNull(),
    quoteMicroUsdc: bigint('quote_micro_usdc', { mode: 'number' }).notNull(),
    chargedMicroUsdc: bigint('charged_micro_usdc', { mode: 'number' }),
    payer: text('payer'),
    payment: jsonb('payment').$type<PaymentRecord>(),
    response: jsonb('response').$type<StoredResponse>(),
    usage: jsonb('usage').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('inference_requests_status_updated_idx').on(t.status, t.updatedAt)],
);

export type InferenceRequest = typeof inferenceRequests.$inferSelect;
export type NewInferenceRequest = typeof inferenceRequests.$inferInsert;
