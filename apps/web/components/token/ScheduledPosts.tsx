'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useNow } from '@/lib/hooks';
import { qk, ReviewError } from '@/lib/indexer';
import type { AgentScheduledPosts, ScheduledPost, Token } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { consolePost, untilLabel, whenLabel } from './console-call';
import { useConsoleSession } from './console-session';

const ID_RE = /^sch_[0-9a-f]{16}$/;
const MAX_ITEMS = 12;
const TEXT_MAX_CHARS = 4000;

/** What a status reads as; a post can be cancelled only while it waits. */
const STATUS: Record<string, { label: string; waiting: boolean }> = {
  waiting: { label: 'Waiting', waiting: true },
  waiting_review: { label: 'Waits for your review', waiting: true },
  sending: { label: 'Going out', waiting: false },
  sent: { label: 'Sent', waiting: false },
  failed: { label: 'Not sent', waiting: false },
  missed: { label: 'Missed its time', waiting: false },
  cancelled: { label: 'Cancelled', waiting: false },
};

/**
 * The list as the console renders it, from what the agent service answers: rows that name a post and a time, soonest
 * first. `parts` is taken as a count or as the list of parts, `picture` as anything set, `mayQueue` as a count, and
 * `thread` (the posts after the first) as a short list of strings.
 */
export function sanitizeScheduled(raw: unknown): AgentScheduledPosts {
  const o = (raw ?? {}) as { items?: unknown; mayQueue?: unknown; token?: unknown };
  const items: ScheduledPost[] = [];
  for (const it of Array.isArray(o.items) ? o.items : []) {
    const r = (it ?? {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || !ID_RE.test(r.id) || typeof r.sendAt !== 'string' || !Number.isFinite(Date.parse(r.sendAt)) || typeof r.text !== 'string') continue;
    const thread = (Array.isArray(r.thread) ? r.thread : []).filter((p): p is string => typeof p === 'string').slice(0, 8).map((p) => p.slice(0, TEXT_MAX_CHARS));
    const parts = Array.isArray(r.parts) ? r.parts.length : Number(r.parts);
    items.push({
      id: r.id,
      sendAt: r.sendAt,
      status: typeof r.status === 'string' && r.status.length <= 40 ? r.status : 'waiting',
      text: r.text.slice(0, TEXT_MAX_CHARS),
      parts: Number.isInteger(parts) && parts >= 1 && parts <= 25 ? parts : 1 + thread.length,
      picture: !!r.picture,
      thread,
    });
    if (items.length >= MAX_ITEMS) break;
  }
  items.sort((a, b) => Date.parse(a.sendAt) - Date.parse(b.sendAt));
  const more = typeof o.mayQueue === 'number' && Number.isInteger(o.mayQueue) && o.mayQueue >= 0 ? o.mayQueue : null;
  return { items, mayQueue: more, ...(typeof o.token === 'string' ? { token: o.token } : {}) };
}

function Row({ post, now, busy, onCancel }: { post: ScheduledPost; now: number; busy: boolean; onCancel: () => void }) {
  const [asking, setAsking] = useState(false);
  const status = STATUS[post.status] ?? { label: post.status.replace(/_/g, ' '), waiting: false };
  const until = untilLabel(post.sendAt, now);
  const extras = [post.parts > 1 ? `thread of ${post.parts}` : null, post.picture ? 'with a picture' : null].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-col gap-2 py-3" data-testid="scheduled-post" data-id={post.id} data-status={post.status}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-caption text-ink tabular" title={new Date(post.sendAt).toISOString()}>
          {whenLabel(post.sendAt)}
        </span>
        {until ? <span className="font-mono text-micro text-mute tabular">{until}</span> : null}
        <Badge tone={post.status === 'waiting_review' ? 'graduated' : 'default'}>{status.label}</Badge>
      </div>
      <p className="whitespace-pre-line break-words text-sm text-body">{post.text}</p>
      {post.thread.length > 0 ? (
        <details data-testid="scheduled-thread">
          <summary className="cursor-pointer text-micro text-mute hover:text-ink">The rest of the thread</summary>
          <ol className="mt-1.5 flex flex-col gap-1.5 border-l border-hairline pl-3">
            {post.thread.map((part, i) => (
              <li key={i} className="whitespace-pre-line break-words text-caption text-body">
                {part}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-micro text-mute">{extras}</span>
        {status.waiting ? (
          asking ? (
            <span className="flex flex-wrap items-center gap-2">
              <span className="text-micro text-body">Cancel this post? It will not go out.</span>
              <Button type="button" variant="ink" size="sm" disabled={busy} loading={busy} loadingLabel="Cancelling…" onClick={onCancel} data-testid="scheduled-cancel-confirm">
                Cancel the post
              </Button>
              <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setAsking(false)}>
                Keep it
              </Button>
            </span>
          ) : (
            <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(true)} data-testid="scheduled-cancel">
              Cancel
            </Button>
          )
        ) : null}
      </div>
    </li>
  );
}

/**
 * The posts the agent wrote ahead and set a time for (docs/design/agent-tools-2.md section 5.5), in the console's
 * Posting section: when each goes out, whether it waits for the creator's review, and a cancel button. Read inside the
 * console's signed session: with the console already open the list loads on its own, otherwise one signature opens it.
 * A post in review is approved or rejected in the Inbox's review queue; here it can only be cancelled.
 */
export function ScheduledPosts({ token }: { token: Token }) {
  const session = useConsoleSession(token);
  const queryClient = useQueryClient();
  const now = useNow();
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const key = [...qk.agent(token.kernel), 'scheduled'] as const;
  const query = useQuery<AgentScheduledPosts>({
    queryKey: key,
    queryFn: async () => sanitizeScheduled(await consolePost<unknown>(token.kernel, 'scheduled/list', { token: session.held() })),
    enabled: session.open,
    staleTime: 30_000,
    retry: false,
  });
  const list = query.data ?? null;
  const set = (next: AgentScheduledPosts) => {
    session.keep(next.token);
    queryClient.setQueryData(key, next);
  };
  const expired = (err: unknown) => {
    if (err instanceof ReviewError && err.status === 401) {
      session.forget();
      toast.error('The console session expired. Try again.');
      return true;
    }
    return false;
  };

  const open = async () => {
    const auth = await session.auth();
    if (!auth) return;
    setOpening(true);
    try {
      set(sanitizeScheduled(await consolePost<unknown>(token.kernel, 'scheduled/list', { ...auth })));
    } catch (err) {
      if (!expired(err)) toast.error('The scheduled posts are unavailable right now.');
    } finally {
      setOpening(false);
    }
  };

  const cancel = async (id: string) => {
    const auth = await session.auth();
    if (!auth) return;
    setBusy(id);
    try {
      set(sanitizeScheduled(await consolePost<unknown>(token.kernel, 'scheduled/cancel', { ...auth, id })));
      toast.success('Post cancelled. It will not go out.');
    } catch (err) {
      if (expired(err)) return;
      // A post that went out or was cancelled a moment ago is no longer there to cancel: the list is read again.
      void queryClient.invalidateQueries({ queryKey: key });
      toast.error(err instanceof ReviewError && err.status === 404 ? 'That post already went out or was cancelled.' : err instanceof Error ? err.message : 'Could not cancel that post.');
    } finally {
      setBusy(null);
    }
  };

  const waiting = list?.items.filter((p) => STATUS[p.status]?.waiting).length ?? 0;
  return (
    <div data-testid="scheduled-posts" data-open={list ? 'true' : 'false'}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-caption font-medium text-ink">
          Scheduled posts{' '}
          {list ? (
            <span className="font-mono text-micro text-mute" data-testid="scheduled-count">
              {waiting} waiting
            </span>
          ) : null}
        </h3>
        {list || query.isFetching ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void query.refetch()} loading={query.isFetching} loadingLabel="Refreshing…">
            Refresh
          </Button>
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Opening…" disabled={!session.canSign} data-testid="scheduled-open">
            Show
          </Button>
        )}
      </div>
      <p className="mt-1 text-micro text-mute">
        Posts your agent wrote ahead and gave a time. Each goes out at its time and counts as one of its regular posts, so scheduling never adds posts.
        {list ? '' : ' Opening the list takes one wallet signature.'}
      </p>
      {query.isPending && session.open ? (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-12" />
          <Skeleton className="h-12" />
        </div>
      ) : query.isError && !list ? (
        <p className="mt-2 text-caption text-mute" data-testid="scheduled-unavailable">
          The scheduled posts are unavailable right now.
        </p>
      ) : list ? (
        list.items.length === 0 ? (
          <p className="mt-2 text-caption text-mute" data-testid="scheduled-empty">
            Nothing is scheduled.
          </p>
        ) : (
          <>
            <ul className="mt-1 divide-y divide-hairline">
              {list.items.map((post) => (
                <Row key={post.id} post={post} now={now} busy={busy === post.id} onCancel={() => void cancel(post.id)} />
              ))}
            </ul>
            <p className="text-micro text-mute" data-testid="scheduled-note">
              {list.mayQueue !== null ? `${list.mayQueue === 0 ? 'No more posts' : list.mayQueue === 1 ? '1 more post' : `${list.mayQueue} more posts`} may wait. ` : ''}A post that waits for your review is approved or rejected in the Inbox. A post that cannot go out close to its time is dropped, never sent late.
            </p>
          </>
        )
      ) : null}
    </div>
  );
}
