import { and, eq } from 'drizzle-orm';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import {
  inferenceRequests,
  type InferenceRequest,
  type NewInferenceRequest,
  type RequestStatus,
} from './db/schema.js';

export type RequestPatch = Partial<
  Pick<
    InferenceRequest,
    | 'status'
    | 'statusReason'
    | 'chargedMicroUsdc'
    | 'payment'
    | 'response'
    | 'usage'
    | 'upstreamAttempts'
  >
>;

/** Outcome of a claim: the row was created, the payer already used the key, or the authorization was. */
export type ClaimResult = 'inserted' | 'key_exists' | 'nonce_reused';

/**
 * Persistence for idempotency keys and receipts. Rows are addressed by (payer, Idempotency-Key).
 * `insertIfAbsent` is the claim: exactly one concurrent request per key wins, and one payment
 * authorization (payer, nonce) can open only one row. `update` with `expectStatus` is a
 * compare-and-set.
 */
export interface RequestStore {
  get(payer: string, key: string): Promise<InferenceRequest | null>;
  insertIfAbsent(row: NewInferenceRequest): Promise<ClaimResult>;
  update(
    payer: string,
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDatabase = PgDatabase<any, any>;

export class PgRequestStore implements RequestStore {
  constructor(private readonly db: AnyPgDatabase) {}

  async get(payer: string, key: string): Promise<InferenceRequest | null> {
    const rows = await this.db
      .select()
      .from(inferenceRequests)
      .where(and(eq(inferenceRequests.payer, payer), eq(inferenceRequests.idempotencyKey, key)))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertIfAbsent(row: NewInferenceRequest): Promise<ClaimResult> {
    // No conflict target: both the (payer, key) primary key and the (payer, nonce) unique index
    // turn a duplicate into "nothing inserted".
    const inserted = await this.db
      .insert(inferenceRequests)
      .values(row)
      .onConflictDoNothing()
      .returning({ key: inferenceRequests.idempotencyKey });
    if (inserted.length === 1) return 'inserted';
    return (await this.get(row.payer, row.idempotencyKey)) ? 'key_exists' : 'nonce_reused';
  }

  async update(
    payer: string,
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null> {
    const match = and(
      eq(inferenceRequests.payer, payer),
      eq(inferenceRequests.idempotencyKey, key),
    );
    const where = expectStatus ? and(match, eq(inferenceRequests.status, expectStatus)) : match;
    const rows = await this.db
      .update(inferenceRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();
    return rows[0] ?? null;
  }
}

export const memoryRowKey = (payer: string, key: string) => `${payer}\u0000${key}`;

/** In-memory store for tests and local experiments (same uniqueness rules as Postgres). */
export class MemoryRequestStore implements RequestStore {
  readonly rows = new Map<string, InferenceRequest>();

  /** Test helper: the row for a key regardless of payer (keys are unique in tests). */
  byKey(key: string): InferenceRequest | undefined {
    for (const row of this.rows.values()) if (row.idempotencyKey === key) return row;
    return undefined;
  }

  async get(payer: string, key: string): Promise<InferenceRequest | null> {
    const row = this.rows.get(memoryRowKey(payer, key));
    return row ? structuredClone(row) : null;
  }

  async insertIfAbsent(row: NewInferenceRequest): Promise<ClaimResult> {
    if (this.rows.has(memoryRowKey(row.payer, row.idempotencyKey))) return 'key_exists';
    for (const r of this.rows.values()) {
      if (r.payer === row.payer && r.paymentNonce === row.paymentNonce) return 'nonce_reused';
    }
    const now = new Date();
    this.rows.set(memoryRowKey(row.payer, row.idempotencyKey), {
      statusReason: null,
      chargedMicroUsdc: null,
      payment: null,
      response: null,
      usage: null,
      upstreamAttempts: 0,
      createdAt: now,
      updatedAt: now,
      ...structuredClone(row),
    } as InferenceRequest);
    return 'inserted';
  }

  async update(
    payer: string,
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null> {
    const k = memoryRowKey(payer, key);
    const row = this.rows.get(k);
    if (!row || (expectStatus && row.status !== expectStatus)) return null;
    const next = { ...row, ...structuredClone(patch), updatedAt: new Date() } as InferenceRequest;
    this.rows.set(k, next);
    return structuredClone(next);
  }
}
