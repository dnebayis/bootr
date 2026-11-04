'use client';

import { SiweMessage } from 'siwe';
import { toast } from 'sonner';
import { useConnection, useSignMessage } from 'wagmi';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';

export type SignedStatement = { message: string; signature: string };

/**
 * The creator's one signature for a coin-page edit (the agent config, the coin's links): a nonce from
 * `POST /api/agent/nonce`, a SIWE message with `statement`, signed by the connected wallet. Null when there is no
 * wallet, the nonce failed or the signature was cancelled; each case has toasted already. In mock mode nothing is
 * signed: the routes skip the check and read the address as the message.
 */
export function useCreatorSignature() {
  const { address } = useConnection();
  const { signMessageAsync } = useSignMessage();
  const sign = async (statement: string): Promise<SignedStatement | null> => {
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
      statement,
      uri: window.location.origin,
      version: '1',
      chainId: appChain.id,
      nonce,
      issuedAt: new Date().toISOString(),
    }).prepareMessage();
    try {
      const signature = await signMessageAsync({ message });
      return { message, signature };
    } catch {
      toast.error('Signature cancelled.');
      return null;
    }
  };
  return { address, canSign: env.useMock || !!address, sign };
}
