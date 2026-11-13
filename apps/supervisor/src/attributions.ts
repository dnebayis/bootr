/**
 * The `attributions` of a publish, made to pass the publish gate (`validatePost`: the credited handles must equal the
 * mentioned handles). Two steps on what the model gave:
 *  - credits naming nobody in the text are dropped (the model credits what it read; such a credit carries nothing to X);
 *  - a mention of another Bootr agent (the agent directory, or a launch in the platform feed) is credited with that
 *    coin's page, so the host can welcome @newcoinagent without inventing a "source";
 *  - a mention of @bootrfun, Bootr's official account, is credited with the site.
 * A mention of anyone else still needs the model's own credit; otherwise the gate refuses the post, as designed.
 *
 * The mention audience (docs/design/agent-tools-2.md section 4.4; `MENTION_AUDIENCE`, `engaged` by default): X's rule
 * for automated accounts is "no unsolicited @mentions", and every agent posts through one X app. So an `@` in an
 * ORIGINAL post is accepted only for another Bootr agent, for @bootrfun, for an account that wrote to the agent within
 * `ENGAGED_WINDOW_MS` (the sender's inbox says so, with the account lookup the mention check makes anyway:
 * `addressedAt`) and for an account on the creator's reply list. Anybody else is named without the `@`, which notifies
 * nobody: `mention_not_engaged`. `anyone` is the rule as it was. A comment (`publish_post {about}`) is held to the
 * engaged audience whatever the setting: it must never be a way to notify a stranger. Replies are not touched: a reply
 * goes to somebody who addressed the agent already.
 *
 * A sender from before this rule (the two services restart together, and for some minutes one may be new and the other
 * old) answers an account read with no `addressedAt` at all: null means "never wrote to the agent", absent means "this
 * sender cannot say". Then the audience is unknown, and an original post is held to the rule as it was before (the
 * account exists and posts these days), so a mention that was allowed yesterday is not refused because of a deploy. A
 * comment did not exist before, so for a comment "cannot say" stays a refusal.
 */
import { creditedAttributions, mentionedHandles } from '@bootr/agent-core';
import { eq } from 'drizzle-orm';
import { agentDirectory } from './agent-directory.js';
import type { SupervisorContext } from './context.js';
import { agents } from './db/schema.js';
import { cachedPlatformFeedData } from './platform-feed.js';

export interface Attribution {
  username: string;
  sourceUrl: string;
}

const HANDLE = /^[a-z0-9_]{1,15}$/;
/** Bootr's official X account: known to every agent, credited with the site, never looked up. */
export const BOOTR_OFFICIAL_HANDLE = 'bootrfun';
// Our own indexer's addresses (tests use short hex ids); the page path is what matters to the gate.
const ADDRESS = /^0x[0-9a-f]{1,40}$/;

/** The refusal an original post gets for an `@` of an account that did not write to the agent. */
export const mentionNotEngaged = (handle: string): string => `mention_not_engaged: @${handle} has not written to you; name them without the @. Nothing was posted.`;

/**
 * Thrown by `publishAttributions` when a mentioned account is unknown on X or has not posted in half a year, or
 * (`mention_not_engaged`) when an original post names with an `@` somebody who did not write to the agent.
 */
export class MentionError extends Error {
  constructor(
    readonly code: 'mention_unknown_account' | 'mention_inactive_account' | 'mention_not_engaged',
    readonly handle: string,
  ) {
    super(code === 'mention_not_engaged' ? mentionNotEngaged(handle) : `${code}: @${handle} ${code === 'mention_unknown_account' ? 'is not an account on X' : 'has not posted in months'}; name the source by its name and link instead of a mention`);
  }
}

/** What kind of publish the credits are for; absent = a reply or a template post, to which the mention audience does not apply. */
export interface MentionAudienceOptions {
  /** An original post: held to `MENTION_AUDIENCE`. */
  original?: boolean;
  /** A comment (`publish_post {about}`): held to the engaged audience whatever `MENTION_AUDIENCE` says. */
  comment?: boolean;
}

/** Account checks of this process: handle -> {ok, until}; one X lookup per handle per day. */
const accountChecks = new Map<string, { code: MentionError['code'] | null; until: number }>();
const ACCOUNT_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

/** For tests: forget cached account checks. */
export function resetAccountChecks(): void {
  accountChecks.clear();
}

/**
 * Every mentioned account that is not a Bootr agent must exist on X and have posted within the last months: the
 * model used to derive handles from website names (a publication's site is not its X account). Looked up through
 * the sender with the agent's own token; a lookup that fails for other reasons lets the mention through.
 */
export async function verifyMentions(ctx: Pick<SupervisorContext, 'sender' | 'now' | 'log'>, agentId: string, handles: readonly string[]): Promise<void> {
  for (const handle of handles) {
    const cached = accountChecks.get(handle);
    if (cached && cached.until > ctx.now()) {
      if (cached.code) throw new MentionError(cached.code, handle);
      continue;
    }
    let code: MentionError['code'] | null = null;
    try {
      const res = await ctx.sender.readAccount(agentId, handle);
      if (res.activity === 'stale') code = 'mention_inactive_account';
    } catch (err) {
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 404 || /x_not_found|not found/i.test(message)) code = 'mention_unknown_account';
      else ctx.log.warn({ agentId, handle, err }, 'mention check skipped: account lookup failed');
    }
    accountChecks.set(handle, { code, until: ctx.now() + ACCOUNT_CHECK_TTL_MS });
    if (code) throw new MentionError(code, handle);
  }
}

/**
 * Every mentioned account outside Bootr must have written to the agent within `ENGAGED_WINDOW_MS`, or be on the
 * creator's reply list (stable ids). One account lookup through the sender per handle: it answers the account's id and
 * when it last wrote to the agent. An account X does not know is `mention_unknown_account` as before; a lookup that
 * fails for another reason cannot show that the mention is welcome, so it is refused too.
 */
export async function requireEngaged(ctx: Pick<SupervisorContext, 'db' | 'sender' | 'now' | 'log' | 'config'>, agentId: string, handles: readonly string[], opts: { comment?: boolean } = {}): Promise<void> {
  if (handles.length === 0) return;
  const row = await ctx.db.query.agents.findFirst({ where: eq(agents.agentId, agentId), columns: { config: true } });
  const listed = (row?.config as { replyAuthorIds?: unknown } | undefined)?.replyAuthorIds;
  const replyAuthorIds = new Set(Array.isArray(listed) ? listed.filter((id): id is string => typeof id === 'string') : []);
  for (const handle of handles) {
    let engaged = false;
    try {
      const res = await ctx.sender.readAccount(agentId, handle);
      const id = (res.user as { id?: unknown } | null)?.id;
      const at = typeof res.addressedAt === 'string' ? Date.parse(res.addressedAt) : Number.NaN;
      engaged = (typeof id === 'string' && replyAuthorIds.has(id)) || (Number.isFinite(at) && ctx.now() - at <= ctx.config.ENGAGED_WINDOW_MS);
      // A sender from before this rule does not say who wrote to the agent: the audience is unknown. An original post
      // is then held to the rule of before (a real account that posts these days); a comment stays refused.
      if (!engaged && res.addressedAt === undefined && opts.comment !== true) {
        if (res.activity === 'stale') throw new MentionError('mention_inactive_account', handle);
        ctx.log.warn({ agentId, handle }, 'mention audience unknown: the sender does not say who wrote to the agent (it is older than this supervisor); the mention is held to the rule of before');
        engaged = true;
      }
    } catch (err) {
      if (err instanceof MentionError) throw err;
      const status = (err as { status?: number }).status;
      const message = err instanceof Error ? err.message : String(err);
      if (status === 404 || /x_not_found|not found/i.test(message)) throw new MentionError('mention_unknown_account', handle);
      ctx.log.warn({ agentId, handle, err }, 'mention refused: the account could not be looked up, so it is not known to have written to the agent');
    }
    if (!engaged) throw new MentionError('mention_not_engaged', handle);
  }
}

export async function publishAttributions(ctx: Pick<SupervisorContext, 'db' | 'now' | 'indexer' | 'log' | 'config' | 'sender'>, agentId: string, text: string, given: readonly Attribution[] | undefined, audience: MentionAudienceOptions = {}): Promise<Attribution[]> {
  const out = creditedAttributions(text, given);
  const mentions = [...new Set(mentionedHandles(text))];
  if (mentions.length === 0) return out;
  const credited = new Set(out.map((a) => a.username.toLowerCase()));
  const site = ctx.config.SITE_URL.replace(/\/$/, '');
  // Which mentions are Bootr agents (the per-tick directory, re-read once when a handle is unknown: a coin launched
  // a minute ago is exactly what the host welcomes), and the coin page each one is credited with.
  const coinPages = new Map<string, string>();
  if (mentions.includes(BOOTR_OFFICIAL_HANDLE)) coinPages.set(BOOTR_OFFICIAL_HANDLE, `${site}/`);
  for (const fresh of [false, true]) {
    const directory = await agentDirectory(ctx, { fresh });
    for (const h of mentions) {
      const entry = directory.byHandle.get(h);
      if (entry && ADDRESS.test(entry.token)) coinPages.set(h, `${site}/token/${entry.token}`);
    }
    if (coinPages.size === mentions.length) break;
  }
  if (coinPages.size < mentions.length) {
    const feed = await cachedPlatformFeedData(ctx).catch(() => null);
    for (const launch of feed?.launches ?? []) {
      const h = typeof launch.xHandle === 'string' ? launch.xHandle.replace(/^@/, '').toLowerCase() : '';
      const token = typeof launch.token === 'string' ? launch.token.toLowerCase() : '';
      if (HANDLE.test(h) && ADDRESS.test(token) && mentions.includes(h) && !coinPages.has(h)) coinPages.set(h, `${site}/token/${token}`);
    }
  }
  for (const h of mentions) {
    const url = coinPages.get(h);
    if (url && !credited.has(h)) out.push({ username: h, sourceUrl: url });
  }
  const outside = mentions.filter((h) => !coinPages.has(h));
  // An original post names with an `@` only who wrote to the agent first (the mention audience); a comment always.
  if (audience.comment === true || (audience.original === true && ctx.config.MENTION_AUDIENCE === 'engaged')) await requireEngaged(ctx, agentId, outside, { comment: audience.comment === true });
  // Mentions of accounts outside Bootr (the model's own credits) must be real, recently active X accounts.
  else await verifyMentions(ctx, agentId, outside);
  return out;
}
