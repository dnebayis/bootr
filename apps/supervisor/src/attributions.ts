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

export async function publishAttributions(ctx: Pick<SupervisorContext, 'db' | 'now' | 'indexer' | 'log' | 'config'>, text: string, given: readonly Attribution[] | undefined): Promise<Attribution[]> {
  const out = creditedAttributions(text, given);
  const credited = new Set(out.map((a) => a.username.toLowerCase()));
  const missing = [...new Set(mentionedHandles(text))].filter((h) => !credited.has(h));
  if (missing.length === 0) return out;
  const site = ctx.config.SITE_URL.replace(/\/$/, '');
  const coinPages = new Map<string, string>();
  // The per-tick directory first; a handle it does not know may be an agent registered since (a coin launched a
  // minute ago is exactly what the host welcomes), so read the table once more before giving up on it.
  for (const fresh of [false, true]) {
    const directory = await agentDirectory(ctx, { fresh });
    for (const h of missing) {
      const entry = directory.byHandle.get(h);
      if (entry && ADDRESS.test(entry.token)) coinPages.set(h, `${site}/token/${entry.token}`);
    }
    if (coinPages.size === missing.length) break;
  }
  if (coinPages.size < missing.length) {
    const feed = await cachedPlatformFeedData(ctx).catch(() => null);
    for (const launch of feed?.launches ?? []) {
      const h = typeof launch.xHandle === 'string' ? launch.xHandle.replace(/^@/, '').toLowerCase() : '';
      const token = typeof launch.token === 'string' ? launch.token.toLowerCase() : '';
      if (HANDLE.test(h) && ADDRESS.test(token) && missing.includes(h) && !coinPages.has(h)) coinPages.set(h, `${site}/token/${token}`);
    }
  }
  for (const h of missing) {
    const url = coinPages.get(h);
    if (url) out.push({ username: h, sourceUrl: url });
  }
  return out;
}
