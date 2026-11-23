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
 *  - the **judge** (judge.ts) sees the criteria and the artefacts, nothing else, and marks every criterion for every
 *    entry; **code** picks the winner from those marks (`pickWinner`): pass on every required criterion of the job
 *    (`required`, one or two; `[1]` for a job that stored none), then the most passes, a tie to the earlier entry;
 *  - the **creator** approves the proposal with the paying transaction hash, or declines it.
 *
 * The entry rules (section 3.3 "How a delivery is read") are `evaluateEntries`, a pure function over what the sender
 * returned: one artefact of the job's kind, exactly one `0x` address, not the agent or the creator, an account at
 * least 30 days old, one entry per author, a shared address drops both, a repeated media drops the later one, the
 * address is not the kernel, the creator or the spender, and it was not paid inside the cooldown. The first 12
 * eligible by time are judged. Reply text is read for the address and thrown away: no row and no model ever holds it.
 *
 * The judge may be asked twice (judge.ts): when its first answer is no verdict, or the thought gave none, one more
 * thought is bought under a new key. When that fails too the job is not closed in public as "no entry met the job":
 * it goes to the creator's queue as a `bounty_pick` item, where the creator picks the entry to pay from the considered
 * ones (and pays it by hand, like any payout) or declines. What the judge wrote is kept on the row (`judgeRaw`). A job
 * that closed `no_winner` on such a failure before this existed is judged once more by the sweep (`rejudgeJob`).
 *
 * A job that closed with no winner under the earlier rule (every criterion had to pass) and whose stored marks give a
 * winner under this one is ruled once more by the sweep, from the marks alone and with no thought bought (`reruleJob`):
 * it becomes an ordinary payout proposal, with nothing new said in public.
 *
 * A paid job is said twice in public, both from fixed templates: the reply under the winning entry, and one original
 * post of the agent's own (`payoutPostText`) with the job, the amount and the transaction link.
 *
 * What a job may ask for (`jobTextProblem`, `repeatedJobProblem`): a picture, or data that already exists or is quick
 * to put together and is handed in as a link (a CSV, a gist, a sheet, a query, an onchain fact with its source). Never
 * something to build, design, write or publish (a web page, a site, an app, an article), never a job in substantially
 * the words of one the agent posted in the last 30 days.
 *
 * Every step logs `jobId`, `status` and counts under `module: 'bounties'`, never a reply's text or an entry's address.
 *
 * An own-agent coin (docs/design/byo-agent.md; `isOwn(agent)`, the stored config, whatever the flag says) is collected
 * by the same code and never judged by a bought thought: its job stays `judging` with the artefacts pinned on the entry
 * rows (`artefact.sha256`, and a page's excerpt) until the creator's own client rules through `settleOwnRuling`
 * (own/judge.ts), which runs the same proposal step, or until `OWN_JUDGE_WAIT_MS` after the close, when it closes
 * `no_winner` with `judge_absent`.
 */
import {
  BOUNTY_DEFAULT_HOURS_OPEN,
  BOUNTY_FORBIDDEN_WORDS,
  BOUNTY_MAX_AMOUNT_MICRO_USDC,
  BOUNTY_MAX_CONSIDERED,
  BOUNTY_MAX_HOURS_OPEN,
  BOUNTY_MAX_REQUIRED,
  BOUNTY_MIN_AMOUNT_MICRO_USDC,
  BOUNTY_MIN_HOURS_OPEN,
  BOUNTY_PAY_GRACE_MS,
  bountiesPolicySchema,
  countCashtags,
  DEFAULT_BOUNTIES_POLICY,
  gateWords,
  postFinding,
  postLength,
  postLimitsFor,
  postValidation,
  type ActionOutcome,
  type AgentConfig,
  type BountiesPolicy,
  type ToolInput,
} from '@bootr/agent-core';
import { OWN_AGENT_MODEL_ID } from '@bootr/shared/own-agent';
import { IDENTITY_ENCODING, readBodyCapped } from '@bootr/shared/public-fetch';
import { createHash } from 'node:crypto';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql, type SQL } from 'drizzle-orm';
import { encodeAbiParameters, formatUnits, getAddress, isAddress, keccak256, parseAbiParameters, stringToHex, type Address, type Hex } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, agents, approvals, bountyEntries, bountyJobs, type BountyDeliverable, type BountyJobStatus } from './db/schema.js';
import { JUDGE_MARKS, JUDGE_MAX_EXCERPT_CHARS, JUDGE_MAX_IMAGE_BYTES, JUDGE_MAX_THOUGHTS, JUDGE_RETRY_CODES, judgeJob, pickWinner, requiredOf, templateReason, type JudgeEntry, type JudgeMark, type JudgeThought, type JudgeVerdict } from './judge.js';
import { raiseNotification } from './notifications.js';
import { agentConfigOf } from './onboarding.js';
import { isOwn, OWN_AGENT_MARK, ownSetting } from './own/registry.js';
import { originalPostGate } from './rhythm.js';
import { wordOverlap, wordsOf } from './said.js';
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

/** A job closed on a failed ruling is judged once more by the sweep when it closed inside this long. */
export const REJUDGE_WINDOW_MS = 7 * 24 * 3_600_000;
/** A paid job is announced by the agent's own post inside this long of the payment; after it the post is not made. */
export const PAYOUT_POST_WINDOW_MS = 48 * 3_600_000;
/** A job that closed with no winner under the every-criterion rule is ruled again from its stored marks when it closed inside this long. */
export const RERULE_WINDOW_MS = 7 * 24 * 3_600_000;
/** A new job may not repeat one of the agent's jobs from this many days back. */
export const BOUNTY_REPEAT_DAYS = 30;
/** Two tasks are one job when this share of their words is common (words in both over words in either)... */
export const BOUNTY_REPEAT_OVERLAP_PCT = 50;
/** ...or when this share of the shorter task's words is in the longer one (a task reworded around the same words). */
export const BOUNTY_REPEAT_CONTAINED_PCT = 75;
/** A task of fewer words than this names no subject and no output. */
export const BOUNTY_MIN_TASK_WORDS = 6;

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
 * Things nobody builds for a dollar: a job that asks a stranger to make one is hours of work for 0.1 to 1 USDC, and the
 * three "a public web page that explains ..." jobs the platform agent posted drew no entry at all.
 */
const BUILT_THING = '(?:web ?pages?|landing ?pages?|web ?sites?|sites?|pages?|web ?apps?|apps?|dapps?|applications?|dashboards?|bots?|articles?|blog ?posts?|blogs?|essays?|tutorials?|guides?|threads?|videos?|white ?papers?|documentation|docs)';
const BUILD_VERB = '(?:build|builds|built|building|create|creates|created|creating|make|makes|made|making|design|designs|designed|designing|write|writes|wrote|written|writing|publish|publishes|published|publishing|develop|develops|developed|developing|code|codes|coded|coding|launch|launches|launched|launching|deploy|deploys|deployed|deploying|host|hosts|hosted|hosting|draft|drafts|drafted|drafting|set up|put together)';
/** "write a short article", "build a simple landing page": the verb and, at most three words on, the thing. */
const ASKS_TO_BUILD = new RegExp(`\\b${BUILD_VERB}\\b(?:[^\\w.;:!?]+[\\w'’-]+){0,3}?[^\\w.;:!?]+${BUILT_THING}\\b`, 'i');
const BUILT_THING_WORD = new RegExp(`\\b${BUILT_THING}\\b`, 'i');
/** What a `link` job may ask for: data. One of these words has to be in the task. */
const DATA_WORD = /\b(?:csv|tsv|spreadsheets?|sheets?|gists?|datasets?|data|tables?|lists?|quer(?:y|ies)|dune|json|figures?|numbers?|counts?|totals?|sources?|transactions?|tx|onchain|on-chain|rankings?|top \d+|\d+ (?:largest|biggest|newest|latest|most))\b/i;
/** Words a judge cannot check from an artefact: a criterion made of one says nothing about what has to be there. */
const UNCHECKABLE_WORD = /\b(?:good|nice|cool|great|awesome|amazing|creative|beautiful|pretty|stunning|high[- ]quality|top[- ]quality|interesting|engaging|appealing|eye[- ]catching|well[- ]made|well[- ]done|professional[- ]looking|impressive)\b/i;

const BUILD_REFUSAL =
  'a job never asks a stranger to build, design, write or publish a web page, a site, an app or an article: that is hours of work for at most 1 USDC and nobody enters. Ask for a picture (deliverable image), or for data that already exists or is quick to put together and comes as a link (deliverable link): a CSV, a gist or a sheet, a Dune or similar query, an onchain fact with its source';
const SPECIFIC_EXAMPLES = 'e.g. "a CSV of the 20 largest Base token launches this week with name, address and launch block", "a square image showing how a trade fee is split, with the labels creator, agent and platform"';

/**
 * Whether a `link` task asks for a built thing as the deliverable itself: the first such word comes within the task's
 * first words, with no data word and no "of / for / with ..." before it ("a public web page that explains X" is one;
 * "a list of Base apps with their launch dates" is not).
 */
function headIsBuiltThing(task: string): string | null {
  const m = BUILT_THING_WORD.exec(task);
  if (!m) return null;
  const before = task.slice(0, m.index).trim();
  const words = before ? before.split(/\s+/) : [];
  if (words.length > 4 || DATA_WORD.test(before) || /\b(?:of|for|about|from|with|in|on|per|by)\b/i.test(before)) return null;
  return m[0];
}

/**
 * What a job may ask for, beyond the promotion words: nothing to build, design, write or publish (any deliverable), a
 * `link` job only for data, and a task and criteria specific enough for a judge to check from the artefact. The reason
 * as the agent reads it, or null.
 */
export function taskRuleProblem(p: { task: string; criteria: readonly string[]; deliverable: BountyDeliverable }): string | null {
  const texts = [['task', p.task], ...p.criteria.map((c, i) => [`criterion ${i + 1}`, c] as const)] as const;
  for (const [what, value] of texts) {
    const build = ASKS_TO_BUILD.exec(value);
    if (build) return `bounty_asks_to_build: the ${what} says "${build[0].trim()}"; ${BUILD_REFUSAL}`;
  }
  if (p.deliverable === 'link') {
    const head = headIsBuiltThing(p.task);
    if (head) return `bounty_asks_to_build: the task asks for "${head}" as the thing to hand in; ${BUILD_REFUSAL}`;
    if (!DATA_WORD.test(p.task)) return `bounty_link_needs_data: a link job asks for data and says which: a CSV, a gist or a sheet, a table or a list, a Dune or similar query, an onchain fact with its source. Name the data and its columns or fields, ${SPECIFIC_EXAMPLES}; for anything visual use deliverable image`;
  }
  const words = p.task.trim().split(/\s+/).filter(Boolean).length;
  if (words < BOUNTY_MIN_TASK_WORDS) return `bounty_task_too_vague: the task is ${words} word${words === 1 ? '' : 's'}; say the subject and the output concretely, ${SPECIFIC_EXAMPLES}`;
  for (const [what, value] of texts.slice(1)) {
    const vague = UNCHECKABLE_WORD.exec(value);
    if (vague) return `bounty_criterion_not_checkable: ${what} says "${vague[0]}", which a judge cannot check from the artefact; say what has to be in it (a label, a column, a count, a colour, a size)`;
  }
  return null;
}

/**
 * Why a job may not be posted, or null. The task and the criteria may ask for work only (none of the promotion words,
 * decision 15; nothing to build and nothing vague, `taskRuleProblem`), may name no address and no cashtag but the
 * agent's own, and the whole post, template included, must pass the publish gate (the platform rules for the platform
 * agent) and fit the account's post length.
 */
export function jobTextProblem(p: { task: string; criteria: readonly string[]; deliverable: BountyDeliverable; text: string; attributions: { username: string; sourceUrl: string }[]; config: Pick<AgentConfig, 'platform' | 'token' | 'kernel'>; premium: boolean | null }): string | null {
  const own = `$${p.config.token.symbol}`.toUpperCase();
  for (const [what, value] of [['task', p.task], ...p.criteria.map((c, i) => [`criterion ${i + 1}`, c] as const)] as const) {
    const word = FORBIDDEN_WORD.exec(value);
    if (word) return `bounty_asks_for_promotion: the ${what} says "${word[0]}"; a job asks for work (a picture, a table of data), never for a post, a tweet, a follow, a like, a repost or any promotion`;
    if (ANY_ADDRESS.test(value)) return `bounty_address_forbidden: the ${what} names an address; the entries carry the addresses, the job never does`;
    const tags = [...value.matchAll(/(?<![a-z0-9_])\$[a-z][a-z0-9_]*\b/gi)].map((m) => m[0].toUpperCase());
    if (tags.some((t) => t !== own)) return `bounty_cashtag_forbidden: the ${what} names a cashtag other than ${own}`;
  }
  const rule = taskRuleProblem(p);
  if (rule) return rule;
  if (countCashtags(p.text) > 1) return 'x_post_requires_at_most_one_cashtag: the job may name your own cashtag once at most';
  const gate = postFinding(p.text, p.attributions, 'original', false, { platform: p.config.platform === true, publicAddresses: [p.config.token.address, p.config.kernel.address] });
  if (gate) {
    // What tripped, in the gate's own words (agent-core gate-words.ts): the job post is the agent's task in a frame.
    const words = gateWords(gate);
    return `${gate.code}: the job post does not pass the publish gate; rewrite the task${words ? `: ${words}` : ''}`;
  }
  const limit = postLimitsFor(p.premium).original;
  const length = postLength(p.text);
  if (length > limit) return `bounty_post_too_long: the job post would be ${length} characters and this X account may send ${limit}; shorten the task by about ${length - limit} characters`;
  return null;
}

/** Words every job carries whatever it asks for: the format, not the subject. Left out when two tasks are compared. */
const FORMAT_WORDS = new Set(['image', 'picture', 'pic', 'square', 'png', 'jpg', 'link', 'csv', 'public', 'show', 'showing', 'shows', 'explain', 'explains', 'explaining', 'explainer', 'simple', 'short', 'single', 'small']);

/** The words of a task as two tasks are compared: `wordsOf` (said.ts), plain endings cut ("launches" and "launch" are one word), format words out. */
export function taskWords(task: string): string[] {
  const stems = wordsOf(task)
    .filter((w) => !FORMAT_WORDS.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(?:ing|ers?|ed|es|s)$/, '') : w));
  return [...new Set(stems)].sort();
}

/** Whether two tasks are substantially one job: by the share of common words, or by how much of the shorter one is in the longer. */
export function sameJob(a: string, b: string): boolean {
  const wa = taskWords(a);
  const wb = taskWords(b);
  if (wa.length < 2 || wb.length < 2) return a.trim().toLowerCase() === b.trim().toLowerCase();
  if (wordOverlap(wa, wb) * 100 >= BOUNTY_REPEAT_OVERLAP_PCT) return true;
  const [small, large] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (small.length < 4) return false;
  const inLarge = new Set(large);
  return (small.filter((w) => inLarge.has(w)).length / small.length) * 100 >= BOUNTY_REPEAT_CONTAINED_PCT;
}

/** How a job ended or where it stands, in a few words the treasury turn reads: the outcome a refusal names and `bounty_list` shows. */
export function jobOutcome(job: Pick<BountyJobRow, 'status' | 'entriesReceived' | 'openedAt' | 'error'>): string {
  const entries = `${job.entriesReceived} ${job.entriesReceived === 1 ? 'entry' : 'entries'}`;
  switch (job.status) {
    case 'draft':
      return 'waits to be posted';
    case 'open':
      return 'is open now';
    case 'judging':
      return 'is being judged now';
    case 'proposed':
      return `has ${entries} and waits for your creator's decision`;
    case 'paid':
      return `was paid (${entries})`;
    case 'no_winner':
      return job.entriesReceived === 0 ? 'drew no entries' : job.error?.startsWith('declined') ? `was declined by your creator (${entries})` : `closed with no winner (${entries})`;
    case 'expired':
      return `expired unpaid (${entries})`;
    case 'cancelled':
      return job.openedAt ? 'was cancelled' : 'was withdrawn before it was posted';
    default:
      return job.openedAt ? 'closed because its replies could not be read' : 'could not be posted';
  }
}

/**
 * Why a task repeats an earlier job of this agent, or null: the jobs of the last `BOUNTY_REPEAT_DAYS` days that reached
 * the public or still wait to (a draft that never went out and was closed does not count). The refusal names the
 * earlier job and how it ended, so the turn asks for something else instead of rewording it.
 */
export async function repeatedJobProblem(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, task: string): Promise<string | null> {
  const rows = (await recentJobs(ctx, agentId)).filter((job) => job.openedAt || job.status === 'draft');
  const earlier = rows.find((job) => sameJob(task, job.task));
  if (!earlier) return null;
  const said = earlier.task.length > 120 ? `${earlier.task.slice(0, 117).trimEnd()}...` : earlier.task;
  return `bounty_repeats_earlier_job: this is substantially the job ${shortJobId(earlier.id)} you posted on ${earlier.createdAt.toISOString().slice(0, 10)} ("${said}"), which ${jobOutcome(earlier)}. A job is not asked twice inside ${BOUNTY_REPEAT_DAYS} days, reworded or not: ask for different work, or post nothing`;
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

/** The required criteria of a job, as 1-based numbers: what the row stores, or `[1]` for a job from before the split. */
export function requiredOfJob(job: Pick<BountyJobRow, 'required' | 'criteria'>): number[] {
  return requiredOf(job.required, job.criteria.length);
}

export const reviewApprovalId = (actionId: string) => actionId;
export const payoutApprovalId = (jobId: string) => `bounty-pay-${jobId.slice(2, 34)}`;
export const pickApprovalId = (jobId: string) => `bounty-pick-${jobId.slice(2, 34)}`;

/** One entry the creator may pick when the judge gave no ruling: its number, who it would pay, and where to look at it. */
export interface BountyPickCandidate {
  n: number;
  payee: string;
  replyId: string;
  entryUrl: string;
  artefactUrl?: string;
}

export interface BountyApprovalMeta {
  bounty: 'job' | 'payout' | 'pick';
  jobId: string;
  task: string;
  amountMicroUsdc: string;
  /** The job's criteria and which of them are required (1-based numbers); absent on an item from before the split. */
  criteria?: string[];
  required?: number[];
  /** `payout` only: the winning entry's number and its marks, one per criterion. */
  winner?: number;
  marks?: string[];
  payee?: string;
  reason?: string;
  replyId?: string;
  entryUrl?: string;
  /** `pick` only: the considered entries with an address, in the judge's numbering. */
  candidates?: BountyPickCandidate[];
  /** `pick` only: the code the judge's ruling failed with. */
  why?: string;
}

/** The `bounty` block of an approval view (approvals.ts), from the row's meta; null for a post or reply. */
export function bountyApprovalView(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  const m = meta as Partial<BountyApprovalMeta> | null | undefined;
  if (!m || (m.bounty !== 'job' && m.bounty !== 'payout' && m.bounty !== 'pick') || typeof m.jobId !== 'string') return null;
  return {
    kind: m.bounty,
    jobId: m.jobId,
    task: typeof m.task === 'string' ? m.task : '',
    amountUsdc: typeof m.amountMicroUsdc === 'string' ? usdc(m.amountMicroUsdc) : null,
    ...(Array.isArray(m.criteria) && m.criteria.length ? { criteria: m.criteria, required: requiredOf(m.required, m.criteria.length) } : {}),
    ...(m.bounty === 'payout'
      ? { payee: m.payee ?? null, reason: m.reason ?? null, entryUrl: m.entryUrl ?? null, txHashRequired: true, ...(typeof m.winner === 'number' ? { winner: m.winner } : {}), ...(Array.isArray(m.marks) ? { marks: m.marks } : {}) }
      : {}),
    ...(m.bounty === 'pick'
      ? { candidates: (Array.isArray(m.candidates) ? m.candidates : []).map((c) => ({ n: c.n, payee: c.payee, entryUrl: c.entryUrl, artefactUrl: c.artefactUrl ?? null })), why: m.why ?? null, txHashRequired: true, entryRequired: true }
      : {}),
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
    required: requiredOfJob(job),
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
  const required = input.required ? [...input.required].sort((a, b) => a - b) : requiredOf(null, criteria.length);
  if (required.length < 1 || required.length > BOUNTY_MAX_REQUIRED || new Set(required).size !== required.length || required.some((n) => !Number.isInteger(n) || n < 1 || n > criteria.length)) {
    return failed(`bounty_required_out_of_range: required names one or two of your criteria by number, each once, from 1 to ${criteria.length} for this job (you wrote ${criteria.length} ${criteria.length === 1 ? 'criterion' : 'criteria'}); leave it out and criterion 1 is the required one`);
  }
  const jobId = bountyJobId(agent.kernel as Address, nonce, task);
  const link = coinPageLink(ctx.config.SITE_URL, agent.token, jobId);
  const closesAt = now + hours * 3_600_000;
  const text = jobPostText({ task, amountMicroUsdc: amount, deliverable: input.deliverable, closesAt, handle: config.xHandle, link });
  const premium = (await ctx.sender.account(agent.agentId).catch(() => null))?.premium ?? null;
  const problem = jobTextProblem({ task, criteria, deliverable: input.deliverable, text, attributions: templateAttributions(config, link), config, premium });
  if (problem) return failed(problem);
  const repeat = await repeatedJobProblem(ctx, agent.agentId, task);
  if (repeat) return failed(repeat);

  const [job] = await ctx.db
    .insert(bountyJobs)
    .values({ id: jobId, agentId: agent.agentId, actionId, nonce, task, criteria, required, deliverable: input.deliverable, amountMicroUsdc: amount.toString(), status: 'draft', createdAt: new Date(now), closesAt: new Date(closesAt), pageText: text, updatedAt: new Date(now) })
    .onConflictDoNothing()
    .returning();
  if (!job) return outcomeOfJob((await ctx.db.query.bountyJobs.findFirst({ where: eq(bountyJobs.actionId, actionId) }))!);
  log(ctx, agent.agentId, job, { amountMicroUsdc: amount.toString(), hours, deliverable: input.deliverable, criteria: criteria.length, required, review: policy.review }, 'bounty job drafted');

  if (policy.review) {
    const approvalId = reviewApprovalId(actionId);
    const meta: BountyApprovalMeta = { bounty: 'job', jobId, task, amountMicroUsdc: amount.toString(), criteria, required };
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

const NO_ENTRIES_MEANING = `Jobs of yours from the last ${BOUNTY_REPEAT_DAYS} days that nobody entered. Do not ask for any of them again, reworded or not (code refuses a repeat): nobody wanted that work at that price. Ask for something else, smaller and more exact, or post nothing.`;

/**
 * The agent's jobs of the last `BOUNTY_REPEAT_DAYS` days that were posted and drew no reply at all, newest first: what
 * `bounty_list` and the treasury observation show so the turn stops asking for the same work.
 */
export function noEntryJobs(rows: readonly BountyJobRow[], now: number): { jobId: string; task: string; amountUsdc: string; deliverable: BountyDeliverable; postedAt: string }[] {
  return rows
    .filter((job) => job.status === 'no_winner' && job.entriesReceived === 0 && job.openedAt && now - job.createdAt.getTime() <= BOUNTY_REPEAT_DAYS * DAY_MS)
    .map((job) => ({ jobId: job.id, task: job.task, amountUsdc: usdc(job.amountMicroUsdc), deliverable: job.deliverable, postedAt: job.openedAt!.toISOString() }));
}

/** The agent's jobs of the repeat window, newest first (the list a new task is compared with, and the zero-entry list). */
async function recentJobs(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string): Promise<BountyJobRow[]> {
  return ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.agentId, agentId), gte(bountyJobs.createdAt, new Date(ctx.now() - BOUNTY_REPEAT_DAYS * DAY_MS))))
    .orderBy(desc(bountyJobs.createdAt))
    .limit(60);
}

/** `bounty_list` (both turns): the agent's jobs, newest first, with status, counts and verdicts; never entry text or an address. */
export async function bountyList(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig): Promise<ActionOutcome> {
  const rows = await ctx.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId)).orderBy(desc(bountyJobs.createdAt)).limit(20);
  const budget = await bountyBudget(ctx, agent.agentId, bountiesPolicyOf(config));
  const unanswered = noEntryJobs(await recentJobs(ctx, agent.agentId), ctx.now());
  return {
    kind: 'completed',
    result: {
      jobs: rows.map((job) => ({
        ...postResult(job),
        criteria: job.criteria,
        openedAt: job.openedAt?.toISOString() ?? null,
        entries: { received: job.entriesReceived, eligible: job.entriesEligible, considered: job.entriesConsidered },
        outcome: jobOutcome(job),
        verdict: verdictSummary(job),
        ...(job.status === 'paid' && job.txHash ? { paidTx: job.txHash } : {}),
      })),
      ...(unanswered.length ? { drewNoEntries: { meaning: NO_ENTRIES_MEANING, jobs: unanswered } } : {}),
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
  /** How the coin is run, from its stored config alone: an own coin is collected here and never judged by a bought thought. */
  const own = isOwn(agent);
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
    // An own coin's job is ruled later, by the creator's client: the page as it read at the close is pinned on the row.
    else if (own) entry.artefact = { ...entry.artefact, sha256: fetched.sha256, excerpt: fetched.excerpt };
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

  // An own coin: no thought is bought for it, with the flag on or off. The job stays `judging`, its artefacts pinned on
  // the rows above, until the creator's client rules (`settleOwnRuling`) or the wait runs out (`sweepBounties`).
  if (own) {
    log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { considered: considered.length }, "bounty entries wait for the ruling of the creator's own agent; no thought bought");
    return { job: await jobByIdOrThrow(ctx, job.id), verdict: null };
  }

  // The agent row is the sweep's (read once per sweep), and the collection above read X and fetched every artefact:
  // seconds, at times minutes. A coin switched to its creator's own agent in that time is own now, whatever the row in
  // hand says, and no thought is bought for it. The stored config is read again here, directly before the judge; the
  // job stays `judging` and the next sweep, which reads the row afresh, collects it as an own coin's job.
  const stored = await ctx.db.query.agents.findFirst({ where: (t, { eq: eqf }) => eqf(t.agentId, agent.agentId), columns: { config: true } });
  if (!stored || isOwn(stored)) {
    log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { considered: considered.length }, "the coin became its creator's own agent's while the entries were collected; no thought bought");
    return { job: await jobByIdOrThrow(ctx, job.id), verdict: null };
  }

  const entries: JudgeEntry[] = considered.map((c) => (c.fetched.kind === 'image' ? { n: c.n, kind: 'image', image: { mime: c.fetched.mime, bytes: c.fetched.bytes } } : { n: c.n, kind: 'link', excerpt: c.fetched.excerpt }));
  const verdict = await judgeJob(ctx, agent, config, { jobId: job.id, task: job.task, criteria: job.criteria, entries, required: requiredOfJob(job) });
  if (verdict.invalid === 'thought_pending') {
    log(ctx, agent.agentId, { id: job.id, status: 'judging' }, { key: verdict.thought.key }, 'judge thought pending; the job stays judging');
    return { job: await jobByIdOrThrow(ctx, job.id), verdict };
  }
  return { job: await settleVerdict(ctx, agent, config, job, verdict, considered.map((c) => ({ n: c.n, kind: c.fetched.kind, sha256: c.fetched.sha256, replyId: c.entry.replyId, payee: c.entry.payee, url: String(c.entry.artefact?.url ?? '') }))), verdict };
}

/** One judged entry as the proposal step needs it: its number, what the judge saw of it (by hash) and who it would pay. */
export interface JudgedEntryRef {
  n: number;
  kind: BountyDeliverable;
  sha256: string;
  replyId: string;
  payee: string | null;
  /** The artefact's own address (the picture, the linked data), for the creator who picks by hand; never sent to a judge. */
  url?: string;
}

/** The thoughts a job has had, the earlier ones first, each key once (a replayed thought is the same thought). */
function thoughtsOf(earlier: unknown, verdict: JudgeVerdict): JudgeThought[] {
  const before = earlier as { thought?: JudgeThought; thoughts?: JudgeThought[] } | null | undefined;
  const all = [...(Array.isArray(before?.thoughts) ? before.thoughts : before?.thought ? [before.thought] : []), ...(verdict.thoughts ?? [verdict.thought])];
  const byKey = new Map<string, JudgeThought>();
  for (const t of all) if (t && typeof t.key === 'string' && t.outcome !== 'none') byKey.set(t.key, t);
  return [...byKey.values()];
}

/**
 * The verdict as the job row keeps it: the ruling (the winner is code's pick from the marks; `required` is what it was
 * picked under, `modelWinner` what the judge itself named, `reasonBy` who wrote the reason), the hash of the bundle it
 * was given on and of its reason, and the thoughts behind it (`thought` is the last one; `thoughts` every one the job has had, an earlier ruling's included).
 */
function storedVerdict(ctx: Pick<SupervisorContext, 'now'>, verdict: JudgeVerdict, considered: readonly JudgedEntryRef[], earlier?: unknown): Record<string, unknown> & { deliveryHash: string } {
  const deliveryHash = deliveryHashOf(considered.map((c) => ({ n: c.n, kind: c.kind, sha256: c.sha256 })));
  const thoughts = thoughtsOf(earlier, verdict);
  const picked = { ...(verdict.required ? { required: verdict.required } : {}), ...(verdict.modelWinner !== undefined ? { modelWinner: verdict.modelWinner } : {}), ...(verdict.reasonBy ? { reasonBy: verdict.reasonBy } : {}) };
  return { winner: verdict.winner, perCriterion: verdict.perCriterion, reason: verdict.reason, ...picked, ...(verdict.invalid ? { invalid: verdict.invalid } : {}), deliveryHash, reasonHash: sha256Hex(verdict.reason), judgedAt: new Date(ctx.now()).toISOString(), thought: verdict.thought, ...(thoughts.length ? { thoughts } : {}) };
}

/**
 * What the judge wrote when code refused it, as the row keeps it (`judgeRaw`): each refused answer under a line that
 * says which attempt it was, the code, and how the answer ended. Null when nothing was refused. Never logged.
 */
export function judgeRawOf(verdict: Pick<JudgeVerdict, 'refused'>): string | null {
  if (!verdict.refused?.length) return null;
  return verdict.refused.map((r) => `[attempt ${r.attempt}: ${r.invalid}; finish ${r.finishReason ?? 'unknown'}; ${r.completionTokens ?? '?'} output tokens]\n${r.raw || '(no text)'}`).join('\n\n');
}

/** Whether a ruling failed because the judge gave no usable answer in every thought it may have (the hosted judge's only: an own agent's ruling carries no `thoughts`). */
function judgeGaveNoRuling(verdict: JudgeVerdict): boolean {
  return !!verdict.invalid && JUDGE_RETRY_CODES.includes(verdict.invalid) && Array.isArray(verdict.thoughts) && verdict.thoughts.length > 0;
}

/**
 * What a verdict does to its job, the same for the hosted judge's and an own agent's. `verdict.winner` is already
 * code's pick from the marks (`parseVerdict`), never the judge's own word. A ruling with no winner, or one refused in
 * code, closes the job unpaid in public; a winner becomes a payout proposal in the
 * creator's queue, with the payee taken from the entry record, never from the judge's text. When the hosted judge gave
 * no usable answer in both of its thoughts, nothing is said in public: the creator is asked to pick (`proposePick`).
 *
 * `again` is set for a job that had already closed `no_winner` and is judged a second time (`rejudgeJob`): the earlier
 * verdict's thoughts are carried over, the verdict is marked `rejudged`, and a second ruling without a winner changes
 * the row only (its public close was already said, and is not said twice).
 */
async function settleVerdict(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow, verdict: JudgeVerdict, considered: readonly JudgedEntryRef[], again?: { earlier: unknown }): Promise<BountyJobRow> {
  const mark = (outcome: string) => (again ? { rejudged: { at: new Date(ctx.now()).toISOString(), outcome } } : {});
  const stored = storedVerdict(ctx, verdict, considered, again?.earlier);
  const judgeRaw = judgeRawOf(verdict);
  const raw = judgeRaw ? { judgeRaw } : {};
  log(ctx, agent.agentId, { id: job.id, status: job.status }, { winner: verdict.winner, invalid: verdict.invalid ?? null, deliveryHash: stored.deliveryHash, outcome: verdict.thought.outcome, thoughts: verdict.thoughts?.length ?? 0, ...(again ? { rejudge: true } : {}) }, 'bounty judged');

  if (judgeGaveNoRuling(verdict) && considered.some((c) => c.payee)) return proposePick(ctx, agent, job, { ...stored, ...mark('manual_pick') }, considered, raw);
  if (verdict.invalid || verdict.winner === null) {
    if (again) return setJob(ctx, job.id, { verdict: { ...stored, ...mark('no_winner') }, judgedAt: new Date(ctx.now()), ...raw });
    return closeUnpaid(ctx, agent, config, job, stored, NO_WINNER_TEXT, raw);
  }
  const winner = considered.find((c) => c.n === verdict.winner);
  if (!winner?.payee) {
    if (again) return setJob(ctx, job.id, { verdict: { ...stored, invalid: 'winner_without_payee', ...mark('no_winner') }, judgedAt: new Date(ctx.now()), ...raw });
    return closeUnpaid(ctx, agent, config, job, { ...stored, invalid: 'winner_without_payee' }, NO_WINNER_TEXT, raw);
  }

  return (await proposePayout(ctx, agent, job, { n: winner.n, replyId: winner.replyId, payee: winner.payee }, verdict.reason, { ...stored, ...mark('proposed') }, { judgedAt: new Date(ctx.now()), ...raw }, verdict.perCriterion[String(winner.n)]))!;
}

/**
 * A winner becomes a payout proposal in the creator's queue: the approval row (its id is the job's, so it is made
 * once), then the job `proposed` with the payee, taken from the entry record and never from the judge's text. The
 * creator pays by hand or declines; nothing here moves money. `closedAt` is stamped now, so the 48 hours the creator
 * has run from this moment, also for a job that had closed before (a second ruling, `reruleJob`). With `onlyWhile`
 * the job is moved only while that condition still holds (the approval row, whose id is the job's, is written first
 * and is the same row whoever wins the write); null when it no longer did.
 */
async function proposePayout(ctx: SupervisorContext, agent: AgentRow, job: BountyJobRow, winner: { n: number; replyId: string; payee: string }, reason: string, verdict: Record<string, unknown>, patch: Partial<typeof bountyJobs.$inferInsert>, marks?: readonly string[], onlyWhile?: SQL): Promise<BountyJobRow | null> {
  const approvalId = payoutApprovalId(job.id);
  const entryUrl = replyLink(winner.replyId);
  const meta: BountyApprovalMeta = { bounty: 'payout', jobId: job.id, task: job.task, amountMicroUsdc: job.amountMicroUsdc, criteria: job.criteria, required: requiredOfJob(job), winner: winner.n, ...(marks ? { marks: [...marks] } : {}), payee: winner.payee, reason, replyId: winner.replyId, entryUrl };
  const text = `Pay ${usdc(job.amountMicroUsdc)} USDC to ${winner.payee} for entry ${entryUrl} of job ${shortJobId(job.id)}. Why: ${reason}`;
  await ctx.db
    .insert(approvals)
    .values({ id: approvalId, agentId: agent.agentId, kind: 'bounty_payout', text, textHash: sha256Hex(text), meta: meta as unknown as Record<string, unknown>, status: 'pending_approval', createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  const now = new Date(ctx.now());
  const [proposed] = await ctx.db
    .update(bountyJobs)
    .set({ ...patch, verdict, payee: winner.payee, approvalId, error: null, status: 'proposed', closedAt: now, updatedAt: now })
    .where(onlyWhile ? and(eq(bountyJobs.id, job.id), onlyWhile) : eq(bountyJobs.id, job.id))
    .returning();
  if (!proposed) return null;
  await notifyReview(ctx, agent.agentId);
  log(ctx, agent.agentId, proposed, { approvalId, winner: winner.n }, 'bounty payout proposed to the creator');
  return proposed;
}

/**
 * The judge gave no usable ruling in both thoughts: the job goes to the creator's queue as a `bounty_pick` item instead
 * of closing in public as if no entry had met it. The item lists the considered entries that could be paid (number,
 * entry link, artefact link, address); the creator picks one and pays it by hand, or declines, which closes the job
 * unpaid as a declined payout does. The job is `proposed` with no payee until then, and expires like any proposal.
 */
async function proposePick(ctx: SupervisorContext, agent: AgentRow, job: BountyJobRow, stored: Record<string, unknown>, considered: readonly JudgedEntryRef[], patch: Partial<typeof bountyJobs.$inferInsert>): Promise<BountyJobRow> {
  const approvalId = pickApprovalId(job.id);
  const candidates: BountyPickCandidate[] = considered.filter((c): c is JudgedEntryRef & { payee: string } => !!c.payee).map((c) => ({ n: c.n, payee: c.payee, replyId: c.replyId, entryUrl: replyLink(c.replyId), ...(c.url ? { artefactUrl: c.url } : {}) }));
  const why = typeof stored.invalid === 'string' ? stored.invalid : 'malformed_answer';
  const meta: BountyApprovalMeta = { bounty: 'pick', jobId: job.id, task: job.task, amountMicroUsdc: job.amountMicroUsdc, criteria: job.criteria, required: requiredOfJob(job), candidates, why };
  const text = `The judge gave no usable ruling on job ${shortJobId(job.id)} (${candidates.length} ${candidates.length === 1 ? 'entry' : 'entries'}). Pick the entry to pay ${usdc(job.amountMicroUsdc)} USDC, or decline and nothing is paid.`;
  await ctx.db
    .insert(approvals)
    .values({ id: approvalId, agentId: agent.agentId, kind: 'bounty_pick', text, textHash: sha256Hex(text), meta: meta as unknown as Record<string, unknown>, status: 'pending_approval', createdAt: new Date(ctx.now()) })
    .onConflictDoNothing();
  const proposed = await closeJob(ctx, job.id, 'proposed', { verdict: { ...stored, manualPick: true }, judgedAt: new Date(ctx.now()), payee: null, approvalId, error: null, ...patch });
  await notifyReview(ctx, agent.agentId);
  log(ctx, agent.agentId, proposed, { approvalId, candidates: candidates.length, invalid: why }, "the judge gave no usable ruling; the entries wait for the creator's pick");
  return proposed;
}

// ---------------------------------------------------------------------------
// An own agent's ruling (own/judge.ts): the job waits, the client rules, the same proposal step runs
// ---------------------------------------------------------------------------

/** The error a job closes with when its own agent gave no ruling within `OWN_JUDGE_WAIT_MS` of the close. */
export const JUDGE_ABSENT = 'judge_absent';
export const JUDGE_ABSENT_TEXT = NOTHING_PAID_TEXT;

/** A considered entry whose artefact was not pinned at collection (a page collected while the coin was hosted). */
const UNPINNED_ENTRY = sql`exists (select 1 from ${bountyEntries} where ${bountyEntries.jobId} = ${bountyJobs.id} and ${bountyEntries.considered} and (${bountyEntries.artefact}->>'sha256') is null)`;
/** The job belongs to a coin whose stored config says `runner: 'own'` (`isOwn`, in SQL; the flag is not asked). */
const OWN_COIN_JOB = sql`${bountyJobs.agentId} in (select ${agents.agentId} from ${agents} where ${agents.config}->>'runner' = 'own')`;
/**
 * A job that waits for its own agent's ruling: `judging`, its entries collected and pinned, no verdict. The sweep leaves
 * such a job alone (it would otherwise hold a sweep slot for two days) and the judge role lists it as due.
 */
const AWAITS_OWN_RULING = sql`(${bountyJobs.status} = 'judging' and ${bountyJobs.entriesConsidered} > 0 and ${bountyJobs.verdict} is null and ${OWN_COIN_JOB} and not ${UNPINNED_ENTRY})`;

/** When an own coin's job closes unjudged: `OWN_JUDGE_WAIT_MS` after its window closed. */
export function ruleByOf(ctx: Pick<SupervisorContext, 'config'>, job: Pick<BountyJobRow, 'closesAt'>): number {
  return job.closesAt.getTime() + ownSetting(ctx, 'OWN_JUDGE_WAIT_MS');
}

/** The jobs of an own agent that wait for its ruling, the oldest close first. Empty for a hosted coin, whatever its jobs. */
export async function jobsAwaitingRuling(ctx: Pick<SupervisorContext, 'db'>, agentId: string): Promise<BountyJobRow[]> {
  return ctx.db.select().from(bountyJobs).where(and(eq(bountyJobs.agentId, agentId), AWAITS_OWN_RULING)).orderBy(asc(bountyJobs.closesAt), asc(bountyJobs.id)).limit(20);
}

/** One considered entry of a job as the judge role reads it: its number, its kind and the pinned artefact. Never the reply, its author or its address. */
export interface PinnedEntry {
  n: number;
  kind: BountyDeliverable;
  url: string;
  sha256: string;
  /** A page's text as it read when the window closed; absent for a picture. */
  excerpt?: string;
}

async function consideredRows(ctx: Pick<SupervisorContext, 'db'>, jobId: string): Promise<BountyEntryRow[]> {
  return ctx.db.select().from(bountyEntries).where(and(eq(bountyEntries.jobId, jobId), eq(bountyEntries.considered, true))).orderBy(asc(bountyEntries.n));
}

const artefactString = (row: BountyEntryRow, key: string): string => {
  const value = (row.artefact as Record<string, unknown> | null)?.[key];
  return typeof value === 'string' ? value : '';
};

/** The considered entries of a job, in the judge's numbering. */
export async function pinnedEntries(ctx: Pick<SupervisorContext, 'db'>, jobId: string): Promise<PinnedEntry[]> {
  const rows = await consideredRows(ctx, jobId);
  return rows.filter((row) => row.n !== null).map((row) => ({ n: row.n!, kind: row.kind, url: artefactString(row, 'url'), sha256: artefactString(row, 'sha256'), ...(row.kind === 'link' ? { excerpt: artefactString(row, 'excerpt') } : {}) }));
}

async function judgedRefs(ctx: Pick<SupervisorContext, 'db'>, jobId: string): Promise<JudgedEntryRef[]> {
  const rows = await consideredRows(ctx, jobId);
  return rows.filter((row) => row.n !== null).map((row) => ({ n: row.n!, kind: row.kind, sha256: artefactString(row, 'sha256'), replyId: row.replyId, payee: row.payee, url: artefactString(row, 'url') }));
}

/**
 * Takes an own agent's ruling for a job, once. The verdict is written first, under a condition (`judging`, no verdict
 * yet), so a second ruling, or one that arrives after the wait ran out, finds nothing to claim and changes nothing;
 * then the same proposal step as the hosted judge's runs. A crash between the two is finished by the sweep
 * (`resumeOwnRuling`). `verdict` has already been through `parseVerdict` (own/judge.ts): this function checks nothing
 * about the ruling itself. It takes a ruling for an own coin's job only, and only for one whose entries were collected:
 * a hosted coin's job is ruled by its bought thought and by nothing else.
 */
export async function settleOwnRuling(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, jobId: string, verdict: JudgeVerdict): Promise<{ ok: true; job: BountyJobRow } | { ok: false }> {
  if (!isOwn(agent)) return { ok: false };
  const considered = await judgedRefs(ctx, jobId);
  if (!considered.length || considered.some((entry) => !entry.sha256)) return { ok: false };
  const stored = storedVerdict(ctx, verdict, considered);
  const [claimed] = await ctx.db
    .update(bountyJobs)
    .set({ verdict: stored, judgedAt: new Date(ctx.now()), updatedAt: new Date(ctx.now()) })
    .where(and(eq(bountyJobs.id, jobId), eq(bountyJobs.agentId, agent.agentId), eq(bountyJobs.status, 'judging'), isNull(bountyJobs.verdict)))
    .returning();
  if (!claimed) return { ok: false };
  return { ok: true, job: await settleVerdict(ctx, agent, config, claimed, verdict, considered) };
}

/** The ruling an own agent gave and the row kept (`settleOwnRuling`), or null when the job's verdict is not one. */
function ownRulingOf(job: BountyJobRow): JudgeVerdict | null {
  const v = job.verdict as { winner?: unknown; perCriterion?: unknown; reason?: unknown; invalid?: unknown; required?: unknown; modelWinner?: unknown; reasonBy?: unknown; thought?: { model?: unknown } } | null;
  if (!v || v.thought?.model !== OWN_AGENT_MODEL_ID) return null;
  return {
    jobId: job.id,
    winner: typeof v.winner === 'number' ? v.winner : null,
    perCriterion: (v.perCriterion && typeof v.perCriterion === 'object' ? v.perCriterion : {}) as JudgeVerdict['perCriterion'],
    reason: typeof v.reason === 'string' ? v.reason : '',
    ...(Array.isArray(v.required) ? { required: requiredOf(v.required, job.criteria.length) } : {}),
    ...(typeof v.modelWinner === 'number' || v.modelWinner === null ? { modelWinner: v.modelWinner } : {}),
    ...(v.reasonBy === 'judge' || v.reasonBy === 'code' ? { reasonBy: v.reasonBy } : {}),
    ...(typeof v.invalid === 'string' ? { invalid: v.invalid as NonNullable<JudgeVerdict['invalid']> } : {}),
    thought: v.thought as JudgeVerdict['thought'],
  };
}

/** A `judging` job that already holds an own agent's ruling (a crash after the claim): the proposal step runs from the stored ruling. */
async function resumeOwnRuling(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow, ruling: JudgeVerdict): Promise<BountyJobRow> {
  return settleVerdict(ctx, agent, config, job, ruling, await judgedRefs(ctx, job.id));
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

/**
 * The one reply that closes a job in public, under its job post. A job that already carries one (it closed once, was
 * judged again and now closes a second time) is not answered twice: its first close stands.
 */
async function closeReply(ctx: SupervisorContext, agent: AgentRow | null, config: AgentConfig | null, job: Pick<BountyJobRow, 'id' | 'postId' | 'closeReplyId'>, text: string): Promise<string | null> {
  if (job.closeReplyId || !agent || !config || !job.postId) return null;
  return templateReply(ctx, agent, config, `bounty:${job.id}:close`, job.postId, text);
}

/** Closes a job unpaid (`no_winner`) with its verdict and the template reply under the job post. */
async function closeUnpaid(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow, verdict: Record<string, unknown>, text: string, patch: Partial<typeof bountyJobs.$inferInsert> = {}): Promise<BountyJobRow> {
  const closeReplyId = await closeReply(ctx, agent, config, job, text);
  const closed = await closeJob(ctx, job.id, 'no_winner', { verdict, judgedAt: new Date(ctx.now()), ...(closeReplyId ? { closeReplyId } : {}), ...patch });
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
 * the creator at their word and shows the hash in public), closes the job `paid`, replies under the winning entry and
 * announces the payment in a post of the agent's own (`publishPayoutPost`); reject closes it `no_winner` with "Nothing
 * paid." in public. `bounty_pick` (the judge gave no usable ruling): approve needs `txHash` and `entry`, the number of
 * the entry the creator paid, one of the item's candidates, and then runs as a payout does; reject closes the job as a
 * declined payout. Returns the patch for the approval row.
 */
export async function decideBountyApproval(ctx: SupervisorContext, agent: AgentRow, row: typeof approvals.$inferSelect, decision: 'approve' | 'reject', by: string, note: string | null, extra: { txHash?: unknown; entry?: unknown }): Promise<BountyDecision> {
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
    const closeReplyId = await closeReply(ctx, agent, config, job, NOTHING_PAID_TEXT);
    const closed = await closeJob(ctx, job.id, 'no_winner', { error: 'declined by the creator', ...(closeReplyId ? { closeReplyId } : {}) });
    log(ctx, agent.agentId, closed, { by, closeReplyId, pick: row.kind === 'bounty_pick' }, 'bounty payout declined by the creator');
    return { ok: true, patch: { status: 'rejected', decision: 'reject', decidedBy: by, note, decidedAt: now } };
  }
  const txHash = typeof extra.txHash === 'string' ? extra.txHash.trim() : '';
  if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return { ok: false, status: 400, error: 'tx_hash_required', message: 'approving a bounty payout needs txHash, the hash of the transaction that paid the winner' };

  // A pick: the creator names the entry they paid, one of the item's candidates; the payee is that entry's, from the row.
  let paidPatch: Partial<typeof bountyJobs.$inferInsert> = {};
  let replyId = typeof meta.replyId === 'string' ? meta.replyId : null;
  let reason = typeof meta.reason === 'string' ? meta.reason : '';
  if (row.kind === 'bounty_pick') {
    const n = typeof extra.entry === 'number' ? extra.entry : typeof extra.entry === 'string' && /^\d{1,3}$/.test(extra.entry.trim()) ? Number(extra.entry.trim()) : Number.NaN;
    const picked = Number.isInteger(n) ? (Array.isArray(meta.candidates) ? meta.candidates : []).find((c) => c.n === n) : undefined;
    if (!picked) return { ok: false, status: 400, error: 'entry_required', message: 'approving this item needs entry, the number of the entry you paid (one of the entries listed)' };
    const [entryRow] = await ctx.db.select().from(bountyEntries).where(and(eq(bountyEntries.jobId, job.id), eq(bountyEntries.considered, true), eq(bountyEntries.n, n))).limit(1);
    if (!entryRow?.payee || entryRow.payee !== picked.payee) return { ok: false, status: 409, error: 'bounty_payee_mismatch', message: 'the item and the entry record disagree on the payee' };
    const kept = { ...((job.verdict ?? {}) as Record<string, unknown>) };
    const invalid = kept.invalid;
    delete kept.invalid;
    delete kept.manualPick;
    paidPatch = { payee: entryRow.payee, verdict: { ...kept, winner: n, pickedBy: 'creator', ...(typeof invalid === 'string' ? { judgeInvalid: invalid } : {}) } };
    replyId = entryRow.replyId;
    reason = '';
  } else {
    const payee = typeof meta.payee === 'string' && meta.payee === job.payee ? job.payee : null;
    if (!payee) return { ok: false, status: 409, error: 'bounty_payee_mismatch', message: 'the proposal and the job disagree on the payee' };
  }
  const paid = await setJob(ctx, job.id, { ...paidPatch, status: 'paid', txHash, paidAt: now });
  const paidReplyId = replyId ? await templateReply(ctx, agent, config, `bounty:${job.id}:paid`, replyId, paidReplyText({ amountMicroUsdc: job.amountMicroUsdc, reason, txUrl: explorerTxUrl(ctx.chain.chainId, txHash) })) : null;
  const replied = paidReplyId ? await setJob(ctx, job.id, { paidReplyId }) : paid;
  // The agent's own post about the payment: now when a slot is open, else by the sweep. A failure here never undoes the payment record.
  const done = await publishPayoutPost(ctx, agent, config, replied).catch((err: unknown) => {
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, err }, 'bounty payout post failed; the sweep tries again');
    return replied;
  });
  log(ctx, agent.agentId, done, { by, txHash, paidReplyId, payoutPostId: done.payoutPostId ?? null, pick: row.kind === 'bounty_pick' }, 'bounty paid by the creator');
  return { ok: true, patch: { status: 'approved', decision: 'approve', decidedBy: by, note, postId: paidReplyId, decidedAt: now } };
}

// ---------------------------------------------------------------------------
// The payout post: the agent's own original post about a paid job, from a fixed template
// ---------------------------------------------------------------------------

/**
 * The agent's post about a paid job, word for word; only the task is the model's (it already went out in the job post).
 * It names nobody: the winner's handle is not kept (an entry row holds an author id and no name), and a mention needs a
 * source credit the gate checks. The winning entry is linked instead, which the job post asked leave for ("By replying
 * you let @handle repost your entry with credit"). When the text would not fit `limit`, the entry link goes first, then
 * the task is cut.
 */
export function payoutPostText(p: { task: string; amountMicroUsdc: bigint | string; txUrl: string; entryUrl?: string | null; limit: number }): string {
  const build = (task: string, entryUrl: string | null) => `Bounty paid: ${usdc(p.amountMicroUsdc)} USDC to the winning entry. The job: ${task}${endsSentence(task) ? '' : '.'} Payment: ${p.txUrl}${entryUrl ? ` Entry: ${entryUrl}` : ''}`;
  const task = p.task.trim();
  for (const entryUrl of p.entryUrl ? [p.entryUrl, null] : [null]) {
    const text = build(task, entryUrl);
    if (postLength(text) <= p.limit) return text;
  }
  const over = postLength(build(task, null)) - p.limit;
  const kept = [...task].slice(0, Math.max(0, [...task].length - over - 1)).join('').trimEnd();
  return build(`${kept}…`, null);
}

/**
 * Publishes the payout post of a paid job, once: the sender action id is `bounty:<jobId>:payout`, so a retry after an
 * unknown outcome replays the sender's receipt and never posts twice, and a job that carries `payoutPostId` (or a final
 * `payoutPostError`) is left alone. It is one of the agent's original posts: a closed posting slot, quiet hours, a used
 * up quota or a sender that cannot be reached leave the job as it is for the sweep, which tries again until
 * `PAYOUT_POST_WINDOW_MS` after the payment. A text the publish gate refuses, or the sender rejects, is final.
 */
export async function publishPayoutPost(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job: BountyJobRow): Promise<BountyJobRow> {
  if (job.status !== 'paid' || !job.txHash || job.payoutPostId || job.payoutPostError) return job;
  const now = ctx.now();
  const gate = await originalPostGate(ctx, now);
  if (!gate.open) return job;
  const premium = (await ctx.sender.account(agent.agentId).catch(() => null))?.premium ?? null;
  const winner = (job.verdict as { winner?: unknown } | null)?.winner;
  const [entry] = typeof winner === 'number' ? await ctx.db.select({ replyId: bountyEntries.replyId }).from(bountyEntries).where(and(eq(bountyEntries.jobId, job.id), eq(bountyEntries.considered, true), eq(bountyEntries.n, winner))).limit(1) : [];
  const text = payoutPostText({ task: job.task, amountMicroUsdc: job.amountMicroUsdc, txUrl: explorerTxUrl(ctx.chain.chainId, job.txHash), entryUrl: entry ? replyLink(entry.replyId) : null, limit: postLimitsFor(premium).original });
  const finding = postFinding(text, [], 'original', false, { platform: config.platform === true, publicAddresses: publicAddressesOf(config) });
  if (finding) {
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, code: finding.code }, 'bounty payout post refused by the publish gate; not sent');
    return setJob(ctx, job.id, { payoutPostError: `gate:${finding.code}` });
  }
  let res;
  try {
    res = await ctx.sender.publish({ agentId: agent.agentId, actionId: `bounty:${job.id}:payout`, text, publicAddresses: publicAddressesOf(config), xUserId: config.xUserId, ...(config.platform ? { platform: true } : {}) });
  } catch (err) {
    const error = err instanceof SenderError ? `sender:${err.code}` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
    const transient = (err instanceof SenderError && (err.retryable || err.code === 'quota_exceeded')) || (err instanceof Error && /abort|timeout|fetch failed|ECONN|network/i.test(err.message));
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, error, transient }, 'bounty payout post not sent');
    return transient ? job : setJob(ctx, job.id, { payoutPostError: error.slice(0, 300) });
  }
  if (res.status === 'rejected') {
    ctx.log.warn({ ...MODULE, agentId: agent.agentId, jobId: job.id, error: res.receipt.error ?? null }, 'bounty payout post refused by the sender');
    return setJob(ctx, job.id, { payoutPostError: `sender_rejected:${res.receipt.error ?? 'rejected'}`.slice(0, 300) });
  }
  // Held or pending: X may have the post. The same sender action id is asked again by the sweep; never a second post.
  if (res.status !== 'sent' || !res.providerPostId) return job;
  const posted = await setJob(ctx, job.id, { payoutPostId: res.providerPostId });
  log(ctx, agent.agentId, posted, { payoutPostId: res.providerPostId }, 'bounty payment announced in a post of its own');
  return posted;
}

// ---------------------------------------------------------------------------
// A second ruling for a job that closed on a failed one
// ---------------------------------------------------------------------------

/**
 * A job to judge once more: closed `no_winner` inside `REJUDGE_WINDOW_MS` because the judge's answer was no verdict
 * or its thought gave none, with fewer than two thoughts so far, entries on record, not yet judged again, and not an
 * own coin's (no thought is ever bought for one). A verdict from before `thoughts` existed had one thought.
 */
const rejudgeDue = (now: number) =>
  and(
    eq(bountyJobs.status, 'no_winner'),
    sql`${bountyJobs.verdict}->>'invalid' in ('malformed_answer', 'thought_failed')`,
    sql`(${bountyJobs.verdict}->'rejudged') is null`,
    sql`(case when jsonb_typeof(${bountyJobs.verdict}->'thoughts') = 'array' then jsonb_array_length(${bountyJobs.verdict}->'thoughts') else 1 end) < ${JUDGE_MAX_THOUGHTS}`,
    gte(bountyJobs.closedAt, new Date(now - REJUDGE_WINDOW_MS)),
    lte(bountyJobs.updatedAt, new Date(now - RETRY_AFTER_MS)),
    sql`${bountyJobs.entriesConsidered} > 0`,
    sql`not ${OWN_COIN_JOB}`,
  );

/**
 * Judges a closed job once more, from its stored entry rows: each considered entry's artefact is fetched again under
 * the same rules as at the close (and a picture whose bytes are no longer the ones entered is left out), then the judge
 * is asked. When the bundle is the one the first ruling was given on, the first thought is replayed (free; the answer
 * that was refused may hold under today's parser) before a second is bought; when it is not, only the second is asked.
 * A winner becomes a payout proposal; two thoughts with no usable answer become the creator's pick; anything else
 * leaves the job closed as it was, marked `rejudged`, and is not said in public a second time. Returns null while a
 * thought is pending (the next sweep asks the same keys again and pays nothing more).
 */
export async function rejudgeJob(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, job0: BountyJobRow): Promise<BountyJobRow | null> {
  const earlier = job0.verdict as { deliveryHash?: unknown } | null;
  // The touch spaces the attempts (`rejudgeDue` reads `updatedAt`) should this one end on a pending thought.
  const job = await setJob(ctx, job0.id, {});
  const mark = (outcome: string) => ({ ...(job.verdict ?? {}), rejudged: { at: new Date(ctx.now()).toISOString(), outcome } });
  if (isOwn(agent)) return setJob(ctx, job.id, { verdict: mark('own_agent') });
  const rows = (await consideredRows(ctx, job.id)).filter((row) => row.n !== null);
  const refs: JudgedEntryRef[] = [];
  const entries: JudgeEntry[] = [];
  for (const row of rows) {
    const url = artefactString(row, 'url');
    const fetched = url ? await fetchArtefact(ctx, row.kind, url) : null;
    if (!fetched?.ok) continue;
    const pinned = artefactString(row, 'sha256');
    if (pinned && pinned !== fetched.sha256) continue;
    refs.push({ n: row.n!, kind: row.kind, sha256: fetched.sha256, replyId: row.replyId, payee: row.payee, url });
    entries.push(fetched.kind === 'image' ? { n: row.n!, kind: 'image', image: { mime: fetched.mime, bytes: fetched.bytes } } : { n: row.n!, kind: 'link', excerpt: fetched.excerpt });
  }
  if (!entries.length) {
    log(ctx, agent.agentId, job, { considered: rows.length }, 'bounty not judged again: none of its artefacts can be read any more');
    return setJob(ctx, job.id, { verdict: mark('artefacts_unreadable') });
  }
  const sameBundle = deliveryHashOf(refs) === earlier?.deliveryHash;
  log(ctx, agent.agentId, job, { entries: entries.length, considered: rows.length, sameBundle }, 'bounty judged again after a failed ruling');
  const verdict = await judgeJob(ctx, agent, config, { jobId: job.id, task: job.task, criteria: job.criteria, entries, required: requiredOfJob(job) }, { fromAttempt: sameBundle ? 1 : 2 });
  if (verdict.invalid === 'thought_pending') return null;
  return settleVerdict(ctx, agent, config, job, verdict, refs, { earlier: job.verdict });
}

// ---------------------------------------------------------------------------
// A second ruling, from the stored marks, for a job that closed with no winner under the every-criterion rule
// ---------------------------------------------------------------------------

/**
 * A job to rule once more from its stored marks: closed `no_winner` inside `RERULE_WINDOW_MS` on a ruling that stood
 * (no `invalid`, marks on record) and named no winner, never declined by its creator (a declined payout keeps its
 * winner and carries `error`), and not ruled this way before (`verdict.rerule`). A hosted coin's job or an own coin's:
 * nothing is asked of any judge here.
 */
const reruleDue = (now: number) =>
  and(
    eq(bountyJobs.status, 'no_winner'),
    sql`(${bountyJobs.verdict}->>'invalid') is null`,
    sql`(${bountyJobs.verdict}->>'winner') is null`,
    sql`jsonb_typeof(${bountyJobs.verdict}->'perCriterion') = 'object'`,
    sql`(${bountyJobs.verdict}->'rerule') is null`,
    isNull(bountyJobs.error),
    gte(bountyJobs.closedAt, new Date(now - RERULE_WINDOW_MS)),
    sql`${bountyJobs.entriesConsidered} > 0`,
  );

/** Still closed with no winner and not ruled from its marks before: the condition every write of `reruleJob` carries, so it happens once. */
const UNRULED = sql`(${bountyJobs.status} = 'no_winner' and (${bountyJobs.verdict}->'rerule') is null)`;

/** The stored marks of a verdict by entry number, when every one is a full row of marks for `criteria` criteria; else null. */
function storedMarks(verdict: unknown, criteria: number): Map<number, JudgeMark[]> | null {
  const per = (verdict as { perCriterion?: unknown } | null)?.perCriterion;
  if (!per || typeof per !== 'object' || Array.isArray(per)) return null;
  const out = new Map<number, JudgeMark[]>();
  for (const [key, marks] of Object.entries(per as Record<string, unknown>)) {
    if (!/^[1-9]\d{0,2}$/.test(key) || !Array.isArray(marks) || marks.length !== criteria) return null;
    if (!marks.every((m): m is JudgeMark => (JUDGE_MARKS as readonly unknown[]).includes(m))) return null;
    out.set(Number(key), marks);
  }
  return out.size ? out : null;
}

/**
 * Rules a closed job once more under today's winner rule, from the marks its judge already gave: no artefact is
 * fetched, no thought is bought, no judge is asked. The marks must be whole (one row per ruled entry, each entry one of
 * the job's considered rows) or nothing happens. A winner (`pickWinner` over the job's required criteria) with an
 * address on its entry row becomes an ordinary payout proposal, with a reason written by code; nothing is said in
 * public here (the paid reply and the payout post follow when the creator pays). Whatever comes of it, the verdict is
 * marked `rerule` in the one conditional write that moves or marks the job (`UNRULED`), so it happens once. Returns
 * the job when it was proposed, else null.
 */
export async function reruleJob(ctx: SupervisorContext, agent: AgentRow, job: BountyJobRow): Promise<BountyJobRow | null> {
  const before = (job.verdict ?? {}) as Record<string, unknown>;
  const at = new Date(ctx.now()).toISOString();
  const required = requiredOfJob(job);
  /** The mark alone: written only while the job is still closed with no winner and unmarked. */
  const claim = async (verdict: Record<string, unknown>): Promise<BountyJobRow | null> => {
    const [row] = await ctx.db
      .update(bountyJobs)
      .set({ verdict, updatedAt: new Date(ctx.now()) })
      .where(and(eq(bountyJobs.id, job.id), UNRULED))
      .returning();
    return row ?? null;
  };
  const leave = async (outcome: string): Promise<null> => {
    const marked = await claim({ ...before, rerule: { at, outcome, required } });
    if (marked) log(ctx, agent.agentId, marked, { outcome, required }, 'bounty ruled again from its stored marks; the job stays closed');
    return null;
  };

  const marks = storedMarks(before, job.criteria.length);
  const rows = (await consideredRows(ctx, job.id)).filter((row) => row.n !== null);
  if (!marks || !rows.length || [...marks.keys()].some((n) => !rows.some((row) => row.n === n))) return leave('marks_incomplete');
  const perCriterion = Object.fromEntries([...marks].map(([n, m]) => [String(n), m]));
  const pick = pickWinner(perCriterion, [...marks.keys()], required);
  if (pick.winner === null) return leave('no_winner');
  const winner = rows.find((row) => row.n === pick.winner);
  if (!winner?.payee) return leave('winner_without_payee');
  // A payout item for this job that was already decided (there should be none for a job that never had a winner) is not reopened.
  const earlier = await ctx.db.query.approvals.findFirst({ where: eq(approvals.id, payoutApprovalId(job.id)) });
  if (earlier && earlier.status !== 'pending_approval') return leave('approval_exists');

  const reason = templateReason({ winner: pick.winner, passes: pick.passes, criteria: job.criteria.length, required: required.length });
  const verdict = {
    ...before,
    winner: pick.winner,
    reason,
    reasonHash: sha256Hex(reason),
    required,
    reasonBy: 'code',
    rerule: { at, outcome: 'proposed', required, was: { winner: null, reason: typeof before.reason === 'string' ? before.reason : '', reasonHash: typeof before.reasonHash === 'string' ? before.reasonHash : null } },
  };
  const proposed = await proposePayout(ctx, agent, job, { n: pick.winner, replyId: winner.replyId, payee: winner.payee }, reason, verdict, {}, marks.get(pick.winner), UNRULED);
  if (!proposed) return null;
  log(ctx, agent.agentId, proposed, { winner: pick.winner, passes: pick.passes, required, qualified: pick.qualified.length }, 'bounty ruled again from its stored marks: the best entry is proposed to the creator; no thought bought');
  return proposed;
}

// ---------------------------------------------------------------------------
// The sweep (tick.ts)
// ---------------------------------------------------------------------------

export interface BountySweepReport {
  posted: number;
  judged: number;
  expired: number;
  failed: number;
  /** Jobs that had closed on a failed ruling and were judged once more; absent when none. */
  rejudged?: number;
  /** Jobs that had closed with no winner under the every-criterion rule and became a payout proposal from their stored marks; absent when none. */
  reruled?: number;
  /** Paid jobs announced in a post of the agent's own this sweep; absent when none. */
  announced?: number;
  /** Own coins' jobs closed with no winner because their agent gave no ruling in time (`judge_absent`); absent when none. */
  unjudged?: number;
}

/**
 * Every tick: drafts whose wait is over are posted (or fail after DRAFT_TTL_MS), open jobs past their close time are
 * collected and judged (a `judging` job left by a crash is resumed), a job that closed on a failed ruling in the last
 * seven days is judged once more (`rejudgeJob`), a job that closed in the last seven days with no winner on marks that
 * give one under today's rule is proposed from those marks (`reruleJob`; no thought), proposals nobody acted on in 48 hours expire with their approval
 * withdrawn, and a paid job whose own post is still owed gets it (`publishPayoutPost`). At most MAX_JOBS_PER_SWEEP jobs
 * move per tick; an error on one job is logged and counted against its attempts, never thrown.
 *
 * An own coin's job (`isOwn`, with the flag on or off) is collected like any other and then left alone while it waits
 * for its agent's ruling: it is not among the rows step 2 reads, so it holds no sweep slot. A job still unjudged
 * `OWN_JUDGE_WAIT_MS` after its close is closed `no_winner` with `judge_absent` (step 2b). No step here buys a thought
 * for an own coin.
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
    .where(and(or(eq(bountyJobs.status, 'judging'), and(eq(bountyJobs.status, 'open'), lte(bountyJobs.closesAt, new Date(now)))), sql`not ${AWAITS_OWN_RULING}`))
    .orderBy(asc(bountyJobs.closesAt))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of due) {
    if (moved >= MAX_JOBS_PER_SWEEP) break;
    if (job.status === 'judging' && job.attempts > 0 && now - job.updatedAt.getTime() < RETRY_AFTER_MS) continue;
    moved += 1;
    if (job.attempts >= MAX_COLLECT_ATTEMPTS) {
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      const closeReplyId = await closeReply(ctx, agent, config, job, NOTHING_PAID_TEXT);
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
      // A ruling an own agent already gave (the claim landed, the process died before the proposal): finished from the row, never asked again.
      const ruling = job.status === 'judging' ? ownRulingOf(job) : null;
      const { job: after } = ruling ? { job: await resumeOwnRuling(ctx, agent, config, job, ruling) } : await collectAndJudge(ctx, agent, config, job);
      if (after.status !== 'judging') report.judged += 1;
    } catch (err) {
      const error = err instanceof SenderError ? `sender:${err.code}` : err instanceof Error ? err.message.split('\n')[0]! : String(err);
      await setJob(ctx, job.id, { error }).catch(() => undefined);
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, error, attempts: job.attempts + 1 }, 'bounty collection failed; tried again next tick');
    }
  }

  // 2b. Own coins: a job whose agent gave no ruling within the wait closes with no winner, in public. The close is a
  //     conditional write (still `judging`, still no verdict), so a ruling that lands at the same moment wins or loses
  //     whole: never a job both closed and proposed.
  const unjudged = await ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.status, 'judging'), isNull(bountyJobs.verdict), OWN_COIN_JOB, lte(bountyJobs.closesAt, new Date(now - ownSetting(ctx, 'OWN_JUDGE_WAIT_MS')))))
    .orderBy(asc(bountyJobs.closesAt))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of unjudged) {
    try {
      const closedAt = new Date(ctx.now());
      const verdict = { winner: null, perCriterion: {}, reason: '', invalid: JUDGE_ABSENT, deliveryHash: deliveryHashOf([]), reasonHash: sha256Hex(''), judgedAt: closedAt.toISOString() };
      const [closed] = await ctx.db
        .update(bountyJobs)
        .set({ status: 'no_winner', error: JUDGE_ABSENT, verdict, closedAt, updatedAt: closedAt })
        .where(and(eq(bountyJobs.id, job.id), eq(bountyJobs.status, 'judging'), isNull(bountyJobs.verdict)))
        .returning();
      if (!closed) continue;
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      const closeReplyId = await closeReply(ctx, agent, config, job, JUDGE_ABSENT_TEXT);
      if (closeReplyId) await setJob(ctx, job.id, { closeReplyId });
      log(ctx, job.agentId, closed, { closeReplyId, considered: job.entriesConsidered }, "bounty closed unjudged: the creator's own agent gave no ruling in time");
      report.unjudged = (report.unjudged ?? 0) + 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty unjudged close failed for one job');
    }
  }

  // 2c. A job that closed with "no winner" only because the judge gave no usable answer, and has had one thought: judged
  //     once more. One per sweep at most: it fetches every artefact again and may buy a thought.
  if (moved < MAX_JOBS_PER_SWEEP) {
    const [again] = await ctx.db.select().from(bountyJobs).where(rejudgeDue(now)).orderBy(asc(bountyJobs.closedAt)).limit(1);
    if (again) {
      try {
        const agent = await agentFor(again.agentId);
        const config = agent ? agentConfigOf(agent) : null;
        if (!agent || !config) await setJob(ctx, again.id, { verdict: { ...(again.verdict ?? {}), rejudged: { at: new Date(now).toISOString(), outcome: 'agent_not_ready' } } });
        else if (await rejudgeJob(ctx, agent, config, again)) report.rejudged = (report.rejudged ?? 0) + 1;
        moved += 1;
      } catch (err) {
        await setJob(ctx, again.id, {}).catch(() => undefined);
        ctx.log.warn({ ...MODULE, agentId: again.agentId, jobId: again.id, err }, 'bounty re-judge failed for one job; tried again later');
      }
    }
  }

  // 2d. A job that closed with no winner while every criterion had to pass, whose stored marks give a winner under
  //     today's rule: proposed to the creator from those marks. No network and no thought, so it takes no sweep slot.
  const unruled = await ctx.db.select().from(bountyJobs).where(reruleDue(now)).orderBy(asc(bountyJobs.closedAt)).limit(MAX_JOBS_PER_SWEEP);
  for (const job of unruled) {
    try {
      const agent = await agentFor(job.agentId);
      if (!agent) continue;
      if (await reruleJob(ctx, agent, job)) report.reruled = (report.reruled ?? 0) + 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty re-rule from stored marks failed for one job; tried again next tick');
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
      const closeReplyId = await closeReply(ctx, agent, config, job, NOTHING_PAID_TEXT);
      const expired = await closeJob(ctx, job.id, 'expired', { error: 'proposal not acted on within 48 hours', ...(closeReplyId ? { closeReplyId } : {}) });
      log(ctx, job.agentId, expired, { closeReplyId }, 'bounty proposal expired unpaid');
      report.expired += 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty expiry failed for one job');
    }
  }
  // 4. Paid jobs whose own post is still owed (no slot, quiet hours or no quota when the creator approved).
  const owed = await ctx.db
    .select()
    .from(bountyJobs)
    .where(and(eq(bountyJobs.status, 'paid'), isNull(bountyJobs.payoutPostId), isNull(bountyJobs.payoutPostError), gte(bountyJobs.paidAt, new Date(now - PAYOUT_POST_WINDOW_MS))))
    .orderBy(asc(bountyJobs.paidAt))
    .limit(MAX_JOBS_PER_SWEEP);
  for (const job of owed) {
    try {
      const agent = await agentFor(job.agentId);
      const config = agent ? agentConfigOf(agent) : null;
      if (!agent || !config) continue;
      if ((await publishPayoutPost(ctx, agent, config, job)).payoutPostId) report.announced = (report.announced ?? 0) + 1;
    } catch (err) {
      ctx.log.warn({ ...MODULE, agentId: job.agentId, jobId: job.id, err }, 'bounty payout post failed for one job');
    }
  }
  if (report.posted || report.judged || report.expired || report.failed || report.unjudged || report.rejudged || report.reruled || report.announced) ctx.log.info({ ...MODULE, ...report }, 'bounty sweep');
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
  /** The required criteria as 1-based numbers into `criteria`; the others are scored. `[1]` for a job from before the split. */
  required: number[];
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
  payment: { status: 'proposed' | 'paid'; payee: string; amountUsdc: string; txHash: string | null; txUrl: string | null; replyUrl: string | null; paidAt: string | null; postUrl?: string | null } | null;
  closedAt: string | null;
  closeReplyUrl: string | null;
  /**
   * Set while the job waits for the ruling of the creator's own agent (an own-agent coin): when the wait ends and the
   * job closes with no winner. Present on an own-agent coin's jobs only (null once the job is ruled or closed), so a hosted
   * coin's view is what it was. A job that closed unjudged carries `verdict.invalid = 'judge_absent'`.
   */
  ownJudge?: { ruleBy: string } | null;
}

export async function bountyJobViews(ctx: SupervisorContext, agent: AgentRow, opts: { limit?: number; jobId?: string } = {}): Promise<BountyJobView[]> {
  const limit = Math.min(100, Math.max(1, Math.floor(opts.limit ?? 20)));
  const rows = opts.jobId ? [await jobById(ctx, agent.agentId, opts.jobId)].filter((r): r is BountyJobRow => !!r) : await ctx.db.select().from(bountyJobs).where(eq(bountyJobs.agentId, agent.agentId)).orderBy(desc(bountyJobs.createdAt)).limit(limit);
  if (!rows.length) return [];
  const own = isOwn(agent);
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
      required: requiredOfJob(job),
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
          ? { status: job.status, payee: job.payee, amountUsdc: usdc(job.amountMicroUsdc), txHash: job.txHash, txUrl: job.txHash ? explorerTxUrl(ctx.chain.chainId, job.txHash) : null, replyUrl: job.paidReplyId ? replyLink(job.paidReplyId) : null, paidAt: job.paidAt?.toISOString() ?? null, ...(job.payoutPostId ? { postUrl: replyLink(job.payoutPostId) } : {}) }
          : null,
      closedAt: job.closedAt?.toISOString() ?? null,
      closeReplyUrl: job.closeReplyId ? replyLink(job.closeReplyId) : null,
      ...(own ? { ownJudge: job.status === 'judging' && !job.verdict ? { ruleBy: new Date(ruleByOf(ctx, job)).toISOString() } : null } : {}),
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

/**
 * One tape row per job event: posted, judged, paid, no winner, cancelled, expired, failed. Plain words, no address.
 * Two of them are the agent's own doing, and when an own agent's client did them they carry the mark its other rows
 * carry: the job it posted (its `bounty_post` action says `via: 'own'`) and the ruling it gave (the verdict's model is
 * the own-agent id). The rest is code or the creator, and is never marked.
 */
export async function bountyActivity(ctx: SupervisorContext, agent: AgentRow, limit: number, before?: Date, onFull?: (ms: number) => void): Promise<BountyTapeItem[]> {
  const rows = await ctx.db
    .select()
    .from(bountyJobs)
    .where(before ? and(eq(bountyJobs.agentId, agent.agentId), lte(bountyJobs.createdAt, before)) : eq(bountyJobs.agentId, agent.agentId))
    .orderBy(desc(bountyJobs.updatedAt))
    .limit(limit);
  // Every event of a job is at or before its `updatedAt`: a job not read has none newer than the oldest one read.
  if (rows.length === limit) onFull?.(rows[rows.length - 1]!.updatedAt.getTime());
  const items: BountyTapeItem[] = [];
  const push = (at: Date | null, summary: string, extra: Partial<BountyTapeItem> = {}) => {
    if (!at || (before && at.getTime() >= before.getTime())) return;
    items.push({ at: at.toISOString(), kind: 'bounty', summary, ...extra });
  };
  // The jobs an own agent's client posted, in one read (none when no job is listed).
  const postedByOwn = new Set(
    rows.length
      ? (
          await ctx.db
            .select({ actionId: actions.actionId })
            .from(actions)
            .where(and(inArray(actions.actionId, rows.map((j) => j.actionId)), sql`${actions.action}->>'via' = 'own'`))
        ).map((r) => r.actionId)
      : [],
  );
  for (const job of rows) {
    const amount = `${usdc(job.amountMicroUsdc)} USDC`;
    const postUrl = job.postId ? replyLink(job.postId) : undefined;
    push(job.openedAt, `Posted a bounty for ${amount}: ${short(job.task)}${postedByOwn.has(job.actionId) ? OWN_AGENT_MARK : ''}`, postUrl ? { url: postUrl } : {});
    if (job.judgedAt && job.status !== 'no_winner') {
      const verdict = job.verdict as { winner?: unknown; manualPick?: unknown; pickedBy?: unknown; thought?: { model?: unknown } } | null;
      if (verdict?.pickedBy === 'creator') push(job.judgedAt, `Bounty: the judge gave no ruling, the creator picked entry ${String(verdict.winner ?? '?')} of ${job.entriesConsidered}`, postUrl ? { url: postUrl } : {});
      else if (verdict?.manualPick === true) push(job.judgedAt, `Bounty: the judge gave no ruling, ${job.entriesConsidered} ${job.entriesConsidered === 1 ? 'entry waits' : 'entries wait'} for the creator's pick`, postUrl ? { url: postUrl } : {});
      else push(job.judgedAt, `Judged a bounty: entry ${verdict?.winner ?? '?'} of ${job.entriesConsidered} won${verdict?.thought?.model === OWN_AGENT_MODEL_ID ? OWN_AGENT_MARK : ''}`, postUrl ? { url: postUrl } : {});
    }
    switch (job.status) {
      case 'paid':
        push(job.paidAt, `Paid ${amount} for a bounty entry`, { ...(job.txHash ? { txHash: job.txHash, url: explorerTxUrl(ctx.chain.chainId, job.txHash) } : {}) });
        break;
      case 'no_winner':
        push(
          job.closedAt,
          job.error?.startsWith('declined')
            ? 'Bounty closed: the creator declined the proposal, nothing paid'
            : job.error === JUDGE_ABSENT
              ? 'Bounty closed: the entries were not judged in time, nothing paid'
              : `Bounty closed: no entry met the job (${job.entriesReceived} ${job.entriesReceived === 1 ? 'reply' : 'replies'}), nothing paid`,
          postUrl ? { url: postUrl } : {},
        );
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

/**
 * What a good job looks like, in the suggestion: work the agent will use, small enough to do in minutes for the money,
 * with the subject and the output named. Never promotion, never something to build (a page, a site, an app, an article).
 */
export const BOUNTY_GOOD_JOBS: readonly string[] = [
  'data you will cite (deliverable link): "a CSV of the 20 largest Base token launches this week with name, address and launch block", criteria: it has 20 rows, every row has the three columns, every launch block is from this week',
  'a picture for your next post (deliverable image): "a square image showing how a trade fee is split, with the labels creator, agent and platform", criteria: it is square, the three labels are in it, no other text',
  'one onchain fact with its source (deliverable link): "a Dune query that returns the number of new Base tokens per day for the last 30 days", criteria: the link opens a query result, it has one row per day, it covers 30 days',
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
    how: 'Post one with bounty_post this turn: a task that names its subject and its output exactly, 1 to 4 criteria a judge can check from the artefact alone (a count, a label, a column, a size; never "good" or "creative"), image or link, 0.1 to 1 USDC. A link job asks for data that exists or takes minutes to put together, never for a web page, a site, an app or an article to be built or written. Work you will use, never promotion: no post, follow, like, repost or mention of your coin as the work. Nothing you asked in the last 30 days, and nothing listed under drewNoEntries. If you cannot name such work now, say why in your checkpoint.',
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
  const unanswered = noEntryJobs(await recentJobs(ctx, agent.agentId), ctx.now());
  // rows are newest first; a draft that was never posted still counts as an attempt.
  const suggestion = bountySuggestion({ openJobs: budget.openJobs, maxOpen: budget.maxOpen, remainingTodayMicroUsdc: budget.remainingTodayMicroUsdc, lastJobAt: rows[0] ? rows[0].createdAt.getTime() : null, now: ctx.now() });
  return {
    bounties: {
      meaning: BOUNTIES_MEANING,
      ...(suggestion ? { suggestion } : {}),
      policy: { dailyCapUsdc: usdc(policy.dailyCapMicroUsdc), maxOpen: policy.maxOpen, cooldownDays: Math.round(policy.cooldownSeconds / 86_400), defaultHoursOpen: policy.defaultHoursOpen, review: policy.review, amountUsdc: { min: usdc(BOUNTY_MIN_AMOUNT_MICRO_USDC), max: usdc(BOUNTY_MAX_AMOUNT_MICRO_USDC) }, hoursOpen: { min: BOUNTY_MIN_HOURS_OPEN, max: BOUNTY_MAX_HOURS_OPEN } },
      headroom: bountyBudgetView(budget),
      openJobs: open.map((j) => ({ jobId: j.id, status: j.status, task: j.task, amountUsdc: usdc(j.amountMicroUsdc), deliverable: j.deliverable, closesAt: j.closesAt.toISOString(), ...(j.postId ? { postUrl: replyLink(j.postId) } : {}) })),
      lastVerdicts: verdicts.map((j) => ({ jobId: j.id, status: j.status, task: j.task, amountUsdc: usdc(j.amountMicroUsdc), entries: { received: j.entriesReceived, eligible: j.entriesEligible, considered: j.entriesConsidered }, outcome: jobOutcome(j), verdict: verdictSummary(j) })),
      ...(unanswered.length ? { drewNoEntries: { meaning: NO_ENTRIES_MEANING, jobs: unanswered } } : {}),
    },
  };
}
