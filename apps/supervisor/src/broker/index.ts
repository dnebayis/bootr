import { questionBudget, questionQuotaRefusal } from '../recent-posts.js';
import { MentionError, publishAttributions, type MentionAudienceOptions } from '../attributions.js';
import { commentCheck, commentLimit, storedTurn, type CommentAbout } from '../comment-posts.js';
import { postHooks } from '../post-send.js';
import { linkQuota, sendParts, threadResultFromReceipt, threadRulesRefusal, threadsOffered, THREAD_CUT_NOTE } from '../thread-send.js';
/**
 * Action broker: maps every agent-core tool to an executor and turns what happened into an
 * `ActionOutcome` for the agent-core broker state machine. Idempotency keys are the deterministic
 * `PendingAction.id` (sender publishes) and `sv_treasury_ops.op_id` (money).
 */
import {
  PolicyError,
  TOOLS,
  checkpoint,
  isPolicyError,
  replyEligibility,
  threadParts,
  toolsFor,
  THREAD_MAX_PARTS,
  THREAD_NOT_HERE,
  type Action,
  type ActionOutcome,
  type AgentConfig,
  type PendingAction,
  type PublishPostOptions,
  type ToolAccountOptions,
  type ToolDefinition,
  type ToolName,
} from '@bootr/agent-core';
import { and, desc, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from 'viem';
import { agentDirectory, bootrAgentOf, conversationGuard, markOf, openRepliesInWindow, replyNamingGuard, type AgentDirectory, type BootrAgentMark } from '../agent-directory.js';
import type { AgentRow, SupervisorContext } from '../context.js';
import { actions, approvals, treasuryOps } from '../db/schema.js';
import { originalPostGate } from '../rhythm.js';
import { SenderError, type SenderInboxItem, type ReplyEligibility } from '../sender-client.js';
import { clampSlippageBps, encodeFundSpenderCall, encodeSwapCalls, executeOp, fundingBudget, minUsdcOut, opView, openOps, prepareOp, readTreasuryOnChain, recentOps, swapHelperAddress } from '../treasury.js';
import { SWAP_MAX_SLIPPAGE_BPS } from '../abi.js';
import { readCoin } from '../coin-reader.js';
import { readUrl, searchWeb } from '../web-reader.js';
import { discoverServices, reconcileServiceCall, serviceFetch } from '../services.js';
import { serviceCalls } from '../db/schema.js';
import { generateImage, imageStoredAt, loadImage, mediaFor, WITHOUT_PICTURE } from '../images.js';
import { isOwn, ownSetting } from '../own/registry.js';
import { altTextRisk } from '../image-rules.js';
import { erc20Abi } from 'viem';
import { BOUNTY_ENTRY_REASON, bountyCancel, bountyList, bountyPost, outcomeOfJob } from '../bounties.js';
import { bountyJobs } from '../db/schema.js';
import { RESERVED_REQUEST_TAGS } from '../creator-requests.js';
import { scheduledCancel, scheduledList, schedulePost } from '../scheduled.js';
import { noteWhatWorks, whatWorksOffered } from '../what-works.js';

/** Tools the supervisor can actually execute right now (search needs an API key; images go through the relay). */



/** The `attributions` field of a publish (attributions.ts): the model's credits for mentioned handles, plus coin pages for mentioned Bootr agents. */
async function attributionsFor(ctx: SupervisorContext, agentId: string, text: string, attributions: { username: string; sourceUrl: string }[] | undefined, audience: MentionAudienceOptions = {}): Promise<{ attributions?: { username: string; sourceUrl: string }[] }> {
  const credited = await publishAttributions(ctx, agentId, text, attributions, audience);
  return credited.length ? { attributions: credited } : {};
}

/**
 * Which optional fields of `publish_post` this deployment and this coin offer (docs/design/agent-tools-2.md section
 * 13: a limit of 0 switches its piece off and its sentence leaves the description). `thread`: the thread limits;
 * `about`: the comment limit and the creator's switch (`comments`, read loosely: it is another workstream's field);
 * `topic`: offered unless the facts it feeds are switched off (`LEARN_WINDOW_DAYS` at 0, another workstream's limit,
 * read loosely: absent = on).
 */
export function publishPostOptions(ctx: Pick<SupervisorContext, 'config'>, config: object): PublishPostOptions {
  const loose = ctx.config as unknown as Record<string, unknown>;
  return {
    threadMore: threadsOffered(ctx) ? (ctx.config.THREAD_MAX_PARTS ?? THREAD_MAX_PARTS) - 1 : 0,
    comments: commentLimit(ctx, { config: config as Record<string, unknown> }) > 0,
    topic: loose.LEARN_WINDOW_DAYS !== 0,
  };
}

/**
 * The agent's tool catalog: agent-core's `toolsFor` (capabilities, owner rules, and with `account.premium` the account's
 * own post limit in `publish_post`'s description) minus the tools this deployment cannot serve.
 */
export function availableTools(ctx: Pick<SupervisorContext, 'config'>, config: AgentConfig, account: ToolAccountOptions = {}): ToolDefinition[] {
  return toolsFor(config, { ...account, post: account.post ?? publishPostOptions(ctx, config) }).filter((t) => {
    if (t.name === 'search_web') return !!(ctx.config.SEARCH_API_URL && ctx.config.SEARCH_API_KEY);
    // The note on what works is off at a limit of 0 (what-works.ts): the tool is then not offered at all.
    if (t.name === 'note_what_works') return whatWorksOffered(ctx);
    return true;
  });
}

export interface BrokerEnv {
  /** Inbox snapshot of this turn: postId -> item (for replyAuthorId resolution and eligibility). */
  inbox: Map<string, SenderInboxItem>;
  /** postId -> agent-core `replyEligibility` decision taken when the mention was observed; sent with every reply. */
  eligibility: Map<string, ReplyEligibility>;
  /** The runtime cycle executing the action (bookkeeping for paid relay calls); 0 when unknown. */
  cycle?: number;
  /** The own agent's turn the action belongs to (own/turns.ts); the guards of `ownGuard` read it. Absent on a hosted turn. */
  own?: OwnBrokerTurn;
}

/** What the broker needs to know of an own agent's turn for the guards the hosted prompt alone carries (`ownGuard`). */
export interface OwnBrokerTurn {
  /** When the turn opened (epoch ms): a picture attached to a publish must have been stored since. */
  openedAt: number;
  /** Whether an original post may go out now: the turn holds a due slot it has not used, an open creator request, the digest or the numbers post. */
  postAllowed: boolean;
  /** The agent's next original-post slot (epoch ms), for the refusal's text; null when it has none. */
  nextSlotAt: number | null;
  /** This turn already carried one original post (sent, or queued for review): a turn has one, whatever let it out. */
  postedThisTurn?: boolean;
  /** The coin is in approval mode: an original post is queued, and one queued original per slot is all the queue holds. */
  reviewed?: boolean;
  /** The coin's own post interval (ms): how long one queued original stands for its slot. */
  postIntervalMs?: number | null;
  /** Posts this turn already answered or closed (`publish_reply`, `resolve_mention`, `resolve_mentions`): none is answered again. */
  handledPostIds?: readonly string[];
  /** The X hold on the coin's state right now (quota, credits or 403; rhythm.ts), in the words the client is shown; null when none. */
  hold?: { reason: string; until: number; message: string } | null;
}

/** An original post outside its slot (docs/design/byo-agent.md section 1.6): the text an own agent's client reads. */
export function postSlotNotDue(nextSlotAt: number): string {
  return `post_slot_not_due: an original post needs a due slot or an open request from your creator; your next slot is at ${new Date(nextSlotAt).toISOString()}. Replies may still go out.`;
}
/** A second original post in one turn: a due slot, a creator request, the digest or the numbers post each let one post out, not several. */
export const POST_ALREADY_SENT_THIS_TURN = 'post_already_sent: this turn already carried its one original post; nothing was posted. Replies may still go out, and the next original post waits for your next slot.';
/** Approval mode: an original post is already waiting for the creator, so a second one for the same slot is not queued. */
export function postAlreadyQueued(approvalId: string): string {
  return `post_already_queued: an original post of yours (${approvalId}) is still waiting for your creator's review; nothing more is queued for this slot until it is decided. Replies may still go out.`;
}
/** A second reply to a post the turn already answered or closed: the first answer stands. */
export function mentionAlreadyHandled(postId: string): string {
  return `mention_already_handled: this turn already answered or closed post ${postId}; nothing was posted. One reply per mention: go on with the others.`;
}
/** How long one queued original stands for its slot when the coin has no interval on record. */
export const QUEUED_POST_SLOT_MS = 60 * 60 * 1000;
export const IMAGE_NOT_FROM_THIS_TURN = 'image_not_from_this_turn: attach only a picture uploaded in this turn. Publish your post without an imageId.';
/** The window of an own coin's daily counts of `search_web` and `read_url`. */
export const OWN_DAILY_WINDOW_MS = 24 * 60 * 60 * 1000;
export function searchDailyCap(limit: number): string {
  return `search_daily_cap: at most ${limit} web searches per 24 hours; this one was not run. Go on with what you already have.`;
}
export function readUrlDailyCap(limit: number): string {
  return `read_url_daily_cap: at most ${limit} page reads per 24 hours; this one was not run. Go on with what you already have.`;
}

export function servicesDailyCount(limit: number): string {
  return `services_daily_count: at most ${limit} paid-service calls and catalogue searches per 24 hours; this one was not sent. Go on with what you already have.`;
}
export function rememberDailyCap(limit: number): string {
  return `remember_daily_cap: at most ${limit} notes per 24 hours; this one was not kept. Put what matters in the memory of your finish.`;
}
export function treasuryPrepareDailyCap(limit: number): string {
  return `treasury_prepare_daily_cap: at most ${limit} prepared operations per 24 hours; nothing was prepared. Finish the turn and leave this for a later one.`;
}
export function treasuryExecuteDailyCap(limit: number): string {
  return `treasury_execute_daily_cap: at most ${limit} treasury operations per 24 hours; nothing was signed or sent. Finish the turn and leave this for a later one.`;
}

/** An own coin's calls of `tool` in the last 24 hours, whatever became of them, the action being decided left out. */
async function ownCallsInWindow(ctx: Pick<SupervisorContext, 'db' | 'now'>, agentId: string, tool: ToolName, exceptActionId: string): Promise<number> {
  const since = new Date(ctx.now() - OWN_DAILY_WINDOW_MS);
  const [row] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(actions)
    .where(and(eq(actions.agentId, agentId), gt(actions.createdAt, since), ne(actions.actionId, exceptActionId), sql`${actions.action}->>'tool' = ${tool}`));
  return Number(row?.n ?? 0);
}

/**
 * The guards an own agent's action passes before anything else runs (docs/design/byo-agent.md sections 1.5, 1.6 and 7).
 * A hosted model is held to these by its prompt, its fuel and its loop; an own agent's client is held by code:
 *   - `publish_post` needs a due slot of this turn, an open creator request, the digest or the numbers post, a turn
 *     carries one original post at most, and in approval mode one queued original per slot is all the queue holds;
 *   - a picture attached to a publish must have been stored in this turn;
 *   - no publish goes out while an X hold stands, and a mention the turn already answered or closed is not answered again;
 *   - `search_web` and `read_url` are counted per coin over 24 hours (Bootr's search key and compute, with no fuel to bound them),
 *     and so are `remember`, `treasury_prepare`, `treasury_execute` and the paid-service tools (`x402_fetch` and
 *     `discover_services` together).
 * Null when the action may go on. `executeAction` calls it for an own coin; the engine calls it itself before a publish
 * is queued for review, which never reaches `executeAction`. A turn that is not on record allows no original post.
 */
export async function ownGuard(ctx: SupervisorContext, agent: AgentRow, pending: PendingAction, env: BrokerEnv): Promise<ActionOutcome | null> {
  const action = pending.action;
  const turn: OwnBrokerTurn = env.own ?? { openedAt: ctx.now(), postAllowed: false, nextSlotAt: null };
  // An X hold (quota, credits, 403) is on the coin's state: a hosted agent is not woken while it stands, and an own
  // client is told in the due view; here it is a refusal, so a client that calls anyway reaches neither the sender nor X.
  if ((action.tool === 'publish_post' || action.tool === 'publish_reply') && turn.hold && turn.hold.until > ctx.now()) return failed(turn.hold.message, turn.hold.until);
  if (action.tool === 'publish_post' && !turn.postAllowed) return failed(postSlotNotDue(turn.nextSlotAt ?? ctx.now()));
  if (action.tool === 'publish_post' && turn.postedThisTurn) return failed(POST_ALREADY_SENT_THIS_TURN);
  if (action.tool === 'publish_post' && turn.reviewed) {
    // A queued post never reaches X until the creator approves it, so nothing else bounds how many wait: one per slot.
    const since = new Date(ctx.now() - (turn.postIntervalMs && turn.postIntervalMs > 0 ? turn.postIntervalMs : QUEUED_POST_SLOT_MS));
    const waiting = await ctx.db.query.approvals.findFirst({
      where: and(eq(approvals.agentId, agent.agentId), eq(approvals.kind, 'post'), eq(approvals.status, 'pending_approval'), gt(approvals.createdAt, since), ne(approvals.id, pending.id)),
      columns: { id: true },
    });
    if (waiting) return failed(postAlreadyQueued(waiting.id));
  }
  if ((action.tool === 'publish_post' || action.tool === 'publish_reply') && action.input.imageId) {
    // A picture that does not exist (or is another coin's) is left to `mediaForAction`, which says so in the hosted words.
    const storedAt = await imageStoredAt(ctx, agent.agentId, action.input.imageId);
    if (storedAt !== null && storedAt < turn.openedAt) return failed(IMAGE_NOT_FROM_THIS_TURN);
  }
  if (action.tool === 'publish_reply' && turn.handledPostIds?.includes(action.input.postId)) return failed(mentionAlreadyHandled(action.input.postId));
  if (action.tool === 'publish_reply') {
    // Other Bootr agents named in a reply: each name is a mention in their inbox, and for a hosted one a thought it pays for.
    const named = await replyNamingGuard(ctx, agent, pending, env);
    if (named) return named;
  }
  if (action.tool === 'search_web') {
    const limit = ownSetting(ctx, 'OWN_SEARCH_PER_DAY');
    if ((await ownCallsInWindow(ctx, agent.agentId, 'search_web', pending.id)) >= limit) return failed(searchDailyCap(limit));
  }
  if (action.tool === 'read_url') {
    const limit = ownSetting(ctx, 'OWN_READ_URL_PER_DAY');
    if ((await ownCallsInWindow(ctx, agent.agentId, 'read_url', pending.id)) >= limit) return failed(readUrlDailyCap(limit));
  }
  // Outbound requests of an own coin's choosing: the catalogue search and the paid call share one count.
  if (action.tool === 'x402_fetch' || action.tool === 'discover_services') {
    const limit = ownSetting(ctx, 'OWN_SERVICE_CALLS_PER_DAY');
    const used = (await ownCallsInWindow(ctx, agent.agentId, 'x402_fetch', pending.id)) + (await ownCallsInWindow(ctx, agent.agentId, 'discover_services', pending.id));
    if (used >= limit) return failed(servicesDailyCount(limit));
  }
  // Rows and signatures nothing else bounds without fuel: notes, prepared operations, executed ones.
  if (action.tool === 'remember') {
    const limit = ownSetting(ctx, 'OWN_REMEMBER_PER_DAY');
    if ((await ownCallsInWindow(ctx, agent.agentId, 'remember', pending.id)) >= limit) return failed(rememberDailyCap(limit));
  }
  if (action.tool === 'treasury_prepare') {
    const limit = ownSetting(ctx, 'OWN_TREASURY_PREPARE_PER_DAY');
    if ((await ownCallsInWindow(ctx, agent.agentId, 'treasury_prepare', pending.id)) >= limit) return failed(treasuryPrepareDailyCap(limit));
  }
  if (action.tool === 'treasury_execute') {
    const limit = ownSetting(ctx, 'OWN_TREASURY_EXECUTE_PER_DAY');
    if ((await ownCallsInWindow(ctx, agent.agentId, 'treasury_execute', pending.id)) >= limit) return failed(treasuryExecuteDailyCap(limit));
  }
  return null;
}

/** Records the eligibility decisions of `views` in `env` (what `publish_reply` sends to the sender). */
export function recordEligibility(env: BrokerEnv, views: readonly InboxView[]): void {
  for (const v of views) env.eligibility.set(v.postId, { eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) });
}

/** How long to wait before retrying a publish whose consent lookup could not reach X. */
export const CONSENT_RETRY_MS = 5 * 60_000;

export interface InboxView {
  postId: string;
  authorId: string;
  conversationId: string;
  eligible: boolean;
  reason?: string;
  post: SenderInboxItem['post'];
  observedAt: string | number;
  /** Set when the author is another Bootr agent (agent-directory.ts). */
  bootrAgent?: BootrAgentMark;
  /**
   * Eligible only because it is a direct reply to one of the agent's own posts and the coin answers those (the reply
   * audience `own_threads`, agent-directory.ts `openReplies`): counted against `OPEN_REPLIES_PER_DAY` when answered.
   */
  openReply?: boolean;
}

/** Addresses the agent may name in public: its own token and its own treasury. */
export function publicAddressesOf(config: AgentConfig): string[] {
  return [config.token.address, config.kernel.address];
}

/**
 * Inbox items as the model sees them, with agent-core's reply eligibility. With a `directory`, messages from other
 * Bootr agents are marked and their authors may be answered without a verified badge (the conversation caps in
 * agent-directory.ts bound the exchange). With `bountyConversations` (the conversations of the agent's open bounty
 * jobs, bounties.ts), a reply in one of them is an entry, not a mention: ineligible with reason `bounty_entry`, whatever
 * else is true of it, so no turn answers it and no wake is bought for it.
 */
export function inboxViews(config: AgentConfig, items: readonly SenderInboxItem[], now: number, directory?: AgentDirectory | null, bountyConversations?: ReadonlySet<string> | null): InboxView[] {
  const peers = directory ? directory.entries.filter((e) => e.agentId !== config.agentId && e.xUserId !== config.xUserId) : [];
  const replyAuthorIds = peers.length ? [...new Set([...config.replyAuthorIds, ...peers.map((e) => e.xUserId)])] : config.replyAuthorIds;
  // The reply audience `own_threads`: direct replies under the agent's own posts, as many as the day still has room for.
  const open = directory?.openReplies?.get(config.agentId) ?? null;
  let openLeft = open?.left ?? 0;
  return items.map((item) => {
    if (bountyConversations?.has(item.conversationId)) {
      return { postId: item.postId, authorId: item.authorId, conversationId: item.conversationId, eligible: false, reason: BOUNTY_ENTRY_REASON, post: item.post, observedAt: item.observedAt };
    }
    const e = replyEligibility(item.post, {
      ownUserId: config.xUserId,
      ownHandle: config.xHandle,
      replyAuthorIds,
      blockedAuthorIds: config.blockedAuthorIds,
      seenAt: typeof item.seenAt === 'number' ? item.seenAt : item.seenAt ? Date.parse(item.seenAt) : null,
      deferredUntil: typeof item.deferredUntil === 'number' ? item.deferredUntil : item.deferredUntil ? Date.parse(item.deferredUntil) : null,
      now,
      ...(open && openLeft > 0 ? { openReplyTo: open.ownPostIds } : {}),
    });
    if (e.open) openLeft -= 1;
    const peer = directory ? bootrAgentOf(directory, item.authorId, config.agentId) : null;
    return {
      postId: item.postId,
      authorId: item.authorId,
      conversationId: item.conversationId,
      eligible: e.eligible,
      ...(e.reason ? { reason: e.reason } : {}),
      post: item.post,
      observedAt: item.observedAt,
      ...(peer ? { bootrAgent: markOf(peer) } : {}),
      ...(e.open ? { openReply: true } : {}),
    };
  });
}

/**
 * The eligibility a reply is sent with, held to the reply audience as it is now. A mention that is eligible only as a
 * direct reply under the agent's own post (`own_threads`) is answered while the coin still answers those and the
 * day's count has room; else it is what it was before that audience existed: `verified_audience_required`. Every
 * other decision passes untouched, and a coin on the verified audience never reaches the count.
 */
export async function openReplyEligibility(ctx: Pick<SupervisorContext, 'db' | 'now' | 'config'>, config: AgentConfig, item: SenderInboxItem | undefined, decided: ReplyEligibility, exceptActionId: string): Promise<{ eligibility: ReplyEligibility; openReply: boolean }> {
  if (!item || !decided.eligible) return { eligibility: decided, openReply: false };
  const directory = await agentDirectory(ctx);
  if (!directory.openReplies?.has(config.agentId)) return { eligibility: decided, openReply: false };
  const strict = inboxViews(config, [item], ctx.now(), { ...directory, openReplies: new Map() })[0]!;
  if (strict.eligible || strict.reason !== 'verified_audience_required') return { eligibility: decided, openReply: false };
  const now = inboxViews(config, [item], ctx.now(), directory)[0]!;
  const limit = ctx.config.OPEN_REPLIES_PER_DAY;
  if (now.eligible && now.openReply && limit > 0 && (await openRepliesInWindow(ctx, config.agentId, ctx.now(), exceptActionId)) < limit) return { eligibility: decided, openReply: true };
  return { eligibility: { eligible: false, reason: 'verified_audience_required' }, openReply: false };
}

function failed(error: string, retryAt?: number): ActionOutcome {
  return { kind: 'failed', error, ...(retryAt ? { retryAt } : {}) };
}

function errorText(err: unknown): string {
  if (isPolicyError(err)) return err.message;
  if (err instanceof Error) return `${err.name}: ${err.message.split('\n')[0]}`;
  return String(err);
}

function isTransportError(err: unknown): boolean {
  return err instanceof Error && /abort|timeout|fetch failed|ECONN|network/i.test(errorText(err));
}

/** Sender calls in flight at once while closing a list of mentions. */
const RESOLVE_CONCURRENCY = 5;

export interface MentionResolutions {
  resolved: string[];
  failed: { postId: string; error: string; transport: boolean }[];
}

/**
 * Closes several mentions, one sender call each (the sender's resolve is safe to repeat), for `resolve_mentions` and
 * the auto-close pass (mention-close.ts). Never throws: an id that failed comes back in `failed` with its error.
 */
export async function resolveMentions(ctx: SupervisorContext, agentId: string, items: readonly { postId: string; reason: string }[], outcome: 'skip' | 'opt_out' | 'defer', reviewAt?: string): Promise<MentionResolutions> {
  const out: MentionResolutions = { resolved: [], failed: [] };
  for (let i = 0; i < items.length; i += RESOLVE_CONCURRENCY) {
    const round = await Promise.all(
      items.slice(i, i + RESOLVE_CONCURRENCY).map(async ({ postId, reason }) => {
        try {
          await ctx.sender.resolve({ agentId, postId, outcome, reason, ...(reviewAt ? { reviewAt } : {}) });
          return { postId, failure: null };
        } catch (err) {
          return { postId, failure: { postId, error: err instanceof SenderError ? `sender:${err.code}` : errorText(err), transport: isTransportError(err) } };
        }
      }),
    );
    for (const { postId, failure } of round) {
      if (failure) out.failed.push(failure);
      else out.resolved.push(postId);
    }
  }
  return out;
}

/** Thrown inside `executeAction` when a tool runs past its ceiling (`TOOL_TIMEOUT_MS` / `TOOL_READ_TIMEOUT_MS`). */
export class ToolTimeoutError extends Error {
  constructor(
    readonly tool: ToolName,
    readonly timeoutMs: number,
  ) {
    super(`tool_timeout: ${tool} gave no answer within ${Math.round(timeoutMs / 1000)} s`);
    this.name = 'ToolTimeoutError';
  }
}

/** The ceiling for one call of `tool` (config.ts): reads are cut sooner, since nothing of theirs needs reconciling. */
export function toolTimeoutMs(config: Pick<SupervisorContext['config'], 'TOOL_TIMEOUT_MS' | 'TOOL_READ_TIMEOUT_MS'>, tool: ToolName): number {
  return TOOLS[tool].effect === 'read' ? Math.min(config.TOOL_READ_TIMEOUT_MS, config.TOOL_TIMEOUT_MS) : config.TOOL_TIMEOUT_MS;
}

/**
 * `work` or a ToolTimeoutError after `timeoutMs`, whichever comes first. The work itself is not cancelled (a publish
 * or a userOp already on its way cannot be), so a late rejection is swallowed here and a late result is dropped; the
 * caller settles the effect from receipts, like any other `unknown` outcome.
 */
export function withToolTimeout<T>(work: Promise<T>, tool: ToolName, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeoutError(tool, timeoutMs)), timeoutMs);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/**
 * Execute a bound action. Throws nothing: every failure becomes an outcome. Agents run one at a time, so no tool may
 * hold the tick: each call has a hard ceiling (`toolTimeoutMs`), past which a read fails and a write or money tool
 * ends `unknown`, since its effect may still land.
 */
export async function executeAction(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, env: BrokerEnv): Promise<ActionOutcome> {
  const action = pending.action;
  try {
    // An own agent's action passes the own guards first (the slot, the same-turn picture, the daily counts); a hosted one never meets them.
    if (isOwn(agent)) {
      const refused = await ownGuard(ctx, agent, pending, env);
      if (refused) return refused;
    }
    return await withToolTimeout(dispatch(ctx, agent, config, pending, action, env), action.tool, toolTimeoutMs(ctx.config, action.tool));
  } catch (err) {
    return outcomeOfError(ctx, agent, pending.id, action.tool, err);
  }
}

/**
 * What a thrown error of a tool call becomes: every failure is an outcome. Shared with the send of an original that
 * no turn's step carries (thread-send.ts `sendOriginal`: the review queue, the scheduler's sweep), so a post sent
 * there fails, or stays unknown, by the same rules as one the broker sent.
 */
export function outcomeOfError(ctx: Pick<SupervisorContext, 'log' | 'now'>, agent: Pick<AgentRow, 'agentId'>, actionId: string, tool: ToolName, err: unknown): ActionOutcome {
  if (err instanceof ToolTimeoutError) {
    ctx.log.warn({ agentId: agent.agentId, actionId, tool, timeoutMs: err.timeoutMs }, 'tool call timed out');
    return TOOLS[tool].effect === 'read' ? failed(err.message) : { kind: 'unknown', error: err.message };
  }
  if (err instanceof SenderError) {
    if (err.code === 'storage_unavailable_after_send') return { kind: 'unknown', error: err.code };
    // The consent check could not reach X: nothing was recorded or sent; retry the same action later.
    if (err.code === 'consent_lookup_failed') return failed('sender:consent_lookup_failed', err.retryAt ?? ctx.now() + CONSENT_RETRY_MS);
    // The connected X account was authorized without the right to upload pictures (`media.write`); the creator must reconnect it.
    if (err.code === 'media_not_authorized') {
      ctx.log.warn({ agentId: agent.agentId, actionId }, 'picture not sent: the X account was connected without the media.write scope; the creator must reconnect it from the console');
      return failed(`image_not_authorized: your X account was connected without permission to upload pictures; nothing was posted. ${WITHOUT_PICTURE} Your creator can reconnect the account from the console to allow pictures.`);
    }
    // The day's count of posts with a link is used up (the sender, next to the quota): nothing was recorded there, and
    // it is no hold: the same thought goes out without the link.
    if (err.code === 'link_quota') {
      const limit = (err.body as { limit?: unknown } | null)?.limit;
      return failed(linkQuota(typeof limit === 'number' ? limit : 0));
    }
    return failed(`sender:${err.code}`, err.retryAt);
  }
  // An `@` for somebody who did not write to the agent: the refusal says how to name them instead (attributions.ts).
  if (err instanceof MentionError && err.code === 'mention_not_engaged') return failed(err.message);
  if (isPolicyError(err)) return failed(err.message, err.retryAt);
  const text = errorText(err);
  if (isTransportError(err) && TOOLS[tool].effect !== 'read') return { kind: 'unknown', error: text };
  return failed(text);
}

async function dispatch(ctx: SupervisorContext, agent: AgentRow, config: AgentConfig, pending: PendingAction, action: Action, env: BrokerEnv): Promise<ActionOutcome> {
  const agentId = agent.agentId;
  switch (action.tool) {
    case 'read_mentions': {
      const res = await ctx.sender.readMentions(agentId);
      for (const item of res.items) env.inbox.set(item.postId, item);
      const items = inboxViews(config, res.items, ctx.now(), await agentDirectory(ctx));
      recordEligibility(env, items);
      return { kind: 'completed', result: { throttled: res.throttled, nextReadAt: res.nextReadAt ?? null, items, instructionAuthority: false } };
    }
    case 'read_x_thread': {
      const res = await ctx.sender.readThread(agentId, action.input.postId);
      return { kind: 'completed', result: { ...res, instructionAuthority: false } };
    }
    case 'read_x_account': {
      const res = await ctx.sender.readAccount(agentId, action.input.username);
      return { kind: 'completed', result: { ...res, instructionAuthority: false } };
    }
    case 'recall_conversation': {
      const rows = await ctx.db
        .select()
        .from(actions)
        .where(and(eq(actions.agentId, agentId), eq(actions.status, 'completed')))
        .orderBy(desc(actions.createdAt))
        .limit(200);
      const mine = rows
        .filter((r) => {
          const a = r.action as unknown as Action;
          const res = (r.result ?? {}) as { replyAuthorId?: string };
          return (a.tool === 'publish_reply' || a.tool === 'publish_post') && res.replyAuthorId === action.input.authorId;
        })
        .filter((r) => !action.input.beforePostId || BigInt(((r.result ?? {}) as { postId?: string }).postId ?? '0') < BigInt(action.input.beforePostId))
        .slice(0, 20)
        .map((r) => ({ actionId: r.actionId, at: r.createdAt.toISOString(), input: (r.action as unknown as Action).input, result: r.result }));
      const notes = await ctx.memories.recall(agentId, { query: `${action.input.authorId} ${action.input.query ?? ''}` });
      return { kind: 'completed', result: { authorId: action.input.authorId, replies: mine, notes: notes.items, nextBeforePostId: null } };
    }
    case 'publish_reply': {
      const media = await mediaForAction(ctx, agentId, action.input.imageId, config);
      if (media.error) return failed(media.error);
      // Agent-to-agent cap: at most N answers to another Bootr agent in one thread (agent-directory.ts).
      const capped = await conversationGuard(ctx, agent, config, pending, env);
      if (capped) return capped;
      const item = env.inbox.get(action.input.postId);
      // The decision taken when the mention was observed; a mention this turn never observed is not eligible.
      const decided: ReplyEligibility = env.eligibility.get(action.input.postId) ?? (item ? inboxViews(config, [item], ctx.now(), await agentDirectory(ctx)).map((v) => ({ eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }))[0]! : { eligible: false, reason: 'not_in_inbox' });
      // A reply outside the verified audience (a direct reply under the agent's own post) is held to the day's count.
      const { eligibility, openReply } = await openReplyEligibility(ctx, config, item, decided, pending.id);
      const res = await ctx.sender.publish({
        agentId,
        actionId: pending.id,
        text: action.input.text,
        replyTo: action.input.postId,
        ...(item ? { replyAuthorId: item.authorId } : {}),
        replyEligibility: eligibility,
        ...(await attributionsFor(ctx, agentId, action.input.text, action.input.attributions)),
        ...(media.media ? { media: media.media } : {}),
        publicAddresses: publicAddressesOf(config),
        xUserId: config.xUserId,
        ...(config.platform ? { platform: true } : {}),
      });
      return publishOutcome(res, item?.authorId, item?.conversationId, openReply);
    }
    case 'publish_post': {
      const media = await mediaForAction(ctx, agentId, action.input.imageId, config);
      if (media.error) return failed(media.error);
      // Platform rhythm: quiet hours and the platform-wide slot window (rhythm.ts); this action's own row is not a used slot.
      const gate = await originalPostGate(ctx, ctx.now(), { excludeActionId: pending.id });
      if (!gate.open) return failed(gate.hold.message);
      // A scheduled post of the coin's own is due within one post interval: the one it would crowd is the one that waits (post-send.ts).
      const scheduledSoon = await postHooks.beforeOriginalNow(ctx, agent, ctx.now());
      if (scheduledSoon) return failed(scheduledSoon);
      // Agent-to-agent cap: one new thread with another Bootr agent per day (agent-directory.ts).
      const capped = await conversationGuard(ctx, agent, config, pending, env);
      if (capped) return capped;
      // The question quota (recent-posts.ts): at most one original post in five may ask something; a thread asks when any part does.
      const parts = threadParts(action.input);
      const asked = questionQuotaRefusal(parts.join('\n'), await questionBudget(ctx, agentId, { excludeActionId: pending.id }));
      if (asked) return failed(asked);
      const checked = await originalRules(ctx, agent, config, pending.id, action.input, env.inbox, !!media.media);
      if ('refusal' in checked) return failed(checked.refusal);
      const outcome = await sendParts(ctx, agent, config, { actionId: pending.id, text: action.input.text, ...(action.input.thread ? { thread: action.input.thread } : {}), ...(checked.attributions.length ? { attributions: checked.attributions } : {}), ...(checked.about ? { aboutAuthorId: checked.about.authorId } : {}) }, media.media);
      // A comment's result says whose post it is about (the per-author count and the tape read it).
      return checked.about && outcome.kind === 'completed' ? { ...outcome, result: { ...(outcome.result as Record<string, unknown>), about: checked.about } } : outcome;
    }
    case 'resolve_mention': {
      const res = await ctx.sender.resolve({ agentId, postId: action.input.postId, outcome: action.input.outcome, reason: action.input.reason, ...(action.input.reviewAt ? { reviewAt: action.input.reviewAt } : {}) });
      env.inbox.delete(action.input.postId);
      return { kind: 'completed', result: { postId: action.input.postId, outcome: action.input.outcome, ...res } };
    }
    case 'resolve_mentions': {
      const { outcome, reason, reviewAt } = action.input;
      const { resolved, failed: errors } = await resolveMentions(ctx, agentId, [...new Set(action.input.postIds)].map((postId) => ({ postId, reason })), outcome, reviewAt);
      for (const postId of resolved) env.inbox.delete(postId);
      if (resolved.length === 0) {
        const error = `resolve_mentions_failed: ${errors.map((e) => `${e.postId}: ${e.error}`).join('; ')}`;
        // Nothing is known to have reached the sender: the same list may be sent again (a repeat resolve is harmless).
        return errors.every((e) => e.transport) ? { kind: 'unknown', error } : failed(error);
      }
      return { kind: 'completed', result: { outcome, resolved, failed: errors.map(({ postId, error }) => ({ postId, error })) } };
    }
    case 'remember': {
      // A creator request is filed by the chat alone (creator-requests.ts): its tags are dropped from a model's own note.
      const tags = action.input.tags?.filter((tag) => !RESERVED_REQUEST_TAGS.includes(tag));
      const rec = await ctx.memories.remember(agentId, { text: action.input.text, ...(action.input.sources ? { sources: action.input.sources } : {}), ...(tags?.length ? { tags } : {}) });
      return { kind: 'completed', result: { id: rec.id, createdAt: rec.createdAt } };
    }
    case 'recall': {
      const res = await ctx.memories.recall(agentId, action.input);
      return { kind: 'completed', result: res };
    }
    case 'note_what_works':
      return noteWhatWorks(ctx, agent, config, pending);
    case 'finish': {
      const cp = checkpoint(action.input as unknown as Record<string, unknown>, ctx.now());
      return { kind: 'completed', result: { checkpointed: true, nextAt: cp.nextAt } };
    }
    case 'schedule_post':
      return schedulePost(ctx, agent, config, pending, action.input, env);
    case 'scheduled_list':
      return scheduledList(ctx, agent, config);
    case 'scheduled_cancel':
      return scheduledCancel(ctx, agent, action.input);
    case 'read_url': {
      const res = await readUrl(action.input.url, { fetch: ctx.fetch, resolve: ctx.resolveHost });
      return { kind: 'completed', result: res };
    }
    case 'search_web': {
      if (!ctx.config.SEARCH_API_URL || !ctx.config.SEARCH_API_KEY) return failed('search_unavailable');
      const res = await searchWeb(action.input.query, { url: ctx.config.SEARCH_API_URL, key: ctx.config.SEARCH_API_KEY }, ctx.fetch);
      return { kind: 'completed', result: res };
    }
    case 'read_market': {
      const token = action.input.tokenAddress ?? agent.token;
      const snapshot = await ctx.indexer.market(token);
      if (!snapshot) return failed('market_unavailable');
      return { kind: 'completed', result: { token, snapshot, observedAt: new Date(ctx.now()).toISOString(), untrusted: true } };
    }
    case 'read_coin':
      return readCoin(ctx, action.input.symbolOrAddress);
    case 'read_chain':
      return readChain(ctx, action.input);
    case 'treasury_read': {
      const [onchain, indexed, open, recent] = await Promise.all([readTreasuryOnChain(ctx, agent), ctx.indexer.treasury(agent.kernel), openOps(ctx, agentId), recentOps(ctx, agentId, 10)]);
      return {
        kind: 'completed',
        result: {
          ...onchain,
          indexed,
          pending: open.map(opView),
          recent: recent.map(opView),
          policy: {
            allowedOperations: [`swap (WETH -> USDC via the Bootr swap helper; output floor from Chainlink ETH/USD, maxSlippageBps at most ${SWAP_MAX_SLIPPAGE_BPS})`, `transfer (USDC -> your own spender account ${onchain.spender}, which pays for inference; at most ${formatUnits(BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP), 6)} USDC per ${ctx.config.SESSION_USDC_WINDOW_SECONDS}s window in total)`],
            automatic: `LP fees are claimed automatically above $${ctx.config.CLAIM_THRESHOLD_USD}; WETH is swapped to keep >= ${ctx.config.FUEL_TARGET_USDC} USDC of fuel; the spender is topped up to ${ctx.config.SPENDER_TARGET_USDC} USDC when it drops below ${ctx.config.SPENDER_MIN_USDC}.`,
            fees:
              onchain.source === 'clanker-v5' && onchain.claimable.asset === 'USDC'
                ? "Your coin was launched through Clanker v5 and is paired with USDC: every trade pays a tax, Clanker keeps its share, and your slot is credited in USDC to Clanker's fee escrow on every trade. It is claimed in one call (claimFor) and lands on your wallet as USDC, which is fuel for your thinking. It never pays gas: your gas comes only from your creator."
                : onchain.source === 'clanker-v5'
                ? "Your coin was launched through Clanker v5: every trade pays a tax, Clanker keeps its share, and your slot is credited in native ETH to Clanker's fee escrow on every trade. It is claimed in one call (claimFor) and lands on your wallet as ETH, which pays your gas; it is not swapped to USDC, so your fuel stays the USDC your creator adds."
                : onchain.source === 'clanker'
                ? 'Your coin was launched through Clanker: swap fees are collected from the Clanker LP locker into the Clanker fee locker and claimed from there (collectRewards + claim). Uncollected LP fees may be under-reported in `claimable` until a claim collects them.'
                : 'Your coin was launched through Bootr: swap fees accrue on the RWAGMI locker (pending + settled) and are claimed with settleAndClaim.',
            note: 'Only a confirmed transaction hash from treasury_execute proves execution.',
          },
        },
      };
    }
    case 'treasury_prepare':
      return treasuryPrepare(ctx, agent, action.input);
    case 'treasury_execute': {
      const res = await executeOp(ctx, agent, action.input.preparedId, action.input.expectedHash as Hex);
      if (res.status === 'confirmed') return { kind: 'completed', result: { opId: res.opId, txHash: res.txHash, userOpHash: res.userOpHash }, receipt: { txHash: res.txHash, userOpHash: res.userOpHash, opId: res.opId } };
      if (res.status === 'unknown') return { kind: 'unknown', error: `treasury_outcome_unknown:${res.opId}:${res.userOpHash}` };
      return failed(`treasury_failed: ${res.error}`);
    }
    case 'discover_services':
      return { kind: 'completed', result: await discoverServices(ctx, agent, config, action.input) };
    case 'x402_fetch': {
      // Keyed by the action id: the same decision never pays twice (services.ts). An unknown outcome holds the action
      // until the chain closes it (`resolvePending`).
      const res = await serviceFetch(ctx, agent, config, pending.id, action.input);
      if (res.kind === 'completed') return { kind: 'completed', result: res.result, ...(res.receipt ? { receipt: res.receipt } : {}) };
      if (res.kind === 'unknown') return { kind: 'unknown', error: res.error };
      return failed(res.error);
    }
    case 'bounty_post':
      // Keyed by the action id: a resumed step finds its job (bounties.ts). The treasury turn alone holds this tool (roles.ts).
      return bountyPost(ctx, agent, config, pending.id, action.input);
    case 'bounty_cancel':
      return bountyCancel(ctx, agent, config, action.input);
    case 'bounty_list':
      return bountyList(ctx, agent, config);
    case 'generate_image': {
      // The messages received this turn: a picture is never made because somebody asked for one (image-rules.ts).
      const receivedTexts = [...env.inbox.values()].map((item) => (typeof item.post?.text === 'string' ? item.post.text : ''));
      const res = await generateImage(ctx, agent, config, pending, action.input, { cycle: env.cycle ?? 0, receivedTexts });
      if (res.kind === 'completed') return { kind: 'completed', result: res.result };
      if (res.kind === 'unknown') return { kind: 'unknown', error: res.error };
      return failed(res.error);
    }
    default: {
      const never: never = action;
      return failed(`unsupported_tool:${(never as { tool: string }).tool}`);
    }
  }
}

/**
 * The rules of an original post that are new with threads and comments, for the broker and the review queue alike
 * (a queued post never reaches `dispatch`): the thread rules, then the comment rules, and with them the credits of the
 * post's mentions held to the mention audience. A plain post passes through with its credits and nothing else read.
 * Throws `MentionError` as `publishAttributions` does.
 */
export async function originalRules(
  ctx: SupervisorContext,
  agent: AgentRow,
  config: AgentConfig,
  actionId: string,
  input: Extract<Action, { tool: 'publish_post' }>['input'],
  inbox: ReadonlyMap<string, SenderInboxItem>,
  hasMedia: boolean,
): Promise<{ refusal: string } | { attributions: { username: string; sourceUrl: string }[]; about: CommentAbout | null }> {
  const parts = threadParts(input);
  const isThread = parts.length > 1;
  const isComment = !!input.about;
  // What the turn carries (the digest, the numbers post) and what it was shown: read once, and only for a thread or a comment.
  const turn = isThread || isComment ? await storedTurn(ctx, agent.agentId) : null;
  // Mentions belong to the first part; a comment's are held to accounts that wrote to the agent whatever the audience is set to.
  const audience: MentionAudienceOptions = { original: true, ...(isComment ? { comment: true } : {}) };
  let attributions: { username: string; sourceUrl: string }[] | null = null;
  if (isThread) {
    if (turn?.digestWeek || turn?.numbersDay) return { refusal: THREAD_NOT_HERE };
    attributions = await publishAttributions(ctx, agent.agentId, parts[0]!, input.attributions, audience);
    const refused = await threadRulesRefusal(ctx, agent, config, actionId, parts, attributions, { hasMedia, singlePostTurn: false });
    if (refused) return { refusal: refused };
  }
  let about: CommentAbout | null = null;
  if (isComment) {
    const decision = await commentCheck(ctx, agent, config, actionId, input, inbox, turn);
    if ('refusal' in decision) return decision;
    about = decision.about;
  }
  attributions = attributions ?? (await publishAttributions(ctx, agent.agentId, parts[0]!, input.attributions, audience));
  return { attributions, about };
}

/** The sender `media` for a post's optional `imageId`: the agent's own stored image, else a failure the model can act on. */
export async function mediaForAction(ctx: SupervisorContext, agentId: string, imageId: string | undefined, config: Pick<AgentConfig, 'platform'>): Promise<{ media?: ReturnType<typeof mediaFor>; error?: string }> {
  if (!imageId) return {};
  const image = await loadImage(ctx, agentId, imageId);
  if (!image) return { error: `image_not_found: ${imageId} (a picture you made this turn with generate_image, else none). ${WITHOUT_PICTURE}` };
  // The alt text is public text: the same gates as the post, once more at the moment it leaves (image-rules.ts).
  const alt = altTextRisk(image.alt, { platform: config.platform === true });
  if (alt) return { error: `${alt.message}. ${WITHOUT_PICTURE}` };
  return { media: mediaFor(image) };
}

export function publishOutcome(res: { status: string; providerPostId?: string | null; receipt: { error?: string | null; status: string } }, replyAuthorId?: string, conversationId?: string, openReply = false): ActionOutcome {
  if (res.status === 'sent') {
    const postId = res.providerPostId ?? undefined;
    // `replyAuthorId` + `conversationId` are what the agent-to-agent caps count (agent-directory.ts); `openReply` what the day's count of replies outside the verified audience does.
    return { kind: 'completed', result: { postId, ...(replyAuthorId ? { replyAuthorId } : {}), ...(conversationId ? { conversationId } : {}), ...(openReply ? { openReply: true } : {}) }, receipt: { ...(postId ? { postId } : {}) } };
  }
  if (res.status === 'rejected') return failed(`sender_rejected:${res.receipt.error ?? 'rejected'}`);
  // held or pending: maybe published; never resend. The runtime holds until the receipt settles.
  return { kind: 'unknown', error: `sender_${res.status}` };
}

async function readChain(ctx: SupervisorContext, input: Action & { tool: 'read_chain' } extends { input: infer I } ? I : never): Promise<ActionOutcome> {
  const { publicClient } = ctx.chain;
  switch (input.method) {
    case 'balance': {
      if (!input.address) return failed('address_required');
      const [eth, usdc, weth] = await Promise.all([
        publicClient.getBalance({ address: input.address as Address }),
        publicClient.readContract({ address: ctx.chain.addresses.usdc, abi: erc20Abi, functionName: 'balanceOf', args: [input.address as Address] }),
        publicClient.readContract({ address: ctx.chain.addresses.weth, abi: erc20Abi, functionName: 'balanceOf', args: [input.address as Address] }),
      ]);
      return { kind: 'completed', result: { address: input.address, eth: formatUnits(eth, 18), usdc: formatUnits(usdc, 6), weth: formatUnits(weth, 18) } };
    }
    case 'contract_call': {
      if (!input.address || !input.signature) return failed('address_and_signature_required');
      const item = parseAbiItem(input.signature.startsWith('function ') ? input.signature : `function ${input.signature}`);
      if (item.type !== 'function' || (item.stateMutability !== 'view' && item.stateMutability !== 'pure')) return failed('read_only_calls_only');
      const args = (input.args ?? []).map((a, i) => coerceArg(a, item.inputs[i]?.type ?? 'string'));
      const value = await publicClient.readContract({ address: input.address as Address, abi: [item], functionName: item.name, args: args as never });
      return { kind: 'completed', result: { address: input.address, signature: input.signature, value: jsonSafe(value) } };
    }
    case 'transaction': {
      if (!input.txHash) return failed('txHash_required');
      const [tx, receipt] = await Promise.all([publicClient.getTransaction({ hash: input.txHash as Hex }).catch(() => null), publicClient.getTransactionReceipt({ hash: input.txHash as Hex }).catch(() => null)]);
      if (!tx) return failed('transaction_not_found');
      return { kind: 'completed', result: jsonSafe({ hash: tx.hash, from: tx.from, to: tx.to, value: tx.value, blockNumber: tx.blockNumber, status: receipt?.status ?? 'pending', gasUsed: receipt?.gasUsed, logs: receipt?.logs.length }) };
    }
    case 'block': {
      const block = await publicClient.getBlock(input.blockNumber !== undefined ? { blockNumber: BigInt(input.blockNumber) } : {});
      return { kind: 'completed', result: jsonSafe({ number: block.number, hash: block.hash, timestamp: block.timestamp, transactions: block.transactions.length, baseFeePerGas: block.baseFeePerGas }) };
    }
  }
}

function coerceArg(value: string | number | boolean, type: string): unknown {
  if (/^u?int/.test(type)) return BigInt(value as string | number);
  if (type === 'bool') return value === true || value === 'true';
  return value;
}

export function jsonSafe<T>(value: T): T {
  return JSON.parse(JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))) as T;
}

async function treasuryPrepare(ctx: SupervisorContext, agent: AgentRow, input: { operation: string; asset?: string; amount: string; to?: string; maxSlippageBps?: number; memo?: string }): Promise<ActionOutcome> {
  const { addresses } = ctx.chain;
  if (input.operation === 'swap') {
    // The treasury's ether arrives as WETH (LP fees), so 'ETH' is accepted as an alias for WETH here.
    const asset = input.asset && input.asset !== 'ETH' ? getAddress(input.asset) : addresses.weth;
    if (asset !== addresses.weth) return failed('treasury_operation_not_allowed: only WETH -> USDC swaps are allowed');
    const amountIn = parseUnits(input.amount, 18);
    const snap = await readTreasuryOnChain(ctx, agent);
    if (amountIn <= 0n || amountIn > parseUnits(snap.balances.weth, 18)) return failed(`treasury_insufficient_balance: WETH balance ${snap.balances.weth}`);
    if (!snap.ethUsd) return failed('price_feed_unavailable');
    const slippage = clampSlippageBps(input.maxSlippageBps ?? ctx.config.SWAP_SLIPPAGE_BPS);
    const minOut = minUsdcOut(amountIn, snap.ethUsd, slippage);
    let swapHelper: Address;
    try {
      swapHelper = swapHelperAddress(ctx);
    } catch (err) {
      return failed(`treasury_unavailable: ${err instanceof Error ? err.message : String(err)}`);
    }
    const calls = encodeSwapCalls({ weth: addresses.weth, swapHelper, amountIn, maxSlippageBps: slippage });
    const op = await prepareOp(ctx, agent, { kind: 'swap', calls, description: `swap ${input.amount} WETH -> ~>= ${formatUnits(minOut, 6)} USDC via the swap helper (max slippage ${slippage} bps)${input.memo ? ` (${input.memo})` : ''}`, origin: 'model' });
    return { kind: 'completed', result: { preparedId: op.opId, expectedHash: op.callHash, description: op.description, simulated: true, note: 'Nothing moved. Call treasury_execute with preparedId and expectedHash to execute.' } };
  }
  if (input.operation === 'transfer') {
    const spender = ctx.spenderFor(agent).address;
    if (input.to && (!isAddress(input.to) || getAddress(input.to) !== spender)) return failed(`treasury_operation_not_allowed: transfers may only fund your spender account ${spender}`);
    if (input.asset && input.asset !== 'ETH' && getAddress(input.asset) !== addresses.usdc) return failed('treasury_operation_not_allowed: only USDC transfers are allowed');
    if (input.asset === 'ETH') return failed('treasury_operation_not_allowed: only USDC transfers are allowed');
    const amount = parseUnits(input.amount, 6);
    const cap = BigInt(ctx.config.SESSION_USDC_TRANSFER_CAP);
    if (amount <= 0n || amount > cap) return failed(`treasury_policy_limit: at most ${formatUnits(cap, 6)} USDC per ${ctx.config.SESSION_USDC_WINDOW_SECONDS}s window`);
    const budget = await fundingBudget(ctx, agent);
    if (budget && amount > budget.remaining) return failed(`treasury_policy_limit: only ${formatUnits(budget.remaining, 6)} USDC left in the current funding window (resets at ${new Date(budget.windowEnd * 1000).toISOString()})`);
    const calls = [encodeFundSpenderCall(addresses.usdc, spender, amount)];
    const op = await prepareOp(ctx, agent, { kind: 'fund_model', calls, description: `transfer ${input.amount} USDC to the spender ${spender}${input.memo ? ` (${input.memo})` : ''}`, origin: 'model' });
    return { kind: 'completed', result: { preparedId: op.opId, expectedHash: op.callHash, description: op.description, simulated: true, note: 'Nothing moved. Call treasury_execute with preparedId and expectedHash to execute.' } };
  }
  return failed(`treasury_operation_not_allowed: ${input.operation} is handled by the on-chain burner, not the agent`);
}

// ---------------------------------------------------------------------------
// Reconciliation of a pending action (sent / held) without re-sending anything
// ---------------------------------------------------------------------------

export type PendingResolution = { resolved: true; outcome: Exclude<ActionOutcome, { kind: 'unknown' }>; receipt?: Record<string, unknown> } | { resolved: false; reason: string };

export async function resolvePending(ctx: SupervisorContext, agent: AgentRow, pending: PendingAction): Promise<PendingResolution> {
  const tool: ToolName = pending.action.tool;
  if (tool === 'publish_post' || tool === 'publish_reply') {
    try {
      const receipt = await ctx.sender.receipt(pending.id);
      if (receipt.status === 'sent') {
        const postId = receipt.providerPostId ?? undefined;
        // A thread whose first part settled here is closed as the sender holds it, cut where it stopped: nothing more
        // is sent, also when the first part only now proves sent (docs/design/agent-tools-2.md section 3.4).
        const thread = pending.action.tool === 'publish_post' ? pending.action.input.thread : undefined;
        if (thread?.length) {
          const result = threadResultFromReceipt(receipt, 1 + thread.length);
          return { resolved: true, outcome: { kind: 'completed', result: { ...result, ...(result.cut ? { note: THREAD_CUT_NOTE } : {}) }, ...(postId ? { receipt: { postId } } : {}) }, ...(postId ? { receipt: { postId } } : {}) };
        }
        return { resolved: true, outcome: { kind: 'completed', result: { postId }, ...(postId ? { receipt: { postId } } : {}) }, ...(postId ? { receipt: { postId } } : {}) };
      }
      if (receipt.status === 'rejected') return { resolved: true, outcome: { kind: 'failed', error: `sender_rejected:${receipt.error ?? 'rejected'}` } };
      return { resolved: false, reason: `sender_${receipt.status}` };
    } catch (err) {
      if (err instanceof SenderError && err.status === 404) return { resolved: true, outcome: { kind: 'failed', error: 'sender_receipt_missing' } };
      return { resolved: false, reason: errorText(err) };
    }
  }
  if (tool === 'x402_fetch') {
    const row = await ctx.db.query.serviceCalls.findFirst({ where: and(eq(serviceCalls.id, pending.id), eq(serviceCalls.agentId, agent.agentId)) });
    if (!row) return { resolved: true, outcome: { kind: 'failed', error: 'services_call_not_found' } };
    const res = await reconcileServiceCall(ctx, row);
    if (res.kind === 'completed') return { resolved: true, outcome: { kind: 'completed', result: res.result, ...(row.txHash ? { receipt: { txHash: row.txHash } } : {}) }, ...(row.txHash ? { receipt: { txHash: row.txHash } } : {}) };
    if (res.kind === 'failed') return { resolved: true, outcome: { kind: 'failed', error: res.error } };
    return { resolved: false, reason: res.error };
  }
  if (tool === 'bounty_post') {
    // The job row keyed by the action id says what became of the post; a draft or an open job is a completed action.
    const job = await ctx.db.query.bountyJobs.findFirst({ where: and(eq(bountyJobs.actionId, pending.id), eq(bountyJobs.agentId, agent.agentId)) });
    if (!job) return { resolved: true, outcome: { kind: 'failed', error: 'bounty_job_not_found: nothing was posted' } };
    const outcome = outcomeOfJob(job);
    return outcome.kind === 'unknown' ? { resolved: false, reason: outcome.error } : { resolved: true, outcome, ...(outcome.kind === 'completed' && outcome.receipt ? { receipt: outcome.receipt } : {}) };
  }
  if (tool === 'treasury_execute') {
    const opId = (pending.action as Action & { tool: 'treasury_execute' }).input.preparedId;
    const op = await ctx.db.query.treasuryOps.findFirst({ where: and(eq(treasuryOps.opId, opId), eq(treasuryOps.agentId, agent.agentId)) });
    if (!op) return { resolved: true, outcome: { kind: 'failed', error: 'treasury_op_not_found' } };
    if (op.status === 'confirmed') {
      const receipt = { txHash: op.txHash as string, userOpHash: op.userOpHash as string, opId };
      return { resolved: true, outcome: { kind: 'completed', result: { opId, txHash: op.txHash, userOpHash: op.userOpHash }, receipt }, receipt };
    }
    if (op.status === 'failed') return { resolved: true, outcome: { kind: 'failed', error: `treasury_failed: ${op.error ?? 'failed'}` } };
    return { resolved: false, reason: `op_${op.status}` };
  }
  return { resolved: false, reason: 'not_reconcilable' };
}

export async function hasOpenOps(ctx: SupervisorContext, agentId: string): Promise<boolean> {
  const rows = await ctx.db.select({ opId: treasuryOps.opId }).from(treasuryOps).where(and(eq(treasuryOps.agentId, agentId), inArray(treasuryOps.status, ['sent', 'unknown']))).limit(1);
  return rows.length > 0;
}

export { PolicyError };
