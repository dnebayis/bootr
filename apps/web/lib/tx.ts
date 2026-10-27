'use client';

import { useCallback, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { toast } from 'sonner';
import type { Hash, TransactionReceipt } from 'viem';
import { explorer } from './chains';

export function txErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  const msg = err?.shortMessage || err?.message || 'Transaction failed';
  if (/user rejected|denied/i.test(msg)) return 'Request rejected in wallet.';
  return msg.split('\n')[0]!;
}

/**
 * Wraps "send tx -> wait for receipt" with toasts. `send` returns the tx hash
 * (e.g. `writeContract.mutateAsync`).
 */
export function useTxRunner() {
  const client = usePublicClient();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, send: () => Promise<Hash>): Promise<TransactionReceipt | null> => {
      setPending(label);
      const id = toast.loading(`${label}: confirm in wallet`);
      try {
        const hash = await send();
        toast.loading(`${label}: waiting for confirmation`, { id, description: hash.slice(0, 12) + '…' });
        const receipt = client ? await client.waitForTransactionReceipt({ hash }) : null;
        if (receipt && receipt.status !== 'success') throw new Error('Transaction reverted');
        toast.success(`${label}: confirmed`, {
          id,
          action: { label: 'View', onClick: () => window.open(explorer.tx(hash), '_blank', 'noopener') },
        });
        return receipt;
      } catch (e) {
        toast.error(txErrorMessage(e), { id });
        return null;
      } finally {
        setPending(null);
      }
    },
    [client],
  );

  return { run, pending };
}
