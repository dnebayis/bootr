/**
 * Before a turn's first step, closes the mentions the sender would refuse to answer because their author has no
 * verified badge (`verified_audience_required`), so the agent's model does not spend steps tidying them. No model call,
 * no payment and no step: the decision reads author facts only, never a mention's text. A repeat is harmless (the
 * sender's resolve is safe to repeat), so a retry needs no state. Whatever goes wrong, the turn sees the inbox as it was.
 */
import type { AgentConfig } from '@bootr/agent-core';
import type { AgentDirectory } from './agent-directory.js';
import { BOUNTY_ENTRY_REASON } from './bounties.js';
import { availableTools, inboxViews, resolveMentions, type InboxView } from './broker/index.js';
import type { AgentRow, RuntimeRow, SupervisorContext } from './context.js';
import { isVerifiedAuthor, renewLease, type AgentState } from './runtime.js';
import type { SenderInboxItem } from './sender-client.js';

/** The exclusion this pass acts on (agent-core `replyExclusion`), and the reason stored on the closed mention. */
export const AUTO_CLOSE_REASON = 'verified_audience_required';
/** The sender returns at most this many waiting mentions per read; anything beyond waits for the next turn. */
export const MAX_AUTO_CLOSE_PER_TURN = 50;

/**
 * Only an author X reports as unverified, whose id agrees everywhere, and who is nobody the agent has reason to hear.
 * `replyEligibility` checks the badge before it checks a deferral, so a deferred mention can carry this reason too.
 */
export function autoClosable(config: Pick<AgentConfig, 'replyAuthorIds' | 'creator'>, item: SenderInboxItem, view: InboxView): boolean {
  if (view.reason !== AUTO_CLOSE_REASON || view.bootrAgent || item.status !== 'pending' || item.deferredUntil != null) return false;
  const author = item.post.author;
  if (!author || author.verified !== false || isVerifiedAuthor(item.post)) return false;
  if (author.id !== item.authorId || item.post.authorId !== item.authorId) return false;
  const creator = config.creator;
  const isCreator = creator.xUserId === item.authorId || (!!creator.xHandle && creator.xHandle.toLowerCase() === author.username?.toLowerCase());
  return !isCreator && !config.replyAuthorIds.includes(item.authorId);
}

/**
 * Replies in the conversation of one of the agent's open bounty jobs (bounties.ts) are entries, not mentions: they are
 * closed at the sender with the reason `bounty_entry` and taken out of the inbox before the turn sees it, so no model
 * ever answers, acknowledges or ranks an entry. Code collects them from X once the window closes. Never throws.
 */
export async function closeBountyEntries(ctx: SupervisorContext, agent: AgentRow, inbox: SenderInboxItem[], bountyConversations: ReadonlySet<string>): Promise<SenderInboxItem[]> {
  if (!bountyConversations.size) return inbox;
  const entries = inbox.filter((item) => bountyConversations.has(item.conversationId)).slice(0, MAX_AUTO_CLOSE_PER_TURN);
  if (entries.length === 0) return inbox;
  const log = ctx.log.child({ agentId: agent.agentId });
  try {
    const { resolved, failed } = await resolveMentions(ctx, agent.agentId, entries.map((item) => ({ postId: item.postId, reason: BOUNTY_ENTRY_REASON })), 'skip');
    log.info({ closed: resolved.length, failed: failed.length }, 'bounty entries closed in the inbox');
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'bounty entries could not be closed at the sender; they are kept out of the turn anyway');
  }
  // Out of the turn whether or not the sender took the close: the entry rows are collected from X, never from here.
  return inbox.filter((item) => !bountyConversations.has(item.conversationId));
}

/** The inbox the turn should see. Never throws and never touches the turn's steps or failure count. */
export async function autoCloseMentions(ctx: SupervisorContext, agent: AgentRow, runtime: RuntimeRow, config: AgentConfig, inbox: SenderInboxItem[], directory: AgentDirectory, lease: string): Promise<SenderInboxItem[]> {
  if (!ctx.config.MENTION_AUTO_CLOSE_ENABLED) return inbox;
  const log = ctx.log.child({ agentId: agent.agentId });
  try {
    // A thought or an action still in the air may be about one of these mentions: it settles first.
    const state = runtime.state as unknown as AgentState;
    const pending = runtime.pending as unknown as { status?: string } | null;
    if (state.inferenceKey || (pending && pending.status !== 'completed' && pending.status !== 'failed')) return inbox;
    // The same authority the model would need to close them.
    if (!availableTools(ctx, config).some((t) => t.name === 'resolve_mentions')) return inbox;

    const views = inboxViews(config, inbox, ctx.now(), directory);
    const closable = inbox.filter((item, i) => autoClosable(config, item, views[i]!)).slice(0, MAX_AUTO_CLOSE_PER_TURN);
    if (closable.length === 0 || !(await renewLease(ctx, agent.agentId, lease))) return inbox;

    const { resolved, failed } = await resolveMentions(ctx, agent.agentId, closable.map((item) => ({ postId: item.postId, reason: AUTO_CLOSE_REASON })), 'skip');
    log.info({ closed: resolved.length, failed }, 'mentions auto-closed');
    const closed = new Set(resolved);
    return inbox.filter((item) => !closed.has(item.postId));
  } catch (err) {
    log.warn({ err: err instanceof Error ? err.message : String(err) }, 'mention auto-close failed; the turn goes on without it');
    return inbox;
  }
}
