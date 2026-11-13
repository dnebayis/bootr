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
 *
 * A thread is one item (docs/design/agent-tools-2.md section 3.5): its later parts wait in `meta.thread`, the
 * duplicate check is over all parts, approving sends all of them through the one send of an original
 * (`postHooks.sendOriginal`, post-send.ts) and rejecting rejects all. A comment keeps the post it is about in
 * `meta.about`. The rules that are new with threads and comments are applied when the item is queued, as the broker
 * applies them to a post sent at once (broker `originalRules`).
 */
import { createHash } from 'node:crypto';
import type { ActionOutcome, PendingAction } from '@bootr/agent-core';
import { PolicyError, threadParts, threadRefusal, validatePost } from '@bootr/agent-core';
import { MentionError, publishAttributions } from './attributions.js';
import { and, desc, eq, gt, inArray, isNull, lt } from 'drizzle-orm';
import { getAddress, isAddressEqual, type Address } from 'viem';
import { agentDirectory, conversationGuard } from './agent-directory.js';
import { bountyApprovalView, decideBountyApproval } from './bounties.js';
import { inboxViews, openReplyEligibility, originalRules, publicAddressesOf, type BrokerEnv } from './broker/index.js';
import type { CommentAbout } from './comment-posts.js';
import { postHooks, type OriginalResult } from './post-send.js';
import { SCHEDULED_ID_RE, retryableSend, threadLimits, type CommentedOriginal } from './thread-send.js';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, approvals, type ApprovalDecision, type ApprovalKind, type ApprovalStatus } from './db/schema.js';
import { loadImage, mediaFor, WITHOUT_PICTURE } from './images.js';
import { altTextRisk } from './image-rules.js';
import { raiseNotification } from './notifications.js';
import { agentConfigOf } from './onboarding.js';
import { decideScheduled, isScheduledApproval } from './scheduled.js';
import { SenderError, type ReplyEligibility } from './sender-client.js';
import { addressRefusal } from './your-coin.js';

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
  /**
   * For `bounty_job` and `bounty_payout` items (bounties.ts): the job id, its task and amount, and for a payout the
   * payee, the judge's reason, the winning entry's link and `txHashRequired: true` (approving needs the creator's
   * paying transaction hash in the body). Null for a post or reply.
   */
  bounty: Record<string, unknown> | null;
  /** A thread: the texts of the parts after `text`, in order, so the creator reads all of what approving sends. Absent for a single post. */
  thread?: string[];
  /** A scheduled post (`meta.scheduled`): the time it goes out when approved by then, ISO. Absent for a post that goes out on approval. */
  scheduledFor?: string;
}

/** The parts after the first of a queued thread, and the time a queued scheduled post is for, as the item's meta keeps them. */
function reviewExtras(meta: unknown): Pick<ApprovalView, 'thread' | 'scheduledFor'> {
  const m = (meta ?? {}) as { thread?: unknown; scheduled?: { sendAt?: unknown } };
  const thread = Array.isArray(m.thread) ? m.thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string') : [];
  const sendAt = typeof m.scheduled?.sendAt === 'string' && Number.isFinite(Date.parse(m.scheduled.sendAt)) ? new Date(Date.parse(m.scheduled.sendAt)).toISOString() : null;
  return { ...(thread.length ? { thread } : {}), ...(sendAt ? { scheduledFor: sendAt } : {}) };
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
    bounty: bountyApprovalView(row.meta),
    ...reviewExtras(row.meta),
  };
}

/**
 * What the model is told when its post is queued (the runtime records the action as completed with this result).
 * A reply's `replyAuthorId` / `conversationId` ride along so the agent-to-agent caps (agent-directory.ts) count it.
 */
function queuedResult(row: Pick<ApprovalRow, 'id' | 'kind' | 'createdAt' | 'meta'>): Record<string, unknown> {
  const meta = (row.meta ?? {}) as { replyAuthorId?: string; conversationId?: string; openReply?: boolean; about?: CommentAbout };
  return {
    ...(meta.replyAuthorId ? { replyAuthorId: meta.replyAuthorId } : {}),
    ...(meta.conversationId ? { conversationId: meta.conversationId } : {}),
    // What the day's counts read from a queued row as from a sent one: a reply outside the verified audience, a comment's author.
    ...(meta.openReply ? { openReply: true } : {}),
    ...(meta.about ? { about: meta.about } : {}),
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

  // The duplicate check is over all parts of a thread; a single post hashes as it always did.
  const parts = action.tool === 'publish_post' ? threadParts(action.input) : [action.input.text];
  const hash = textHash(parts.join('\n'));
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
  // A scheduled post (its id says so) is queued for a time of its own: the scheduler asked what that time allows.
  const scheduled = SCHEDULED_ID_RE.test(pending.id);
  // The coin's contract address is held to the day's count when a post is queued, as when one is sent at once (your-coin.ts).
  if (!scheduled) {
    const addressed = await addressRefusal(ctx, agent, pending.id, parts, action.tool === 'publish_reply' ? { replyTo: env.inbox.get(action.input.postId)?.post } : {});
    if (addressed) return { kind: 'failed', error: addressed };
  }
  // An original queued now stands for the slot of this moment: a scheduled post that is due within one post interval
  // holds that slot already (post-send.ts `beforeOriginalNow`), as it does for a post sent at once.
  if (action.tool === 'publish_post' && !scheduled) {
    const scheduledSoon = await postHooks.beforeOriginalNow(ctx, agent, now);
    if (scheduledSoon) return { kind: 'failed', error: scheduledSoon };
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
    // A reply outside the verified audience is held to the day's count when it is queued, as one sent at once is.
    const open = config ? await openReplyEligibility(ctx, config, item, eligibility, pending.id) : { eligibility, openReply: false };
    meta.replyEligibility = open.eligibility;
    if (open.openReply) meta.openReply = true;
  }
  // What the sender will check on approval, checked now: credits that name nobody in the text are dropped, and a
  // text the publish gate refuses comes back to the agent as a tool error instead of failing after the creator's approval.
  let attributions: { username: string; sourceUrl: string }[];
  const threaded = action.tool === 'publish_post' && parts.length > 1;
  try {
    if (action.tool === 'publish_post' && threaded && scheduled) {
      // A scheduled thread: the gate over every part, as the send will run it again; the day's count and the turn's
      // own posts are questions about the time it goes out, which the scheduler asked and asks again at the send.
      attributions = await publishAttributions(ctx, agent.agentId, action.input.text, action.input.attributions, { original: true });
      const refused = threadRefusal(parts, attributions, { limits: threadLimits(ctx, agent), hasMedia: !!action.input.imageId, platform: agent.config.platform === true });
      if (refused) return { kind: 'failed', error: refused };
      meta.thread = action.input.thread;
    } else if (action.tool === 'publish_post' && (threaded || action.input.about)) {
      // A thread or a comment: the rules the broker applies before a send apply before the creator sees the item.
      const config = agentConfigOf(agent);
      if (!config) return { kind: 'failed', error: 'agent_not_ready: the agent has no X account yet; nothing was queued' };
      const checked = await originalRules(ctx, agent, config, pending.id, action.input, env.inbox, !!action.input.imageId);
      if ('refusal' in checked) return { kind: 'failed', error: checked.refusal };
      attributions = checked.attributions;
      if (threaded) meta.thread = action.input.thread;
      if (checked.about) meta.about = checked.about;
    } else {
      // An original post names with an `@` only who the mention audience allows; a reply is not touched (attributions.ts).
      attributions = await publishAttributions(ctx, agent.agentId, action.input.text, action.input.attributions, kind === 'post' ? { original: true } : {});
    }
  } catch (err) {
    if (err instanceof MentionError) return { kind: 'failed', error: err.message };
    throw err;
  }
  if (attributions.length) meta.attributions = attributions;
  if (action.tool === 'publish_post' && action.input.topic) meta.topic = action.input.topic;
  // A thread passed its own gate over every part above (`validateThread`); a single post passes the common one here.
  if (!threaded) {
    try {
      validatePost(action.input.text, attributions, kind === 'post' ? 'original' : 'short', !!action.input.imageId, { platform: agent.config.platform === true });
    } catch (err) {
      const code = err instanceof PolicyError ? err.code : 'invalid_post';
      return { kind: 'failed', error: `${code}: the post does not pass the publish gate; rewrite it` };
    }
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
  /** Approving a `bounty_payout`: the hash of the creator's own transaction that paid the winner (32-byte hex). */
  txHash?: unknown;
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

  // A bounty item (a job text under review, a payout proposal) is settled by bounties.ts: it posts the job, or records
  // the creator's payment and replies under the winning entry; the row here only carries the decision.
  if (row.kind === 'bounty_job' || row.kind === 'bounty_payout') {
    const result = await decideBountyApproval(ctx, agent, row, decision, by, note, body.txHash);
    if (!result.ok) {
      if (result.status === 409 && result.error === 'publish_failed') await ctx.db.update(approvals).set({ status: 'failed', decision: 'approve', decidedBy: by, note: result.message.slice(0, MAX_NOTE_CHARS), decidedAt: now }).where(eq(approvals.id, row.id));
      return reject(result.status, result.error, result.message);
    }
    const [updated] = await ctx.db.update(approvals).set(result.patch).where(eq(approvals.id, row.id)).returning();
    ctx.log.info({ agentId: agent.agentId, approvalId: row.id, kind: row.kind, decision, by }, 'bounty item decided by the creator');
    return { ok: true, approval: await viewOf(ctx, agent, updated!, false) };
  }

  if (isScheduledApproval(row)) return decideScheduled(ctx, agent, row, decision, by, note);
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
  const meta = row.meta as { replyAuthorId?: string; conversationId?: string; replyEligibility?: ReplyEligibility; attributions?: { username: string; sourceUrl: string }[]; openReply?: boolean; thread?: { text: string }[]; about?: CommentAbout; topic?: string };
  /** What became of the send: the sender's word for it, the post on X when it is known, and what the action row keeps. */
  let sent: { senderStatus: string; postId: string | null; result: Record<string, unknown> };
  if (row.kind === 'post') {
    // An original post, one or a thread, goes out through the one send of an original (post-send.ts): every part
    // through the publish gate, the quota and the opt-outs, nothing ever twice, a broken thread cut where it broke.
    const post: CommentedOriginal = {
      actionId: row.id,
      text: row.text,
      ...(meta.thread?.length ? { thread: meta.thread } : {}),
      ...(row.imageId ? { imageId: row.imageId } : {}),
      ...(meta.attributions ? { attributions: meta.attributions } : {}),
      ...(meta.about?.authorId ? { aboutAuthorId: meta.about.authorId } : {}),
    };
    const outcome = await postHooks.sendOriginal(ctx, agent, post);
    if (outcome.kind === 'failed') {
      if (retryableSend(outcome)) {
        // Nothing was recorded at the sender (its quota, a consent lookup, an account that is not connected): the item stays pending.
        ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, code: outcome.error.split(/\s/)[0] }, 'approved post could not be sent right now');
        return reject(503, 'sender_unavailable', `the post could not be sent right now (${outcome.error.replace(/^sender:/, '')}); try again`);
      }
      await ctx.db.update(approvals).set({ status: 'failed', decision: 'approve', decidedBy: by, note: outcome.error.slice(0, MAX_NOTE_CHARS), decidedAt: now }).where(eq(approvals.id, row.id));
      ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, error: outcome.error.split(/\s/)[0] }, 'approved post failed at the sender');
      return reject(409, 'publish_failed', `the sender refused the post: ${outcome.error.replace(/^sender_rejected:/, '')}`);
    }
    if (outcome.kind === 'unknown' && !/^sender_(held|pending)$/.test(outcome.error)) {
      // The sender did not answer: nothing is known sent, and approving again repeats the same ids (never a second post).
      ctx.log.warn({ agentId: agent.agentId, approvalId: row.id, error: outcome.error }, 'approved post could not be sent right now');
      return reject(503, 'sender_unavailable', outcome.error === 'storage_unavailable_after_send' ? `the post could not be sent right now (${outcome.error}); try again` : `the sender did not answer (${outcome.error}); try again`);
    }
    // completed, or held/pending at the sender: maybe published, never resent; the sender receipt keeps the truth.
    const result = (outcome.kind === 'completed' ? (outcome.result as OriginalResult & Record<string, unknown>) : {}) ?? {};
    sent = { senderStatus: outcome.kind === 'completed' ? 'sent' : outcome.error.replace(/^sender_/, ''), postId: typeof result.postId === 'string' ? result.postId : null, result: { ...result, ...(meta.about ? { about: meta.about } : {}) } };
  } else {
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
    const replyPostId = res.status === 'sent' ? (res.providerPostId ?? null) : null;
    sent = { senderStatus: res.status, postId: replyPostId, result: { ...(replyPostId ? { postId: replyPostId } : {}), ...(meta.replyAuthorId ? { replyAuthorId: meta.replyAuthorId } : {}), ...(meta.conversationId ? { conversationId: meta.conversationId } : {}), ...(meta.openReply ? { openReply: true } : {}) } };
  }

  const postId = sent.postId;
  const tool = row.kind === 'reply' ? 'publish_reply' : 'publish_post';
  await ctx.db
    .insert(actions)
    .values({
      actionId: `${row.id}-approved`,
      agentId: agent.agentId,
      cycleKey: `approval:${row.id}`,
      // The input as the agent gave it (section 17.4): a thread's later parts, the post a comment is about, its topic.
      action: { tool, input: { text: row.text, ...(meta.thread?.length ? { thread: meta.thread } : {}), ...(row.imageId ? { imageId: row.imageId } : {}), ...(row.inReplyTo ? { postId: row.inReplyTo } : {}), ...(meta.about ? { about: { postId: meta.about.postId } } : {}), ...(meta.topic ? { topic: meta.topic } : {}) }, approval: { id: row.id, by, note } },
      status: sent.senderStatus === 'sent' ? 'completed' : 'held',
      result: { ...sent.result, approvalId: row.id, senderStatus: sent.senderStatus },
      receipt: postId ? { postId } : null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();
  const [updated] = await ctx.db
    .update(approvals)
    .set({ status: 'approved', decision: 'approve', decidedBy: by, note: sent.senderStatus === 'sent' ? note : `${note ? `${note} · ` : ''}sender ${sent.senderStatus}`, postId, decidedAt: now })
    .where(eq(approvals.id, row.id))
    .returning();
  ctx.log.info({ agentId: agent.agentId, approvalId: row.id, by, postId, senderStatus: sent.senderStatus }, 'post approved by the creator and sent');
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
  const noun = (r: ApprovalRow) => (r.kind === 'reply' ? 'reply' : r.kind === 'bounty_job' ? 'bounty job' : r.kind === 'bounty_payout' ? 'bounty payout' : 'post');
  const items: { at: string; kind: 'approval_pending' | 'approval_approved' | 'approval_rejected'; summary: string; url?: string }[] = [];
  for (const r of pendingRows) items.push({ at: r.createdAt.toISOString(), kind: 'approval_pending', summary: `A ${noun(r)} is waiting for the creator's review` });
  for (const r of decidedRows) {
    const at = (r.decidedAt ?? r.createdAt).toISOString();
    // Bounty items have their own tape rows (bounties.ts `bountyActivity`: posted, paid, declined), so the queue stays quiet about them.
    if (r.kind === 'bounty_job' || r.kind === 'bounty_payout') continue;
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
