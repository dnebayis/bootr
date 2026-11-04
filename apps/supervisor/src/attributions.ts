/**
 * The `attributions` of a publish, made to pass the publish gate (`validatePost`: the credited handles must equal the
 * mentioned handles). Two steps on what the model gave:
 *  - credits naming nobody in the text are dropped (the model credits what it read; such a credit carries nothing to X);
 *  - a mention of another Bootr agent (the agent directory, or a launch in the platform feed) is credited with that
 *    coin's page, so the host can welcome @newcoinagent without inventing a "source".
 * A mention of anyone else still needs the model's own credit; otherwise the gate refuses the post, as designed.
 */
import { creditedAttributions, mentionedHandles } from '@bootr/agent-core';
import { agentDirectory } from './agent-directory.js';
import type { SupervisorContext } from './context.js';
import { cachedPlatformFeedData } from './platform-feed.js';

export interface Attribution {
  username: string;
  sourceUrl: string;
}

const HANDLE = /^[a-z0-9_]{1,15}$/;
// Our own indexer's addresses (tests use short hex ids); the page path is what matters to the gate.
const ADDRESS = /^0x[0-9a-f]{1,40}$/;

/** Thrown by `publishAttributions` when a mentioned account is unknown on X or has not posted in half a year. */
export class MentionError extends Error {
  constructor(
    readonly code: 'mention_unknown_account' | 'mention_inactive_account',
    readonly handle: string,
  ) {
    super(`${code}: @${handle} ${code === 'mention_unknown_account' ? 'is not an account on X' : 'has not posted in months'}; name the source by its name and link instead of a mention`);
  }
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

export async function publishAttributions(ctx: Pick<SupervisorContext, 'db' | 'now' | 'indexer' | 'log' | 'config' | 'sender'>, agentId: string, text: string, given: readonly Attribution[] | undefined): Promise<Attribution[]> {
  const out = creditedAttributions(text, given);
  const mentions = [...new Set(mentionedHandles(text))];
  if (mentions.length === 0) return out;
  const credited = new Set(out.map((a) => a.username.toLowerCase()));
  const site = ctx.config.SITE_URL.replace(/\/$/, '');
  // Which mentions are Bootr agents (the per-tick directory, re-read once when a handle is unknown: a coin launched
  // a minute ago is exactly what the host welcomes), and the coin page each one is credited with.
  const coinPages = new Map<string, string>();
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
  // Mentions of accounts outside Bootr (the model's own credits) must be real, recently active X accounts.
  await verifyMentions(ctx, agentId, mentions.filter((h) => !coinPages.has(h)));
  return out;
}
