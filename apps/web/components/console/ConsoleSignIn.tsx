'use client';

import { useState } from 'react';
import { useConnection, useSignMessage } from 'wagmi';
import { SiweMessage } from 'siwe';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { appChain } from '@/lib/chains';
import { txErrorMessage } from '@/lib/tx';

export function ConsoleSignIn() {
  const { address, isConnected, chainId } = useConnection();
  const sign = useSignMessage();
  const [busy, setBusy] = useState(false);

  async function signIn() {
    if (!address) return;
    setBusy(true);
    try {
      const n = await fetch('/api/siwe/nonce', { method: 'POST' });
      if (!n.ok) throw new Error((await n.json().catch(() => ({})))?.error ?? 'Could not start sign-in');
      const { nonce } = (await n.json()) as { nonce: string };
      const now = new Date();
      const message = new SiweMessage({
        domain: window.location.host,
        address,
        statement: 'Sign in to the Bootr console.',
        uri: window.location.origin,
        version: '1',
        chainId: chainId ?? appChain.id,
        nonce,
        issuedAt: now.toISOString(),
        expirationTime: new Date(now.getTime() + 10 * 60_000).toISOString(),
      }).prepareMessage();
      const signature = await sign.mutateAsync({ message });
      const v = await fetch('/api/siwe/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message, signature }),
      });
      const body = (await v.json().catch(() => ({}))) as { error?: string };
      if (!v.ok) throw new Error(body.error ?? 'Sign-in failed');
      window.location.assign(window.location.pathname.replace(/\/signin\/?$/, ''));
    } catch (e) {
      toast.error(txErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-24">
      <h1 className="text-display-md font-semibold text-ink">Console</h1>
      <p className="text-sm text-mute">Sign in with an admin wallet.</p>
      {isConnected ? (
        <Button variant="ink" size="lg" onClick={signIn} loading={busy} loadingLabel="Check your wallet…">
          Sign in with Ethereum
        </Button>
      ) : (
        <ConnectButton block />
      )}
    </div>
  );
}
