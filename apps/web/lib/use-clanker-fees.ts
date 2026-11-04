'use client';

import { useReadContract, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';

/**
 * The WETH waiting in Clanker's fee locker for `owner` (one balance across all their Clanker coins) and the claim that
 * sends it to them. Clanker's LP locker converts every slot's fees to WETH and deposits them in ClankerFeeLocker per
 * fee owner: `availableFees(owner, WETH)` is the balance, `claim(owner, WETH)` pays `owner` whoever sends it, so the
 * connected wallet sends the claim and the owner receives the WETH either way (docs/design/clanker-launch.md, section 1).
 *
 * Mock mode shows a deterministic non-zero amount and the claim is a toast. `enabled` false skips the read (nothing
 * to claim without a Clanker coin); `label` names the transaction in the toasts.
 */
export function useClankerFees({ owner, enabled = true, label = 'Claim Clanker fees' }: { owner: Address | undefined; enabled?: boolean; label?: string }) {
  const locker = contracts.clankerFeeLocker;
  const live = !env.useMock && !!locker;
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const read = useReadContract({
    address: locker ?? undefined,
    abi: clankerFeeLockerAbi,
    functionName: 'availableFees',
    args: owner ? [owner, contracts.weth] : undefined,
    chainId: appChain.id,
    query: { enabled: live && enabled && !!owner },
  });

  const amount: bigint | null = !enabled ? null : env.useMock ? (owner ? mock.clankerFees(owner) : null) : live ? (read.data ?? null) : null;
  const reading = live && enabled && !!owner && read.isPending;

  /** Sends `claim(owner, WETH)` from the connected wallet; the WETH goes to `owner`. Refetches the balance on the receipt. */
  const claim = async (): Promise<boolean> => {
    if (env.useMock) {
      toast.success(`Mock: ${label} sent`);
      return true;
    }
    if (!locker || !owner) return false;
    const r = await run(label, () =>
      write.mutateAsync({ address: locker, abi: clankerFeeLockerAbi, functionName: 'claim', args: [owner, contracts.weth], chainId: appChain.id, dataSuffix: builderDataSuffix }),
    );
    if (r) void read.refetch();
    return !!r;
  };

  return { amount, reading, claim, pending: pending === label, live, error: live && read.isError ? read.error : null };
}
