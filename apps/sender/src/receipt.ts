import { eq } from 'drizzle-orm';
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

export async function getAction(
  ctx: SenderContext,
  actionId: string,
): Promise<ActionRow | undefined> {
  const rows = await ctx.db.select().from(actions).where(eq(actions.actionId, actionId)).limit(1);
  return rows[0];
}
