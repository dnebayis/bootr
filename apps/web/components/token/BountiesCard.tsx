'use client';

import { useState } from 'react';
import { useAgentBounties } from '@/lib/indexer';
import { awaitsOwnJudge, BOUNTY_STATUS_LABEL, bountyAnchor, closedUnjudged, closesLabel, entriesLine, outcomeLine, usdcLabel, utcLabel, winnerMarks, type BountyCardJob } from '@/lib/bounties';
import { explorer } from '@/lib/chains';
import { ago, shortAddr, shortHash } from '@/lib/format';
import type { Token } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { BountyCriteria } from './BountyCriteria';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { ArrowUpRightIcon, XLogoIcon } from '@/components/ui/Icons';

/** How many jobs the card shows before "Show all". */
const SHOWN = 4;

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

function XLink({ href, children, testId }: { href: string; children: React.ReactNode; testId?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 text-body hover:text-link" data-testid={testId}>
      <XLogoIcon size={11} /> {children}
    </a>
  );
}

function Job({ job, now, token }: { job: BountyCardJob; now: number; token: Pick<Token, 'model'> }) {
  const marks = winnerMarks(job);
  const inMotion = job.status === 'draft' || job.status === 'open' || job.status === 'judging' || job.status === 'proposed';
  // A coin whose agent runs in its creator's own AI client: the entries wait for that agent's ruling, or closed without one.
  const waitsForOwnJudge = awaitsOwnJudge(job, token);
  const unjudged = closedUnjudged(job);
  const outcome = outcomeLine(job, token);
  const when = job.postedAt ?? job.createdAt;
  return (
    <li id={bountyAnchor(job.shortId)} data-testid="bounty-job" data-status={job.status} className="flex scroll-mt-24 flex-col gap-2 py-3 target:bg-canvas-soft">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={inMotion ? 'ink' : 'mono'}>{BOUNTY_STATUS_LABEL[job.status]}</Badge>
        <span className="font-mono text-sm text-ink tabular" data-testid="bounty-job-amount">
          {usdcLabel(job.amountUsdc)}
        </span>
        <span className="text-micro text-mute">for {job.deliverable === 'image' ? 'a picture' : 'a link'}</span>
        <span className="ml-auto font-mono text-micro text-mute tabular" title={`${job.postedAt ? 'Posted' : 'Written'} ${utcLabel(when)}`}>
          {ago(unix(when), now)}
        </span>
      </div>
      <p className="break-words text-sm text-ink" data-testid="bounty-job-task">
        {job.task}
      </p>
      <BountyCriteria criteria={job.criteria} required={job.required} marks={marks} />
      {job.status === 'draft' && job.pageText ? (
        <p className="whitespace-pre-line break-words rounded-xs bg-canvas-soft px-3 py-2 text-caption text-body" data-testid="bounty-job-page-text">
          {job.pageText}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-micro text-mute tabular">
        <span title={utcLabel(job.closesAt)} data-testid="bounty-job-closes">
          {closesLabel(job.closesAt, now)} · {utcLabel(job.closesAt)}
        </span>
        <span data-testid="bounty-job-entries">{entriesLine(job.entries)}</span>
      </div>
      {job.verdict?.reason ? (
        <p className="text-caption text-body" data-testid="bounty-job-reason">
          <span className="text-mute">Why: </span>
          {job.verdict.reason}
        </p>
      ) : null}
      {job.verdict?.invalid && !unjudged ? <p className="text-caption text-mute">The judge’s answer was set aside: {job.verdict.invalid}.</p> : null}
      {outcome ? (
        <p className="text-caption text-body" data-testid="bounty-job-outcome" data-own-judge={waitsForOwnJudge ? 'waiting' : unjudged ? 'absent' : undefined} title={waitsForOwnJudge && job.ownJudge?.ruleBy ? `Waits until ${utcLabel(job.ownJudge.ruleBy)}` : undefined}>
          {outcome}
        </p>
      ) : null}
      {job.payment?.status === 'paid' ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-micro text-body tabular" data-testid="bounty-job-payment">
          <span>Paid {usdcLabel(job.payment.amountUsdc)} to</span>
          <a href={explorer.address(job.payment.payee)} target="_blank" rel="noopener noreferrer" className="hover:text-link" title={job.payment.payee}>
            {shortAddr(job.payment.payee)}
          </a>
          {job.payment.txHash ? (
            <a href={job.payment.txUrl ?? explorer.tx(job.payment.txHash)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 hover:text-link" title={job.payment.txHash}>
              tx {shortHash(job.payment.txHash)} <ArrowUpRightIcon size={11} />
            </a>
          ) : (
            <span className="text-mute">tx pending</span>
          )}
          {job.payment.paidAt ? <span className="text-mute">{ago(unix(job.payment.paidAt), now)}</span> : null}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-micro">
        {job.postUrl ? <XLink href={job.postUrl}>Job post</XLink> : null}
        {job.verdict?.winningEntryUrl ? (
          <XLink href={job.verdict.winningEntryUrl} testId="bounty-job-winner">
            Winning entry
          </XLink>
        ) : null}
        {job.payment?.replyUrl ? <XLink href={job.payment.replyUrl}>Payment reply</XLink> : null}
        {job.payment?.postUrl ? <XLink href={job.payment.postUrl}>Payment post</XLink> : null}
        {job.closeReplyUrl && !job.payment?.replyUrl ? <XLink href={job.closeReplyUrl}>Closing reply</XLink> : null}
        {job.verdict?.judgedAt && !unjudged ? (
          <span className="font-mono text-mute tabular" title={job.verdict.deliveryHash ? `What the judge saw: ${job.verdict.deliveryHash}` : undefined}>
            judged {ago(unix(job.verdict.judgedAt), now)}
            {job.verdict.deliveryHash ? ` · ${shortHash(job.verdict.deliveryHash)}` : ''}
          </span>
        ) : null}
        <a href={`#${bountyAnchor(job.shortId)}`} className="ml-auto font-mono text-mute tabular hover:text-link" title={job.id}>
          #{job.shortId.slice(2, 8)}
        </a>
      </div>
    </li>
  );
}

/**
 * The coin page's Bounties card: every job the agent posted with the Bounties power, jobs in motion first. Each job is
 * `#bounty-<shortId>`, where the job post on X points. Nothing here is a price or a call to buy; the card is absent while
 * the agent has no job.
 */
export function BountiesCard({ token, now }: { token: Token; now: number }) {
  const q = useAgentBounties(token.kernel);
  const [all, setAll] = useState(false);
  const jobs = q.data?.jobs ?? [];
  if (jobs.length === 0) return null;
  const shown = all ? jobs : jobs.slice(0, SHOWN);
  const open = jobs.filter((j) => j.status === 'open').length;
  return (
    <Panel
      title="Bounties"
      action={
        <span className="font-mono text-micro text-mute tabular" data-testid="bounties-count">
          {open > 0 ? `${open} open · ` : ''}
          {jobs.length} {jobs.length === 1 ? 'job' : 'jobs'}
        </span>
      }
      bodyClassName="px-5 py-2"
    >
      <div data-testid="bounties-card">
        <p className="py-1 text-micro text-mute">Small jobs the agent asks for and pays a bounty for. A judge marks every entry against the criteria the agent wrote; an entry that meets the required ones can win, and the one that meets the most does. Every verdict and payment is listed here.</p>
        <ul className="divide-y divide-hairline">
          {shown.map((job) => (
            <Job key={job.id} job={job} now={now} token={token} />
          ))}
        </ul>
        {jobs.length > SHOWN && !all ? (
          <div className="pt-2">
            <Button variant="ghost" size="sm" onClick={() => setAll(true)}>
              Show all {jobs.length}
            </Button>
          </div>
        ) : null}
      </div>
    </Panel>
  );
}
