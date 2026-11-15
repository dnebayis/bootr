'use client';

import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { DatasetDay, DatasetRecordView, DatasetXView } from '@/lib/server/dataset';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Empty, Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { cn } from '@/components/ui/cn';

const th = 'px-4 py-2 text-left text-caption font-normal text-mute';
const td = 'px-4 py-2.5 align-top';

const today = () => new Date().toISOString().slice(0, 10);
const shift = (day: string, by: number) => new Date(Date.parse(`${day}T00:00:00Z`) + by * 86_400_000).toISOString().slice(0, 10);
const clock = (iso: string) => iso.slice(11, 16);
const amount = (n: { value: number; unit: string; what: string }) => `${n.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}${n.unit ? ` ${n.unit}` : ''} ${n.what}`.trim();

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; data: DatasetDay };

function GradeMark({ record }: { record: DatasetRecordView }) {
  return (
    <span title={record.gradeWords} className={cn('inline-flex h-6 min-w-6 items-center justify-center rounded-sm border px-1 font-mono text-caption tabular', record.grade >= 4 ? 'border-ink text-ink' : 'border-hairline text-mute')}>
      {record.grade}
    </span>
  );
}

function RecordRow({ record }: { record: DatasetRecordView }) {
  return (
    <tr className="border-t border-hairline hover:bg-canvas-sub">
      <td className={td}>
        <GradeMark record={record} />
      </td>
      <td className={`${td} font-mono text-caption text-mute`}>
        {record.kind}
        {record.status !== 'open' ? <div>{record.status}</div> : null}
        {record.incidentSourced === false ? <div className="text-danger">a report only</div> : null}
      </td>
      <td className={td}>
        <div className="text-sm text-ink">
          {record.link ? (
            <a href={record.link} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-link">
              {record.headline}
            </a>
          ) : (
            record.headline
          )}
        </div>
        {record.summary ? <p className="mt-1 text-caption text-body">{record.summary}</p> : null}
        <p className="mt-1 font-mono text-micro text-mute">
          {[record.id, record.cluster, ...record.entities, record.coin ? `coin ${record.coin.slice(0, 8)}…` : null, record.eventTime ? `happened ${record.eventTime.slice(0, record.eventPrecision === 'day' ? 10 : 16).replace('T', ' ')}` : null].filter(Boolean).join(' · ')}
        </p>
        {record.numbers.length ? <p className="mt-1 font-mono text-micro text-body">{record.numbers.map(amount).join(' · ')}</p> : null}
        {record.sightings.length > 1 ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-caption text-mute">{record.sightings.length} sightings</summary>
            <ul className="mt-1 flex flex-col gap-0.5">
              {record.sightings.map((s, i) => (
                <li key={i} className="text-caption text-body">
                  <span className="font-mono text-micro text-mute">
                    {s.source} · {s.matchedBy}
                  </span>{' '}
                  {s.withheld ? <em className="text-mute">text withheld</em> : s.title}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </td>
      <td className={`${td} text-caption text-body`}>
        {record.sources.map((s, i) => (
          <div key={i} title={s.group}>
            {s.name}
            {s.official ? <span className="font-mono text-micro text-mute"> official</span> : null}
            {s.open ? <span className="font-mono text-micro text-mute"> open venue</span> : null}
          </div>
        ))}
      </td>
      <td className={`${td} text-right font-mono text-sm tabular`}>
        {record.observationCount}
        <div className="text-micro text-mute">{record.groups === 1 ? '1 group' : `${record.groups} groups`}</div>
        {record.posted ? <div className="text-micro text-mute">posted {record.posted}</div> : null}
      </td>
      <td className={`${td} text-right font-mono text-caption tabular text-mute`}>{clock(record.firstSeenAt)}</td>
    </tr>
  );
}

const usd = (n: number) => `${n.toFixed(2)} USD`;

/**
 * Layer c: what the day's X reads cost (the owner pays X for each: 0.005 USD a post, 0.01 USD a user) and the listed
 * accounts, with a suspended one's reason and a "look again" for a false alarm. A real change of an account (a new
 * handle) is a commit to the source list, not this button.
 */
function XAccounts({ x, onReview }: { x: DatasetXView; onReview: (id: string) => Promise<string | null> }) {
  const [asked, setAsked] = useState<Record<string, string>>({});
  const count = (status: string) => x.accounts.filter((a) => a.status === status).length;
  const held = x.accounts.filter((a) => a.status === 'suspended' || a.status === 'review');
  return (
    <div className="border-t border-hairline px-4 py-3">
      <div className="text-caption text-mute">X accounts (layer c)</div>
      {x.day ? (
        <p className="mt-1 font-mono text-micro text-body tabular">
          {x.day.posts} posts read · {x.day.userReads} user reads · {x.day.checks} checks · {x.day.units} of {x.day.limit} units · {usd(x.day.usd)} today (at most {usd(x.day.worstUsd)})
          {x.day.stopped ? ` · reading stopped: ${x.day.stopped === 'cap' ? 'the cap is reached' : 'paced over the day'}` : ''}
        </p>
      ) : (
        <p className="mt-1 text-caption text-body">Nothing was read on X this day and nothing was spent: the X layer is off until DATASET_X_POSTS_PER_DAY is set on the sender and the dataset service.</p>
      )}
      {x.day?.error ? <p className="mt-1 text-caption text-danger">{x.day.error}</p> : null}
      <p className="mt-1 font-mono text-micro text-mute">
        {x.accounts.length} listed · {count('active')} read · {count('pending')} waiting for their first lookup · {held.length} suspended
      </p>
      {held.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {held.map((a) => (
            <li key={a.id} className="flex items-start justify-between gap-3 text-caption text-body">
              <span>
                <span className="font-mono text-micro text-ink">{a.handle || a.id}</span> · {a.statusReason ?? 'no reason kept'}
                {asked[a.id] ? <span className="font-mono text-micro text-mute"> · {asked[a.id]}</span> : null}
              </span>
              {a.status === 'suspended' ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={async () => {
                    const failed = await onReview(a.id);
                    setAsked((m) => ({ ...m, [a.id]: failed ?? 'looked at again at the next pass' }));
                  }}
                >
                  Look again
                </Button>
              ) : (
                <span className="font-mono text-micro text-mute">looked at again at the next pass</span>
              )}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Bootr's own dataset, one UTC day at a time (docs/design/agent-behaviour.md section 6.4): the records with their
 * grade, sources and counts, read from `/api/admin/dataset`. Read-only: a day is read here by hand before any agent is
 * shown a record. The grade says how a record is sourced, not whether it is true.
 */
export function DatasetPanel() {
  const [day, setDay] = useState(today);
  const queryClient = useQueryClient();
  const review = async (id: string): Promise<string | null> => {
    const res = await fetch('/api/admin/dataset/x-review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }) }).catch(() => null);
    if (!res) return 'the request failed';
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) return body.message ?? body.error ?? `the request failed (${res.status})`;
    await queryClient.invalidateQueries({ queryKey: ['admin-dataset'] });
    return null;
  };
  const query = useQuery({
    queryKey: ['admin-dataset', day],
    queryFn: async (): Promise<DatasetDay> => {
      const res = await fetch(`/api/admin/dataset?day=${day}`, { cache: 'no-store' });
      const body = (await res.json().catch(() => ({}))) as DatasetDay & { message?: string; error?: string };
      if (!res.ok) throw new Error(body.message ?? body.error ?? `The request failed (${res.status}).`);
      return body;
    },
    staleTime: 30_000,
    retry: false,
  });
  const load: Load = query.isPending ? { state: 'loading' } : query.isError ? { state: 'error', message: query.error.message } : { state: 'ready', data: query.data };

  const data = load.state === 'ready' ? load.data : null;
  const failing = data ? data.sources.filter((s) => s.status === 'active' && s.failures > 0) : [];
  const reading = data ? data.sources.filter((s) => s.status === 'active').length : 0;

  return (
    <Panel
      title="Dataset"
      bodyClassName="p-0"
      action={
        <div className="flex items-center gap-2">
          <span className="font-mono text-micro text-mute">{data ? (data.enabled ? 'ON' : 'OFF') : ''}</span>
          <Button size="sm" variant="ghost" aria-label="The day before" onClick={() => setDay((d) => shift(d, -1))}>
            ←
          </Button>
          <Input type="date" aria-label="Day (UTC)" value={day} max={today()} onChange={(e) => e.target.value && setDay(e.target.value)} className="w-40" mono />
          <Button size="sm" variant="ghost" aria-label="The day after" disabled={day >= today()} onClick={() => setDay((d) => shift(d, 1))}>
            →
          </Button>
        </div>
      }
    >
      <p className="border-b border-hairline px-4 py-2 text-caption text-mute">
        What Bootr saw happen on this UTC day, one record per event. The grade says how a record is sourced (1 a single source, 3 two independent groups, 4 an official source, 5 official and two more groups), not whether it is true.
        No agent reads these yet.
      </p>
      {load.state === 'loading' ? (
        <div className="p-4">
          <Skeleton className="h-48" />
        </div>
      ) : load.state === 'error' ? (
        <Empty>{load.message}</Empty>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 gap-px border-b border-hairline bg-hairline sm:grid-cols-5">
            {[
              ['Records', String(data.totals.records)],
              ['Sightings', String(data.totals.sightings)],
              ['By grade', [5, 4, 3, 2, 1].map((g) => `${g}: ${data.totals.byGrade[String(g)] ?? 0}`).join('  ')],
              ['Past the cap', String(data.totals.capped)],
              ['Sources', `${reading} read, ${failing.length} failing`],
            ].map(([k, v]) => (
              <div key={k} className="bg-canvas px-4 py-3">
                <div className="text-caption text-mute">{k}</div>
                <div className="font-mono text-sm text-ink tabular">{v}</div>
              </div>
            ))}
          </div>
          {data.records.length === 0 ? (
            <Empty>{data.enabled ? 'No records on this day.' : 'No records on this day. The dataset process is off (DATASET_ENABLED).'}</Empty>
          ) : (
            <div className="max-h-[720px] overflow-auto">
              <table className="w-full min-w-[960px] border-collapse">
                <thead className="sticky top-0 bg-canvas-soft">
                  <tr>
                    <th className={th}>Grade</th>
                    <th className={th}>Kind</th>
                    <th className={th}>Record</th>
                    <th className={th}>Sources</th>
                    <th className={`${th} text-right`}>Seen</th>
                    <th className={`${th} text-right`}>First (UTC)</th>
                  </tr>
                </thead>
                <tbody>
                  {data.records.map((r) => (
                    <RecordRow key={r.id} record={r} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <XAccounts x={data.x} onReview={review} />
          {failing.length ? (
            <details className="border-t border-hairline px-4 py-3">
              <summary className="cursor-pointer text-caption text-mute">{failing.length} sources failing</summary>
              <ul className="mt-2 flex flex-col gap-1">
                {failing.map((s) => (
                  <li key={s.id} className="font-mono text-micro text-body">
                    {s.name} · {s.failures} in a row · {s.lastError ?? 'no reason kept'} · next try {s.nextFetchAt ? s.nextFetchAt.slice(0, 16).replace('T', ' ') : 'unknown'}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </Panel>
  );
}
