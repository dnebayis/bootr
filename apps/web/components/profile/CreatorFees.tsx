'use client';

import Link from 'next/link';
import { useReadContracts, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address, Hex } from 'viem';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { otherSharesInBalance } from '@/lib/creator-fees';
import { env } from '@/lib/env';
import { units } from '@/lib/format';
import { mock } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';
import type { Token } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Empty, Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';

const th = 'px-5 py-2 text-left text-caption font-normal text-mute';
const td = 'px-5 py-2.5';

/**
 * Creator fees in RWAGMI's LP locker for `owner` (the connected wallet), all in WETH: the settled balance
 * (`claimableQuote(owner, WETH)`, one pooled balance across every coin) plus each coin's unsettled share
 * (`pendingQuote(poolId, owner)`). Claims pay `msg.sender`'s balance, so only the creator's own wallet can claim:
 * `settleAndClaim(poolIds, WETH, owner)` settles the given pools first, `claimQuote(WETH, owner)` takes the settled
 * balance alone.
 */
export function CreatorFees({ owner, tokens, loading }: { owner: Address; tokens: Token[]; loading: boolean }) {
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const locker = contracts.lpLocker;
  const live = !env.useMock && !!locker;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: locker ?? undefined, abi: rwagmiLpLockerV3Abi, functionName: 'claimableQuote' as const, args: [owner, contracts.weth] as const, chainId: appChain.id },
      ...tokens.map((t) => ({
        address: locker ?? undefined,
        abi: rwagmiLpLockerV3Abi,
        functionName: 'pendingQuote' as const,
        args: [t.poolId, owner] as const,
        chainId: appChain.id,
      })),
    ],
    query: { enabled: live && tokens.length > 0 },
  });

  const amount = (i: number, scope: string): bigint | null => {
    if (env.useMock) return mock.claimable(owner, scope);
    const r = reads.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : null;
  };
  const settled = amount(0, 'settled');
  const unsettled = tokens.map((t, i) => amount(i + 1, t.poolId));
  const known = settled != null && unsettled.every((v) => v != null);
  const total = known ? unsettled.reduce<bigint>((sum, v) => sum + (v ?? 0n), settled) : null;

  /** Settles `poolIds` (none: only the settled balance) and pays the creator's WETH to the connected wallet. */
  const claim = async (poolIds: Hex[], label: string) => {
    if (env.useMock) return void toast.success(`Mock: ${label} sent`);
    if (!locker) return;
    const r = await run(label, () =>
      write.mutateAsync(
        poolIds.length > 0
          ? {
              address: locker,
              abi: rwagmiLpLockerV3Abi,
              functionName: 'settleAndClaim',
              args: [poolIds, contracts.weth, owner],
              chainId: appChain.id,
              dataSuffix: builderDataSuffix,
            }
          : { address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [contracts.weth, owner], chainId: appChain.id, dataSuffix: builderDataSuffix },
      ),
    );
    if (r) void reads.refetch();
  };
  const pendingPools = tokens.filter((_, i) => (unsettled[i] ?? 0n) > 0n).map((t) => t.poolId);

  const reading = live && reads.isPending && tokens.length > 0;
  const alsoHolds = otherSharesInBalance(owner, tokens);

  return (
    <Panel
      title="Creator fees"
      bodyClassName="p-0"
      action={<span className="text-caption text-mute">Paid in WETH. Only this wallet can claim its share.</span>}
    >
      {loading ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : tokens.length === 0 ? (
        <Empty>Launch a coin to earn the creator share of its trading fees.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
            <div>
              <div className="text-caption text-mute">Claimable WETH, all your coins</div>
              <div className="font-mono text-base text-ink tabular" data-testid="creator-weth">
                {reading ? <Skeleton className="h-5 w-24" /> : total == null ? '—' : `${units(total, 18, 6)} WETH`}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void claim(pendingPools, 'Claim WETH fees')} disabled={!total} loading={pending === 'Claim WETH fees'}>
              Claim WETH
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <thead className="bg-canvas-soft">
                <tr>
                  <th scope="col" className={th}>Coin</th>
                  <th scope="col" className={`${th} text-right`}>Unsettled WETH</th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t, i) => {
                  const own = unsettled[i] ?? null;
                  const label = `Claim $${t.symbol} fees`;
                  return (
                    <tr key={t.id} className="border-t border-hairline">
                      <td className={td}>
                        <Link href={`/token/${t.id}`} className="flex items-center gap-2.5 hover:text-link">
                          <TokenImage src={t.image} symbol={t.symbol} size={28} className="rounded-xs" />
                          <span className="text-sm text-ink">{t.name}</span>
                          <span className="font-mono text-caption text-mute">${t.symbol}</span>
                        </Link>
                      </td>
                      <td className={`${td} text-right font-mono text-sm tabular text-ink`}>
                        {reading ? '…' : own == null ? '—' : `${units(own, 18, 6)} WETH`}
                      </td>
                      <td className={`${td} text-right`}>
                        <Button size="sm" variant="secondary" onClick={() => void claim([t.poolId], label)} disabled={!own} loading={pending === label}>
                          Claim fees
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="border-t border-hairline px-5 py-2.5 text-caption text-mute">
            Every claim also pays out your settled WETH from all coins; a coin&rsquo;s unsettled fees are settled into it in the same transaction.
            {alsoHolds ? ` ${alsoHolds}` : null}
          </p>
        </>
      )}
    </Panel>
  );
}
