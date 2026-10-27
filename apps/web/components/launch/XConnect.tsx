'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { env } from '@/lib/env';
import { Button } from '@/components/ui/Button';
import { XLogoIcon } from '@/components/ui/Icons';

type Status = { connected: boolean; handle?: string | null };

/**
 * Opens the sender service's OAuth flow in a popup and polls /oauth/status until the
 * handle is linked to this draft agent id.
 */
export function XConnect({ draftId, handle, onHandle, symbol }: { draftId: string | null; handle: string | null; onHandle: (h: string | null) => void; symbol: string }) {
  const [pending, setPending] = useState(false);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => () => {
    if (poll.current) clearInterval(poll.current);
  }, []);

  const configured = !!env.senderPublicUrl || env.useMock;

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
    const url = `${env.senderPublicUrl}/oauth/start?agentId=${encodeURIComponent(draftId)}&state=${encodeURIComponent(state)}`;
    const popup = window.open(url, 'bootr-x-oauth', 'width=520,height=720,noopener=no');
    if (!popup) {
      toast.error('Allow popups for bootr.fun to connect X.');
      return;
    }
    setPending(true);
    const started = Date.now();
    if (poll.current) clearInterval(poll.current);
    poll.current = setInterval(async () => {
      try {
        const res = await fetch(
          `${env.senderPublicUrl}/oauth/status?agentId=${encodeURIComponent(draftId)}&state=${encodeURIComponent(state)}`,
          { cache: 'no-store' },
        );
        if (res.ok) {
          const s = (await res.json()) as Status;
          if (s.connected && s.handle) {
            onHandle(s.handle.replace(/^@/, ''));
            setPending(false);
            if (poll.current) clearInterval(poll.current);
            popup.close();
            return;
          }
        }
      } catch {
        /* keep polling */
      }
      if (Date.now() - started > 5 * 60_000 || popup.closed) {
        if (poll.current) clearInterval(poll.current);
        setPending(false);
      }
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
