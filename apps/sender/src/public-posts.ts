import { and, desc, eq, isNotNull } from 'drizzle-orm';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { Context } from 'hono';
import { getAccount } from './accounts.js';
import type { SenderContext } from './context.js';
import { actions, type ActionKind } from './db/schema.js';
import { AGENT_ID_RE } from './rebind.js';

/**
 * Public, read-only view of what an agent has published on X: `GET /public/posts/:agentId?limit=3`.
 * Only rows with status `sent` and a provider post id. Never exposes tokens, X user ids, reply
 * targets, errors or anything about held / rejected actions.
 */

export const PUBLIC_POSTS_DEFAULT_LIMIT = 3;
export const PUBLIC_POSTS_MAX_LIMIT = 10;
export const PUBLIC_CACHE_CONTROL = 'public, max-age=60';

export interface PublicPost {
  id: string;
  kind: ActionKind;
  text: string;
  postId: string;
  url: string;
  createdAt: string;
}

export interface PublicPosts {
  agentId: string;
  /** Currently connected handle; null when the agent has no (or a revoked) X account. */
  handle: string | null;
  items: PublicPost[];
}

const HANDLE_RE = /^\w{1,15}$/;
const POST_ID_RE = /^\d{1,25}$/;

export function parseLimit(raw: string | undefined): number {
  const n = raw === undefined || raw === '' ? PUBLIC_POSTS_DEFAULT_LIMIT : Number(raw);
  if (!Number.isFinite(n)) return PUBLIC_POSTS_DEFAULT_LIMIT;
  return Math.min(PUBLIC_POSTS_MAX_LIMIT, Math.max(1, Math.trunc(n)));
}

/** Null when the agent id is unknown to the sender (never connected, never posted). */
export async function publicPosts(
  ctx: SenderContext,
  agentId: string,
  limit: number,
): Promise<PublicPosts | null> {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const [account, rows] = await Promise.all([
    getAccount(ctx, agentId),
    ctx.db
      .select({
        actionId: actions.actionId,
        kind: actions.kind,
        text: actions.text,
        providerPostId: actions.providerPostId,
        xUserId: actions.xUserId,
        createdAt: actions.createdAt,
        sentAt: actions.sentAt,
      })
      .from(actions)
      .where(
        and(
          eq(actions.agentId, agentId),
          eq(actions.status, 'sent'),
          isNotNull(actions.providerPostId),
        ),
      )
      .orderBy(desc(actions.createdAt))
      .limit(limit),
  ]);
  if (!account && rows.length === 0) return null;

  const connected = !!account && !account.revokedAt && HANDLE_RE.test(account.xHandle);
  const handle = connected ? account.xHandle : null;
  const items: PublicPost[] = [];
  for (const r of rows) {
    const postId = r.providerPostId ?? '';
    if (!POST_ID_RE.test(postId)) continue;
    // The handle is only known for posts sent from the account connected now; X resolves
    // `/i/status/<id>` for any post, so older accounts still get a working link.
    const sameAccount =
      !!account && HANDLE_RE.test(account.xHandle) && r.xUserId === account.xUserId;
    items.push({
      id: r.actionId,
      kind: r.kind,
      text: r.text,
      postId,
      url: sameAccount
        ? `https://x.com/${account.xHandle}/status/${postId}`
        : `https://x.com/i/status/${postId}`,
      createdAt: (r.sentAt ?? r.createdAt).toISOString(),
    });
  }
  return { agentId, handle, items };
}

// ------------------------------------------------------------------ rate limit

export interface PublicApiOptions {
  /** Requests per minute per client IP on `/public/*`; 0 disables the limit. */
  ratePerMinute: number;
  /** Use the right-most `X-Forwarded-For` entry (set by one trusted proxy) instead of the socket address. */
  trustProxy: boolean;
}

export const DEFAULT_PUBLIC_API: PublicApiOptions = { ratePerMinute: 120, trustProxy: false };

const WINDOW_MS = 60_000;
const MAX_KEYS = 10_000;

/** Fixed one-minute window per key, in memory (one sender instance is assumed). */
export class RateLimiter {
  private hits = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly now: () => number,
  ) {}

  /** Seconds until the window resets when the request is over the limit; 0 when allowed. */
  check(key: string): number {
    if (this.limit <= 0) return 0;
    const t = this.now();
    const hit = this.hits.get(key);
    if (!hit || t - hit.start >= WINDOW_MS) {
      this.hits.delete(key);
      if (this.hits.size >= MAX_KEYS) this.prune(t);
      this.hits.set(key, { start: t, count: 1 });
      return 0;
    }
    hit.count += 1;
    if (hit.count <= this.limit) return 0;
    return Math.max(1, Math.ceil((hit.start + WINDOW_MS - t) / 1000));
  }

  private prune(t: number) {
    for (const [k, v] of this.hits) if (t - v.start >= WINDOW_MS) this.hits.delete(k);
    // Still full (many live keys): drop the oldest insertions.
    for (const k of this.hits.keys()) {
      if (this.hits.size < MAX_KEYS) break;
      this.hits.delete(k);
    }
  }
}

/** Client address for rate limiting. Never trusts forwarding headers unless configured to. */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = c.req.header('x-forwarded-for');
    const last = xff
      ?.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .pop();
    if (last) return last.slice(0, 64);
  }
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
