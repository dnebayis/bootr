import { questionBudget, questionQuotaRefusal } from '../recent-posts.js';
import { publishAttributions } from '../attributions.js';
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
  toolsFor,
  type Action,
  type ActionOutcome,
  type AgentConfig,
  type PendingAction,
  type ToolAccountOptions,
  type ToolDefinition,
  type ToolName,
} from '@bootr/agent-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { formatUnits, getAddress, isAddress, parseAbiItem, parseUnits, type Address, type Hex } from 'viem';
import { agentDirectory, bootrAgentOf, conversationGuard, markOf, type AgentDirectory, type BootrAgentMark } from '../agent-directory.js';
import type { AgentRow, SupervisorContext } from '../context.js';
import { actions, treasuryOps } from '../db/schema.js';
import { originalPostGate } from '../rhythm.js';
import { SenderError, type SenderInboxItem, type ReplyEligibility } from '../sender-client.js';
import { clampSlippageBps, encodeFundSpenderCall, encodeSwapCalls, executeOp, fundingBudget, minUsdcOut, opView, openOps, prepareOp, readTreasuryOnChain, recentOps, swapHelperAddress } from '../treasury.js';
import { SWAP_MAX_SLIPPAGE_BPS } from '../abi.js';
import { readCoin } from '../coin-reader.js';
import { readUrl, searchWeb } from '../web-reader.js';
import { discoverServices, reconcileServiceCall, serviceFetch } from '../services.js';
import { serviceCalls } from '../db/schema.js';
import { generateImage, loadImage, mediaFor, WITHOUT_PICTURE } from '../images.js';
import { altTextRisk } from '../image-rules.js';
import { erc20Abi } from 'viem';
import { BOUNTY_ENTRY_REASON, bountyCancel, bountyList, bountyPost, outcomeOfJob } from '../bounties.js';
import { bountyJobs } from '../db/schema.js';
import { RESERVED_REQUEST_TAGS } from '../creator-requests.js';

/** Tools the supervisor can actually execute right now (search needs an API key; images go through the relay). */



/** The `attributions` field of a publish (attributions.ts): the model's credits for mentioned handles, plus coin pages for mentioned Bootr agents. */
async function attributionsFor(ctx: SupervisorContext, agentId: string, text: string, attributions: { username: string; sourceUrl: string }[] | undefined): Promise<{ attributions?: { username: string; sourceUrl: string }[] }> {
  const credited = await publishAttributions(ctx, agentId, text, attributions);
  return credited.length ? { attributions: credited } : {};
}

/**
 * The agent's tool catalog: agent-core's `toolsFor` (capabilities, owner rules, and with `account.premium` the account's
 * own post limit in `publish_post`'s description) minus the tools this deployment cannot serve.
 */
export function availableTools(ctx: Pick<SupervisorContext, 'config'>, config: AgentConfig, account: ToolAccountOptions = {}): ToolDefinition[] {
  return toolsFor(config, account).filter((t) => {
    if (t.name === 'search_web') return !!(ctx.config.SEARCH_API_URL && ctx.config.SEARCH_API_KEY);
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
    });
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
    };
  });
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
    return await withToolTimeout(dispatch(ctx, agent, config, pending, action, env), action.tool, toolTimeoutMs(ctx.config, action.tool));
  } catch (err) {
    if (err instanceof ToolTimeoutError) {
      ctx.log.warn({ agentId: agent.agentId, actionId: pending.id, tool: action.tool, timeoutMs: err.timeoutMs }, 'tool call timed out');
      return TOOLS[action.tool].effect === 'read' ? failed(err.message) : { kind: 'unknown', error: err.message };
    }
    if (err instanceof SenderError) {
      if (err.code === 'storage_unavailable_after_send') return { kind: 'unknown', error: err.code };
      // The consent check could not reach X: nothing was recorded or sent; retry the same action later.
      if (err.code === 'consent_lookup_failed') return failed('sender:consent_lookup_failed', err.retryAt ?? ctx.now() + CONSENT_RETRY_MS);
      // The connected X account was authorized without the right to upload pictures (`media.write`); the creator must reconnect it.
      if (err.code === 'media_not_authorized') {
        ctx.log.warn({ agentId: agent.agentId, actionId: pending.id }, 'picture not sent: the X account was connected without the media.write scope; the creator must reconnect it from the console');
        return failed(`image_not_authorized: your X account was connected without permission to upload pictures; nothing was posted. ${WITHOUT_PICTURE} Your creator can reconnect the account from the console to allow pictures.`);
      }
      return failed(`sender:${err.code}`, err.retryAt);
    }
    if (isPolicyError(err)) return failed(err.message, err.retryAt);
    const text = errorText(err);
    if (isTransportError(err) && TOOLS[action.tool].effect !== 'read') return { kind: 'unknown', error: text };
    return failed(text);
  }
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
      const eligibility: ReplyEligibility = env.eligibility.get(action.input.postId) ?? (item ? inboxViews(config, [item], ctx.now(), await agentDirectory(ctx)).map((v) => ({ eligible: v.eligible, ...(v.reason ? { reason: v.reason } : {}) }))[0]! : { eligible: false, reason: 'not_in_inbox' });
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
      return publishOutcome(res, item?.authorId, item?.conversationId);
    }
    case 'publish_post': {
      const media = await mediaForAction(ctx, agentId, action.input.imageId, config);
      if (media.error) return failed(media.error);
      // Platform rhythm: quiet hours and the platform-wide slot window (rhythm.ts); this action's own row is not a used slot.
      const gate = await originalPostGate(ctx, ctx.now(), { excludeActionId: pending.id });
      if (!gate.open) return failed(gate.hold.message);
      // Agent-to-agent cap: one new thread with another Bootr agent per day (agent-directory.ts).
      const capped = await conversationGuard(ctx, agent, config, pending, env);
      if (capped) return capped;
      // The question quota (recent-posts.ts): at most one original post in five may ask something.
      const asked = questionQuotaRefusal(action.input.text, await questionBudget(ctx, agentId, { excludeActionId: pending.id }));
      if (asked) return failed(asked);
      const res = await ctx.sender.publish({ agentId, actionId: pending.id, text: action.input.text, ...(config.platform ? { platform: true } : {}), ...(await attributionsFor(ctx, agentId, action.input.text, action.input.attributions)), ...(media.media ? { media: media.media } : {}), publicAddresses: publicAddressesOf(config), xUserId: config.xUserId });
      return publishOutcome(res);
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
    case 'finish': {
      const cp = checkpoint(action.input as unknown as Record<string, unknown>, ctx.now());
      return { kind: 'completed', result: { checkpointed: true, nextAt: cp.nextAt } };
    }
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

/** The sender `media` for a post's optional `imageId`: the agent's own stored image, else a failure the model can act on. */
async function mediaForAction(ctx: SupervisorContext, agentId: string, imageId: string | undefined, config: Pick<AgentConfig, 'platform'>): Promise<{ media?: ReturnType<typeof mediaFor>; error?: string }> {
  if (!imageId) return {};
  const image = await loadImage(ctx, agentId, imageId);
  if (!image) return { error: `image_not_found: ${imageId} (a picture you made this turn with generate_image, else none). ${WITHOUT_PICTURE}` };
  // The alt text is public text: the same gates as the post, once more at the moment it leaves (image-rules.ts).
  const alt = altTextRisk(image.alt, { platform: config.platform === true });
  if (alt) return { error: `${alt.message}. ${WITHOUT_PICTURE}` };
  return { media: mediaFor(image) };
}

function publishOutcome(res: { status: string; providerPostId?: string | null; receipt: { error?: string | null; status: string } }, replyAuthorId?: string, conversationId?: string): ActionOutcome {
  if (res.status === 'sent') {
    const postId = res.providerPostId ?? undefined;
    // `replyAuthorId` + `conversationId` are what the agent-to-agent caps count (agent-directory.ts).
    return { kind: 'completed', result: { postId, ...(replyAuthorId ? { replyAuthorId } : {}), ...(conversationId ? { conversationId } : {}) }, receipt: { ...(postId ? { postId } : {}) } };
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
