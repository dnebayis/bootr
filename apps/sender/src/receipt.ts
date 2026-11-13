import { and, asc, eq } from 'drizzle-orm';
import type { SenderContext } from './context.js';
import { canonicalJson, hmacHex } from './crypto.js';
import { actions, type ActionRow } from './db/schema.js';

export interface Receipt {
  actionId: string;
  agentId: string;
  kind: ActionRow['kind'];
  status: ActionRow['status'];
  providerPostId: string | null;
  bodyHash: string;
  attempts: number;
  error: string | null;
  createdAt: string;
  sentAt: string | null;
  lastCheckedAt: string | null;
  nextCheckAt: string | null;
  /** HMAC-SHA256(SENDER_SERVICE_KEY, canonicalJson(receipt without signature)). */
  signature: string;
}

export function toReceipt(ctx: SenderContext, row: ActionRow): Receipt {
  const body = {
    actionId: row.actionId,
    agentId: row.agentId,
    kind: row.kind,
    status: row.status,
    providerPostId: row.providerPostId,
    bodyHash: row.bodyHash,
    attempts: row.attempts,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    sentAt: row.sentAt?.toISOString() ?? null,
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    nextCheckAt: row.status === 'held' ? (row.nextCheckAt?.toISOString() ?? null) : null,
  };
  return { ...body, signature: hmacHex(ctx.serviceKey, `receipt\n${canonicalJson(body)}`) };
}

/** One part of a thread as the sender holds it. */
export interface ThreadPartView {
  n: number;
  status: ActionRow['status'];
  providerPostId: string | null;
  error: string | null;
}

/**
 * The parts of a thread the sender has a row for (`GET /internal/receipt/:actionId` of a thread's first part): `n` is
 * the part asked for, `of` the highest part on record (the sender keeps no row for a part that was never sent to it,
 * so it cannot say how long the thread was meant to be; the supervisor knows that from its own action).
 */
export interface ThreadView {
  n: number;
  of: number;
  parts: ThreadPartView[];
}

/** The thread view of `row` when it is the first part of a thread; null for every other row. */
export async function threadOf(ctx: SenderContext, row: ActionRow): Promise<ThreadView | null> {
  if (row.threadN !== 1 || row.threadHead !== row.actionId) return null;
  const rows = await ctx.db
    .select({ n: actions.threadN, status: actions.status, providerPostId: actions.providerPostId, error: actions.error })
    .from(actions)
    .where(and(eq(actions.threadHead, row.actionId), eq(actions.agentId, row.agentId)))
    .orderBy(asc(actions.threadN));
  const parts = rows.filter((r): r is typeof r & { n: number } => typeof r.n === 'number').map((r) => ({ n: r.n, status: r.status, providerPostId: r.providerPostId, error: r.error }));
  return { n: 1, of: parts.reduce((max, p) => Math.max(max, p.n), 1), parts };
}

export async function getAction(
  ctx: SenderContext,
  actionId: string,
): Promise<ActionRow | undefined> {
  const rows = await ctx.db.select().from(actions).where(eq(actions.actionId, actionId)).limit(1);
  return rows[0];
}
