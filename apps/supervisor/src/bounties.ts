/**
 * Bounties, stage A (docs/design/agent-capabilities.md section 3.3; docs/STATUS.md section 3 item 3): the agent posts
 * a small job in public, code collects the replies when the window closes, the judge rules, and the verdict lands in
 * the creator's approval queue as a proposal the creator pays by hand from their own wallet. Nothing here moves money
 * and nothing touches the chain: no `open`, no `pay`, no userOp, no session rule. The only payment is the creator's
 * own transaction, reported back by its hash.
 *
 * Who decides what:
 *  - the **treasury turn** (roles.ts) calls `bounty_post` and `bounty_cancel`; the task text, the criteria, the kind,
 *    the amount and the window are its; everything else (the template, the checks, the publishing, the collection,
 *    the judgment, the proposal) is code;
 *  - the **social turn** sees replies to a job post as `bounty_entry`, never as mentions to answer (`inboxViews` with
 *    `bountyConversationIds`); `bounty_list` is its only bounty tool;
 *  - the **judge** (judge.ts) sees the criteria and the artefacts, nothing else, and names an entry, never a payment;
 *  - the **creator** approves the proposal with the paying transaction hash, or declines it.
 *
 * The entry rules (section 3.3 "How a delivery is read") are `evaluateEntries`, a pure function over what the sender
 * returned: one artefact of the job's kind, exactly one `0x` address, not the agent or the creator, an account at
 * least 30 days old, one entry per author, a shared address drops both, a repeated media drops the later one, the
 * address is not the kernel, the creator or the spender, and it was not paid inside the cooldown. The first 12
 * eligible by time are judged. Reply text is read for the address and thrown away: no row and no model ever holds it.
 *
 * Every step logs `jobId`, `status` and counts under `module: 'bounties'`, never a reply's text or an entry's address.
 */
import {
  BOUNTY_DEFAULT_HOURS_OPEN,
  BOUNTY_FORBIDDEN_WORDS,
  BOUNTY_MAX_AMOUNT_MICRO_USDC,
  BOUNTY_MAX_CONSIDERED,
  BOUNTY_MAX_HOURS_OPEN,
  BOUNTY_MIN_AMOUNT_MICRO_USDC,
  BOUNTY_MIN_HOURS_OPEN,
  BOUNTY_PAY_GRACE_MS,
  bountiesPolicySchema,
  countCashtags,
  DEFAULT_BOUNTIES_POLICY,
  postLength,
  postLimitsFor,
  postValidation,
  type ActionOutcome,
  type AgentConfig,
  type BountiesPolicy,
  type ToolInput,
} from '@bootr/agent-core';
import { IDENTITY_ENCODING, readBodyCapped } from '@bootr/shared/public-fetch';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { encodeAbiParameters, formatUnits, getAddress, isAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { approvals, bountyEntries, bountyJobs, type BountyDeliverable, type BountyJobStatus } from './db/schema.js';
import { JUDGE_MAX_EXCERPT_CHARS, JUDGE_MAX_IMAGE_BYTES, judgeJob, type JudgeEntry, type JudgeVerdict } from './judge.js';
import { raiseNotification } from './notifications.js';
import { agentConfigOf } from './onboarding.js';
import { originalPostGate } from './rhythm.js';
import { SenderError, type SenderConversationReply } from './sender-client.js';
import { assertPublicHost, htmlToText } from './web-reader.js';

export type BountyJobRow = typeof bountyJobs.$inferSelect;
export type BountyEntryRow = typeof bountyEntries.$inferSelect;

/** Statuses whose amount is reserved against the day's cap (a cancelled, expired or failed job releases it). */
export const RESERVED_STATUSES: readonly BountyJobStatus[] = ['draft', 'open', 'judging', 'proposed', 'paid', 'no_winner'];
/** Statuses that hold one of the agent's open-job slots. */
export const OPEN_STATUSES: readonly BountyJobStatus[] = ['draft', 'open', 'judging', 'proposed'];
/** Statuses `bountyJobClosed` (roles.ts) counts as "a job closed since the last treasury turn". */
export const CLOSED_FOR_TREASURY: readonly BountyJobStatus[] = ['proposed', 'no_winner', 'expired', 'failed'];
/** The conversations whose replies are entries, not mentions. */
export const ENTRY_STATUSES: readonly BountyJobStatus[] = ['open', 'judging'];

/** An account younger than this may not win (sybil rule). */
export const MIN_AUTHOR_AGE_MS = 30 * 24 * 3_600_000;
/** A draft that could not be posted within this long of its creation fails. */
export const DRAFT_TTL_MS = 24 * 3_600_000;
/** Collection attempts before a job fails, and the pause between two. */
export const MAX_COLLECT_ATTEMPTS = 5;
export const MAX_PUBLISH_ATTEMPTS = 12;
export const RETRY_AFTER_MS = 15 * 60_000;
/** Jobs the sweep moves per tick, so a tick stays short. */
export const MAX_JOBS_PER_SWEEP = 3;
/** An image artefact is read up to this (X's own photo limit); the judge takes JUDGE_MAX_IMAGE_BYTES of it. */
export const MAX_ARTEFACT_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_ARTEFACT_PAGE_BYTES = 1_000_000;
export const ARTEFACT_TIMEOUT_MS = 15_000;
/** The eligibility reason an entry's inbox item carries (inboxViews, mention-close). */
export const BOUNTY_ENTRY_REASON = 'bounty_entry';
/** The reason the template replies send as their reply eligibility (code text under a known post). */
const TEMPLATE_REPLY_REASON = 'bounty_template';

const DAY_MS = 24 * 3_600_000;
const MODULE = { module: 'bounties' } as const;

// ---------------------------------------------------------------------------
// Policy and budget
// ---------------------------------------------------------------------------

/** The policy in force for a parsed config: its block, or the defaults. */
export function bountiesPolicyOf(config: Pick<AgentConfig, 'bounties'>): BountiesPolicy {
  return config.bounties ?? DEFAULT_BOUNTIES_POLICY;
}

/** The stored `bounties` block of a raw config, or the defaults when missing or malformed (agent-config.ts). */
export function bountiesOf(raw: Record<string, unknown>): BountiesPolicy {
  const parsed = bountiesPolicySchema.safeParse(raw.bounties ?? {});
  return parsed.success ? parsed.data : DEFAULT_BOUNTIES_POLICY;
}

/** Start of the UTC day `now` falls in: the cap's fixed 24 hour grid. */
export function utcDayStart(now: number): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export interface BountyBudget {
  dailyCapMicroUsdc: bigint;
  reservedTodayMicroUsdc: bigint;
  remainingTodayMicroUsdc: bigint;
  dayEndsAt: number;
  openJobs: number;
  maxOpen: number;
}

/** What the day and the open-job cap still allow: reservations of jobs made today (UTC) that were not released. */
export async function bountyBudget(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, policy: BountiesPolicy): Promise<BountyBudget> {
  const now = ctx.now();
  const dayStart = new Date(utcDayStart(now));
  const [reserved] = await ctx.db
    .select({ sum: sql<string>`coalesce(sum(${bountyJobs.amountMicroUsdc}::numeric), 0)::text` })
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), inArray(bountyJobs.status, RESERVED_STATUSES), gte(bountyJobs.createdAt, dayStart)));
  const [open] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), inArray(bountyJobs.status, OPEN_STATUSES)));
  const spent = BigInt(String(reserved?.sum ?? '0').replace(/\.0+$/, ''));
  const cap = BigInt(policy.dailyCapMicroUsdc);
  return { dailyCapMicroUsdc: cap, reservedTodayMicroUsdc: spent, remainingTodayMicroUsdc: cap > spent ? cap - spent : 0n, dayEndsAt: utcDayStart(now) + DAY_MS, openJobs: Number(open?.n ?? 0), maxOpen: policy.maxOpen };
}

/** The budget as a model or the console sees it. */
export function bountyBudgetView(b: BountyBudget): Record<string, unknown> {
  return {
    dailyCapUsdc: usdc(b.dailyCapMicroUsdc),
    reservedTodayUsdc: usdc(b.reservedTodayMicroUsdc),
    remainingTodayUsdc: usdc(b.remainingTodayMicroUsdc),
    dayEndsAt: new Date(b.dayEndsAt).toISOString(),
    openJobs: b.openJobs,
    maxOpen: b.maxOpen,
  };
}

// ---------------------------------------------------------------------------
// Text: amounts, times, the templates and the job rules
// ---------------------------------------------------------------------------

/** "0.5", "1", "0.25": micro-USDC as the templates print it (at most two decimals). */
export function usdc(micro: bigint | string | number): string {
  const text = formatUnits(BigInt(micro), 6);
  const n = Number(text);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : text;
}

/** "2026-10-24 18:00 UTC". */
export function utcTime(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/**
 * The public handle of a job: `0x` and the first 16 hex characters of its id. The full id is a 32-byte hex, and the
 * publish gate (agent-core `outgoingDisclosureRisk`, applied here and again in the sender) refuses any 32-byte hex in
 * a post as secret material, so the job post, the page link and the proposal name the job by this prefix; the read
 * routes answer to either form.
 */
export function shortJobId(jobId: string): string {
  return jobId.slice(0, 18).toLowerCase();
}

export function coinPageLink(siteUrl: string, token: string, jobId: string): string {
  return `${siteUrl.replace(/\/$/, '')}/token/${token.toLowerCase()}#bounty-${shortJobId(jobId)}`;
}

export function replyLink(replyId: string): string {
  return `https://x.com/i/status/${replyId}`;
}

/** The explorer link of the creator's paying transaction (the same shape activity.ts uses; kept here so neither module needs the other). */
export function explorerTxUrl(chainId: number, txHash: string): string {
  return `${chainId === 8453 ? 'https://basescan.org' : 'https://sepolia.basescan.org'}/tx/${txHash}`;
}

const endsSentence = (s: string) => /[.!?…]$/.test(s.trim());

/** The job post, section 3.3 step 1, word for word; the task is the model's, everything else is code text. */
export function jobPostText(p: { task: string; amountMicroUsdc: bigint | string; deliverable: BountyDeliverable; closesAt: number; handle: string; link: string }): string {
  const task = p.task.trim();
  return `Bounty: ${task}${endsSentence(task) ? '' : '.'} ${usdc(p.amountMicroUsdc)} USDC to the best entry. Reply with your ${p.deliverable} and your Base address by ${utcTime(p.closesAt)}; the first ${BOUNTY_MAX_CONSIDERED} entries are considered. By replying you let @${p.handle} repost your entry with credit. Details: ${p.link}`;
}

/** The reply under the winning entry once the creator paid. */
export function paidReplyText(p: { amountMicroUsdc: bigint | string; reason: string; txUrl: string }): string {
  const reason = p.reason.trim().replace(/[.]+$/, '');
  return reason ? `Paid ${usdc(p.amountMicroUsdc)} USDC for this entry. Why: ${reason}. ${p.txUrl}` : `Paid ${usdc(p.amountMicroUsdc)} USDC for this entry. ${p.txUrl}`;
}

export const NO_WINNER_TEXT = 'No entry met the job; nothing paid.';
export const NOTHING_PAID_TEXT = 'Nothing paid.';
export const CANCELLED_TEXT = 'Cancelled by the agent.';

/** `BOUNTY_FORBIDDEN_WORDS` with their inflections ("posting", "promotion", "bought", "reposts"). */
const INFLECTIONS: Record<string, string[]> = {
  buy: ['buy', 'buys', 'buying', 'bought'],
  post: ['post', 'posts', 'posted', 'posting', 'repost', 'reposts', 'reposted', 'reposting'],
  tweet: ['tweet', 'tweets', 'tweeted', 'tweeting'],
  promote: ['promote', 'promotes', 'promoted', 'promoting', 'promotion', 'promotions'],
  shill: ['shill', 'shills', 'shilled', 'shilling'],
  follow: ['follow', 'follows', 'followed', 'following'],
  like: ['like', 'likes', 'liked', 'liking'],
  retweet: ['retweet', 'retweets', 'retweeted', 'retweeting'],
};
const FORBIDDEN_WORD = new RegExp(`\\b(?:${BOUNTY_FORBIDDEN_WORDS.flatMap((w) => INFLECTIONS[w] ?? [w]).join('|')})\\b`, 'i');
const ANY_ADDRESS = /0x[0-9a-fA-F]{40}/;

/**
 * Why a job may not be posted, or null. The task and the criteria may ask for work only (none of the promotion words,
 * decision 15), may name no address and no cashtag but the agent's own, and the whole post, template included, must
 * pass the publish gate (the platform rules for the platform agent) and fit the account's post length.
 */
export function jobTextProblem(p: { task: string; criteria: readonly string[]; text: string; attributions: { username: string; sourceUrl: string }[]; config: Pick<AgentConfig, 'platform' | 'token' | 'kernel'>; premium: boolean | null }): string | null {
  const own = `$${p.config.token.symbol}`.toUpperCase();
  for (const [what, value] of [['task', p.task], ...p.criteria.map((c, i) => [`criterion ${i + 1}`, c] as const)] as const) {
    const word = FORBIDDEN_WORD.exec(value);
    if (word) return `bounty_asks_for_promotion: the ${what} says "${word[0]}"; a job asks for work (a picture, a page, a comparison), never for a post, a tweet, a follow, a like, a repost or any promotion`;
    if (ANY_ADDRESS.test(value)) return `bounty_address_forbidden: the ${what} names an address; the entries carry the addresses, the job never does`;
    const tags = [...value.matchAll(/(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/gi)].map((m) => m[0].toUpperCase());
    if (tags.some((t) => t !== own)) return `bounty_cashtag_forbidden: the ${what} names a cashtag other than ${own}`;
  }
  if (countCashtags(p.text) > 1) return 'x_post_requires_at_most_one_cashtag: the job may name your own cashtag once at most';
  const gate = postValidation(p.text, p.attributions, 'original', false, { platform: p.config.platform === true, publicAddresses: [p.config.token.address, p.config.kernel.address] });
  if (!gate.ok) return `${gate.code}: the job post does not pass the publish gate; rewrite the task`;
  const limit = postLimitsFor(p.premium).original;
  const length = postLength(p.text);
  if (length > limit) return `bounty_post_too_long: the job post would be ${length} characters and this X account may send ${limit}; shorten the task by about ${length - limit} characters`;
  return null;
}

/** `keccak256(kernel, nonce, taskHash)`: the id of section 3.3, the one the contract of stage B will take. */
export function bountyJobId(kernel: Address, nonce: number, task: string): Hex {
  return keccak256(encodeAbiParameters(parseAbiParameters('address, uint256, bytes32'), [kernel, BigInt(nonce), keccak256(stringToHex(task))]));
}

/** Micro-USDC of a tool amount, or null when it is outside 0.1 to 1 USDC or has more than two decimals. */
export function amountMicroOf(amountUsdc: number): bigint | null {
  if (!Number.isFinite(amountUsdc)) return null;
  const cents = amountUsdc * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) return null;
  const micro = BigInt(Math.round(cents)) * 10_000n;
  if (micro < BigInt(BOUNTY_MIN_AMOUNT_MICRO_USDC) || micro > BigInt(BOUNTY_MAX_AMOUNT_MICRO_USDC)) return null;
  return micro;
}

const sha256Hex = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const publicAddressesOf = (config: Pick<AgentConfig, 'token' | 'kernel'>) => [config.token.address, config.kernel.address];
const failed = (error: string): ActionOutcome => ({ kind: 'failed', error });
const log = (ctx: Pick<SupervisorContext, 'log'>, agentId: string, job: Pick<BountyJobRow, 'id' | 'status'> | null, fields: Record<string, unknown>, msg: string) => ctx.log.info({ ...MODULE, agentId, ...(job ? { jobId: job.id, status: job.status } : {}), ...fields }, msg);

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/** A job of the agent by its full id, or by its public prefix (`shortJobId`); null when none or ambiguous. */
export async function jobById(ctx: Pick<SupervisorContext, 'db'>, agentId: string, jobId: string): Promise<BountyJobRow | null> {
  const id = jobId.toLowerCase();
  if (/^0x[0-9a-f]{64}$/.test(id)) return (await ctx.db.query.bountyJobs.findFirst({ where: and(eq(bountyJobs.id, id), eq(bountyJobs.agentId, agentId)) })) ?? null;
  if (!/^0x[0-9a-f]{16}$/.test(id)) return null;
  const rows = await ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), sql`${bountyJobs.id} like ${`${id}%`}`))
    .limit(2);
  return rows.length === 1 ? rows[0]! : null;
}

async function setJob(ctx: Pick<SupervisorContext, 'db' | 'now'>, jobId: string, patch: Partial<typeof bountyJobs.$inferInsert>): Promise<BountyJobRow> {
  const [row] = await ctx.db
    .update(bountyJobs)
    .set({ ...patch, updatedAt: new Date(ctx.now()) })
    .where(eq(bountyJobs.id, jobId))
    .returning();
  return row!;
}

/** Moves a job to a closing status and stamps `closedAt` (what `bountyJobClosed` reads). */
async function closeJob(ctx: Pick<SupervisorContext, 'db' | 'now'>, jobId: string, status: Extract<BountyJobStatus, 'proposed' | 'paid' | 'no_winner' | 'cancelled' | 'expired' | 'failed'>, patch: Partial<typeof bountyJobs.$inferInsert> = {}): Promise<BountyJobRow> {
  return setJob(ctx, jobId, { ...patch, status, closedAt: new Date(ctx.now()) });
}

/** The conversations of this agent's open and judging jobs: replies in them are entries, not mentions. */
export async function bountyConversationIds(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<Set<string>> {
  const rows = await ctx.db
    .select({ conversationId: bountyJobs.conversationId })
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), inArray(bountyJobs.status, ENTRY_STATUSES)));
  return new Set(rows.map((r) => r.conversationId).filter((id): id is string => typeof id === 'string' && id.length > 0));
}

/** Whether a job of this agent reached a closing status since `sinceMs` (roles.ts `bountyJobClosed`). */
export async function jobClosedSince(ctx: Pick<SupervisorContext, 'db'>, agentId: string, sinceMs: number): Promise<boolean> {
  const [row] = await ctx.db
    .select({ id: bountyJobs.id })
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), inArray(bountyJobs.status, CLOSED_FOR_TREASURY), sql`${bountyJobs.closedAt} > ${new Date(sinceMs)}`))
    .limit(1);
  return !!row;
}

// ---------------------------------------------------------------------------
// The approval queue: a job text under review, a payout proposal
// ---------------------------------------------------------------------------

export const reviewApprovalId = (actionId: string) => actionId;
export const payoutApprovalId = (jobId: string) => `bounty-pay-${jobId.slice(2, 34)}`;

export interface BountyApprovalMeta {
  bounty: 'job' | 'payout';
  jobId: string;
  task: string;
  amountMicroUsdc: string;
  payee?: string;
  reason?: string;
  replyId?: string;
  entryUrl?: string;
}

/** The `bounty` block of an approval view (approvals.ts), from the row's meta; null for a post or reply. */
export function bountyApprovalView(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const m = meta as Partial<BountyApprovalMeta> | null | undefined;
  if (!m || (m.bounty !== 'job' && m.bounty !== 'payout') || typeof m.jobId !== 'string') return null;
  return {
    kind: m.bounty,
    jobId: m.jobId,
    task: typeof m.task === 'string' ? m.task : '',
    amountUsdc: typeof m.amountMicroUsdc === 'string' ? usdc(m.amountMicroUsdc) : null,
    ...(m.bounty === 'payout' ? { payee: m.payee ?? null, reason: m.reason ?? null, entryUrl: m.entryUrl ?? null, txHashRequired: true } : {}),
  };
}

async function notifyReview(ctx: SupervisorContext, agentId: string): Promise<void> {
  try {
    const [row] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(approvals).where(and(eq(approvals.agentId, agentId), eq(approvals.status, 'pending_approval')));
    await raiseNotification(ctx, agentId, 'review_waiting', { pending: Number(row?.n ?? 0) });
  } catch (err) {
    ctx.log.warn({ ...MODULE, agentId, err }, 'review notification failed');
  }
}

// ---------------------------------------------------------------------------
// bounty_post
// ---------------------------------------------------------------------------

/** What the model is told about a job it posted or that waits (status, the id it can cancel by, no entry text). */
function postResult(job: BountyJobRow, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: job.id,
    status: job.status,
    task: job.task,
    amountUsdc: usdc(job.amountMicroUsdc),
    deliverable: job.deliverable,
    closesAt: job.closesAt.toISOString(),
    ...(job.postId ? { postId: job.postId, postUrl: replyLink(job.postId) } : {}),
    ...extra,
  };
}

const WAIT_NOTE = 'The job is posted by code when a slot opens; treat it as posted: do not post or rephrase it again.';

/**
 * `bounty_post` (treasury turn only; roles.ts). Idempotent on the action id: a resumed step finds its job. Checks in
 * order: the power, the amount, the window, the day's headroom and the open-job cap, the task rules and the gate; then
 * the row is written (the reservation starts here) and the job text goes to the creator's review (policy `review`) or
 * straight to X as one of the agent's original posts.
 */
export async function bountyPost(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, actionId: string, input: ToolInput<'bounty_post'>): Promise<ActionOutcome> {
  const existing = await ctx.db.query.bountyJobs.findFirst({ where: eq(bountyJobs.actionId, actionId) });
  if (existing) return outcomeOfJob(existing);
  if (config.capabilities.bounties !== true) return failed('bounties_power_off: bounties are switched off for this agent');
  const policy = bountiesPolicyOf(config);
  const amount = amountMicroOf(input.amountUsdc);
  if (amount === null) return failed(`bounty_amount_out_of_bounds: amountUsdc must be between ${usdc(BOUNTY_MIN_AMOUNT_MICRO_USDC)} and ${usdc(BOUNTY_MAX_AMOUNT_MICRO_USDC)} USDC with at most two decimals`);
  const hours = input.hoursOpen ?? policy.defaultHoursOpen ?? BOUNTY_DEFAULT_HOURS_OPEN;
  if (!Number.isInteger(hours) || hours < BOUNTY_MIN_HOURS_OPEN || hours > BOUNTY_MAX_HOURS_OPEN) return failed(`bounty_window_out_of_bounds: hoursOpen must be a whole number of hours between ${BOUNTY_MIN_HOURS_OPEN} and ${BOUNTY_MAX_HOURS_OPEN}`);
  const budget = await bountyBudget(ctx, agent.agentId, policy);
  if (budget.openJobs >= budget.maxOpen) return failed(`bounty_max_open_reached: ${budget.openJobs} of your ${budget.maxOpen} job slots are taken; wait for a job to close or cancel one`);
  if (amount > budget.remainingTodayMicroUsdc) return failed(`bounty_daily_cap_reached: ${usdc(budget.remainingTodayMicroUsdc)} USDC of your ${usdc(budget.dailyCapMicroUsdc)} USDC daily cap is left today (the day resets at ${new Date(budget.dayEndsAt).toISOString()})`);

  const now = ctx.now();
  const [count] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId));
  const nonce = Number(count?.n ?? 0) + 1;
  const task = input.task.trim();
  const criteria = input.criteria.map((c) => c.trim());
  const jobId = bountyJobId(agent.kernel as Address, nonce, task);
  const link = coinPageLink(ctx.config.SITE_URL, agent.token, jobId);
  const closesAt = now + hours * 3_600_000;
  const text = jobPostText({ task, amountMicroUsdc: amount, deliverable: input.deliverable, closesAt, handle: config.xHandle, link });
  const premium = (await ctx.sender.account(agent.agentId).catch(() => null))?.premium ?? null;
  const problem = jobTextProblem({ task, criteria, text, attributions: templateAttributions(config, link), config, premium });
  if (problem) return failed(problem);

  const [job] = await ctx.db
    .insert(bountyJobs)
    .values({ id: jobId, agentId: agent.agentId, actionId, nonce, task, criteria, deliverable: input.deliverable, amountMicroUsdc: amount.toString(), status: 'draft', createdAt: new Date(now), closesAt: new Date(closesAt), pageText: text, updatedAt: new Date(now) })
    .onConflictDoNothing()
    .returning();
  if (!job) return outcomeOfJob((await ctx.db.query.bountyJobs.findFirst({ where: eq(bountyJobs.actionId, actionId) }))!);
  log(ctx, agent.agentId, job, { amountMicroUsdc: amount.toString(), hours, deliverable: input.deliverable, review: policy.review }, 'bounty job drafted');

  if (policy.review) {
    const approvalId = reviewApprovalId(actionId);
    const meta: BountyApprovalMeta = { bounty: 'job', jobId, task, amountMicroUsdc: amount.toString() };
    await ctx.db
      .insert(approvals)
      .values({ id: approvalId, agentId: agent.agentId, kind: 'bounty_job', text, textHash: sha256Hex(text.replace(/\s+/g, ' ').trim().toLowerCase()), meta: meta as unknown as Record<string, unknown>, status: 'pending_approval', createdAt: new Date(now) })
      .onConflictDoNothing();
    const drafted = await setJob(ctx, jobId, { approvalId });
    await notifyReview(ctx, agent.agentId);
    return { kind: 'completed', result: postResult(drafted, { queued: true, approvalId, note: 'The job text waits for your creator\'s review and is posted by code once approved; treat it as posted: do not post or rephrase it again.' }) };
  }
  return publishJob(ctx, agent, config, job);
}

/** The outcome a `bounty_post` action maps to once its job row exists (a resumed or repeated step). */
export function outcomeOfJob(job: BountyJobRow): ActionOutcome {
  if (job.status === 'failed') return failed(`bounty_post_failed: ${job.error ?? 'the job post could not be published'}`);
  if (job.status === 'draft') return { kind: 'completed', result: postResult(job, { queued: true, ...(job.approvalId ? { approvalId: job.approvalId } : {}), note: WAIT_NOTE }) };
  return { kind: 'completed', result: postResult(job), ...(job.postId ? { receipt: { postId: job.postId } } : {}) };
}

const templateAttributions = (config: Pick<AgentConfig, 'xHandle'>, link: string) => [{ username: config.xHandle, sourceUrl: link }];

/**
 * Puts a drafted job on X as one of the agent's original posts (the platform rhythm and the sender's quota apply as to
 * any post). Idempotent on the sender action id `bounty:<jobId>:post`: a retry after an unknown outcome replays the
 * sender's receipt. A closed slot or a used-up quota leaves the job a draft with `publishNotBefore`, for the sweep.
 */
export async function publishJob(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow): Promise<ActionOutcome> {
  if (job.status !== 'draft') return outcomeOfJob(job);
  const now = ctx.now();
  const gate = await originalPostGate(ctx, now);
  if (!gate.open) {
    const waiting = await setJob(ctx, job.id, { publishNotBefore: new Date(Math.max(gate.hold.until, now + 60_000)) });
    log(ctx, agent.agentId, waiting, { reason: gate.hold.reason, until: new Date(gate.hold.until).toISOString() }, 'bounty job waits for a posting slot');
    return { kind: 'completed', result: postResult(waiting, { queued: true, waiting: gate.hold.reason, until: new Date(gate.hold.until).toISOString(), note: `${gate.hold.reason === 'quiet_hours' ? 'Original posts wait during quiet hours' : 'The posting window is full'}. ${WAIT_NOTE}` }) };
  }
  // The window is counted from the moment the post goes out, so a draft that waited keeps its full window.
  const hours = Math.max(BOUNTY_MIN_HOURS_OPEN, Math.round((job.closesAt.getTime() - job.createdAt.getTime()) / 3_600_000));
  const closesAt = now + hours * 3_600_000;
  const link = coinPageLink(ctx.config.SITE_URL, agent.token, job.id);
  const text = jobPostText({ task: job.task, amountMicroUsdc: job.amountMicroUsdc, deliverable: job.deliverable, closesAt, handle: config.xHandle, link });
  let res;
  try {
    res = await ctx.sender.publish({ agentId: agent.agentId, actionId: `bounty:${job.id}:post`, text, attributions: templateAttributions(config, link), publicAddresses: publicAddressesOf(config), xUserId: config.xUserId, ...(config.platform ? { platform: true } : {}) });
  } catch (err) {
    if (err instanceof SenderError && err.code === 'quota_exceeded') {
      const until = err.retryAt ?? now + 3_600_000;
      const waiting = await setJob(ctx, job.id, { publishNotBefore: new Date(until) });
      log(ctx, agent.agentId, waiting, { until: new Date(until).toISOString() }, 'bounty job waits for the X quota');
      return { kind: 'completed', result: postResult(waiting, { queued: true, waiting: 'x_quota', until: new Date(until).toISOString(), note: `Your posting budget for the day is used up until ${new Date(until).toISOString()}. ${WAIT_NOTE}` }) };
    }
    const transient = (err instanceof SenderError && err.retryable) || (err instanceof Error && /abort|timeout|fetch failed|ECONN|network/i.test(err.message));
    const error = err instanceof SenderError ? `sender:${err.code}` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
    if (transient && job.attempts + 1 < MAX_PUBLISH_ATTEMPTS) {
      const waiting = await setJob(ctx, job.id, { attempts: job.attempts + 1, publishNotBefore: new Date(now + RETRY_AFTER_MS), error });
      log(ctx, agent.agentId, waiting, { error, attempts: waiting.attempts }, 'bounty job post could not reach the sender; tried again later');
      return { kind: 'completed', result: postResult(waiting, { queued: true, waiting: 'sender', note: `The posting service did not take the job right now (${error}). ${WAIT_NOTE}` }) };
    }
    const dead = await closeJob(ctx, job.id, 'failed', { error, attempts: job.attempts + 1 });
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, error }, 'bounty job post failed; the job is closed');
    return outcomeOfJob(dead);
  }
  if (res.status === 'rejected') {
    const error = `sender_rejected:${res.receipt.error ?? 'rejected'}`;
    const dead = await closeJob(ctx, job.id, 'failed', { error });
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, error }, 'bounty job post refused by the sender; the job is closed');
    return outcomeOfJob(dead);
  }
  if (res.status !== 'sent' || !res.providerPostId) {
    // Held or pending: X may have the post. The same sender action id is asked again by the sweep; never a second post.
    const waiting = await setJob(ctx, job.id, { attempts: job.attempts + 1, publishNotBefore: new Date(now + RETRY_AFTER_MS), error: `sender_${res.status}` });
    log(ctx, agent.agentId, waiting, { senderStatus: res.status }, 'bounty job post outcome unknown; the receipt is read again later');
    return { kind: 'completed', result: postResult(waiting, { queued: true, waiting: 'sender_receipt', note: `X has not confirmed the job post yet. ${WAIT_NOTE}` }) };
  }
  const open = await setJob(ctx, job.id, { status: 'open', openedAt: new Date(now), closesAt: new Date(closesAt), postId: res.providerPostId, conversationId: res.providerPostId, pageText: text, publishNotBefore: null, error: null });
  log(ctx, agent.agentId, open, { postId: res.providerPostId, closesAt: new Date(closesAt).toISOString() }, 'bounty job posted');
  return { kind: 'completed', result: postResult(open, { note: 'Posted. Code collects the replies after the close time, judges them and proposes the payment to your creator; you will see the outcome in bounty_list. Never name a winner yourself.' }), receipt: { postId: res.providerPostId } };
}

// ---------------------------------------------------------------------------
// bounty_cancel and bounty_list
// ---------------------------------------------------------------------------

/** A template reply under one of the agent's own posts or under an entry; failures are logged and never thrown. */
async function templateReply(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, actionId: string, replyTo: string, text: string): Promise<string | null> {
  const gate = postValidation(text, [], 'short', false, { platform: config.platform === true, publicAddresses: publicAddressesOf(config) });
  if (!gate.ok) {
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, actionId, code: gate.code }, 'template reply refused by the publish gate; not sent');
    return null;
  }
  try {
    const res = await ctx.sender.publish({ agentId: agent.agentId, actionId, text, replyTo, replyEligibility: { eligible: true, reason: TEMPLATE_REPLY_REASON }, publicAddresses: publicAddressesOf(config), xUserId: config.xUserId, ...(config.platform ? { platform: true } : {}) });
    if (res.status === 'sent' && res.providerPostId) return res.providerPostId;
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, actionId, senderStatus: res.status, error: res.receipt.error ?? null }, 'template reply not confirmed');
    return null;
  } catch (err) {
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, actionId, error: err instanceof SenderError ? err.code : err instanceof Error ? err.message.split('\n')[0] : String(err) }, 'template reply failed');
    return null;
  }
}

/** `bounty_cancel` (treasury turn only): a draft or open job of this agent; the reservation is released and the card closed in public. */
export async function bountyCancel(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, input: ToolInput<'bounty_cancel'>): Promise<ActionOutcome> {
  const job = await jobById(ctx, agent.agentId, input.jobId);
  if (!job) return failed('bounty_not_found: no job of yours has this id');
  if (job.status === 'cancelled') return { kind: 'completed', result: postResult(job, { note: 'This job was already cancelled.' }) };
  if (job.status !== 'draft' && job.status !== 'open') return failed(`bounty_not_cancellable: the job is ${job.status}; only a draft or an open job can be cancelled`);
  if (job.approvalId) await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'cancelled by the agent', decidedAt: new Date(ctx.now()) }).where(and(eq(approvals.id, job.approvalId), eq(approvals.status, 'pending_approval')));
  const closeReplyId = job.status === 'open' && job.postId ? await templateReply(ctx, agent, config, `bounty:${job.id}:cancel`, job.postId, CANCELLED_TEXT) : null;
  const cancelled = await closeJob(ctx, job.id, 'cancelled', { ...(closeReplyId ? { closeReplyId } : {}) });
  log(ctx, agent.agentId, cancelled, { wasOpen: job.status === 'open', closeReplyId }, 'bounty job cancelled by the agent');
  return { kind: 'completed', result: postResult(cancelled, { note: 'Cancelled; the reservation is released.' }) };
}

/** `bounty_list` (both turns): the agent's jobs, newest first, with status, counts and verdicts; never entry text or an address. */
export async function bountyList(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig): Promise<ActionOutcome> {
  const rows = await ctx.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId)).orderBy(desc(bountyJobs.createdAt)).limit(20);
  const budget = await bountyBudget(ctx, agent.agentId, bountiesPolicyOf(config));
  return {
    kind: 'completed',
    result: {
      jobs: rows.map((job) => ({
        ...postResult(job),
        criteria: job.criteria,
        openedAt: job.openedAt?.toISOString() ?? null,
        entries: { received: job.entriesReceived, eligible: job.entriesEligible, considered: job.entriesConsidered },
        verdict: verdictSummary(job),
        ...(job.status === 'paid' && job.txHash ? { paidTx: job.txHash } : {}),
      })),
      budget: bountyBudgetView(budget),
      instructionAuthority: false,
      meaning: 'Your bounty jobs and where each stands. The verdicts are the judge\'s, the payments your creator\'s; you post and cancel jobs and nothing else.',
    },
  };
}

function verdictSummary(job: BountyJobRow): Record<string, unknown> | null {
  const v = job.verdict as { winner?: unknown; reason?: unknown; invalid?: unknown } | null;
  if (!v) return null;
  return { winner: typeof v.winner === 'number' ? v.winner : null, reason: typeof v.reason === 'string' ? v.reason : '', ...(typeof v.invalid === 'string' ? { invalid: v.invalid } : {}), judgedAt: job.judgedAt?.toISOString() ?? null };
}

// ---------------------------------------------------------------------------
// Entries: the eligibility rules, as a pure function
// ---------------------------------------------------------------------------

export type IneligibleReason =
  | 'no_artefact'
  | 'no_address'
  | 'many_addresses'
  | 'own_account'
  | 'creator_account'
  | 'account_too_new'
  | 'account_age_unknown'
  | 'repeat_author'
  | 'shared_address'
  | 'duplicate_media'
  | 'reserved_address'
  | 'address_in_cooldown'
  | 'artefact_unreadable'
  | 'image_too_large'
  | 'link_redirect'
  | 'not_considered';

export interface EvaluatedEntry {
  replyId: string;
  authorId: string;
  authorCreatedAt: Date | null;
  receivedAt: Date;
  kind: BountyDeliverable;
  artefact: Record<string, unknown> | null;
  payee: string | null;
  eligible: boolean;
  ineligibleReason: IneligibleReason | null;
}

export interface EligibilityContext {
  kind: BountyDeliverable;
  ownUserId: string;
  creatorUserId?: string | null | undefined;
  creatorHandle?: string | null | undefined;
  /** Addresses that may never be paid: the kernel, the creator, the spender. */
  reservedAddresses: readonly string[];
  /** Addresses paid inside the cooldown (lowercase or checksummed). */
  recentlyPaid: readonly string[];
  now: number;
}

const ADDRESS_G = /0x[0-9a-fA-F]{40}/g;

/** The one checksummed `0x` address of a reply text, or the reason there is none. */
export function addressOf(text: string): { payee: string } | { reason: 'no_address' | 'many_addresses' } {
  const found = [...new Set([...text.matchAll(ADDRESS_G)].map((m) => m[0].toLowerCase()))];
  if (found.length === 0) return { reason: 'no_address' };
  if (found.length > 1) return { reason: 'many_addresses' };
  const raw = found[0]!;
  if (!isAddress(raw)) return { reason: 'no_address' };
  return { payee: getAddress(raw) };
}

/** The artefact of the job's kind in a reply: the first photo, or the first expanded https url of a public-looking host. */
export function artefactOf(reply: SenderConversationReply, kind: BountyDeliverable): Record<string, unknown> | null {
  if (kind === 'image') {
    const photo = reply.media.find((m) => (m.type === null || m.type === 'photo') && typeof m.url === 'string' && /^https:\/\//.test(m.url));
    return photo ? { url: photo.url, mediaKey: photo.mediaKey } : null;
  }
  for (const u of reply.urls) {
    let url: URL;
    try {
      url = new URL(u.expandedUrl);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:' || url.username || url.password) continue;
    // X's own short links and the agent's own coin page are not deliverables.
    if (/^(?:www\.)?(?:t\.co|x\.com|twitter\.com)$/i.test(url.hostname)) continue;
    return { url: url.toString(), host: url.hostname.toLowerCase() };
  }
  return null;
}

/**
 * Section 3.3's rules over the collected replies, oldest first. Pure: no network, no database. Rules that need the
 * fetched bytes (a repeated media hash, an unreadable artefact, an oversized picture) are applied by `collectEntries`
 * once it fetches the considered candidates in order.
 */
export function evaluateEntries(replies: readonly SenderConversationReply[], c: EligibilityContext): EvaluatedEntry[] {
  const sorted = [...replies].sort((a, b) => {
    const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
    const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
    return ta - tb || (BigInt(a.id) < BigInt(b.id) ? -1 : 1);
  });
  const reserved = new Set(c.reservedAddresses.map((a) => a.toLowerCase()));
  const paid = new Set(c.recentlyPaid.map((a) => a.toLowerCase()));
  const creatorHandle = c.creatorHandle?.toLowerCase() ?? null;
  const seenAuthors = new Set<string>();
  const out: EvaluatedEntry[] = [];
  for (const reply of sorted) {
    const artefact = artefactOf(reply, c.kind);
    const address = addressOf(reply.text);
    const authorCreatedAt = reply.author?.createdAt ? new Date(reply.author.createdAt) : null;
    const base: EvaluatedEntry = {
      replyId: reply.id,
      authorId: reply.authorId,
      authorCreatedAt: authorCreatedAt && Number.isFinite(authorCreatedAt.getTime()) ? authorCreatedAt : null,
      receivedAt: new Date(reply.createdAt && Number.isFinite(Date.parse(reply.createdAt)) ? Date.parse(reply.createdAt) : c.now),
      kind: c.kind,
      artefact,
      payee: 'payee' in address ? address.payee : null,
      eligible: false,
      ineligibleReason: null,
    };
    const refuse = (reason: IneligibleReason) => out.push({ ...base, ineligibleReason: reason });
    if (!artefact) {
      refuse('no_artefact');
      continue;
    }
    if ('reason' in address) {
      refuse(address.reason);
      continue;
    }
    if (reply.authorId === c.ownUserId) {
      refuse('own_account');
      continue;
    }
    if ((c.creatorUserId && reply.authorId === c.creatorUserId) || (creatorHandle && reply.author?.username?.toLowerCase() === creatorHandle)) {
      refuse('creator_account');
      continue;
    }
    if (!base.authorCreatedAt) {
      refuse('account_age_unknown');
      continue;
    }
    if (c.now - base.authorCreatedAt.getTime() < MIN_AUTHOR_AGE_MS) {
      refuse('account_too_new');
      continue;
    }
    if (seenAuthors.has(reply.authorId)) {
      refuse('repeat_author');
      continue;
    }
    seenAuthors.add(reply.authorId);
    const payee = address.payee.toLowerCase();
    if (reserved.has(payee)) {
      refuse('reserved_address');
      continue;
    }
    if (paid.has(payee)) {
      refuse('address_in_cooldown');
      continue;
    }
    out.push({ ...base, eligible: true });
  }
  // The same address in two authors' entries drops both (whatever else they did right).
  const byPayee = new Map<string, EvaluatedEntry[]>();
  for (const e of out) {
    if (!e.eligible || !e.payee) continue;
    const key = e.payee.toLowerCase();
    byPayee.set(key, [...(byPayee.get(key) ?? []), e]);
  }
  for (const group of byPayee.values()) {
    if (new Set(group.map((e) => e.authorId)).size < 2) continue;
    for (const e of group) {
      e.eligible = false;
      e.ineligibleReason = 'shared_address';
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Artefacts: bounded fetches, checked before the judge sees them
// ---------------------------------------------------------------------------

export type ImageSniff = { mime: 'image/png' | 'image/jpeg' | 'image/webp' } | null;

/** The picture's type from its first bytes (PNG, JPEG, WEBP); null for anything else. The judge gets nothing unsniffed. */
export function sniffImage(bytes: Uint8Array): ImageSniff {
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a && bytes[12] === 0x49 && bytes[13] === 0x48 && bytes[14] === 0x44 && bytes[15] === 0x52) return { mime: 'image/png' };
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { mime: 'image/jpeg' };
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return { mime: 'image/webp' };
  return null;
}

export type FetchedArtefact = { ok: true; kind: 'image'; mime: string; bytes: Uint8Array; sha256: string } | { ok: true; kind: 'link'; excerpt: string; sha256: string } | { ok: false; reason: 'artefact_unreadable' | 'image_too_large' | 'link_redirect' };

/**
 * Reads one artefact under the `public-fetch` rules: public https host, no redirects followed, bytes capped. A picture
 * is accepted only when its bytes sniff as PNG, JPEG or WEBP and fit the judge's size; a page becomes the web-reader's
 * plain text cut to the judge's excerpt size.
 */
export async function fetchArtefact(ctx: Pick<SupervisorContext, 'fetch' | 'resolveHost'>, kind: BountyDeliverable, url: string): Promise<FetchedArtefact> {
  let target: URL;
  try {
    target = new URL(url);
    if (target.protocol !== 'https:' || target.username || target.password) return { ok: false, reason: 'artefact_unreadable' };
    await assertPublicHost(target.hostname, ctx.resolveHost);
  } catch {
    return { ok: false, reason: 'artefact_unreadable' };
  }
  let res: Response;
  try {
    res = await ctx.fetch(target.toString(), { redirect: 'manual', headers: { 'user-agent': 'BootrAgent/1.0 (+https://bootr.fun)', accept: kind === 'image' ? 'image/*' : 'text/html,application/json,text/plain;q=0.9,*/*;q=0.5', ...IDENTITY_ENCODING }, signal: AbortSignal.timeout(ARTEFACT_TIMEOUT_MS) });
  } catch {
    return { ok: false, reason: 'artefact_unreadable' };
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'link_redirect' };
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'artefact_unreadable' };
  }
  if (kind === 'image') {
    const { bytes, exceeded } = await readBodyCapped(res, MAX_ARTEFACT_IMAGE_BYTES);
    if (exceeded || bytes.byteLength === 0) return { ok: false, reason: exceeded ? 'image_too_large' : 'artefact_unreadable' };
    if (bytes.byteLength > JUDGE_MAX_IMAGE_BYTES) return { ok: false, reason: 'image_too_large' };
    const sniff = sniffImage(bytes);
    if (!sniff) return { ok: false, reason: 'artefact_unreadable' };
    return { ok: true, kind: 'image', mime: sniff.mime, bytes, sha256: sha256Hex(bytes) };
  }
  const { bytes } = await readBodyCapped(res, MAX_ARTEFACT_PAGE_BYTES);
  const body = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('utf8');
  const contentType = res.headers.get('content-type');
  const isHtml = !contentType || /html|xml/i.test(contentType);
  const text = (isHtml ? htmlToText(body) : body.replace(/\s+/g, ' ').trim()).slice(0, JUDGE_MAX_EXCERPT_CHARS);
  if (!text.trim()) return { ok: false, reason: 'artefact_unreadable' };
  return { ok: true, kind: 'link', excerpt: text, sha256: sha256Hex(text) };
}

/** sha256 of the bundle the judge saw, in entry order: `n`, kind and the artefact's own hash. */
export function deliveryHashOf(bundle: readonly { n: number; kind: BountyDeliverable; sha256: string }[]): string {
  return sha256Hex(JSON.stringify(bundle.map((b) => [b.n, b.kind, b.sha256])));
}

// ---------------------------------------------------------------------------
// Collection and judgment
// ---------------------------------------------------------------------------

/** Addresses paid by this agent inside the cooldown (`paid` jobs' payees). */
async function recentlyPaid(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, cooldownSeconds: number): Promise<string[]> {
  if (cooldownSeconds <= 0) return [];
  const rows = await ctx.db
    .select({ payee: bountyJobs.payee })
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), eq(bountyJobs.status, 'paid'), gte(bountyJobs.paidAt, new Date(ctx.now() - cooldownSeconds * 1000))));
  return rows.map((r) => r.payee).filter((p): p is string => typeof p === 'string');
}

export interface CollectResult {
  job: BountyJobRow;
  verdict: JudgeVerdict | null;
}

/**
 * One closed job, end to end: the replies through the sender, the rules, the artefacts of the first 12 eligible
 * (an unreadable or duplicate one is marked and the next eligible takes its place), the judge, the verdict with its
 * hashes, then the proposal or the public close. Resumable: entry rows are rewritten, the judge replays by its key.
 * A failure before the verdict leaves the job `judging` for the next tick (bounded by MAX_COLLECT_ATTEMPTS).
 */
export async function collectAndJudge(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job0: BountyJobRow): Promise<CollectResult> {
  const now = ctx.now();
  const job = job0.status === 'open' ? await setJob(ctx, job0.id, { status: 'judging', attempts: job0.attempts + 1 }) : await setJob(ctx, job0.id, { attempts: job0.attempts + 1 });
  if (!job.conversationId) return { job: await closeJob(ctx, job.id, 'failed', { error: 'no_conversation' }), verdict: null };
  const policy = bountiesPolicyOf(config);

  const replies = (await ctx.sender.readReplies(agent.agentId, job.conversationId)).items;
  const reserved = [agent.kernel, agent.creator, ...(agent.spender ? [agent.spender] : []), ctx.spenderFor(agent).address];
  const evaluated = evaluateEntries(replies, {
    kind: job.deliverable,
    ownUserId: config.xUserId,
    creatorUserId: config.creator.xUserId ?? null,
    creatorHandle: config.creator.xHandle ?? null,
    reservedAddresses: reserved,
    recentlyPaid: await recentlyPaid(ctx, agent.agentId, policy.cooldownSeconds),
    now,
  });

  // The considered set: the first 12 eligible by time whose artefact reads and is not a repeat; others are marked.
  const considered: { entry: EvaluatedEntry; fetched: Extract<FetchedArtefact, { ok: true }>; n: number }[] = [];
  const seenHashes = new Set<string>();
  const seenUrls = new Set<string>();
  for (const entry of evaluated) {
    if (!entry.eligible) continue;
    if (considered.length >= BOUNTY_MAX_CONSIDERED) {
      entry.eligible = true;
      entry.ineligibleReason = 'not_considered';
      continue;
    }
    const url = String(entry.artefact?.url ?? '');
    if (seenUrls.has(url)) {
      entry.eligible = false;
      entry.ineligibleReason = 'duplicate_media';
      continue;
    }
    seenUrls.add(url);
    const fetched = await fetchArtefact(ctx, job.deliverable, url);
    if (!fetched.ok) {
      entry.eligible = false;
      entry.ineligibleReason = fetched.reason;
      continue;
    }
    if (seenHashes.has(fetched.sha256)) {
      entry.eligible = false;
      entry.ineligibleReason = 'duplicate_media';
      continue;
    }
    seenHashes.add(fetched.sha256);
    if (fetched.kind === 'image') entry.artefact = { ...entry.artefact, sha256: fetched.sha256 };
    considered.push({ entry, fetched, n: considered.length + 1 });
  }

  // The rows: rewritten whole, so a resumed collection leaves no stale entry behind.
  await ctx.db.delete(bountyEntries).where(eq(bountyEntries.jobId, job.id));
  if (evaluated.length) {
    await ctx.db.insert(bountyEntries).values(
      evaluated.map((e) => {
        const c = considered.find((x) => x.entry === e);
        return {
          id: `${job.id}:${e.replyId}`,
          jobId: job.id,
          agentId: agent.agentId,
          replyId: e.replyId,
          authorId: e.authorId,
          authorCreatedAt: e.authorCreatedAt,
          receivedAt: e.receivedAt,
          kind: e.kind,
          artefact: e.artefact,
          payee: e.payee,
          eligible: e.eligible,
          ineligibleReason: e.ineligibleReason,
          considered: !!c,
          n: c?.n ?? null,
          createdAt: new Date(now),
        };
      }),
    );
  }
  const counts = { entriesReceived: evaluated.length, entriesEligible: evaluated.filter((e) => e.eligible).length, entriesConsidered: considered.length };
  await setJob(ctx, job.id, counts);
  log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { ...counts, reasons: reasonCounts(evaluated) }, 'bounty entries collected');

  if (considered.length === 0) {
    const verdict = { winner: null, perCriterion: {}, reason: '', invalid: 'no_entries', deliveryHash: deliveryHashOf([]), reasonHash: sha256Hex(''), judgedAt: new Date(now).toISOString() };
    return { job: await closeUnpaid(ctx, agent, config, job, verdict, NO_WINNER_TEXT), verdict: null };
  }

  const entries: JudgeEntry[] = considered.map((c) => (c.fetched.kind === 'image' ? { n: c.n, kind: 'image', image: { mime: c.fetched.mime, bytes: c.fetched.bytes } } : { n: c.n, kind: 'link', excerpt: c.fetched.excerpt }));
  const verdict = await judgeJob(ctx, agent, config, { jobId: job.id, task: job.task, criteria: job.criteria, entries });
  if (verdict.invalid === 'thought_pending') {
    log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { key: verdict.thought.key }, 'judge thought pending; the job stays judging');
    return { job: await jobByIdOrThrow(ctx, job.id), verdict };
  }
  const deliveryHash = deliveryHashOf(considered.map((c) => ({ n: c.n, kind: c.fetched.kind, sha256: c.fetched.sha256 })));
  const stored = { winner: verdict.winner, perCriterion: verdict.perCriterion, reason: verdict.reason, ...(verdict.invalid ? { invalid: verdict.invalid } : {}), deliveryHash, reasonHash: sha256Hex(verdict.reason), judgedAt: new Date(ctx.now()).toISOString(), thought: verdict.thought };
  log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { winner: verdict.winner, invalid: verdict.invalid ?? null, deliveryHash, outcome: verdict.thought.outcome }, 'bounty judged');

  if (verdict.invalid || verdict.winner === null) return { job: await closeUnpaid(ctx, agent, config, job, stored, NO_WINNER_TEXT), verdict };
  const winner = considered.find((c) => c.n === verdict.winner);
  if (!winner?.entry.payee) return { job: await closeUnpaid(ctx, agent, config, job, { ...stored, invalid: 'winner_without_payee' }, NO_WINNER_TEXT), verdict };

  // The proposal: the payee from the entry record, never from the judge's text.
  const approvalId = payoutApprovalId(job.id);
  const entryUrl = replyLink(winner.entry.replyId);
  const meta: BountyApprovalMeta = { bounty: 'payout', jobId: job.id, task: job.task, amountMicroUsdc: job.amountMicroUsdc, payee: winner.entry.payee, reason: verdict.reason, replyId: winner.entry.replyId, entryUrl };
  const text = `Pay ${usdc(job.amountMicroUsdc)} USDC to ${winner.entry.payee} for entry ${entryUrl} of job ${shortJobId(job.id)}. Why: ${verdict.reason}`;
  await ctx.db
    .insert(approvals)
    .values({ id: approvalId, agentId: agent.agentId, kind: 'bounty_payout', text, textHash: sha256Hex(text), meta: meta as unknown as Record<string, unknown>, status: 'pending_approval', createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  const proposed = await closeJob(ctx, job.id, 'proposed', { verdict: stored, judgedAt: new Date(ctx.now()), payee: winner.entry.payee, approvalId });
  await notifyReview(ctx, agent.agentId);
  log(ctx, agent.agentId, proposed, { approvalId, winner: verdict.winner }, 'bounty payout proposed to the creator');
  return { job: proposed, verdict };
}

async function jobByIdOrThrow(ctx: Pick<SupervisorContext, 'db'>, jobId: string): Promise<BountyJobRow> {
  const row = await ctx.db.query.bountyJobs.findFirst({ where: eq(bountyJobs.id, jobId) });
  if (!row) throw new Error(`bounty job ${jobId} vanished`);
  return row;
}

function reasonCounts(entries: readonly { eligible: boolean; ineligibleReason: string | null }[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of entries) if (e.ineligibleReason && !(e.eligible && e.ineligibleReason === 'not_considered')) out[e.ineligibleReason] = (out[e.ineligibleReason] ?? 0) + 1;
  return out;
}

/** Closes a job unpaid (`no_winner`) with its verdict and the template reply under the job post. */
async function closeUnpaid(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow, verdict: Record<string, unknown>, text: string): Promise<BountyJobRow> {
  const closeReplyId = job.postId ? await templateReply(ctx, agent, config, `bounty:${job.id}:close`, job.postId, text) : null;
  const closed = await closeJob(ctx, job.id, 'no_winner', { verdict, judgedAt: new Date(ctx.now()), ...(closeReplyId ? { closeReplyId } : {}) });
  log(ctx, agent.agentId, closed, { invalid: verdict.invalid ?? null, closeReplyId }, 'bounty job closed without a winner');
  return closed;
}

// ---------------------------------------------------------------------------
// The creator's decision on a bounty approval (approvals.ts hands these kinds here)
// ---------------------------------------------------------------------------

export type BountyDecision = { ok: true; patch: Partial<typeof approvals.$inferInsert> } | { ok: false; status: 400 | 409; error: string; message: string };

/**
 * `bounty_job`: approve posts the job now (or leaves it waiting for a slot), reject cancels it. `bounty_payout`:
 * approve needs `txHash`, the creator's own paying transaction (checked as 32-byte hex, not on chain: stage A takes
 * the creator at their word and shows the hash in public), closes the job `paid` and replies under the winning entry;
 * reject closes it `no_winner` with "Nothing paid." in public. Returns the patch for the approval row.
 */
export async function decideBountyApproval(ctx: SupervisorContext, agent: AgentRow, row: typeof approvals.$inferSelect, decision: 'approve' | 'reject', by: string, note: string | null, txHashRaw: unknown): Promise<BountyDecision> {
  const meta = row.meta as Partial<BountyApprovalMeta>;
  const jobId = typeof meta.jobId === 'string' ? meta.jobId : null;
  const job = jobId ? await jobById(ctx, agent.agentId, jobId) : null;
  if (!job) return { ok: false, status: 409, error: 'bounty_job_missing', message: 'the job of this item no longer exists' };
  const config = agentConfigOf(agent);
  if (!config) return { ok: false, status: 409, error: 'agent_not_ready', message: 'the agent has no X account yet' };
  const now = new Date(ctx.now());

  if (row.kind === 'bounty_job') {
    if (job.status !== 'draft') return { ok: false, status: 409, error: 'bounty_not_draft', message: `the job is ${job.status}` };
    if (decision === 'reject') {
      const cancelled = await closeJob(ctx, job.id, 'cancelled', { error: 'declined by the creator' });
      log(ctx, agent.agentId, cancelled, { by }, 'bounty job text declined by the creator');
      return { ok: true, patch: { status: 'rejected', decision: 'reject', decidedBy: by, note, decidedAt: now } };
    }
    const outcome = await publishJob(ctx, agent, config, job);
    const after = await jobByIdOrThrow(ctx, job.id);
    if (outcome.kind === 'failed' || after.status === 'failed') return { ok: false, status: 409, error: 'publish_failed', message: after.error ?? (outcome.kind === 'failed' ? outcome.error : 'the job post failed') };
    const waiting = after.status === 'draft';
    return { ok: true, patch: { status: 'approved', decision: 'approve', decidedBy: by, note: waiting ? `${note ? `${note} · ` : ''}waits for a posting slot` : note, postId: after.postId ?? null, decidedAt: now } };
  }

  if (job.status !== 'proposed') return { ok: false, status: 409, error: 'bounty_not_proposed', message: `the job is ${job.status}` };
  if (decision === 'reject') {
    const closeReplyId = job.postId ? await templateReply(ctx, agent, config, `bounty:${job.id}:close`, job.postId, NOTHING_PAID_TEXT) : null;
    const closed = await closeJob(ctx, job.id, 'no_winner', { error: 'declined by the creator', ...(closeReplyId ? { closeReplyId } : {}) });
    log(ctx, agent.agentId, closed, { by, closeReplyId }, 'bounty payout declined by the creator');
    return { ok: true, patch: { status: 'rejected', decision: 'reject', decidedBy: by, note, decidedAt: now } };
  }
  const txHash = typeof txHashRaw === 'string' ? txHashRaw.trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, status: 400, error: 'tx_hash_required', message: 'approving a bounty payout needs txHash, the hash of the transaction that paid the winner' };
  const payee = typeof meta.payee === 'string' && meta.payee === job.payee ? job.payee : null;
  if (!payee) return { ok: false, status: 409, error: 'bounty_payee_mismatch', message: 'the proposal and the job disagree on the payee' };
  const paid = await setJob(ctx, job.id, { status: 'paid', txHash, paidAt: now });
  const reason = typeof meta.reason === 'string' ? meta.reason : '';
  const paidReplyId = typeof meta.replyId === 'string' ? await templateReply(ctx, agent, config, `bounty:${job.id}:paid`, meta.replyId, paidReplyText({ amountMicroUsdc: job.amountMicroUsdc, reason, txUrl: explorerTxUrl(ctx.chain.chainId, txHash) })) : null;
  const done = paidReplyId ? await setJob(ctx, job.id, { paidReplyId }) : paid;
  log(ctx, agent.agentId, done, { by, txHash, paidReplyId }, 'bounty paid by the creator');
  return { ok: true, patch: { status: 'approved', decision: 'approve', decidedBy: by, note, postId: paidReplyId, decidedAt: now } };
}

// ---------------------------------------------------------------------------
// The sweep (tick.ts)
// ---------------------------------------------------------------------------

export interface BountySweepReport {
  posted: number;
  judged: number;
  expired: number;
  failed: number;
}

/**
 * Every tick: drafts whose wait is over are posted (or fail after DRAFT_TTL_MS), open jobs past their close time are
 * collected and judged (a `judging` job left by a crash is resumed), proposals nobody acted on in 48 hours expire with
 * their approval withdrawn. At most MAX_JOBS_PER_SWEEP jobs move per tick; an error on one job is logged and counted
 * against its attempts, never thrown.
 */
export async function sweepBounties(ctx: SupervisorContext): Promise<BountySweepReport> {
  const report: BountySweepReport = { posted: 0, judged: 0, expired: 0, failed: 0 };
  const now = ctx.now();
  const agentsById = new Map<string, AgentRow | null>();
  const agentFor = async (agentId: string): Promise<AgentRow | null> => {
    if (!agentsById.has(agentId)) agentsById.set(agentId, (await ctx.db.query.agents.findFirst({ where: (t, { eq: eqf }) => eqf(t.agentId, agentId) })) ?? null);
    return agentsById.get(agentId) ?? null;
  };
  let moved = 0;

  // 1. Drafts: a review that was declined or expired cancels the job; an approved one, or no review, posts it.
  const drafts = await ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.status, 'draft'), or(isNull(bountyJobs.publishNotBefore), lte(bountyJobs.publishNotBefore, new Date(now)))))
    .orderBy(asc(bountyJobs.createdAt))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of drafts) {
    if (moved >= MAX_JOBS_PER_SWEEP) break;
    try {
      if (job.approvalId) {
        const approval = await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, job.approvalId) });
        if (!approval || approval.status === 'pending_approval') continue;
        if (approval.status === 'rejected' || approval.status === 'failed') {
          await closeJob(ctx, job.id, 'cancelled', { error: approval.note ? `review: ${approval.note}` : 'review declined' });
          moved += 1;
          continue;
        }
      }
      if (now - job.createdAt.getTime() > DRAFT_TTL_MS) {
        await closeJob(ctx, job.id, 'failed', { error: 'draft_expired: no posting slot within a day' });
        report.failed += 1;
        moved += 1;
        continue;
      }
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      if (!agent || !config) continue;
      const outcome = await publishJob(ctx, agent, config, job);
      moved += 1;
      const after = await jobByIdOrThrow(ctx, job.id);
      if (after.status === 'open') report.posted += 1;
      else if (after.status === 'failed' || outcome.kind === 'failed') report.failed += 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty draft sweep failed for one job');
    }
  }

  // 2. Closed windows: collect and judge; resumed `judging` rows first (they already count an attempt).
  const due = await ctx.db
    .select()
    .from(bountyJobs)
    .where(or(eq(bountyJobs.status, 'judging'), and(eq(bountyJobs.status, 'open'), lte(bountyJobs.closesAt, new Date(now)))))
    .orderBy(asc(bountyJobs.closesAt))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of due) {
    if (moved >= MAX_JOBS_PER_SWEEP) break;
    if (job.status === 'judging' && job.attempts > 0 && now - job.updatedAt.getTime() < RETRY_AFTER_MS) continue;
    moved += 1;
    if (job.attempts >= MAX_COLLECT_ATTEMPTS) {
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      const closeReplyId = agent && config && job.postId ? await templateReply(ctx, agent, config, `bounty:${job.id}:close`, job.postId, NOTHING_PAID_TEXT) : null;
      await closeJob(ctx, job.id, 'failed', { error: `collection_failed after ${job.attempts} attempts${job.error ? `: ${job.error}` : ''}`, ...(closeReplyId ? { closeReplyId } : {}) });
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, attempts: job.attempts }, 'bounty collection gave up; the job is closed unpaid');
      report.failed += 1;
      continue;
    }
    const agent = await agentFor(job.agentId);
    const config = agent ? agentConfigOf(agent) : null;
    if (!agent || !config) {
      await closeJob(ctx, job.id, 'failed', { error: 'agent_not_ready' });
      report.failed += 1;
      continue;
    }
    try {
      const { job: after } = await collectAndJudge(ctx, agent, config, job);
      if (after.status !== 'judging') report.judged += 1;
    } catch (err) {
      const error = err instanceof SenderError ? `sender:${err.code}` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
      await setJob(ctx, job.id, { error }).catch(() => undefined);
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, error, attempts: job.attempts + 1 }, 'bounty collection failed; tried again next tick');
    }
  }

  // 3. Proposals nobody acted on: withdrawn after the grace, the job expires unpaid.
  const stale = await ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.status, 'proposed'), lte(bountyJobs.closedAt, new Date(now - BOUNTY_PAY_GRACE_MS))))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of stale) {
    try {
      if (job.approvalId) await ctx.db.update(approvals).set({ status: 'rejected', decision: 'reject', decidedBy: 'system', note: 'expired', decidedAt: new Date(now) }).where(and(eq(approvals.id, job.approvalId), eq(approvals.status, 'pending_approval')));
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      const closeReplyId = agent && config && job.postId ? await templateReply(ctx, agent, config, `bounty:${job.id}:close`, job.postId, NOTHING_PAID_TEXT) : null;
      const expired = await closeJob(ctx, job.id, 'expired', { error: 'proposal not acted on within 48 hours', ...(closeReplyId ? { closeReplyId } : {}) });
      log(ctx, job.agentId, expired, { closeReplyId }, 'bounty proposal expired unpaid');
      report.expired += 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty expiry failed for one job');
    }
  }
  if (report.posted || report.judged || report.expired || report.failed) ctx.log.info({ ...MODULE, ...report }, 'bounty sweep');
  return report;
}

// ---------------------------------------------------------------------------
// Public reads (api.ts): what the coin page shows, and nothing more
// ---------------------------------------------------------------------------

export interface BountyJobView {
  id: string;
  /** The public prefix of the id, what the job post's link and the page anchor carry (`#bounty-<shortId>`). */
  shortId: string;
  status: BountyJobStatus;
  task: string;
  criteria: string[];
  deliverable: BountyDeliverable;
  amountUsdc: string;
  amountMicroUsdc: string;
  createdAt: string;
  /** When the job post went out; null for a draft. */
  postedAt: string | null;
  closesAt: string;
  postUrl: string | null;
  pageUrl: string;
  pageText: string;
  entries: { received: number; eligible: number; considered: number; ineligible: Record<string, number> };
  verdict: { winner: number | null; winningEntryUrl: string | null; perCriterion: Record<string, string[]>; reason: string; invalid: string | null; deliveryHash: string | null; reasonHash: string | null; judgedAt: string | null } | null;
  payment: { status: 'proposed' | 'paid'; payee: string; amountUsdc: string; txHash: string | null; txUrl: string | null; replyUrl: string | null; paidAt: string | null } | null;
  closedAt: string | null;
  closeReplyUrl: string | null;
}

export async function bountyJobViews(ctx: SupervisorContext, agent: AgentRow, opts: { limit?: number; jobId?: string } = {}): Promise<BountyJobView[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const rows = opts.jobId ? [await jobById(ctx, agent.agentId, opts.jobId)].filter((r): r is BountyJobRow => !!r) : await ctx.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId)).orderBy(desc(bountyJobs.createdAt)).limit(limit);
  if (!rows.length) return [];
  const entryRows = await ctx.db
    .select({ jobId: bountyEntries.jobId, replyId: bountyEntries.replyId, eligible: bountyEntries.eligible, ineligibleReason: bountyEntries.ineligibleReason, n: bountyEntries.n })
    .from(bountyEntries)
    .where(inArray(bountyEntries.jobId, rows.map((r) => r.id)));
  return rows.map((job) => {
    const entries = entryRows.filter((e) => e.jobId === job.id);
    const v = job.verdict as { winner?: unknown; perCriterion?: unknown; reason?: unknown; invalid?: unknown; deliveryHash?: unknown; reasonHash?: unknown } | null;
    const winner = v && typeof v.winner === 'number' ? v.winner : null;
    const winning = winner !== null ? entries.find((e) => e.n === winner) : undefined;
    const ineligible: Record<string, number> = {};
    for (const e of entries) if (e.ineligibleReason && !(e.eligible && e.ineligibleReason === 'not_considered')) ineligible[e.ineligibleReason] = (ineligible[e.ineligibleReason] ?? 0) + 1;
    const notConsidered = entries.filter((e) => e.eligible && e.ineligibleReason === 'not_considered').length;
    if (notConsidered) ineligible.not_considered = notConsidered;
    return {
      id: job.id,
      shortId: shortJobId(job.id),
      status: job.status,
      task: job.task,
      criteria: job.criteria,
      deliverable: job.deliverable,
      amountUsdc: usdc(job.amountMicroUsdc),
      amountMicroUsdc: job.amountMicroUsdc,
      createdAt: job.createdAt.toISOString(),
      postedAt: job.openedAt?.toISOString() ?? null,
      closesAt: job.closesAt.toISOString(),
      postUrl: job.postId ? replyLink(job.postId) : null,
      pageUrl: coinPageLink(ctx.config.SITE_URL, agent.token, job.id),
      pageText: job.pageText,
      entries: { received: job.entriesReceived, eligible: job.entriesEligible, considered: job.entriesConsidered, ineligible },
      verdict: v
        ? {
            winner,
            winningEntryUrl: winning ? replyLink(winning.replyId) : null,
            perCriterion: (v.perCriterion && typeof v.perCriterion === 'object' ? v.perCriterion : {}) as Record<string, string[]>,
            reason: typeof v.reason === 'string' ? v.reason : '',
            invalid: typeof v.invalid === 'string' ? v.invalid : null,
            deliveryHash: typeof v.deliveryHash === 'string' ? v.deliveryHash : null,
            reasonHash: typeof v.reasonHash === 'string' ? v.reasonHash : null,
            judgedAt: job.judgedAt?.toISOString() ?? null,
          }
        : null,
      payment:
        (job.status === 'proposed' || job.status === 'paid') && job.payee
          ? { status: job.status, payee: job.payee, amountUsdc: usdc(job.amountMicroUsdc), txHash: job.txHash, txUrl: job.txHash ? explorerTxUrl(ctx.chain.chainId, job.txHash) : null, replyUrl: job.paidReplyId ? replyLink(job.paidReplyId) : null, paidAt: job.paidAt?.toISOString() ?? null }
          : null,
      closedAt: job.closedAt?.toISOString() ?? null,
      closeReplyUrl: job.closeReplyId ? replyLink(job.closeReplyId) : null,
    };
  });
}

// ---------------------------------------------------------------------------
// The activity tape (activity.ts) and the treasury observation (roles.ts)
// ---------------------------------------------------------------------------

export interface BountyTapeItem {
  at: string;
  kind: 'bounty';
  summary: string;
  url?: string;
  txHash?: string;
}

const short = (task: string) => (task.length > 80 ? `${task.slice(0, 77).trimEnd()}...` : task);

/** One tape row per job event: posted, judged, paid, no winner, cancelled, expired, failed. Plain words, no address. */
export async function bountyActivity(ctx: SupervisorContext, agent: AgentRow, limit: number, before?: Date): Promise<BountyTapeItem[]> {
  const rows = await ctx.db
    .select()
    .from(bountyJobs)
    .where(before ? and(eq(bountyJobs.agentId, agent.agentId), lte(bountyJobs.createdAt, before)) : eq(bountyJobs.agentId, agent.agentId))
    .orderBy(desc(bountyJobs.updatedAt))
    .limit(limit);
  const items: BountyTapeItem[] = [];
  const push = (at: Date | null, summary: string, extra: Partial<BountyTapeItem> = {}) => {
    if (!at || (before && at.getTime() >= before.getTime())) return;
    items.push({ at: at.toISOString(), kind: 'bounty', summary, ...extra });
  };
  for (const job of rows) {
    const amount = `${usdc(job.amountMicroUsdc)} USDC`;
    const postUrl = job.postId ? replyLink(job.postId) : undefined;
    push(job.openedAt, `Posted a bounty for ${amount}: ${short(job.task)}`, postUrl ? { url: postUrl } : {});
    if (job.judgedAt && job.status !== 'no_winner') push(job.judgedAt, `Judged a bounty: entry ${(job.verdict as { winner?: unknown } | null)?.winner ?? '?'} of ${job.entriesConsidered} won`, postUrl ? { url: postUrl } : {});
    switch (job.status) {
      case 'paid':
        push(job.paidAt, `Paid ${amount} for a bounty entry`, { ...(job.txHash ? { txHash: job.txHash, url: explorerTxUrl(ctx.chain.chainId, job.txHash) } : {}) });
        break;
      case 'no_winner':
        push(job.closedAt, job.error?.startsWith('declined') ? 'Bounty closed: the creator declined the proposal, nothing paid' : `Bounty closed: no entry met the job (${job.entriesReceived} ${job.entriesReceived === 1 ? 'reply' : 'replies'}), nothing paid`, postUrl ? { url: postUrl } : {});
        break;
      case 'cancelled':
        push(job.closedAt, job.openedAt ? 'Bounty cancelled' : 'Bounty draft withdrawn', postUrl ? { url: postUrl } : {});
        break;
      case 'expired':
        push(job.closedAt, 'Bounty proposal expired unpaid', postUrl ? { url: postUrl } : {});
        break;
      case 'failed':
        push(job.closedAt, job.openedAt ? 'Bounty closed: the entries could not be collected, nothing paid' : 'Bounty could not be posted', postUrl ? { url: postUrl } : {});
        break;
      default:
        break;
    }
  }
  return items;
}

const BOUNTIES_MEANING =
  'Your bounty jobs: the day\'s headroom, your open jobs with their close times, and the last verdicts. Code collects, judges and proposes; your creator pays. Your creator turned this power on to have small jobs posted for work you use; the caps are limits, not targets. A suggestion, when present, is your cue to post one.';

/** With no open job and room under the caps, a job is suggested once the last one is this old (or there never was one). */
export const BOUNTY_SUGGEST_AFTER_MS = 2 * 86_400_000;

/** What a good job looks like, in the suggestion: work the agent will use, never promotion. */
export const BOUNTY_GOOD_JOBS: readonly string[] = [
  'a picture for your next post (deliverable image): say what it shows and the style, e.g. "a hand-drawn map of how a fee becomes a burn"',
  'a source you will cite (deliverable link): a public page that answers one question you have, e.g. "a page that explains how Base fees are set"',
  'an explainer diagram (deliverable image) of one thing about your coin or Bootr that words make hard',
];

export interface BountySuggestion {
  now: true;
  why: string;
  goodJobs: readonly string[];
  how: string;
}

/**
 * The suggestion of the bounties section, or null: no open job, room under the open-job cap, the day's headroom at
 * least the smallest amount, and no job created for `BOUNTY_SUGGEST_AFTER_MS` (or never).
 */
export function bountySuggestion(args: { openJobs: number; maxOpen: number; remainingTodayMicroUsdc: bigint; lastJobAt: number | null; now: number }): BountySuggestion | null {
  if (args.openJobs > 0 || args.openJobs >= args.maxOpen) return null;
  if (args.remainingTodayMicroUsdc < BigInt(BOUNTY_MIN_AMOUNT_MICRO_USDC)) return null;
  if (args.lastJobAt !== null && args.now - args.lastJobAt < BOUNTY_SUGGEST_AFTER_MS) return null;
  const why = args.lastJobAt === null ? 'You have never posted a job, have no open one and have room in today\'s cap.' : `Your last job was ${Math.floor((args.now - args.lastJobAt) / 86_400_000)} days ago, none is open and today's cap has room.`;
  return {
    now: true,
    why,
    goodJobs: BOUNTY_GOOD_JOBS,
    how: 'Post one with bounty_post this turn: a task in plain words, 1 to 4 criteria a judge can check from the artefact alone, image or link, 0.1 to 1 USDC. Work you will use, never promotion: no post, follow, like, repost or mention of your coin as the work. If you cannot name such work now, say why in your checkpoint.',
  };
}

const ENTRIES_MEANING =
  'Replies to one of your bounty jobs are entries, not mentions: they are kept out of your inbox and collected by code once the job\'s window closes. You never name a winner, never call an entry accepted or promising, and never answer an entry; a separate judge rules on the artefacts alone and your creator pays. If someone asks about their entry, say the job closes at its time and the result appears on your coin page.';

/**
 * The `bountyEntries` section of the social turn's first observation (runtime.ts): present while the power is on or a
 * job of the agent is open, so the social prompt stays byte for byte what it is and the agent still knows the rule.
 */
export function bountyEntriesSection(config: Pick<AgentConfig, 'capabilities'>, bountyConversations: ReadonlySet<string> | null): Record<string, unknown> {
  if (config.capabilities.bounties !== true && !bountyConversations?.size) return {};
  return { bountyEntries: { meaning: ENTRIES_MEANING, openJobs: bountyConversations?.size ?? 0 } };
}

/** The `bounties` section of the treasury observation (roles.ts), present while the power is on. */
export async function bountiesSection(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig): Promise<Record<string, unknown>> {
  if (config.capabilities.bounties !== true) return {};
  const policy = bountiesPolicyOf(config);
  const [budget, rows] = await Promise.all([bountyBudget(ctx, agent.agentId, policy), ctx.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId)).orderBy(desc(bountyJobs.createdAt)).limit(12)]);
  const open = rows.filter((j) => (OPEN_STATUSES as readonly string[]).includes(j.status));
  const verdicts = rows.filter((j) => j.verdict).slice(0, 5);
  // rows are newest first; a draft that was never posted still counts as an attempt.
  const suggestion = bountySuggestion({ openJobs: budget.openJobs, maxOpen: budget.maxOpen, remainingTodayMicroUsdc: budget.remainingTodayMicroUsdc, lastJobAt: rows[0] ? rows[0].createdAt.getTime() : null, now: ctx.now() });
  return {
    bounties: {
      meaning: BOUNTIES_MEANING,
      ...(suggestion ? { suggestion } : {}),
      policy: { dailyCapUsdc: usdc(policy.dailyCapMicroUsdc), maxOpen: policy.maxOpen, cooldownDays: Math.round(policy.cooldownSeconds / 86_400), defaultHoursOpen: policy.defaultHoursOpen, review: policy.review, amountUsdc: { min: usdc(BOUNTY_MIN_AMOUNT_MICRO_USDC), max: usdc(BOUNTY_MAX_AMOUNT_MICRO_USDC) }, hoursOpen: { min: BOUNTY_MIN_HOURS_OPEN, max: BOUNTY_MAX_HOURS_OPEN } },
      headroom: bountyBudgetView(budget),
      openJobs: open.map((j) => ({ jobId: j.id, status: j.status, task: j.task, amountUsdc: usdc(j.amountMicroUsdc), deliverable: j.deliverable, closesAt: j.closesAt.toISOString(), ...(j.postId ? { postUrl: replyLink(j.postId) } : {}) })),
      lastVerdicts: verdicts.map((j) => ({ jobId: j.id, status: j.status, task: j.task, amountUsdc: usdc(j.amountMicroUsdc), entries: { received: j.entriesReceived, eligible: j.entriesEligible, considered: j.entriesConsidered }, verdict: verdictSummary(j) })),
    },
  };
}
