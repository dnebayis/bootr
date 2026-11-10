'use client';

import { useReadContract, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { feeEscrowAbi, NATIVE_ETH } from '@/lib/abi/feeEscrow';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { mock } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';

/** What each Clanker version pays creators in, and from where. */
export const CLANKER_FEE_SOURCES = {
  4: { asset: 'WETH', from: 'Clanker’s fee locker' },
  5: { asset: 'ETH', from: 'Clanker’s fee escrow' },
} as const;

/**
 * The fees waiting for `owner` on one Clanker version (one balance across all their coins of that version) and the
 * claim that sends it to them; whoever sends the claim, `owner` receives it.
 *
 * - v4 (`version` 4, the default): Clanker's LP locker converts every slot's fees to WETH and deposits them in
 *   ClankerFeeLocker; `availableFees(owner, WETH)` is the balance, `claim(owner, WETH)` pays it
 *   (docs/design/clanker-launch.md, section 1).
 * - v5 (`version` 5): the v5 hook credits Clanker's FeeEscrow on every trade, in native ETH; `owed(owner, 0x0)` is the
 *   balance, `claimFor(owner, 0x0)` pays it (docs/design/clanker-v5-migration.md, section 3).
 *
 * Mock mode shows a deterministic non-zero amount and the claim is a toast. `enabled` false skips the read (nothing
 * to claim without a coin of that version); `label` names the transaction in the toasts.
 */
export function useClankerFees({ owner, enabled = true, label = 'Claim Clanker fees', version = 4 }: { owner: Address | undefined; enabled?: boolean; label?: string; version?: 4 | 5 }) {
  const target = version === 5 ? contracts.clankerFeeEscrow : contracts.clankerFeeLocker;
  const live = !env.useMock && !!target;
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const v4Read = useReadContract({
    address: target ?? undefined,
    abi: clankerFeeLockerAbi,
    functionName: 'availableFees',
    args: owner ? [owner, contracts.weth] : undefined,
    chainId: appChain.id,
    query: { enabled: version === 4 && live && enabled && !!owner },
  });
  const v5Read = useReadContract({
    address: target ?? undefined,
    abi: feeEscrowAbi,
    functionName: 'owed',
    args: owner ? [owner, NATIVE_ETH] : undefined,
    chainId: appChain.id,
    query: { enabled: version === 5 && live && enabled && !!owner },
  });
  const read = version === 5 ? v5Read : v4Read;

  const amount: bigint | null = !enabled ? null : env.useMock ? (owner ? mock.clankerFees(owner, version) : null) : live ? (read.data ?? null) : null;
  const reading = live && enabled && !!owner && read.isPending;

  /** Sends the claim from the connected wallet; the fees go to `owner`. Refetches the balance on the receipt. */
  const claim = async (): Promise<boolean> => {
    if (env.useMock) {
      toast.success(`Mock: ${label} sent`);
      return true;
    }
    if (!target || !owner) return false;
    const r = await run(label, () =>
      version === 5
        ? write.mutateAsync({ address: target, abi: feeEscrowAbi, functionName: 'claimFor', args: [owner, NATIVE_ETH], chainId: appChain.id, dataSuffix: builderDataSuffix })
        : write.mutateAsync({ address: target, abi: clankerFeeLockerAbi, functionName: 'claim', args: [owner, contracts.weth], chainId: appChain.id, dataSuffix: builderDataSuffix }),
    );
    if (r) void read.refetch();
    return !!r;
  };

  return {
    amount,
    reading,
    claim,
    pending: pending === label,
    live,
    /** The escrow or locker the claim is sent to (null where this deployment has none). */
    target,
    asset: CLANKER_FEE_SOURCES[version].asset,
    error: live && read.isError ? read.error : null,
  };
}
