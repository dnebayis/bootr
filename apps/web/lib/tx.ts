'use client';

import { useCallback, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { toast } from 'sonner';
import type { Hash, TransactionReceipt } from 'viem';
import { explorer } from './chains';

const REJECTED = 'Request rejected in wallet.';

export function txErrorMessage(e: unknown): string {
  const err = e as { shortMessage?: string; message?: string };
  const msg = err?.shortMessage || err?.message || 'Transaction failed';
  if (/user rejected|denied/i.test(msg)) return REJECTED;
  return msg.split('\n')[0]!;
}

/** What a caller may add to `run`: its own words for a known revert, and what to do after a failure. */
export type TxRunOptions = {
  /** Plain words for the error, or null to fall back to `txErrorMessage`. */
  describeError?: (e: unknown) => string | null;
  onError?: (e: unknown) => void;
};

/**
 * Wraps "send tx -> wait for receipt" with toasts. `send` returns the tx hash
 * (e.g. `writeContract.mutateAsync`).
 */
export function useTxRunner() {
  const client = usePublicClient();
  const [pending, setPending] = useState<string | null>(null);

  const run = useCallback(
    async (label: string, send: () => Promise<Hash>, opts: TxRunOptions = {}): Promise<TransactionReceipt | null> => {
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
        const rejected = txErrorMessage(e) === REJECTED;
        toast.error((!rejected && opts.describeError?.(e)) || txErrorMessage(e), { id });
        if (!rejected) opts.onError?.(e);
        return null;
      } finally {
        setPending(null);
      }
    },
    [client],
  );

  return { run, pending };
}
