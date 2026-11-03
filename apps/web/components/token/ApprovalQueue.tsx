'use client';

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { SiweMessage } from 'siwe';
import { toast } from 'sonner';
import { useConnection, useSignMessage } from 'wagmi';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { ago } from '@/lib/format';
import { decideApproval, fetchApprovals, qk, ReviewError, useApprovalCount, type ReviewAuth } from '@/lib/indexer';
import type { AgentApproval, AgentApprovals, ApprovalDecision, Token } from '@/lib/types';
import { Badge } from '@/components/ui/Badge';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { cn } from '@/components/ui/cn';

/** "expires in 2 h" / "expires in 35 min" / "expired". */
export function expiresLabel(expiresAt: string, now = Date.now()): string {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return 'expired';
  const h = ms / 3_600_000;
  return h >= 1 ? `expires in ${Math.round(h)} h` : `expires in ${Math.max(1, Math.round(ms / 60_000))} min`;
}

function Item({ item, busy, onDecide }: { item: AgentApproval; busy: boolean; onDecide: (decision: ApprovalDecision, note: string) => void }) {
  const [note, setNote] = useState('');
  const unix = Math.floor(Date.parse(item.createdAt) / 1000);
  return (
    <li data-testid="approval-item" data-approval-id={item.id} data-kind={item.kind} className="flex flex-col gap-2 py-3">
      <div className="flex items-center gap-2">
        <Badge tone="mono">{item.kind === 'reply' ? 'Reply' : 'Post'}</Badge>
        {item.inReplyTo ? <span className="font-mono text-micro text-mute">to {item.inReplyTo}</span> : null}
        <span className="ml-auto font-mono text-micro text-mute tabular" title={new Date(item.createdAt).toLocaleString()}>
          {ago(unix)} · {expiresLabel(item.expiresAt)}
        </span>
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
          <Button type="button" variant="ink" size="sm" disabled={busy} onClick={() => onDecide('approve', note)}>
            Approve
          </Button>
          <Button type="button" variant="secondary" size="sm" disabled={busy} onClick={() => onDecide('reject', note)}>
            Reject
          </Button>
        </div>
      </div>
    </li>
  );
}

/**
 * The creator's review queue inside the console: posts and replies the agent wants to send while "Review posts
 * before they go out" is on. One wallet signature opens the queue (the route answers a review token that keeps it
 * open for the session); Approve sends the post through the agent's X account now, Reject tells the agent why on
 * its next turn. In mock mode the signature is skipped.
 */
export function ApprovalQueue({ token, reviewing }: { token: Token; reviewing: boolean }) {
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();
  const count = useApprovalCount(token.kernel);
  const [auth, setAuth] = useState<ReviewAuth | null>(null);
  const [list, setList] = useState<AgentApprovals | null>(null);
  const [opening, setOpening] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const pending = list ? list.pending : (count.data?.pending ?? 0);
  if (!reviewing && pending === 0 && !list) return null;

  const sign = async (): Promise<ReviewAuth | null> => {
    if (env.useMock) return { message: address ?? '', signature: '0x' };
    if (!address) {
      toast.error('Connect the creator wallet first.');
      return null;
    }
    const n = await fetch('/api/agent/nonce', { method: 'POST' });
    if (!n.ok) {
      toast.error('Could not start the signature (nonce).');
      return null;
    }
    const { nonce } = (await n.json()) as { nonce: string };
    const message = new SiweMessage({
      domain: window.location.host,
      address,
      statement: `Review the posts of Bootr coin $${token.symbol} (#${token.agentId}, ${token.kernel}).`,
      uri: window.location.origin,
      version: '1',
      chainId: appChain.id,
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
    try {
      return { message, signature: await signMessageAsync({ message }) };
    } catch {
      toast.error('Signature cancelled.');
      return null;
    }
  };

  const load = async (fresh: ReviewAuth | null) => {
    const a = fresh ?? auth ?? (await sign());
    if (!a) return;
    const res = await fetchApprovals(token.kernel, a);
    setList(res);
    setAuth(res.token ? { token: res.token } : a);
    queryClient.setQueryData(qk.approvalCount(token.kernel), { pending: res.pending });
  };

  const open = async () => {
    setOpening(true);
    try {
      await load(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Could not open the review queue.');
    } finally {
      setOpening(false);
    }
  };

  const decide = async (item: AgentApproval, decision: ApprovalDecision, note: string) => {
    if (!auth) return;
    setBusy(item.id);
    try {
      const decided = await decideApproval(token.kernel, auth, item.id, decision, note.trim() || undefined);
      setList((prev) => (prev ? { ...prev, items: prev.items.filter((i) => i.id !== item.id), pending: Math.max(0, prev.pending - 1) } : prev));
      queryClient.setQueryData(qk.approvalCount(token.kernel), (c: { pending: number } | undefined) => ({ pending: Math.max(0, (c?.pending ?? 1) - 1) }));
      void queryClient.invalidateQueries({ queryKey: qk.agentActivity(token.kernel) });
      void queryClient.invalidateQueries({ queryKey: qk.posts(token.agentId) });
      toast.success(decided.status === 'approved' ? (decided.url ? 'Approved and posted on X.' : 'Approved: the agent is sending it.') : 'Rejected. The agent will see your note on its next turn.');
    } catch (err) {
      if (err instanceof ReviewError && err.status === 401) {
        setAuth(null);
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
          <Button type="button" variant="secondary" size="sm" onClick={() => void open()} loading={opening} loadingLabel="Opening…" disabled={!env.useMock && !address}>
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
          {list.items.map((item) => (
            <Item key={item.id} item={item} busy={busy === item.id} onDecide={(d, note) => void decide(item, d, note)} />
          ))}
        </ul>
      )}
    </div>
  );
}
