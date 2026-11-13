/**
 * `yourCoin`: an agent's own cashtag and its coin's contract address, as labels it is told to use, and the daily count
 * that keeps the address from becoming spam. Built the way the picture hint and the question quota are: code decides,
 * the model is told. The publish gate is not touched and not loosened: one cashtag per post, the platform account only
 * its own, and no address but the agent's own (agent-core `validatePost`, `outgoingDisclosureRisk`).
 *
 * The section of a social turn's first observation carries `cashtag`, `contractAddress`, `addressDue` (none of the
 * agent's original posts of the last 24 hours carried the address and the day's count has room) and what is left of
 * the count. The count: at most `ADDRESS_POSTS_PER_DAY` posts or replies per rolling 24 hours may carry the contract
 * address. Every post at X is one: an original, a reply, each part of a thread by itself.
 *
 * When a post counts: at the time it goes out. One sent now counts now; one the scheduler holds counts at the time it
 * is due, so the check when it is scheduled and the check when it is sent agree; one waiting in the creator's review
 * can go out at any moment and counts in every 24 hours until it is decided. The row an approved post is recorded
 * under counts once: the turn's own row of a queued post (`result.queued`) is left out.
 *
 * Not counted: a reply to somebody who asked where to find the coin (`asksWhereToFind`, on the mention's own text).
 * It is still one reply per mention, inside the reply audience and the daily quota like every reply. The step's own
 * action row is marked (`action.addressAsked`) before the reply leaves, so the later counts know it whichever way it
 * went out (sent at once, or approved from the review queue).
 *
 * `ADDRESS_POSTS_PER_DAY=0` switches the piece off: no section, no count, no read.
 */
import { PLATFORM_CASHTAG, normalizedCommunication, type AgentConfig } from '@bootr/agent-core';
import { and, eq, gt, inArray, ne, sql } from 'drizzle-orm';
import { getAddress } from 'viem';
import type { AgentRow, SupervisorContext } from './context.js';
import { actions, approvals, scheduledPosts } from './db/schema.js';

export const ADDRESS_WINDOW_MS = 24 * 3_600_000;
/** How far back a mark on a queued reply is looked for: the review queue keeps an item 48 hours, and the approved post counts a day more. */
const MARK_WINDOW_MS = 3 * ADDRESS_WINDOW_MS;
/** The id of a scheduled post (scheduled.ts): its review item carries it, and the post is counted from the schedule. */
const SCHEDULED_ID = /^sch_[0-9a-f]{16}$/;
/** A cashtag as the publish gate counts one (agent-core `CASHTAG`). */
const CASHTAG_SYMBOL = /^[A-Za-z][A-Za-z0-9_]*$/;

type Ctx = Pick<SupervisorContext, 'db' | 'now' | 'config'>;

/** The day's count of posts that may carry the contract address; 0 = the piece is off. A caller that holds only a part of the config has it off. */
export function addressLimit(ctx: Pick<SupervisorContext, 'config'>): number {
  const n = (ctx.config as { ADDRESS_POSTS_PER_DAY?: unknown } | undefined)?.ADDRESS_POSTS_PER_DAY;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

/**
 * Whether `text` carries the address, read the way the publish gate reads it (`normalizedCommunication`: entities and
 * percent-escapes decoded, NFKC, invisible code points dropped, lowercase), so a zero-width character or another
 * spelling of the same characters does not slip a post past the count.
 */
export function carriesAddress(text: unknown, address: string): boolean {
  return typeof text === 'string' && normalizedCommunication(text).includes(address.toLowerCase());
}

/** The agent's own cashtag: `$BOOTR` for the platform account (the one its gate allows), else `$` and the coin's symbol; null when the symbol makes no cashtag. */
export function ownCashtag(config: Pick<AgentConfig, 'platform' | 'token'>): string | null {
  if (config.platform === true) return PLATFORM_CASHTAG;
  return CASHTAG_SYMBOL.test(config.token.symbol) ? `$${config.token.symbol}` : null;
}

const WHERE_TO_FIND = new RegExp(
  [
    '\\b(?:contract|ca|addy)\\b',
    '\\b(?:token|coin|contract|your|the) address\\b',
    '\\bwhere\\b[^?]{0,60}\\b(?:find|buy|get|trade)\\b',
    '\\bhow (?:do|can|could|would) (?:i|we|you|one|someone)\\b[^?]{0,40}\\b(?:find|buy|get)\\b',
  ].join('|'),
);

/**
 * Whether a mention asks where to find the coin: its own text, read as the gate reads text and with links left out,
 * carries a question mark and asks for the contract or the address ("CA?", "what is the contract address?") or where
 * or how to find, get, buy or trade it. Narrow on purpose: a statement, or a question about anything else, is not one.
 */
export function asksWhereToFind(text: unknown): boolean {
  if (typeof text !== 'string') return false;
  const plain = normalizedCommunication(text).replace(/https?:\/\/\S+/g, ' ');
  return plain.includes('?') && WHERE_TO_FIND.test(plain);
}

export function addressDailyCap(limit: number, done: 'posted' | 'scheduled' = 'posted'): string {
  return `address_daily_cap: at most ${limit} posts or replies per 24 hours may carry your contract address; nothing was ${done}. ${done === 'scheduled' ? 'Schedule' : 'Send'} it without the address.`;
}

/** One post that carries the address and counts: when it went or is due to go out, and whether it is an original. */
interface AddressUse {
  at: number;
  original: boolean;
}

interface AddressUses {
  /** On X, or handed to the sender, in the last 24 hours. */
  sent: AddressUse[];
  /** Held by the scheduler, at the time each is due. */
  scheduled: AddressUse[];
  /** Waiting in the creator's review: these can go out at any moment. */
  inReview: AddressUse[];
}

const textsOf = (first: unknown, thread: unknown): string[] => [
  ...(typeof first === 'string' ? [first] : []),
  ...(Array.isArray(thread) ? thread.map((p) => (p as { text?: unknown } | null)?.text).filter((t): t is string => typeof t === 'string') : []),
];

/** Whether the scheduler is on (scheduled.ts `schedulingOn`): with it off nothing in its queue goes out, so nothing in it counts. */
const schedulingOn = (ctx: Pick<SupervisorContext, 'config'>): boolean => ctx.config.SCHEDULED_MAX_WAITING > 0 && ctx.config.SCHEDULE_MAX_AHEAD_MS > 0;

async function addressUses(ctx: Ctx, agentId: string, address: string, except: { actionId?: string; scheduledId?: string }): Promise<AddressUses> {
  const now = ctx.now();
  const [rows, marked, review, queue] = await Promise.all([
    ctx.db
      .select({ id: actions.actionId, at: actions.createdAt, action: actions.action, result: actions.result })
      .from(actions)
      .where(
        and(
          eq(actions.agentId, agentId),
          gt(actions.createdAt, new Date(now - ADDRESS_WINDOW_MS)),
          inArray(actions.status, ['sending', 'sent', 'held', 'completed']),
          sql`${actions.action}->>'tool' in ('publish_post', 'publish_reply')`,
          // The turn's own row of a post that was queued for review: the post counts where it waits and where it is recorded once approved.
          sql`coalesce(${actions.result}->'result'->>'queued', 'false') <> 'true'`,
          ...(except.actionId ? [ne(actions.actionId, except.actionId)] : []),
        ),
      )
      .limit(500),
    // Replies marked as answers to "where do I find the coin": the mark sits on the row of the step that decided the reply.
    ctx.db
      .select({ id: actions.actionId })
      .from(actions)
      .where(and(eq(actions.agentId, agentId), gt(actions.createdAt, new Date(now - MARK_WINDOW_MS)), sql`${actions.action}->>'addressAsked' = 'true'`))
      .limit(500),
    ctx.db
      .select({ id: approvals.id, at: approvals.createdAt, kind: approvals.kind, text: approvals.text, meta: approvals.meta })
      .from(approvals)
      .where(and(eq(approvals.agentId, agentId), eq(approvals.status, 'pending_approval'), inArray(approvals.kind, ['post', 'reply'])))
      .limit(200),
    schedulingOn(ctx)
      ? ctx.db
          .select({ id: scheduledPosts.id, at: scheduledPosts.sendAt, text: scheduledPosts.text, thread: scheduledPosts.thread })
          .from(scheduledPosts)
          .where(and(eq(scheduledPosts.agentId, agentId), inArray(scheduledPosts.status, ['waiting_review', 'waiting', 'sending'])))
          .limit(200)
      : [],
  ]);
  const asked = new Set(marked.map((r) => r.id));
  const uses: AddressUses = { sent: [], scheduled: [], inReview: [] };
  for (const r of rows) {
    const action = r.action as { tool?: unknown; input?: { text?: unknown; thread?: unknown }; approval?: { id?: unknown } };
    const approvalId = typeof action.approval?.id === 'string' ? action.approval.id : null;
    if (asked.has(r.id) || (approvalId && asked.has(approvalId))) continue;
    const result = r.result as { sent?: unknown; result?: { sent?: unknown } } | null;
    const out = result?.result?.sent ?? result?.sent;
    // A thread that settled says how many of its parts went out; before that every part may.
    const parts = textsOf(action.input?.text, action.input?.thread);
    const counted = typeof out === 'number' && Number.isInteger(out) && out >= 0 ? parts.slice(0, out) : parts;
    for (const part of counted) if (carriesAddress(part, address)) uses.sent.push({ at: r.at.getTime(), original: action.tool === 'publish_post' });
  }
  for (const r of review) {
    // A scheduled post in review is counted from the schedule, at its time.
    if (SCHEDULED_ID.test(r.id) || r.id === except.actionId || asked.has(r.id)) continue;
    for (const part of textsOf(r.text, (r.meta as { thread?: unknown } | null)?.thread)) if (carriesAddress(part, address)) uses.inReview.push({ at: r.at.getTime(), original: r.kind === 'post' });
  }
  for (const r of queue) {
    if (r.id === except.scheduledId) continue;
    for (const part of textsOf(r.text, r.thread)) if (carriesAddress(part, address)) uses.scheduled.push({ at: r.at.getTime(), original: true });
  }
  return uses;
}

/** The most posts with the address that any 24 hours holding `at` would carry, with `more` added at `at`. */
function fullestDay(uses: AddressUses, at: number, more: number): number {
  const times = [...uses.sent, ...uses.scheduled].map((u) => u.at);
  const ends = [at, ...times.filter((t) => t >= at && t < at + ADDRESS_WINDOW_MS)];
  let most = 0;
  for (const end of ends) most = Math.max(most, times.filter((t) => t > end - ADDRESS_WINDOW_MS && t <= end).length);
  // What waits in review may go out at any moment from now on, so it is in every one of those days.
  return most + more + uses.inReview.length;
}

export interface AddressCheck {
  /** When the post goes out (epoch ms): now for a post sent or queued now, `sendAt` for one being scheduled. */
  at?: number;
  /** The post a reply answers, as the turn was shown it: a reply to somebody who asked where to find the coin is not counted. */
  replyTo?: { text?: unknown } | null;
  /** A scheduled post at the moment it is sent: only what already went out in the last 24 hours is asked. */
  sending?: boolean;
  /** The scheduled row being decided, left out of the count. */
  scheduledId?: string;
  done?: 'posted' | 'scheduled';
}

/**
 * The refusal a post gets when it carries the contract address and the day's count is used up, else null. `parts` are
 * the texts that go to X: one for a post or a reply, every part of a thread. A post that does not carry the address
 * costs no read. A reply that answers "where do I find the coin" is let through and marked on its action row.
 */
export async function addressRefusal(ctx: Ctx, agent: Pick<AgentRow, 'agentId' | 'token'>, actionId: string, parts: readonly string[], opts: AddressCheck = {}): Promise<string | null> {
  const limit = addressLimit(ctx);
  if (limit <= 0) return null;
  const carrying = parts.filter((part) => carriesAddress(part, agent.token)).length;
  if (carrying === 0) return null;
  if (opts.replyTo && asksWhereToFind(opts.replyTo.text)) {
    await ctx.db
      .update(actions)
      .set({ action: sql`jsonb_set(${actions.action}, '{addressAsked}', 'true'::jsonb)` })
      .where(and(eq(actions.actionId, actionId), eq(actions.agentId, agent.agentId)));
    return null;
  }
  const now = ctx.now();
  const uses = await addressUses(ctx, agent.agentId, agent.token, { actionId, ...(opts.scheduledId ? { scheduledId: opts.scheduledId } : {}) });
  const most = opts.sending ? uses.sent.filter((u) => u.at > now - ADDRESS_WINDOW_MS).length + carrying : fullestDay(uses, opts.at ?? now, carrying);
  return most > limit ? addressDailyCap(limit, opts.done ?? 'posted') : null;
}

export interface YourCoinView {
  meaning: string;
  cashtag?: string;
  contractAddress: string;
  /** None of the agent's original posts of the last 24 hours carried the address (none waits to go out with it either), and the count has room. */
  addressDue: boolean;
  /** How many more posts or replies may carry the address in the 24 hours from now. */
  addressLeftToday: number;
}

export function yourCoinMeaning(limit: number, cashtag: boolean): string {
  return [
    `Your own coin's labels.${cashtag ? ' Use the cashtag when a post is about your coin, and never more than one cashtag in a post.' : ''}`,
    'Give the contract address when someone asks where your coin is or how to find it, and put it in an original post when addressDue is true (none of your original posts of the last 24 hours carried it). Word each such post or reply anew: X refuses the same text twice.',
    "Never another coin's cashtag or address.",
    'A cashtag or an address is a label, not a call to buy: the rules against price talk and against telling anyone to buy or sell are unchanged.',
    `At most ${limit} posts or replies per 24 hours may carry the address, and addressLeftToday says how many are left; a reply to someone who asked where to find your coin does not use one up. Past that, say it without the address.`,
  ].join(' ');
}

/**
 * The observation section of a social turn for an agent that may post or reply; `{}` when the piece is off, when the
 * agent can do neither, or when the count cannot be read (the turn goes on without it).
 */
export async function yourCoinSection(ctx: Ctx & Pick<SupervisorContext, 'log'>, agent: Pick<AgentRow, 'agentId' | 'token'>, config: Pick<AgentConfig, 'platform' | 'token' | 'capabilities'>): Promise<Record<string, unknown>> {
  const limit = addressLimit(ctx);
  if (limit <= 0 || (!config.capabilities.xPublish && !config.capabilities.xReply)) return {};
  try {
    const now = ctx.now();
    const uses = await addressUses(ctx, agent.agentId, agent.token, {});
    const left = Math.max(0, limit - fullestDay(uses, now, 0));
    const saidInAnOriginal = [...uses.sent, ...uses.scheduled, ...uses.inReview].some((u) => u.original);
    const cashtag = ownCashtag(config);
    const view: YourCoinView = {
      meaning: yourCoinMeaning(limit, cashtag !== null),
      ...(cashtag ? { cashtag } : {}),
      contractAddress: getAddress(agent.token),
      addressDue: config.capabilities.xPublish === true && left > 0 && !saidInAnOriginal,
      addressLeftToday: left,
    };
    return { yourCoin: view };
  } catch (err) {
    ctx.log.warn({ agentId: agent.agentId, err }, 'own coin section failed; turn goes on without it');
    return {};
  }
}
