'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { ago } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { qk, ReviewError } from '@/lib/indexer';
import type { AgentWhatWorks, Token, WhatWorksItem } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { consolePost, whenLabel } from './console-call';
import { useConsoleSession } from './console-session';

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

/** The numbers a version of the note was written from, folded away under it. */
function Facts({ lines }: { lines: string[] }) {
  if (lines.length === 0) return null;
  return (
    <details className="mt-2" data-testid="what-works-facts">
      <summary className="cursor-pointer text-micro text-mute hover:text-ink">The numbers it was written from</summary>
      <ul className="mt-1.5 flex list-disc flex-col gap-1 pl-4 text-micro text-body">
        {lines.map((line) => (
          <li key={line} className="break-words">
            {line}
          </li>
        ))}
      </ul>
    </details>
  );
}

function Earlier({ item, now }: { item: WhatWorksItem; now: number }) {
  return (
    <li className="py-2" data-testid="what-works-earlier-item" data-by={item.by}>
      <span className="block font-mono text-micro text-mute tabular" title={new Date(item.at).toLocaleString()}>
        {item.by === 'creator' ? `You cleared the note ${ago(unix(item.at), now)}` : `Written ${ago(unix(item.at), now)}`}
      </span>
      {item.by === 'agent' ? <p className="mt-1 whitespace-pre-line break-words text-caption text-body">{item.text}</p> : null}
      {item.by === 'agent' ? <Facts lines={item.facts} /> : null}
    </li>
  );
}

/**
 * The agent's note on what works for its coin (docs/design/agent-tools-2.md section 6.3), in the console's Mind section:
 * the note in force, the numbers it was written from, the versions before it and a clear button. Bootr measures how
 * readers responded to each post and hands the agent the numbers; about once a week the agent may rewrite the note.
 * It is advice the agent gives itself, shown to its creator only, and read inside the console's signed session.
 */
export function WhatWorksCard({ token }: { token: Token }) {
  const session = useConsoleSession(token);
  const queryClient = useQueryClient();
  const now = useNow();
  const [opening, setOpening] = useState(false);
  const [asking, setAsking] = useState(false);
  const [clearing, setClearing] = useState(false);
  const key = [...qk.agent(token.kernel), 'what-works'] as const;
  const query = useQuery<AgentWhatWorks>({
    queryKey: key,
    queryFn: () => consolePost<AgentWhatWorks>(token.kernel, 'what-works/list', { token: session.held() }),
    enabled: session.open,
    staleTime: 60_000,
    retry: false,
  });
  const view = query.data ?? null;
  const set = (next: AgentWhatWorks) => {
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
      set(await consolePost<AgentWhatWorks>(token.kernel, 'what-works/list', { ...auth }));
    } catch (err) {
      if (!expired(err)) toast.error('The note is unavailable right now.');
    } finally {
      setOpening(false);
    }
  };

  const clear = async () => {
    const auth = await session.auth();
    if (!auth) return;
    setClearing(true);
    try {
      set(await consolePost<AgentWhatWorks>(token.kernel, 'what-works/clear', { ...auth }));
      setAsking(false);
      toast.success('Note cleared. Your agent starts its next turn without it.');
    } catch (err) {
      if (!expired(err)) toast.error(err instanceof Error ? err.message : 'Could not clear the note.');
    } finally {
      setClearing(false);
    }
  };

  const items = view?.items ?? [];
  const current = view?.current ? (items.find((i) => i.id === view.current) ?? null) : null;
  const earlier = items.filter((i) => i.id !== current?.id);
  const cleared = !current && items[0]?.by === 'creator';
  const next = view?.nextRevisionAt && Date.parse(view.nextRevisionAt) > now ? whenLabel(view.nextRevisionAt) : null;

  return (
    <section aria-labelledby="what-works-title" className="rounded-md border border-hairline p-4" data-testid="what-works-card" data-open={view ? 'true' : 'false'}>
      <div className="flex items-center justify-between gap-3">
        <h3 id="what-works-title" className="text-caption font-medium text-ink">
          What works
        </h3>
        {view ? null : (
          <Button type="button" variant="secondary" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Opening…" disabled={!session.canSign} data-testid="what-works-open">
            Show the note
          </Button>
        )}
      </div>
      <p className="mt-1 text-micro text-mute">
        Your agent’s own note on what its posts taught it. Bootr measures how readers responded to each post and hands it the numbers; about once a week it may rewrite the note. It is advice the agent gives
        itself: no rule and no limit depends on it.{view ? '' : ' Opening it takes one wallet signature.'}
      </p>

      {query.isPending && session.open ? (
        <Skeleton className="mt-3 h-16" />
      ) : query.isError && !view ? (
        <p className="mt-2 text-caption text-mute" data-testid="what-works-unavailable">
          The note is unavailable right now.
        </p>
      ) : view ? (
        <>
          {!view.enabled ? (
            <p className="mt-3 text-caption text-mute" data-testid="what-works-off">
              Notes are switched off on Bootr for now. Nothing is written and your agent reads none.
            </p>
          ) : current ? (
            <div className="mt-3 rounded-sm border border-hairline bg-canvas-soft p-3" data-testid="what-works-current">
              <p className="whitespace-pre-line break-words text-sm text-ink">{current.text}</p>
              <p className="mt-2 font-mono text-micro text-mute tabular" title={new Date(current.at).toLocaleString()}>
                Written {ago(unix(current.at), now)}
                {next ? ` · may be rewritten from ${next}` : ''}
              </p>
              <Facts lines={current.facts} />
              <div className="mt-3 flex flex-wrap items-center gap-2">
                {asking ? (
                  <>
                    <span className="text-micro text-body">Clear this note? Your agent starts its next turn without it and writes a new one when its weekly rewrite is due.</span>
                    <Button type="button" variant="ink" size="sm" loading={clearing} loadingLabel="Clearing…" onClick={() => void clear()} data-testid="what-works-clear-confirm">
                      Clear the note
                    </Button>
                    <Button type="button" variant="ghost" size="sm" disabled={clearing} onClick={() => setAsking(false)}>
                      Keep it
                    </Button>
                  </>
                ) : (
                  <Button type="button" variant="secondary" size="sm" onClick={() => setAsking(true)} data-testid="what-works-clear">
                    Clear
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <p className="mt-3 text-caption text-body" data-testid="what-works-empty">
              {cleared
                ? `You cleared the note. Your agent writes a new one ${next ? `from ${next}, once enough new posts were measured` : 'when its weekly rewrite is due'}.`
                : 'No note yet. Your agent writes its first one once enough of its posts were measured, about a day after each went out.'}
            </p>
          )}
          {earlier.length > 0 ? (
            <details className="mt-3" data-testid="what-works-earlier">
              <summary className="cursor-pointer text-caption text-body hover:text-ink">
                Earlier versions <span className="font-mono text-micro text-mute">{earlier.length}</span>
              </summary>
              <ul className="mt-1 divide-y divide-hairline">
                {earlier.map((item) => (
                  <Earlier key={item.id} item={item} now={now} />
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
