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
    'status' | 'statusReason' | 'chargedMicroUsdc' | 'payer' | 'payment' | 'response' | 'usage'
  >
>;

/**
 * Persistence for idempotency keys and receipts. `insertIfAbsent` is the claim: exactly one
 * concurrent request per key wins. `update` with `expectStatus` is a compare-and-set.
 */
export interface RequestStore {
  get(key: string): Promise<InferenceRequest | null>;
  insertIfAbsent(row: NewInferenceRequest): Promise<boolean>;
  update(
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDatabase = PgDatabase<any, any>;

export class PgRequestStore implements RequestStore {
  constructor(private readonly db: AnyPgDatabase) {}

  async get(key: string): Promise<InferenceRequest | null> {
    const rows = await this.db
      .select()
      .from(inferenceRequests)
      .where(eq(inferenceRequests.idempotencyKey, key))
      .limit(1);
    return rows[0] ?? null;
  }

  async insertIfAbsent(row: NewInferenceRequest): Promise<boolean> {
    const inserted = await this.db
      .insert(inferenceRequests)
      .values(row)
      .onConflictDoNothing({ target: inferenceRequests.idempotencyKey })
      .returning({ key: inferenceRequests.idempotencyKey });
    return inserted.length === 1;
  }

  async update(
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null> {
    const where = expectStatus
      ? and(eq(inferenceRequests.idempotencyKey, key), eq(inferenceRequests.status, expectStatus))
      : eq(inferenceRequests.idempotencyKey, key);
    const rows = await this.db
      .update(inferenceRequests)
      .set({ ...patch, updatedAt: new Date() })
      .where(where)
      .returning();
    return rows[0] ?? null;
  }
}

/** In-memory store for tests and local experiments. */
export class MemoryRequestStore implements RequestStore {
  readonly rows = new Map<string, InferenceRequest>();

  async get(key: string): Promise<InferenceRequest | null> {
    const row = this.rows.get(key);
    return row ? structuredClone(row) : null;
  }

  async insertIfAbsent(row: NewInferenceRequest): Promise<boolean> {
    if (this.rows.has(row.idempotencyKey)) return false;
    const now = new Date();
    this.rows.set(row.idempotencyKey, {
      statusReason: null,
      chargedMicroUsdc: null,
      payer: null,
      payment: null,
      response: null,
      usage: null,
      createdAt: now,
      updatedAt: now,
      ...structuredClone(row),
    } as InferenceRequest);
    return true;
  }

  async update(
    key: string,
    patch: RequestPatch,
    expectStatus?: RequestStatus,
  ): Promise<InferenceRequest | null> {
    const row = this.rows.get(key);
    if (!row || (expectStatus && row.status !== expectStatus)) return null;
    const next = { ...row, ...structuredClone(patch), updatedAt: new Date() } as InferenceRequest;
    this.rows.set(key, next);
    return structuredClone(next);
  }
}
