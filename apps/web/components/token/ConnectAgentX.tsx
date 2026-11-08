'use client';

import { useQueryClient } from '@tanstack/react-query';
import { SiweMessage } from 'siwe';
import { toast } from 'sonner';
import { useConnection, useSignMessage } from 'wagmi';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { qk } from '@/lib/indexer';
import type { Token } from '@/lib/types';
import { XConnect } from '@/components/launch/XConnect';

/**
 * `fresh`: the agent has no X account yet. `again`: X dropped the connection (the inbox's `x_revoked`). `forbidden`: X
 * refuses the account's posts (403; the inbox's `x_forbidden` and the coin page's hold panel, CreatorXBanner.tsx): the same
 * reconnect, and the supervisor lifts the hold on its next pass once the sender's row shows the new connection.
 */
export type ConnectAgentXVariant = 'fresh' | 'again' | 'forbidden';

const CAPTION: Record<Exclude<ConnectAgentXVariant, 'fresh'>, string> = {
  again: 'Sign a message with your wallet, then authorise the same X account the agent has been using. It picks up again within a few minutes.',
  forbidden: 'Sign a message with your wallet, then authorise the same X account again. The pause ends within a few minutes of the reconnect.',
};

/**
 * The coin page's "connect X later" path, shown only to the creator of a coin whose agent has no X account
 * yet. The creator signs a SIWE message naming the agent (`POST /api/siwe/x-claim` checks the signature and,
 * through the indexer, that the wallet created the coin), which registers this browser for the agent id;
 * the usual X OAuth popup then runs against the real agent id, and the supervisor finishes onboarding on
 * its next tick once the sender reports the account. With `again` (the inbox, after X dropped the connection) the same
 * flow restores it; the agent only posts as the account it was set up with, so the text asks for that one. `variant`
 * picks the words (`again` is the short form of `variant="again"`).
 */
export function ConnectAgentX({ token, again = false, variant }: { token: Token; again?: boolean; variant?: ConnectAgentXVariant }) {
  const kind: ConnectAgentXVariant = variant ?? (again ? 'again' : 'fresh');
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const queryClient = useQueryClient();

  const claim = async (): Promise<boolean> => {
    if (env.useMock) return true;
    if (!address) {
      toast.error('Connect the creator wallet first.');
      return false;
    }
    const n = await fetch('/api/siwe/nonce', { method: 'POST' });
    if (!n.ok) {
      toast.error('Could not start the signature (nonce).');
      return false;
    }
    const { nonce } = (await n.json()) as { nonce: string };
    const message = new SiweMessage({
      domain: window.location.host,
      address,
      statement: `Connect the X account of Bootr agent #${token.agentId} (${token.kernel}).`,
      uri: window.location.origin,
      version: '1',
      chainId: appChain.id,
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
    let signature: `0x${string}`;
    try {
      signature = await signMessageAsync({ message });
    } catch {
      toast.error('Signature cancelled.');
      return false;
    }
    const v = await fetch('/api/siwe/x-claim', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message, signature }) });
    if (!v.ok) {
      const body = (await v.json().catch(() => ({}))) as { error?: string };
      toast.error(body.error ?? `Could not verify the creator wallet (${v.status}).`);
      return false;
    }
    return true;
  };

  return (
    <div className="flex flex-col gap-2 rounded-sm border border-hairline p-3" data-testid="connect-agent-x" data-variant={kind}>
      {kind !== 'fresh' ? (
        <p className="text-caption text-body">{CAPTION[kind]}</p>
      ) : (
        <p className="text-caption text-body">
          This agent has no X account yet, so it cannot post. As the creator you can connect one now: sign a message with your wallet, then authorise a fresh X
          account for the agent. The agent starts on the next supervisor pass.
        </p>
      )}
      <XConnect
        draftId={token.agentId}
        handle={null}
        symbol={token.symbol}
        claim={claim}
        onHandle={(h) => {
          if (!h) return;
          toast.success(kind === 'forbidden' ? `@${h} connected again. The pause ends on the next supervisor pass.` : `@${h} connected. The agent starts shortly.`);
          void queryClient.invalidateQueries({ queryKey: ['agent'] });
          void queryClient.invalidateQueries({ queryKey: ['token'] });
          void queryClient.invalidateQueries({ queryKey: qk.agentConfig(token.kernel) });
        }}
      />
    </div>
  );
}
