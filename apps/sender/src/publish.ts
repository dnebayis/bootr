import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { postLength, postLimitsFor } from '@bootr/agent-core';
import { getAccessToken, premiumOf } from './accounts.js';
import { MEDIA_SCOPE } from './oauth.js';
import type { SenderContext } from './context.js';
import { canonicalJson, sha256Hex } from './crypto.js';
import { isOptedOut, mentionsOptedOut, resolveReplyTarget } from './consent-gate.js';
import { actions, inbox, type ActionRow } from './db/schema.js';
import { log } from './log.js';
import { checkOutgoing, mentionedHandles } from './policy-shim.js';
import { POST_WINDOW_MS, getQuota, postsInWindow } from './quota.js';
import { getAction, toReceipt, type Receipt } from './receipt.js';
import type { XError } from './x-client.js';

const xId = z.string().regex(/^\d{1,25}$/, 'must be a numeric X id');

/** X accepts photos up to 5 MB. */
export const MAX_MEDIA_BYTES = 5 * 1024 * 1024;
export const MEDIA_MIMES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/** One picture to attach: base64 bytes inline (the supervisor stores the agent's images), its type and alt text. */
export const mediaSchema = z
  .object({
    data: z
      .string()
      .min(1)
      .max(Math.ceil((MAX_MEDIA_BYTES * 4) / 3) + 4)
      .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'must be base64'),
    mime: z.enum(MEDIA_MIMES),
    alt: z.string().trim().min(1).max(1000),
  })
  .strict();
export type MediaInput = z.infer<typeof mediaSchema>;

export function decodeMedia(media: MediaInput): { ok: true; bytes: Buffer } | { ok: false; message: string } {
  const bytes = Buffer.from(media.data, 'base64');
  if (bytes.length === 0) return { ok: false, message: 'media.data decodes to nothing' };
  if (bytes.length > MAX_MEDIA_BYTES) return { ok: false, message: `media is ${bytes.length} bytes; X takes at most ${MAX_MEDIA_BYTES}` };
  return { ok: true, bytes };
}

export const publishSchema = z.object({
  agentId: z.string().min(1).max(128),
  actionId: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[A-Za-z0-9:_.-]+$/),
  text: z.string().min(1).max(25_000),
  /** The platform's own agent: the stricter platform post rules apply (no treasury talk, no market calls, ...). */
  platform: z.boolean().optional(),
  replyTo: xId.nullish(),
  /** Informational only: the author is always resolved by the sender (inbox, else X). */
  replyAuthorId: xId.nullish(),
  /**
   * The supervisor's agent-core `replyEligibility` decision for `replyTo`. Required for replies: a
   * reply without it, or with `eligible: false`, is rejected (`policy:reply_not_eligible:<reason>`).
   * Not part of the body hash (it is a policy input, not content).
   */
  replyEligibility: z
    .object({
      eligible: z.boolean(),
      reason: z
        .string()
        .regex(/^[a-z0-9_]{1,48}$/)
        .optional(),
    })
    .strict()
    .optional(),
  /** Source credits required by agent-core `validatePost` for every @mention in the text. */
  attributions: z
    .array(
      z
        .object({ username: z.string().regex(/^\w{1,15}$/), sourceUrl: z.string().max(2000) })
        .strict(),
    )
    .max(3)
    .optional(),
  /**
   * Addresses the agent may name in public (its own token and treasury), from the supervisor. Any
   * other 0x address in the text is rejected (`social_private_address_forbidden`). Absent: no address
   * check. Not part of the body hash (a policy input, not content).
   */
  publicAddresses: z.array(z.string().regex(/^0x[0-9a-fA-F]{40}$/)).max(4).optional(),
  /** A picture to upload and attach (`media.media_ids`) with its alt text. Part of the body hash. */
  media: mediaSchema.optional(),
  /**
   * The X user the supervisor expects to post as (its agent config). When the account currently bound
   * to the agent is a different user, nothing is sent and nothing is recorded (409 `account_mismatch`):
   * a reconnect to another account must be acknowledged in the agent config before it may publish.
   */
  xUserId: xId.optional(),
});
export type PublishInput = z.infer<typeof publishSchema>;

/** First reconciliation check after an ambiguous outcome. */
export const FIRST_CHECK_DELAY_MS = 15 * 60 * 1000;

/** The receipt error code of an original post longer than the connected account may send. */
export const POST_TOO_LONG_CODE = 'post_too_long_for_account';

/**
 * X's own limit for the account, checked before X is contacted: an account without Premium (`premium === false`,
 * from its `verified_type`) may send originals of at most 280 characters, and X answers a longer one with a bare 403
 * "You are not permitted to perform this action" (the one 403 the supervisor treats as an account hold). Replies are
 * capped at 280 by policy already. With Premium, or while Premium is unknown (null), nothing is refused here. The
 * length is code points (agent-core `postLength`); X's weighting (a URL counts 23, some characters 2) is not reproduced.
 * Returns the receipt error, `post_too_long_for_account: ...`, or null.
 */
export function postTooLongForAccount(text: string, kind: 'post' | 'reply', premium: boolean | null): string | null {
  if (kind !== 'post' || premium !== false) return null;
  const limit = postLimitsFor(premium).original;
  const length = postLength(text);
  if (length <= limit) return null;
  return `${POST_TOO_LONG_CODE}: this X account has no Premium: posts are limited to ${limit} characters (this one is ${length}). Shorten it and publish again.`;
}

export type PublishResult =
  | {
      http: 200;
      body: {
        status: ActionRow['status'];
        providerPostId?: string;
        receipt: Receipt;
        duplicate?: boolean;
      };
    }
  | { http: 400 | 409 | 429 | 503; body: Record<string, unknown> };

export function bodyHash(input: PublishInput): string {
  return sha256Hex(
    canonicalJson({
      agentId: input.agentId,
      kind: input.replyTo ? 'reply' : 'post',
      text: input.text,
      replyTo: input.replyTo ?? null,
      replyAuthorId: input.replyAuthorId ?? null,
      attributions: input.attributions ?? [],
      // the picture by content, not by its base64 text (rows without media keep their pre-media hash)
      ...(input.media
        ? { media: { sha256: sha256Hex(Buffer.from(input.media.data, 'base64')), mime: input.media.mime, alt: input.media.alt } }
        : {}),
    }),
  );
}

function ok(ctx: SenderContext, row: ActionRow, duplicate = false): PublishResult {
  return {
    http: 200,
    body: {
      status: row.status,
      ...(row.providerPostId ? { providerPostId: row.providerPostId } : {}),
      receipt: toReceipt(ctx, row),
      ...(duplicate ? { duplicate: true } : {}),
    },
  };
}

function existing(
  ctx: SenderContext,
  row: ActionRow,
  input: PublishInput,
  hash: string,
): PublishResult {
  if (row.agentId !== input.agentId) {
    return {
      http: 409,
      body: { error: 'action_id_conflict', message: 'actionId belongs to another agent' },
    };
  }
  if (row.bodyHash !== hash) {
    return {
      http: 409,
      body: {
        error: 'action_id_conflict',
        message: 'actionId was used with a different body',
        receipt: toReceipt(ctx, row),
      },
    };
  }
  return ok(ctx, row, true);
}

/**
 * Idempotent publication. Invariants:
 *  - at most one X write per actionId, ever (the claim row is committed before X is contacted);
 *  - a repeated request returns the stored receipt;
 *  - definite provider rejections are final (`rejected`);
 *  - ambiguous outcomes (timeout, 5xx, DB failure after send) become `held` and are only ever
 *    settled by reconciliation, never resent.
 */
export async function publish(ctx: SenderContext, input: PublishInput): Promise<PublishResult> {
  const hash = bodyHash(input);
  const kind = input.replyTo ? 'reply' : 'post';

  const prior = await getAction(ctx, input.actionId);
  if (prior) return existing(ctx, prior, input, hash);

  // Token first: if it is unavailable nothing is recorded and the caller may retry the same actionId.
  const tok = await getAccessToken(ctx, input.agentId);
  if (!tok.ok) {
    return {
      http: tok.code === 'refresh_failed' ? 503 : 409,
      body: { error: tok.code, message: tok.message },
    };
  }
  if (input.xUserId && tok.account.xUserId !== input.xUserId) {
    return {
      http: 409,
      body: {
        error: 'account_mismatch',
        message: `agent ${input.agentId} is bound to @${tok.account.xHandle}, not the X user the agent config expects`,
        boundHandle: tok.account.xHandle,
      },
    };
  }
  // A picture needs the media.write scope; nothing is recorded, the creator reconnects (or the agent posts without it).
  let media: { bytes: Buffer; mime: string; alt: string } | null = null;
  if (input.media) {
    const decoded = decodeMedia(input.media);
    if (!decoded.ok) return { http: 400, body: { error: 'invalid_media', message: decoded.message } };
    if (!tok.account.scopes.split(/\s+/).includes(MEDIA_SCOPE)) {
      return {
        http: 409,
        body: {
          error: 'media_not_authorized',
          message: `the connected X account was authorized without the ${MEDIA_SCOPE} scope; reconnect it to post images`,
        },
      };
    }
    media = { bytes: decoded.bytes, mime: input.media.mime, alt: input.media.alt };
  }

  // ---- policy and consent (a rejection is recorded and final for this actionId) ----
  const reasons: string[] = [];
  const replyReasons: string[] = [];
  let replyAuthorId: string | null = null;
  let recipient: string | null = null;
  if (input.replyTo) {
    const eligibility = input.replyEligibility;
    if (!eligibility?.eligible) {
      replyReasons.push(`reply_not_eligible:${eligibility?.reason ?? 'missing_eligibility'}`);
    }
    // The author always comes from the inbox or X, never from the caller.
    // An ineligible reply is rejected anyway, so it costs no X read.
    const target = await resolveReplyTarget(ctx, input.agentId, input.replyTo, {
      lookup: replyReasons.length === 0,
    });
    if (target.kind === 'transient') return transientFailure(target);
    if (target.kind === 'found') {
      replyAuthorId = target.authorId;
      recipient = target.username;
    } else if (target.kind === 'not_found') {
      replyReasons.push('reply_target_unavailable');
    }
  }
  const decision = checkOutgoing({
    kind,
    text: input.text,
    attributions: input.attributions,
    recipient,
    ownHandle: tok.account.xHandle,
    publicAddresses: input.publicAddresses,
    ...(input.platform ? { platform: true } : {}),
  });
  if (!decision.allowed) reasons.push(decision.code);
  if (replyAuthorId && (await isOptedOut(ctx, input.agentId, [replyAuthorId]))) {
    reasons.push('consent_opted_out');
  }
  if (reasons.length === 0 && replyReasons.length === 0) {
    // Every @mention (originals and replies) must not target an opted-out author.
    const skip = new Set([tok.account.xHandle.toLowerCase(), recipient?.toLowerCase()]);
    const handles = mentionedHandles(input.text).filter((h) => !skip.has(h));
    const mentioned = await mentionsOptedOut(ctx, input.agentId, handles);
    if (mentioned.kind === 'transient') return transientFailure(mentioned);
    if (mentioned.optedOut) reasons.push('mention_opted_out');
  }
  reasons.push(...replyReasons);
  // The account's own length limit (no X Premium: 280), after the policy gates and before X; recorded and final too.
  const tooLong = reasons.length === 0 ? postTooLongForAccount(input.text, kind, premiumOf(tok.account.verifiedType)) : null;

  const base = {
    actionId: input.actionId,
    agentId: input.agentId,
    kind,
    text: input.text,
    replyTo: input.replyTo ?? null,
    replyAuthorId: replyAuthorId ?? input.replyAuthorId ?? null,
    xUserId: tok.account.xUserId,
    bodyHash: hash,
    createdAt: ctx.now(),
  } as const;

  if (reasons.length > 0 || tooLong) {
    await ctx.db
      .insert(actions)
      .values({ ...base, status: 'rejected', error: reasons.length > 0 ? `policy:${reasons.join(',')}` : tooLong!, attempts: 0 })
      .onConflictDoNothing();
    const row = await getAction(ctx, input.actionId);
    return row!.bodyHash === hash ? ok(ctx, row!) : existing(ctx, row!, input, hash);
  }

  // ---- quota + claim, serialised per agent ----
  type Claim =
    | { kind: 'claimed'; row: ActionRow }
    | { kind: 'exists' }
    | { kind: 'quota'; limit: number; retryAt: Date };
  let claim: Claim;
  try {
    claim = await ctx.db.transaction(async (tx): Promise<Claim> => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${'sender_publish:' + input.agentId}))`,
      );
      const quota = await getQuota(ctx, input.agentId, tx);
      const used = await postsInWindow(
        tx,
        input.agentId,
        new Date(ctx.now().getTime() - POST_WINDOW_MS),
      );
      if (used.count >= quota.postsPerDay) {
        const retryAt = new Date((used.oldest ?? ctx.now()).getTime() + POST_WINDOW_MS);
        return { kind: 'quota', limit: quota.postsPerDay, retryAt };
      }
      const inserted = await tx
        .insert(actions)
        .values({ ...base, status: 'pending', attempts: 1 })
        .onConflictDoNothing()
        .returning();
      return inserted[0] ? { kind: 'claimed', row: inserted[0] } : { kind: 'exists' };
    });
  } catch (err) {
    // Nothing was sent: X is only contacted after the claim commits.
    log.error('publish claim failed', { actionId: input.actionId, err: errMsg(err) });
    return {
      http: 503,
      body: {
        error: 'storage_unavailable',
        message: 'could not record the action; nothing was sent',
      },
    };
  }

  if (claim.kind === 'quota') {
    return {
      http: 429,
      body: {
        error: 'quota_exceeded',
        limit: claim.limit,
        window: '24h',
        retryAt: claim.retryAt.toISOString(),
      },
    };
  }
  if (claim.kind === 'exists') {
    const row = await getAction(ctx, input.actionId);
    return existing(ctx, row!, input, hash);
  }

  // ---- contact X ----
  // The picture first: an upload publishes nothing, so any failure here is a definite rejection of
  // this actionId (the agent may retry with a new one); alt text is best effort.
  let mediaIds: string[] | undefined;
  if (media) {
    const up = await ctx.x.uploadMedia(tok.token, { bytes: media.bytes, mime: media.mime });
    const mediaId = up.ok ? up.data.data?.id : undefined;
    if (!up.ok || !mediaId || !/^\d+$/.test(mediaId)) {
      const error = up.ok ? 'media_upload_failed: no media id in 2xx' : `media_upload_failed: ${describe(up.error)}`;
      await safeUpdate(ctx, input.actionId, { status: 'rejected', error });
      const row = await getAction(ctx, input.actionId).catch(() => undefined);
      return row ? ok(ctx, row) : heldFallback(ctx, input.actionId);
    }
    const alt = await ctx.x.setMediaAltText(tok.token, mediaId, media.alt);
    if (!alt.ok) log.warn('media alt text not set', { actionId: input.actionId, code: alt.error.code });
    mediaIds = [mediaId];
  }
  const post = { text: input.text, replyTo: input.replyTo, ...(mediaIds ? { mediaIds } : {}) };
  let res = await ctx.x.createPost(tok.token, post);
  if (!res.ok && res.error.status === 401) {
    // 401 is a definite non-creation; refresh and make exactly one more attempt, recorded first.
    const again = await getAccessToken(ctx, input.agentId, { force: true });
    if (again.ok) {
      const bumped = await safeUpdate(ctx, input.actionId, { attempts: 2 });
      if (bumped) res = await ctx.x.createPost(again.token, post);
    }
  }

  const now = ctx.now();
  if (res.ok) {
    const id = res.data.data?.id;
    if (id && /^\d+$/.test(id)) {
      const settled = await safeUpdate(ctx, input.actionId, {
        status: 'sent',
        providerPostId: id,
        sentAt: now,
        error: null,
      });
      if (!settled) {
        log.error('post sent but receipt write failed; action left for reconciliation', {
          actionId: input.actionId,
          providerPostId: id,
        });
        await safeUpdate(ctx, input.actionId, {
          status: 'held',
          error: 'db_write_failed_after_send',
          nextCheckAt: now,
        });
        return heldFallback(ctx, input.actionId);
      }
      await markInbox(ctx, input, { status: 'answered', replyId: id, reason: null });
    } else {
      await hold(ctx, input, {
        definite: false,
        code: 'malformed_response',
        message: 'no post id in 2xx',
      });
    }
  } else if (res.error.definite) {
    await safeUpdate(ctx, input.actionId, {
      status: 'rejected',
      error: describe(res.error),
    });
    if (res.error.status === 403 || res.error.status === 404) {
      await markInbox(ctx, input, { status: 'delivery_blocked', reason: describe(res.error) });
    }
  } else {
    await hold(ctx, input, res.error);
  }

  const row = await getAction(ctx, input.actionId).catch(() => undefined);
  if (!row) return heldFallback(ctx, input.actionId);
  return ok(ctx, row);
}

/** A consent lookup could not reach X: nothing is recorded, retry the same actionId later. */
function transientFailure(t: {
  status: 429 | 503;
  message: string;
  retryAt?: number;
}): PublishResult {
  return {
    http: t.status,
    body: {
      error: 'consent_lookup_failed',
      message: `could not verify the recipient on X (${t.message}); nothing was sent`,
      ...(t.retryAt ? { retryAt: new Date(t.retryAt).toISOString() } : {}),
    },
  };
}

async function hold(ctx: SenderContext, input: PublishInput, error: XError): Promise<void> {
  const now = ctx.now();
  log.warn('ambiguous publish outcome; action held', {
    actionId: input.actionId,
    code: error.code,
  });
  await safeUpdate(ctx, input.actionId, {
    status: 'held',
    error: describe(error),
    checks: 0,
    nextCheckAt: new Date(now.getTime() + FIRST_CHECK_DELAY_MS),
  });
  await markInbox(ctx, input, { status: 'retrying', reason: 'reply_held' });
}

/** Used when the DB is failing after X was contacted: report `held` without a stored row. */
function heldFallback(_ctx: SenderContext, actionId: string): PublishResult {
  return {
    http: 503,
    body: {
      status: 'held',
      error: 'storage_unavailable_after_send',
      message: 'outcome recorded as held (or will be by the reconciler); do not resend',
      actionId,
    },
  };
}

async function safeUpdate(
  ctx: SenderContext,
  actionId: string,
  set: Partial<typeof actions.$inferInsert>,
): Promise<boolean> {
  try {
    await ctx.db.update(actions).set(set).where(eq(actions.actionId, actionId));
    return true;
  } catch (err) {
    log.error('action update failed', { actionId, err: errMsg(err) });
    return false;
  }
}

async function markInbox(
  ctx: SenderContext,
  input: Pick<PublishInput, 'agentId' | 'replyTo'>,
  set: Partial<typeof inbox.$inferInsert>,
): Promise<void> {
  if (!input.replyTo) return;
  try {
    await ctx.db
      .update(inbox)
      .set(set)
      .where(and(eq(inbox.agentId, input.agentId), eq(inbox.postId, input.replyTo)));
  } catch (err) {
    log.warn('inbox update failed', { agentId: input.agentId, err: errMsg(err) });
  }
}

export { markInbox };

function describe(e: XError): string {
  return `${e.code}${e.status ? `(${e.status})` : ''}: ${e.message}`.slice(0, 500);
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
