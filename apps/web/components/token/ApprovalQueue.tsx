'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { usdcLabel } from '@/lib/bounties';
import { explorer } from '@/lib/chains';
import { ago } from '@/lib/format';
import { decideApproval, fetchApprovals, qk, ReviewError, useApprovalCount } from '@/lib/indexer';
import type { AgentApproval, AgentApprovals, ApprovalDecision, BountyApprovalInfo, Token } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { Input } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';
import { useConsoleSession } from './console-session';

/** "expires in 2 h" / "expires in 35 min" / "expired". */
export function expiresLabel(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const h = ms / 3_600_000;
  return h >= 1 ? `expires in ${Math.round(h)} h` : `expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

const TX_HASH_RE = /^0x[0-9a-fA-F]{64}$/;

/** What the creator decides with: a note on a rejection, the paying transaction's hash on a bounty payout. */
export type Decision = { note?: string; txHash?: string };

function Stamp({ item }: { item: AgentApproval }) {
  return (
    <span className="ml-auto font-mono text-micro text-mute tabular" title={new Date(item.createdAt).toLocaleString()}>
      {ago(Math.floor(Date.parse(item.createdAt) / 1000))} · {expiresLabel(item.expiresAt)}
    </span>
  );
}

function Item({ item, busy, onDecide }: { item: AgentApproval; busy: boolean; onDecide: (decision: ApprovalDecision, extra: Decision) => void }) {
  const [note, setNote] = useState('');
  return (
    <li data-testid="approval-item" data-approval-id={item.id} data-kind={item.kind} className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Badge tone="mono">{item.kind === 'reply' ? 'Reply' : 'Post'}</Badge>
        {item.inReplyTo ? <span className="font-mono text-micro text-mute">to {item.inReplyTo}</span> : null}
        <Stamp item={item} />
      </div>
      <p className="whitespace-pre-line break-words text-sm text-ink">{item.text}</p>
      {item.image?.dataUrl ? (
        // eslint-disable-next-line @next/next/no-img-element -- a base64 preview from the supervisor, never a remote URL
        <img src={item.image.dataUrl} alt={item.image.alt} className="max-h-48 w-auto max-w-full rounded-sm border border-hairline" data-testid="approval-image" />
      ) : item.image ? (
        <span className="text-micro text-mute">With a picture: {item.image.alt}</span>
      ) : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note for the agent (optional, sent with a rejection)" aria-label="Note for the agent" className="min-w-0 flex-1" disabled={busy} />
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ink" size="sm" disabled={busy} onClick={() => onDecide('approve', { note })}>
            Approve
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onDecide('reject', { note })}>
            Reject
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * A job text the agent wrote while "Review every job text first" is on: the post as it would go out (the task, the
 * amount and the closing time are in it). Approve posts it; reject cancels the job, with an optional note.
 */
function JobItem({ item, bounty, busy, onDecide }: { item: AgentApproval; bounty: BountyApprovalInfo; busy: boolean; onDecide: (decision: ApprovalDecision, extra: Decision) => void }) {
  const [note, setNote] = useState('');
  return (
    <li data-testid="approval-item" data-approval-id={item.id} data-kind="bounty_job" className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Badge tone="ink">Bounty job</Badge>
        <span className="font-mono text-sm text-ink tabular" data-testid="bounty-amount">
          {usdcLabel(bounty.amountUsdc)}
        </span>
        <Stamp item={item} />
      </div>
      <p className="whitespace-pre-line break-words text-sm text-ink">{item.text}</p>
      {bounty.task && !item.text.includes(bounty.task) ? <p className="text-caption text-body">Task: {bounty.task}</p> : null}
      <p className="text-caption text-mute">The job goes out on X as this post once you approve it; nothing is paid now. Rejecting cancels the job.</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note for the agent (optional, sent with a rejection)" aria-label="Note for the agent" className="min-w-0 flex-1" disabled={busy} />
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ink" size="sm" disabled={busy} onClick={() => onDecide('approve', { note })} data-testid="bounty-job-post">
            Post it
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onDecide('reject', { note })} data-testid="bounty-job-cancel">
            Do not post
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * A bounty payout the judge proposed: the job, the amount, the payee, the judge's reason and the winning entry. The
 * creator pays from their own wallet (a plain USDC transfer of the amount to the payee) and pastes the transaction hash
 * here; the page never sends that transaction. Reject closes the job unpaid, with an optional note.
 */
function PayoutItem({ item, bounty, busy, onDecide }: { item: AgentApproval; bounty: BountyApprovalInfo & { payee: `0x${string}` }; busy: boolean; onDecide: (decision: ApprovalDecision, extra: Decision) => void }) {
  const [txHash, setTxHash] = useState('');
  const [note, setNote] = useState('');
  const hashOk = TX_HASH_RE.test(txHash.trim());
  const amount = usdcLabel(bounty.amountUsdc);
  return (
    <li data-testid="approval-item" data-approval-id={item.id} data-kind="bounty_payout" className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Badge tone="ink">Bounty payment</Badge>
        <span className="font-mono text-sm text-ink tabular" data-testid="bounty-amount">
          {amount}
        </span>
        <Stamp item={item} />
      </div>
      {bounty.task ? <p className="break-words text-sm text-ink">{bounty.task}</p> : null}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-caption">
        <dt className="text-mute">Pay to</dt>
        <dd className="flex min-w-0 flex-wrap items-center gap-1 font-mono text-ink" data-testid="bounty-payee">
          <a href={explorer.address(bounty.payee)} target="_blank" rel="noopener noreferrer" className="break-all hover:text-link" title="View on Basescan">
            {bounty.payee}
          </a>
          <CopyButton value={bounty.payee} label="Copy the payee address" />
        </dd>
        {bounty.reason ? (
          <>
            <dt className="text-mute">Why</dt>
            <dd className="break-words text-body" data-testid="bounty-reason">
              {bounty.reason}
            </dd>
          </>
        ) : null}
        <dt className="text-mute">Entry</dt>
        <dd className="min-w-0">
          {bounty.entryUrl ? (
            <ExternalLink href={bounty.entryUrl} className="text-link hover:underline">
              The winning entry on X
            </ExternalLink>
          ) : (
            <span className="text-mute">no link</span>
          )}
        </dd>
      </dl>
      <p className="text-caption text-body" data-testid="bounty-instructions">
        Send {amount} from your wallet to this address, then paste the transaction hash.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          value={txHash}
          onChange={(e) => setTxHash(e.target.value)}
          maxLength={66}
          placeholder="0x… the transaction hash"
          aria-label="Transaction hash"
          aria-invalid={txHash.trim() !== '' && !hashOk}
          mono
          spellCheck={false}
          autoComplete="off"
          className="min-w-0 flex-1"
          disabled={busy}
          data-testid="bounty-tx-hash"
        />
        <Button type="button" variant="ink" size="sm" className="shrink-0" disabled={busy || !hashOk} onClick={() => onDecide('approve', { txHash: txHash.trim() })} data-testid="bounty-paid">
          I paid, here is the transaction
        </Button>
      </div>
      {txHash.trim() !== '' && !hashOk ? <p className="text-micro text-danger">A transaction hash is 0x followed by 64 hex characters.</p> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Why not (optional, kept with the decision)" aria-label="Note for the agent" className="min-w-0 flex-1" disabled={busy} />
        <Button type="button" variant="secondary" size="sm" className="shrink-0" disabled={busy} onClick={() => onDecide('reject', { note })} data-testid="bounty-reject">
          Do not pay
        </Button>
      </div>
    </li>
  );
}

function toastFor(item: AgentApproval, decided: AgentApproval): string {
  if (item.kind === 'bounty_payout') return decided.status === 'approved' ? 'Recorded. The payment is on the coin page.' : 'Declined. The job closes unpaid.';
  if (item.kind === 'bounty_job') return decided.status === 'approved' ? 'Approved: the job goes out on X.' : 'Cancelled. The job is closed.';
  return decided.status === 'approved' ? (decided.url ? 'Approved and posted on X.' : 'Approved: the agent is sending it.') : 'Rejected. The agent will see your note on its next turn.';
}

/**
 * The creator's review queue inside the console: posts and replies the agent wants to send while "Review posts
 * before they go out" is on, the job texts it wrote while "Review every job text first" is on, and the bounty payouts
 * the judge proposes. The console's one wallet signature opens the queue (console-session.ts); Approve sends the post
 * (or posts the job) now, Reject tells the agent why on its next turn (or cancels the job); a payout is approved with
 * the creator's paying transaction hash. In mock mode the signature is skipped.
 */
export function ApprovalQueue({ token, reviewing }: { token: Token; reviewing: boolean }) {
  const session = useConsoleSession(token);
  const queryClient = useQueryClient();
  const count = useApprovalCount(token.kernel);
  const [list, setList] = useState<AgentApprovals | null>(null);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = list ? list.pending : (count.data?.pending ?? 0);
  if (!reviewing && pending === 0 && !list) return null;

  const load = async () => {
    const a = await session.auth();
    if (!a) return;
    const res = await fetchApprovals(token.kernel, a);
    setList(res);
    session.keep(res.token);
    queryClient.setQueryData(qk.approvalCount(token.kernel), { pending: res.pending });
  };

  const open = async () => {
    setOpening(true);
    try {
      await load();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the review queue.');
    } finally {
      setOpening(false);
    }
  };

  const decide = async (item: AgentApproval, decision: ApprovalDecision, extra: Decision) => {
    setBusy(item.id);
    try {
      const auth = await session.auth();
      if (!auth) return;
      const decided = await decideApproval(token.kernel, auth, item.id, decision, { note: extra.note?.trim() || undefined, txHash: extra.txHash });
      setList((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id), pending: Math.max(0, prev.pending - 1) } : prev));
      queryClient.setQueryData(qk.approvalCount(token.kernel), (c: { pending: number } | undefined) => ({ pending: Math.max(0, (c?.pending ?? 1) - 1) }));
      void queryClient.invalidateQueries({ queryKey: qk.agentActivity(token.kernel) });
      void queryClient.invalidateQueries({ queryKey: qk.posts(token.agentId) });
      if (item.bounty) void queryClient.invalidateQueries({ queryKey: qk.agentBounties(token.kernel) });
      toast.success(toastFor(item, decided));
    } catch (err) {
      if (err instanceof ReviewError && err.status === 401) {
        session.forget();
        setList(null);
        toast.error('The review session expired. Open the queue again.');
      } else if (err instanceof ReviewError && err.status === 409) {
        setList((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id) } : prev));
        toast.error(err.message);
      } else {
        toast.error(err instanceof Error ? err.message : 'Could not record the decision.');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-testid="approval-queue" className="border-t border-hairline pt-4">
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-caption font-medium text-ink">
          Review queue{' '}
          <span className={cn('font-mono text-micro', pending > 0 ? 'text-ink' : 'text-mute')} data-testid="approval-queue-count">
            {pending} pending
          </span>
        </h3>
        {list ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Refreshing…">
            Refresh
          </Button>
        ) : (
          <Button type="button" variant="secondary" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Opening…" disabled={!session.canSign}>
            {pending > 0 ? 'Review posts' : 'Open queue'}
          </Button>
        )}
      </div>
      {!list ? (
        <p className="mt-1 text-micro text-mute">{reviewing ? 'Posts and replies wait here until you approve them; unreviewed items expire after 48 hours. Opening the queue takes one wallet signature.' : 'Review is off: new posts go out directly. Items queued earlier are still here.'}</p>
      ) : list.items.length === 0 ? (
        <p className="mt-2 text-caption text-mute" data-testid="approval-queue-empty">
          Nothing waiting for review.
        </p>
      ) : (
        <ul className="mt-1 divide-y divide-hairline">
          {list.items.map((item) => {
            const decide_ = (d: ApprovalDecision, extra: Decision) => void decide(item, d, extra);
            if (item.kind === 'bounty_payout' && item.bounty?.payee) return <PayoutItem key={item.id} item={item} bounty={{ ...item.bounty, payee: item.bounty.payee }} busy={busy === item.id} onDecide={decide_} />;
            if (item.kind === 'bounty_job' && item.bounty) return <JobItem key={item.id} item={item} bounty={item.bounty} busy={busy === item.id} onDecide={decide_} />;
            return <Item key={item.id} item={item} busy={busy === item.id} onDecide={decide_} />;
          })}
        </ul>
      )}
    </div>
  );
}
