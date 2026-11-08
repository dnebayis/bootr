/**
 * Post approval mode. When `config.requireApproval` is on (default for the platform's own agent, off for everyone
 * else; the creator flips it from the coin page through `PUT /internal/agents/:id/config`), a `publish_post` or
 * `publish_reply` the agent decided on is not sent: it is stored in `sv_approvals` as `pending_approval` and the
 * agent's turn continues as if the post went out (the tool result says it is queued for the creator's review; the
 * same text is refused again for 24 h). The creator then
 *   - approves: the supervisor sends it through the sender now (same body as a direct post, image included) and
 *     records the real post in `sv_actions` (the activity tape shows "Posted on X" like any other post), or
 *   - rejects: the row is marked and the note reaches the agent as a short observation on its next turn
 *     (`takeFeedback`); a pending row older than `APPROVAL_TTL_MS` is rejected by the system with the note "expired".
 * A queued item raises the creator's notification at once (`notifyPending`, notifications.ts); sending is the notifier's job.
 */
import { createHash } from 'node:crypto';
import type { ActionOutcome, PendingAction } from '@bootr/agent-core';
import { PolicyError, validatePost } from '@bootr/agent-core';
import { MentionError, publishAttributions } from './attributions.js';
import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { agentDirectory, conversationGuard } from './agent-directory.js';
import { inboxViews, publicAddressesOf, type BrokerEnv } from './broker/index.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, approvals, type ApprovalDecision, type ApprovalKind, type ApprovalStatus } from './db/schema.js';
import { loadImage, mediaFor, WITHOUT_PICTURE } from './images.js';
import { altTextRisk } from './image-rules.js';
import { raiseNotification } from './notifications.js';
import { agentConfigOf } from './onboarding.js';
import { SenderError, type ReplyEligibility } from './sender-client.js';

/** A pending item the creator never looked at is rejected ("expired") after this long. */
export const APPROVAL_TTL_MS = 48 * 3_600_000;
/** The same text (whitespace- and case-insensitive) is refused while a row with it is younger than this. */
export const APPROVAL_DEDUPE_MS = 24 * 3_600_000;
export const APPROVAL_LIST_MAX = 100;
export const MAX_NOTE_CHARS = 500;

export type ApprovalRow = typeof approvals.$inferSelect;

/** The flag in force for a stored config: explicit `requireApproval`, else on for the platform's own agent. */
export function requiresApproval(config: Record<string, unknown>): boolean {
  if (typeof config.requireApproval === 'boolean') return config.requireApproval;
  return config.platform === true;
}

export function textHash(text: string): string {
  return createHash('sha256').update(text.replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

/** `GET /internal/agents/:id/approvals` item; `image.data` (base64) only for pending items (what the creator reviews). */
export interface ApprovalView {
  id: string;
  agentId: string;
  kind: ApprovalKind;
  text: string;
  inReplyTo: string | null;
  image: { id: string; alt: string; mime: string; data?: string } | null;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  decidedBy: string | null;
  note: string | null;
  postId: string | null;
  url: string | null;
  createdAt: string;
  decidedAt: string | null;
  expiresAt: string;
}

function postUrl(agent: AgentRow, postId: string | null): string | null {
  const handle = (agent.config as { xHandle?: unknown }).xHandle;
  return postId && typeof handle === 'string' && handle ? `https://x.com/${handle}/status/${postId}` : null;
}

async function viewOf(ctx: SupervisorContext, agent: AgentRow, row: ApprovalRow, withImage: boolean): Promise<ApprovalView> {
  let image: ApprovalView['image'] = null;
  if (row.imageId) {
    const stored = await loadImage(ctx, agent.agentId, row.imageId);
    image = stored ? { id: stored.id, alt: stored.alt, mime: stored.mime, ...(withImage ? { data: stored.bytes.toString('base64') } : {}) } : { id: row.imageId, alt: '', mime: '' };
  }
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    text: row.text,
    inReplyTo: row.inReplyTo,
    image,
    status: row.status,
    decision: row.decision,
    decidedBy: row.decidedBy,
    note: row.note,
    postId: row.postId,
    url: postUrl(agent, row.postId),
    createdAt: row.createdAt.toISOString(),
    decidedAt: row.decidedAt ? row.decidedAt.toISOString() : null,
    expiresAt: new Date(row.createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
  };
}

/**
 * What the model is told when its post is queued (the runtime records the action as completed with this result).
 * A reply's `replyAuthorId` / `conversationId` ride along so the agent-to-agent caps (agent-directory.ts) count it.
 */
function queuedResult(row: Pick<ApprovalRow, 'id' | 'kind' | 'createdAt' | 'meta'>): Record<string, unknown> {
  const meta = (row.meta ?? {}) as { replyAuthorId?: string; conversationId?: string };
  return {
    ...(meta.replyAuthorId ? { replyAuthorId: meta.replyAuthorId } : {}),
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    queued: true,
    approvalId: row.id,
    status: 'pending_approval',
    expiresAt: new Date(row.createdAt.getTime() + APPROVAL_TTL_MS).toISOString(),
    note: `Queued for the creator's review; it goes out on X only if approved. Treat this ${row.kind} as posted: do not post or rephrase it again. You will be told on a later turn if it was rejected.`,
  };
}

/** Puts "posts waiting" in the creator's inbox now. It is a row of our own and nothing else: a failure here never touches the turn. */
async function notifyPending(ctx: SupervisorContext, agent: AgentRow): Promise<void> {
  try {
    await raiseNotification(ctx, agent.agentId, 'review_waiting', { pending: await pendingCount(ctx, agent.agentId) });
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'review notification failed');
  }
}

/**
 * Stores a `publish_post` / `publish_reply` for review instead of sending it. Idempotent on the action id (a
 * resumed step finds its row); the same text as any row of the last 24 h is refused with `approval_duplicate`.
 */
export async function queueForApproval(ctx: SupervisorContext, agent: AgentRow, pending: PendingAction, env: BrokerEnv): Promise<ActionOutcome> {
  const action = pending.action;
  if (action.tool !== 'publish_post' && action.tool !== 'publish_reply') throw new Error(`queueForApproval: not a publish action (${action.tool})`);
  const now = ctx.now();
  const existing = await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, pending.id) });
  if (existing) return { kind: 'completed', result: queuedResult(existing) };

  const hash = textHash(action.input.text);
  const dup = await ctx.db.query.approvals.findFirst({
    where: and(eq(approvals.agentId, agent.agentId), eq(approvals.textHash, hash), gt(approvals.createdAt, new Date(now - APPROVAL_DEDUPE_MS))),
    orderBy: desc(approvals.createdAt),
  });
  if (dup) {
    const state = dup.status === 'pending_approval' ? 'is waiting for the creator\'s review' : dup.status === 'approved' ? 'was already approved and posted' : `was ${dup.status === 'failed' ? 'approved but could not be sent' : 'rejected'}${dup.note ? ` (${dup.note})` : ''}`;
    return { kind: 'failed', error: `approval_duplicate: the same text ${state} (${dup.id}); do not post it again` };
  }

  if (action.input.imageId) {
    const image = await loadImage(ctx, agent.agentId, action.input.imageId);
    if (!image) return { kind: 'failed', error: `image_not_found: ${action.input.imageId} (a picture you made this turn with generate_image, else none). ${WITHOUT_PICTURE}` };
    // The alt text is public text: the same gates as the post, before the creator sees the item (image-rules.ts).
    const alt = altTextRisk(image.alt, { platform: agent.config.platform === true });
    if (alt) return { kind: 'failed', error: `${alt.message}. ${WITHOUT_PICTURE}` };
  }
  // The agent-to-agent caps apply to a reviewed post too: the creator's approval does not undo a loop.
  const capped = await conversationGuard(ctx, agent, { platform: agent.config.platform === true }, pending, env);
  if (capped) return capped;

  const meta: Record<string, unknown> = {};
  let kind: ApprovalKind = 'post';
  let inReplyTo: string | null = null;
  if (action.tool === 'publish_reply') {
    kind = 'reply';
    inReplyTo = action.input.postId;
    const item = env.inbox.get(action.input.postId);
    const config = agentConfigOf(agent);
    // Same decision the broker would send: taken when the mention was observed; unknown mentions are not eligible.
    const eligibility: ReplyEligibility =
      env.eligibility.get(action.input.postId) ??
      (item && config ? inboxViews(config, [item], now, await agentDirectory(ctx)).map((v) => ({ eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }))[0]! : { eligible: false, reason: 'not_in_inbox' });
    if (item) {
      meta.replyAuthorId = item.authorId;
      meta.conversationId = item.conversationId;
    }
    meta.replyEligibility = eligibility;
  }
  // What the sender will check on approval, checked now: credits that name nobody in the text are dropped, and a
  // text the publish gate refuses comes back to the agent as a tool error instead of failing after the creator's approval.
  let attributions: { username: string; sourceUrl: string }[];
  try {
    attributions = await publishAttributions(ctx, agent.agentId, action.input.text, action.input.attributions);
  } catch (err) {
    if (err instanceof MentionError) return { kind: 'failed', error: err.message };
    throw err;
  }
  if (attributions.length) meta.attributions = attributions;
  try {
    validatePost(action.input.text, attributions, kind === 'post' ? 'original' : 'short', !!action.input.imageId, { platform: agent.config.platform === true });
  } catch (err) {
    const code = err instanceof PolicyError ? err.code : 'invalid_post';
    return { kind: 'failed', error: `${code}: the post does not pass the publish gate; rewrite it` };
  }

  const [row] = await ctx.db
    .insert(approvals)
    .values({ id: pending.id, agentId: agent.agentId, kind, text: action.input.text, textHash: hash, imageId: action.input.imageId ?? null, inReplyTo, meta, status: 'pending_approval', createdAt: new Date(now) })
    .onConflictDoNothing()
    .returning();
  const stored = row ?? (await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, pending.id) }))!;
  ctx.log.info({ agentId: agent.agentId, approvalId: stored.id, kind }, 'publish queued for the creator\'s review');
  await notifyPending(ctx, agent);
  return { kind: 'completed', result: queuedResult(stored) };
}

/** The outcome of a publish that was queued before a crash (the runtime resumes it from here, never from the sender). */
export async function queuedOutcomeFor(ctx: SupervisorContext, actionId: string): Promise<ActionOutcome | null> {
  const row = await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, actionId) });
  return row ? { kind: 'completed', result: queuedResult(row) } : null;
}

/** Rejects (by the system, note "expired") every pending item older than the TTL. Returns how many. */
export async function expireApprovals(ctx: SupervisorContext, agentId?: string): Promise<number> {
  const now = ctx.now();
  const cutoff = new Date(now - APPROVAL_TTL_MS);
  const where = agentId ? and(eq(approvals.status, 'pending_approval'), lt(approvals.createdAt, cutoff), eq(approvals.agentId, agentId)) : and(eq(approvals.status, 'pending_approval'), lt(approvals.createdAt, cutoff));
  const rows = await ctx.db
    .update(approvals)
    .set({ status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'expired', decidedAt: new Date(now) })
    .where(where)
    .returning({ id: approvals.id, agentId: approvals.agentId });
  if (rows.length) ctx.log.info({ agentId, expired: rows.map((r) => r.id) }, 'approvals expired');
  return rows.length;
}

export async function pendingCount(ctx: SupervisorContext, agentId: string): Promise<number> {
  const rows = await ctx.db.select({ id: approvals.id }).from(approvals).where(and(eq(approvals.agentId, agentId), eq(approvals.status, 'pending_approval')));
  return rows.length;
}

export interface ReviewFeedback {
  approvalId: string;
  kind: ApprovalKind;
  /** The first 140 characters of what was refused. */
  text: string;
  status: 'rejected' | 'failed';
  note: string | null;
  decidedAt: string | null;
  /** One line for the model: "your post act_x was rejected: too salesy". */
  message: string;
}

/**
 * Rejections (and send failures) not yet told to the agent, marked as delivered. The runtime puts them in the
 * first observation of the next turn.
 */
export async function takeFeedback(ctx: SupervisorContext, agentId: string): Promise<ReviewFeedback[]> {
  const now = new Date(ctx.now());
  const rows = await ctx.db
    .update(approvals)
    .set({ feedbackAt: now })
    .where(and(eq(approvals.agentId, agentId), inArray(approvals.status, ['rejected', 'failed']), isNull(approvals.feedbackAt)))
    .returning();
  return rows
    .sort((a, b) => (a.decidedAt?.getTime() ?? 0) - (b.decidedAt?.getTime() ?? 0))
    .map((r) => ({
      approvalId: r.id,
      kind: r.kind,
      text: r.text.slice(0, 140),
      status: r.status as 'rejected' | 'failed',
      note: r.note,
      decidedAt: r.decidedAt ? r.decidedAt.toISOString() : null,
      message: r.status === 'failed' ? `your ${r.kind} ${r.id} was approved but could not be sent: ${r.note ?? 'sender error'}` : `your ${r.kind} ${r.id} was rejected: ${r.note ?? 'no reason given'}`,
    }));
}

/** `?status=pending` (default) or `all` (newest first, at most APPROVAL_LIST_MAX). Expires stale items first. */
export async function listApprovals(ctx: SupervisorContext, agent: AgentRow, status: 'pending' | 'all' = 'pending'): Promise<{ items: ApprovalView[]; pending: number }> {
  await expireApprovals(ctx, agent.agentId);
  const rows = await ctx.db
    .select()
    .from(approvals)
    .where(status === 'pending' ? and(eq(approvals.agentId, agent.agentId), eq(approvals.status, 'pending_approval')) : eq(approvals.agentId, agent.agentId))
    .orderBy(desc(approvals.createdAt))
    .limit(APPROVAL_LIST_MAX);
  const items: ApprovalView[] = [];
  for (const row of rows) items.push(await viewOf(ctx, agent, row, row.status === 'pending_approval'));
  const pending = status === 'pending' ? rows.length : rows.filter((r) => r.status === 'pending_approval').length;
  return { items, pending };
}

export interface DecisionBody {
  decision?: unknown;
  by?: unknown;
  note?: unknown;
}

export type DecisionResult = { ok: true; approval: ApprovalView } | { ok: false; status: 400 | 403 | 404 | 409 | 503; error: string; message: string };

const reject = (status: 400 | 403 | 404 | 409 | 503, error: string, message: string): DecisionResult => ({ ok: false, status, error, message });

/**
 * `POST /internal/agents/:id/approvals/:approvalId {decision, by, note?}`. Approve sends the post now (sender
 * actionId = the approval id, so a retry after an unknown outcome is idempotent) and records it in `sv_actions`;
 * reject marks the row. 409 when the item is no longer pending, 503 (nothing changed) when the sender cannot
 * take the post right now (X account not connected, rate limit).
 */
export async function decideApproval(ctx: SupervisorContext, agent: AgentRow, approvalId: string, body: DecisionBody): Promise<DecisionResult> {
  let by: Address;
  try {
    by = getAddress(String(body.by ?? ''));
  } catch {
    return reject(400, 'invalid_by', '`by` must be the creator address');
  }
  if (!isAddressEqual(by, agent.creator as Address)) return reject(403, 'not_creator', '`by` is not the creator of this agent');
  const decision = body.decision;
  if (decision !== 'approve' && decision !== 'reject') return reject(400, 'invalid_decision', 'decision must be approve or reject');
  let note: string | null = null;
  if (body.note !== undefined && body.note !== null) {
    if (typeof body.note !== 'string' || body.note.length > MAX_NOTE_CHARS) return reject(400, 'invalid_note', `note must be a string of at most ${MAX_NOTE_CHARS} characters`);
    // eslint-disable-next-line no-control-regex -- strips C0 controls (keeps tabs and newlines)
    note = body.note.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim() || null;
  }

  await expireApprovals(ctx, agent.agentId);
  const row = await ctx.db.query.approvals.findFirst({ where: and(eq(approvals.id, approvalId), eq(approvals.agentId, agent.agentId)) });
  if (!row) return reject(404, 'not_found', 'no such approval');
  if (row.status !== 'pending_approval') return reject(409, 'already_decided', `this item is ${row.status}${row.note ? ` (${row.note})` : ''}`);
  const now = new Date(ctx.now());

  if (decision === 'reject') {
    const [updated] = await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy: by, note, decidedAt: now }).where(eq(approvals.id, row.id)).returning();
    ctx.log.info({ agentId: agent.agentId, approvalId: row.id, by, note }, 'post rejected by the creator');
    return { ok: true, approval: await viewOf(ctx, agent, updated!, false) };
  }

  const config = agentConfigOf(agent);
  if (!config) return reject(409, 'agent_not_ready', 'the agent has no X account yet');
  let media: ReturnType<typeof mediaFor> | undefined;
  if (row.imageId) {
    const image = await loadImage(ctx, agent.agentId, row.imageId);
    if (!image) {
      await ctx.db.update(approvals).set({ status: 'failed', decision: 'approve', decidedBy: by, note: `image ${row.imageId} is gone`, decidedAt: now }).where(eq(approvals.id, row.id));
      return reject(409, 'image_missing', `the image ${row.imageId} attached to this post no longer exists`);
    }
    media = mediaFor(image);
  }
  const meta = row.meta as { replyAuthorId?: string; conversationId?: string; replyEligibility?: ReplyEligibility; attributions?: { username: string; sourceUrl: string }[] };
  let res;
  try {
    res = await ctx.sender.publish({
      agentId: agent.agentId,
      actionId: row.id,
      text: row.text,
      ...(row.kind === 'reply' && row.inReplyTo ? { replyTo: row.inReplyTo, replyEligibility: meta.replyEligibility ?? { eligible: false, reason: 'not_in_inbox' }, ...(meta.replyAuthorId ? { replyAuthorId: meta.replyAuthorId } : {}) } : {}),
      ...(meta.attributions ? { attributions: meta.attributions } : {}),
      ...(media ? { media } : {}),
      publicAddresses: publicAddressesOf(config),
      xUserId: config.xUserId,
    });
  } catch (err) {
    if (err instanceof SenderError && (err.retryable || err.code === 'storage_unavailable_after_send')) {
      ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, code: err.code }, 'approved post could not be sent right now');
      return reject(503, 'sender_unavailable', `the post could not be sent right now (${err.code}); try again`);
    }
    const error = err instanceof SenderError ? `sender:${err.code}` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
    const transport = err instanceof Error && /abort|timeout|fetch failed|ECONN|network/i.test(error);
    if (transport) return reject(503, 'sender_unavailable', `the sender did not answer (${error}); try again`);
    await ctx.db.update(approvals).set({ status: 'failed', decision: 'approve', decidedBy: by, note: error.slice(0, MAX_NOTE_CHARS), decidedAt: now }).where(eq(approvals.id, row.id));
    ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, error }, 'approved post failed at the sender');
    return reject(409, 'publish_failed', `the sender refused the post: ${error}`);
  }

  if (res.status === 'rejected') {
    const error = `sender_rejected:${res.receipt.error ?? 'rejected'}`;
    await ctx.db.update(approvals).set({ status: 'failed', decision: 'approve', decidedBy: by, note: error, decidedAt: now }).where(eq(approvals.id, row.id));
    ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, error }, 'approved post rejected by the sender');
    return reject(409, 'publish_failed', `the sender refused the post: ${res.receipt.error ?? 'rejected'}`);
  }
  // sent (or held/pending: maybe published, never resent; the sender receipt keeps the truth).
  const postId = res.status === 'sent' ? (res.providerPostId ?? null) : null;
  const tool = row.kind === 'reply' ? 'publish_reply' : 'publish_post';
  await ctx.db
    .insert(actions)
    .values({
      actionId: `${row.id}-approved`,
      agentId: agent.agentId,
      cycleKey: `approval:${row.id}`,
      action: { tool, input: { text: row.text, ...(row.imageId ? { imageId: row.imageId } : {}), ...(row.inReplyTo ? { postId: row.inReplyTo } : {}) }, approval: { id: row.id, by, note } },
      status: res.status === 'sent' ? 'completed' : 'held',
      result: { ...(postId ? { postId } : {}), ...(meta.replyAuthorId ? { replyAuthorId: meta.replyAuthorId } : {}), ...(meta.conversationId ? { conversationId: meta.conversationId } : {}), approvalId: row.id, senderStatus: res.status },
      receipt: postId ? { postId } : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [updated] = await ctx.db
    .update(approvals)
    .set({ status: 'approved', decision: 'approve', decidedBy: by, note: res.status === 'sent' ? note : `${note ? `${note} · ` : ''}sender ${res.status}`, postId, decidedAt: now })
    .where(eq(approvals.id, row.id))
    .returning();
  ctx.log.info({ agentId: agent.agentId, approvalId: row.id, by, postId, senderStatus: res.status }, 'post approved by the creator and sent');
  return { ok: true, approval: await viewOf(ctx, agent, updated!, false) };
}

/** Activity tape items for the approvals of an agent (activity.ts merges them); texts stay private (public read). */
export async function approvalActivity(ctx: SupervisorContext, agent: AgentRow, limit: number, before?: Date): Promise<{ at: string; kind: 'approval_pending' | 'approval_approved' | 'approval_rejected'; summary: string; url?: string }[]> {
  const pendingWhere = and(eq(approvals.agentId, agent.agentId), eq(approvals.status, 'pending_approval'), ...(before ? [lt(approvals.createdAt, before)] : []));
  const decidedWhere = and(eq(approvals.agentId, agent.agentId), inArray(approvals.status, ['approved', 'rejected', 'failed']), ...(before ? [lt(approvals.decidedAt, before)] : []));
  const [pendingRows, decidedRows] = await Promise.all([
    ctx.db.select().from(approvals).where(pendingWhere).orderBy(desc(approvals.createdAt)).limit(limit),
    ctx.db.select().from(approvals).where(decidedWhere).orderBy(desc(approvals.decidedAt)).limit(limit),
  ]);
  const noun = (r: ApprovalRow) => (r.kind === 'reply' ? 'reply' : 'post');
  const items: { at: string; kind: 'approval_pending' | 'approval_approved' | 'approval_rejected'; summary: string; url?: string }[] = [];
  for (const r of pendingRows) items.push({ at: r.createdAt.toISOString(), kind: 'approval_pending', summary: `A ${noun(r)} is waiting for the creator's review` });
  for (const r of decidedRows) {
    const at = (r.decidedAt ?? r.createdAt).toISOString();
    if (r.status === 'approved') {
      const url = postUrl(agent, r.postId);
      items.push({ at, kind: 'approval_approved', summary: `${r.kind === 'reply' ? 'Reply' : 'Post'} approved by the creator`, ...(url ? { url } : {}) });
    } else if (r.status === 'failed') {
      items.push({ at, kind: 'approval_rejected', summary: `${r.kind === 'reply' ? 'Reply' : 'Post'} approved but not sent` });
    } else {
      items.push({ at, kind: 'approval_rejected', summary: r.decidedBy === 'system' ? `${r.kind === 'reply' ? 'Reply' : 'Post'} expired without review` : `${r.kind === 'reply' ? 'Reply' : 'Post'} rejected by the creator` });
    }
  }
  return items;
}
