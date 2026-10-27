/**
 * Reconciliation of `held` actions (ambiguous outcomes). Mirrors Claus `x.ts`
 * readPublishedAction / reconcilePostActions:
 *  - read the agent's OWN timeline in the readback window [createdAt - 1s, createdAt + 5min],
 *    at most 3 pages;
 *  - settle to `sent` only on a UNIQUE match of (text after URL expansion, replyTo parent,
 *    created_at in window), excluding posts already bound to another action;
 *  - otherwise keep `held` and schedule the next check: 15 min, then hourly, then daily.
 * A held action is never resent and never auto-rejected.
 *
 * Run once: `pnpm --filter sender reconcile`. The server also runs it on an interval.
 */
import { pathToFileURL } from 'node:url';
import { and, eq, inArray, isNull, lt, lte, or } from 'drizzle-orm';
import { withToken } from './accounts.js';
import type { SenderContext } from './context.js';
import { actions, type ActionRow } from './db/schema.js';
import { log } from './log.js';
import { meterRead } from './metering.js';
import { markInbox } from './publish.js';
import type { XTweet } from './x-client.js';

export const READBACK_BEFORE_MS = 1_000;
export const READBACK_AFTER_MS = 5 * 60 * 1000;
export const MAX_READBACK_PAGES = 3;
const BATCH = 25;

/** Delay before the next check, given how many checks have already failed to settle. */
export function nextCheckDelayMs(checksDone: number): number {
  if (checksDone <= 0) return 15 * 60 * 1000;
  if (checksDone < 24) return 60 * 60 * 1000;
  return 24 * 60 * 60 * 1000;
}

/** `pending` rows older than this are treated as crashed mid-send and become `held`. */
export function staleAfterMs(ctx: SenderContext): number {
  return Math.max(2 * 60 * 1000, 4 * ctx.xTimeoutMs);
}

function unescapeHtml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function normalizeText(s: string): string {
  return unescapeHtml(s).normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

/** Post text as authored: long-form note text when present, t.co links expanded. */
export function expandedText(t: XTweet): string {
  const text = t.note_tweet?.text ?? t.text;
  const urls = t.note_tweet?.entities?.urls ?? t.entities?.urls ?? [];
  let out = text;
  for (const u of urls) {
    if (u.url && u.expanded_url) out = out.split(u.url).join(u.expanded_url);
  }
  return normalizeText(out);
}

/**
 * Same criteria as agent-core `readbackMatch` (social/readback.ts):
 *  - authored by the agent itself;
 *  - created inside the window [floor(createdAt - 1s), ceil(createdAt + 5min)) in whole seconds;
 *  - same reply parent (or none for an original post), and, when the recipient's stable id is
 *    known, `in_reply_to_user_id` must equal it;
 *  - same text after t.co expansion; X may prepend the addressed @handle to a reply, which is
 *    ignored only when the recipient id matches.
 * Text comparison additionally undoes X's HTML escaping (&amp; &lt; &gt;) and NFC/CRLF/trim
 * differences; uniqueness is still required before settling.
 */
export function matchesAction(
  action: Pick<ActionRow, 'text' | 'replyTo' | 'replyAuthorId' | 'createdAt'>,
  t: XTweet,
  ownUserId: string,
): boolean {
  if (t.author_id && t.author_id !== ownUserId) return false;
  if (!t.created_at) return false;
  const created = Date.parse(t.created_at);
  const at = action.createdAt.getTime();
  const start = Math.floor((at - READBACK_BEFORE_MS) / 1000) * 1000;
  const end = Math.ceil((at + READBACK_AFTER_MS) / 1000) * 1000;
  if (!(created >= start && created < end)) return false;

  const parent = t.referenced_tweets?.find((r) => r.type === 'replied_to')?.id ?? null;
  if ((action.replyTo ?? null) !== parent) return false;
  const addressed =
    !!action.replyTo && !!action.replyAuthorId && t.in_reply_to_user_id === action.replyAuthorId;
  if (action.replyTo && action.replyAuthorId && !addressed) return false;

  const expected = normalizeText(action.text);
  const expanded = expandedText(t);
  if (expanded === expected) return true;
  return addressed && expanded.replace(/^@[a-z0-9_]+(?:\s+|$)/i, '') === expected;
}

/** X wants second precision RFC3339. */
const isoSeconds = (ms: number, round: 'floor' | 'ceil'): string =>
  new Date((round === 'floor' ? Math.floor(ms / 1000) : Math.ceil(ms / 1000)) * 1000)
    .toISOString()
    .replace('.000Z', 'Z');

export type ReadbackResult =
  | { kind: 'match'; post: XTweet }
  | { kind: 'none' }
  | { kind: 'ambiguous'; count: number }
  | { kind: 'too_early' }
  | { kind: 'error'; message: string };

/** Read the agent's own timeline and look for the single post that corresponds to `action`. */
export async function readPublishedAction(
  ctx: SenderContext,
  action: ActionRow,
): Promise<ReadbackResult> {
  const startMs = action.createdAt.getTime() - READBACK_BEFORE_MS;
  // X rejects end_time too close to "now"; keep 10s of margin.
  const endMs = Math.min(
    action.createdAt.getTime() + READBACK_AFTER_MS,
    ctx.now().getTime() - 10_000,
  );
  if (endMs <= startMs) return { kind: 'too_early' };

  const candidates: XTweet[] = [];
  let paginationToken: string | undefined;
  for (let page = 0; page < MAX_READBACK_PAGES; page++) {
    const res = await withToken(ctx, action.agentId, (token, acct) =>
      ctx.x.userTimeline(token, acct.xUserId, {
        startTime: isoSeconds(startMs, 'floor'),
        endTime: isoSeconds(endMs, 'ceil'),
        paginationToken,
      }),
    );
    if (!res.ok) return { kind: 'error', message: `${res.error}: ${res.message}` };
    const data = res.data.data ?? [];
    await meterRead(ctx, action.agentId, 'timeline', data.length);
    candidates.push(...data.filter((t) => matchesAction(action, t, res.account.xUserId)));
    paginationToken = res.data.meta?.next_token;
    if (!paginationToken) break;
  }

  // Exclude posts already bound to another action (two held actions with identical text).
  let free = candidates;
  if (candidates.length > 0) {
    const taken = await ctx.db
      .select({ id: actions.providerPostId, actionId: actions.actionId })
      .from(actions)
      .where(
        inArray(
          actions.providerPostId,
          candidates.map((c) => c.id),
        ),
      );
    const takenIds = new Set(taken.filter((r) => r.actionId !== action.actionId).map((r) => r.id));
    free = candidates.filter((c) => !takenIds.has(c.id));
  }
  const unique = [...new Map(free.map((t) => [t.id, t])).values()];
  if (unique.length === 1) return { kind: 'match', post: unique[0]! };
  if (unique.length === 0) return { kind: 'none' };
  return { kind: 'ambiguous', count: unique.length };
}

export interface ReconcileSummary {
  promotedStale: number;
  checked: number;
  settled: number;
  stillHeld: number;
}

export async function reconcilePostActions(ctx: SenderContext): Promise<ReconcileSummary> {
  const now = ctx.now();
  const summary: ReconcileSummary = { promotedStale: 0, checked: 0, settled: 0, stillHeld: 0 };

  // 1. A `pending` row this old means the process died between claim and settle: outcome unknown.
  const stale = await ctx.db
    .update(actions)
    .set({ status: 'held', error: 'stale_pending', checks: 0, nextCheckAt: now })
    .where(
      and(
        eq(actions.status, 'pending'),
        lt(actions.createdAt, new Date(now.getTime() - staleAfterMs(ctx))),
      ),
    )
    .returning({ actionId: actions.actionId });
  summary.promotedStale = stale.length;

  // 2. Due held rows.
  const due = await ctx.db
    .select()
    .from(actions)
    .where(
      and(
        eq(actions.status, 'held'),
        or(isNull(actions.nextCheckAt), lte(actions.nextCheckAt, now)),
      ),
    )
    .orderBy(actions.nextCheckAt)
    .limit(BATCH);

  for (const action of due) {
    summary.checked++;
    let result: ReadbackResult;
    try {
      result = await readPublishedAction(ctx, action);
    } catch (err) {
      result = { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
    const checkedAt = ctx.now();
    if (result.kind === 'match') {
      const sentAt = result.post.created_at ? new Date(result.post.created_at) : checkedAt;
      try {
        const updated = await ctx.db
          .update(actions)
          .set({
            status: 'sent',
            providerPostId: result.post.id,
            sentAt,
            lastCheckedAt: checkedAt,
            error: null,
            nextCheckAt: null,
          })
          .where(and(eq(actions.actionId, action.actionId), eq(actions.status, 'held')))
          .returning({ actionId: actions.actionId });
        if (updated.length > 0) {
          summary.settled++;
          await markInbox(ctx, action, {
            status: 'answered',
            replyId: result.post.id,
            reason: null,
          });
          log.info('held action settled', {
            actionId: action.actionId,
            providerPostId: result.post.id,
          });
        }
        continue;
      } catch (err) {
        log.error('failed to settle held action', { actionId: action.actionId, err: String(err) });
      }
    }
    if (result.kind === 'too_early') {
      await ctx.db
        .update(actions)
        .set({ nextCheckAt: new Date(checkedAt.getTime() + 60_000) })
        .where(eq(actions.actionId, action.actionId));
      summary.stillHeld++;
      continue;
    }
    if (result.kind !== 'none')
      log.warn('held action not settled', { actionId: action.actionId, result: result.kind });
    const checks = action.checks + 1;
    await ctx.db
      .update(actions)
      .set({
        checks,
        lastCheckedAt: checkedAt,
        nextCheckAt: new Date(checkedAt.getTime() + nextCheckDelayMs(checks)),
      })
      .where(eq(actions.actionId, action.actionId));
    summary.stillHeld++;
  }
  return summary;
}

/** Interval runner used by the server; never overlaps itself. */
export function startReconciler(ctx: SenderContext, intervalMs: number): () => void {
  if (intervalMs <= 0) return () => {};
  let running = false;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const s = await reconcilePostActions(ctx);
      if (s.checked > 0 || s.promotedStale > 0) log.info('reconcile tick', { ...s });
    } catch (err) {
      log.error('reconcile tick failed', { err: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };
  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

async function main(): Promise<void> {
  const { buildContext } = await import('./bootstrap.js');
  const { ctx, close } = buildContext();
  try {
    const summary = await reconcilePostActions(ctx);
    log.info('reconcile run complete', { ...summary });
  } finally {
    await close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    log.error('reconcile failed', { err: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
