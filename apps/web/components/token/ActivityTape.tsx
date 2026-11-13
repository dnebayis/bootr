'use client';

import { useMemo, useState } from 'react';
import { useAgentActivity, useAgentPosts } from '@/lib/indexer';
import type { AgentActivityItem, Token } from '@/lib/types';
import { ago } from '@/lib/format';
import { explorer } from '@/lib/chains';
import { aboutHref, aboutParts } from '@/lib/posting-views';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { Button } from '@/components/ui/Button';
import { ArrowUpRightIcon, XLogoIcon } from '@/components/ui/Icons';
import { cn } from '@/components/ui/cn';
import { Isometric } from '@/components/art/Isometric';

type Filter = 'all' | 'posts' | 'treasury';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'posts', label: 'Posts' },
  { id: 'treasury', label: 'Treasury' },
];

const POST_KIND = /^(post|reply|x_post|x_reply|tweet)/i;
const TREASURY_KIND = /claim|swap|gas|fuel|treasury|spender|transfer|deposit|service|bounty/i;

/** Posts are what the agent said on X; treasury is anything that moved value (every row with a tx hash counts). */
export function activityCategory(it: Pick<AgentActivityItem, 'kind' | 'txHash'>): 'posts' | 'treasury' | 'other' {
  if (POST_KIND.test(it.kind)) return 'posts';
  if (it.txHash || TREASURY_KIND.test(it.kind)) return 'treasury';
  return 'other';
}

/**
 * The supervisor's tape plus the sender's latest posts (the page loads those anyway), one list: a post that appears in
 * both is kept once (same URL, or same kind within two minutes), newest first.
 */
export function mergeActivity(tape: AgentActivityItem[], posts: { kind: 'post' | 'reply'; text: string; url: string; createdAt: number }[]): AgentActivityItem[] {
  const out = [...tape];
  const urls = new Set(tape.map((t) => t.url).filter(Boolean));
  for (const p of posts) {
    if (urls.has(p.url)) continue;
    const at = p.createdAt * 1000;
    const near = tape.some((t) => POST_KIND.test(t.kind) && !t.url && Math.abs(Date.parse(t.at) - at) < 120_000);
    if (near) continue;
    out.push({ at: new Date(at).toISOString(), kind: p.kind, summary: p.text, url: p.url });
  }
  return out.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
}

/**
 * A comment: the agent's own post about a post it read. The line names whose post it was and those words link to that
 * post on X; the arrow at the end leads to the agent's own post. Two links, so the row itself is not one.
 */
function CommentRow({ item, source, now }: { item: AgentActivityItem & { about: NonNullable<AgentActivityItem['about']> }; source: string; now: number }) {
  const unix = Math.floor(Date.parse(item.at) / 1000);
  const text = aboutParts(item.summary, item.about.handle);
  return (
    <li data-kind={item.kind} data-comment="true" className="border-b border-hairline last:border-b-0">
      <div className="flex items-baseline gap-3 py-2">
        <span className="shrink-0 font-mono text-micro text-mute tabular" title={new Date(item.at).toLocaleString()}>
          {ago(unix, now)}
        </span>
        <span className="min-w-0 flex-1 whitespace-pre-line break-words text-sm text-body">
          {text.before}
          <a href={source} target="_blank" rel="noopener noreferrer" className="text-link hover:underline" data-testid="activity-about">
            {text.link}
          </a>
          {text.after}
        </span>
        {item.url ? (
          <a href={item.url} target="_blank" rel="noopener noreferrer" className="inline-flex shrink-0 items-center gap-0.5 text-micro text-mute transition-colors duration-150 hover:text-ink" aria-label="View the agent’s post on X" data-testid="activity-own-post">
            <XLogoIcon size={11} />
            <ArrowUpRightIcon size={12} />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function Row({ item, now }: { item: AgentActivityItem; now: number }) {
  const source = aboutHref(item.about);
  if (source && item.about) return <CommentRow item={{ ...item, about: item.about }} source={source} now={now} />;
  const href = item.url ?? (item.txHash ? explorer.tx(item.txHash) : null);
  const isX = !!item.url && /^https:\/\/(x|twitter)\.com\//.test(item.url);
  const unix = Math.floor(Date.parse(item.at) / 1000);
  const body = (
    <>
      <span className="shrink-0 font-mono text-micro text-mute tabular" title={new Date(item.at).toLocaleString()}>
        {ago(unix, now)}
      </span>
      <span className="min-w-0 flex-1 whitespace-pre-line break-words text-sm text-body">{item.summary}</span>
      {href ? (
        <span className="inline-flex shrink-0 items-center gap-0.5 text-micro text-mute" aria-label={isX ? 'View on X' : 'View transaction'}>
          {isX ? <XLogoIcon size={11} /> : null}
          <ArrowUpRightIcon size={12} />
        </span>
      ) : null}
    </>
  );
  const cls = 'flex items-baseline gap-3 py-2';
  return (
    <li data-kind={item.kind} className="border-b border-hairline last:border-b-0">
      {href ? (
        <a href={href} target="_blank" rel="noopener noreferrer" className={cn(cls, 'transition-colors duration-150 hover:text-ink')}>
          {body}
        </a>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

/** The coin page's activity tape: posts, replies, fee claims, swaps, gas, sleeps and wakes, config edits. */
export function ActivityTape({ token, now }: { token: Token; now: number }) {
  const [filter, setFilter] = useState<Filter>('all');
  const activity = useAgentActivity(token.kernel);
  const posts = useAgentPosts(token.agentId || undefined);
  const handle = posts.data ? posts.data.handle : token.xHandle;

  const items = useMemo(() => {
    const tape = activity.data?.pages.flatMap((p) => p.items) ?? [];
    return mergeActivity(tape, posts.data?.items ?? []);
  }, [activity.data, posts.data]);
  const shown = filter === 'all' ? items : items.filter((it) => activityCategory(it) === filter);
  const loading = activity.isPending && (posts.isPending || !token.agentId);
  const failed = activity.isError && items.length === 0;

  return (
    <Panel
      title="Activity"
      action={
        <div role="tablist" aria-label="Activity filter" className="inline-flex rounded-sm border border-hairline p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              role="tab"
              aria-selected={filter === f.id}
              onClick={() => setFilter(f.id)}
              className={cn('h-6 rounded-xs px-2 font-mono text-micro transition-colors', filter === f.id ? 'bg-ink text-on-ink' : 'text-mute hover:text-ink')}
            >
              {f.label}
            </button>
          ))}
        </div>
      }
      bodyClassName="px-5 py-3"
    >
      <div data-testid="activity-tape" data-filter={filter}>
        {handle ? (
          <a href={`https://x.com/${handle}`} target="_blank" rel="noopener noreferrer" className="mb-1 inline-flex items-center gap-1.5 text-caption text-body hover:text-link">
            <XLogoIcon size={12} /> <span className="font-mono">@{handle}</span>
          </a>
        ) : null}
        {loading ? (
          <div className="flex flex-col gap-2 py-1">
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
            <Skeleton className="h-9" />
          </div>
        ) : failed ? (
          <p className="py-2 text-caption text-mute">Activity is unavailable right now.</p>
        ) : shown.length > 0 ? (
          <ul>
            {shown.map((it, i) => (
              <Row key={`${it.at}-${it.kind}-${i}`} item={it} now={now} />
            ))}
          </ul>
        ) : filter === 'posts' && !handle ? (
          <p className="py-2 text-caption text-mute">The agent has not connected an X account yet.</p>
        ) : filter === 'all' ? (
          <div className="flex items-center gap-3 py-2">
            <Isometric kind="blueprint" size={48} className="shrink-0 text-mute" />
            <p className="text-caption text-mute">Nothing yet.</p>
          </div>
        ) : (
          <p className="py-2 text-caption text-mute">{`No ${filter === 'posts' ? 'posts' : 'treasury activity'} yet.`}</p>
        )}
        {activity.hasNextPage ? (
          <div className="pt-2">
            <Button variant="ghost" size="sm" onClick={() => void activity.fetchNextPage()} loading={activity.isFetchingNextPage} loadingLabel="Loading…">
              Show more
            </Button>
          </div>
        ) : null}
        {activity.isError && items.length > 0 ? <p className="pt-2 text-micro text-mute">Older activity is unavailable right now.</p> : null}
      </div>
    </Panel>
  );
}
