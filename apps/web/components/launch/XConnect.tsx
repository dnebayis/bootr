'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { env } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { XLogoIcon } from '@/components/ui/Icons';

type Status = { connected: boolean; handle?: string | null };

/**
 * Opens the X OAuth flow in a popup and polls until the handle is linked to this draft agent id.
 * `/api/x/start` signs the sender's `/oauth/start` server-side and redirects to X; `/api/x/status`
 * asks the sender (HMAC, server-side) whether the draft id has a connected account. After launch the
 * supervisor rebinds the account from the draft id to the ERC-8004 agent id.
 */
export function XConnect({ draftId, handle, onHandle, symbol }: { draftId: string | null; handle: string | null; onHandle: (h: string | null) => void; symbol: string }) {
  const [pending, setPending] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  const configured = !!env.senderPublicUrl || env.useMock;

  // After a reload the draft id survives (sessionStorage) but the handle does not: restore it once.
  useEffect(() => {
    if (!draftId || handle || env.useMock || !env.senderPublicUrl) return;
    let cancelled = false;
    fetch(`/api/x/status?agentId=${encodeURIComponent(draftId)}`, { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<Status>) : null))
      .then((s) => {
        if (!cancelled && s?.connected && s.handle) onHandle(s.handle.replace(/^@/, ''));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per draft id
  }, [draftId]);

  const start = () => {
    if (!draftId) return;
    if (env.useMock) {
      setPending(true);
      setTimeout(() => {
        onHandle(`${(symbol || 'agent').toLowerCase()}_agent`);
        setPending(false);
        toast.success('Mock: X account connected');
      }, 900);
      return;
    }
    const state = crypto.randomUUID();
    const url = `/api/x/start?agentId=${encodeURIComponent(draftId)}&state=${encodeURIComponent(state)}`;
    const popup = window.open(url, 'bootr-x-oauth', 'width=520,height=720,noopener=no');
    if (!popup) {
      toast.error('Allow popups for bootr.fun to connect X.');
      return;
    }
    setPending(true);
    const started = Date.now();
    if (poll.current) clearInterval(poll.current);
    const stop = () => {
      if (poll.current) clearInterval(poll.current);
      poll.current = null;
      setPending(false);
    };
    poll.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/x/status?agentId=${encodeURIComponent(draftId)}`, { cache: 'no-store' });
        if (res.status === 503) {
          stop();
          popup.close();
          toast.error('X connection is not configured on this deployment.');
          return;
        }
        if (res.ok) {
          const s = (await res.json()) as Status;
          if (s.connected && s.handle) {
            onHandle(s.handle.replace(/^@/, ''));
            stop();
            popup.close();
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > 5 * 60_000 || popup.closed) stop();
    }, 2000);
  };

  if (handle) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-sm border border-hairline px-3 py-2.5">
        <span className="inline-flex items-center gap-2 text-sm text-ink">
          <XLogoIcon /> <span className="font-mono">@{handle}</span>
          <span className="text-caption text-mute">connected</span>
        </span>
        <Button variant="ghost" size="sm" onClick={() => onHandle(null)}>
          Disconnect
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="lg" onClick={start} disabled={!configured || !draftId} loading={pending} loadingLabel="Waiting for X…" className="w-full sm:w-auto">
        <XLogoIcon /> Connect X
      </Button>
      <p className="text-caption text-mute">
        {configured
          ? 'Create a fresh X account for the agent first. It will post only from that account.'
          : 'X connection is unavailable: NEXT_PUBLIC_SENDER_PUBLIC_URL is not set.'}
      </p>
    </div>
  );
}
