import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { aadAccess, aadRefresh } from './accounts.js';
import type { SenderContext } from './context.js';
import { decrypt, encrypt } from './crypto.js';
import { accounts, quotas, reads } from './db/schema.js';
import { log } from './log.js';

export const AGENT_ID_RE = /^[\w:.-]{1,128}$/;

export const rebindSchema = z
  .object({
    to: z.string().regex(AGENT_ID_RE),
    /**
     * Optional guard: refuse unless the account under `from` was (last) connected at or before this
     * instant. The supervisor passes the launch block time, so an account bound to a public draft id
     * after the launch became visible on-chain is never moved onto the live agent.
     */
    connectedBefore: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

export type RebindResult =
  | { ok: true; status: 'moved' | 'already'; agentId: string; handle: string | null }
  | { ok: false; status: number; error: string; message: string };

/**
 * Moves the X account connected under a launch draft id (the web form's uuid) to the real ERC-8004
 * agent id, in one transaction:
 *   - `sender_accounts`: the row moves; tokens are re-encrypted because their AAD binds the agent id
 *   - `sender_quotas`:   moves when the target has no row (otherwise the target's row wins)
 *   - `sender_reads`:    metering counts are merged into the target (the `users_me` read at connect time)
 * `sender_actions`, `sender_inbox` and `sender_optouts` stay under the old id: a draft id never
 * publishes or reads mentions (only the supervisor does, with real agent ids), so there is nothing
 * to move and history is never rewritten.
 *
 * Idempotent: `from` gone and `to` present -> `already`. Neither present -> 404. Both present -> 409.
 */
export async function rebindAccount(
  ctx: SenderContext,
  from: string,
  to: string,
  opts: { connectedBefore?: Date } = {},
): Promise<RebindResult> {
  if (from === to) {
    return { ok: false, status: 400, error: 'invalid_request', message: 'from and to are equal' };
  }
  const result = await ctx.db.transaction(async (tx): Promise<RebindResult> => {
    const [src] = await tx.select().from(accounts).where(eq(accounts.agentId, from)).for('update');
    const [dst] = await tx.select().from(accounts).where(eq(accounts.agentId, to)).for('update');
    if (!src && dst) return { ok: true, status: 'already', agentId: to, handle: dst.xHandle };
    if (!src) {
      return { ok: false, status: 404, error: 'not_found', message: 'no account under either id' };
    }
    if (dst) {
      return {
        ok: false,
        status: 409,
        error: 'conflict',
        message: 'the target agent already has an X account',
      };
    }
    if (opts.connectedBefore && src.connectedAt.getTime() > opts.connectedBefore.getTime()) {
      return {
        ok: false,
        status: 409,
        error: 'connected_after_cutoff',
        message: 'the account was connected after connectedBefore',
      };
    }
    const now = ctx.now();
    const access = decrypt(src.encryptedAccessToken, ctx.encryptionKey, aadAccess(from));
    const refresh = src.encryptedRefreshToken
      ? decrypt(src.encryptedRefreshToken, ctx.encryptionKey, aadRefresh(from))
      : null;
    await tx.delete(accounts).where(eq(accounts.agentId, from));
    await tx.insert(accounts).values({
      ...src,
      agentId: to,
      encryptedAccessToken: encrypt(access, ctx.encryptionKey, aadAccess(to)),
      encryptedRefreshToken: refresh ? encrypt(refresh, ctx.encryptionKey, aadRefresh(to)) : null,
      updatedAt: now,
    });

    const [srcQuota] = await tx.select().from(quotas).where(eq(quotas.agentId, from));
    if (srcQuota) {
      const [dstQuota] = await tx.select().from(quotas).where(eq(quotas.agentId, to));
      await tx.delete(quotas).where(eq(quotas.agentId, from));
      if (!dstQuota) await tx.insert(quotas).values({ ...srcQuota, agentId: to, updatedAt: now });
    }

    const srcReads = await tx.select().from(reads).where(eq(reads.agentId, from));
    for (const r of srcReads) {
      await tx
        .insert(reads)
        .values({ ...r, agentId: to })
        .onConflictDoUpdate({
          target: [reads.agentId, reads.kind, reads.day],
          set: { count: sql`${reads.count} + ${r.count}` },
        });
    }
    if (srcReads.length) await tx.delete(reads).where(eq(reads.agentId, from));

    return { ok: true, status: 'moved', agentId: to, handle: src.xHandle };
  });
  if (result.ok && result.status === 'moved') {
    log.info('x account rebound', { from, to, handle: result.handle });
  }
  return result;
}
