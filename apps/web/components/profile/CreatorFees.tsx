'use client';

import Link from 'next/link';
import { useReadContracts, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { feeLockerAbi } from '@/lib/abi/feeLocker';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
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
 * Creator LP fees waiting in Clanker's fee locker for `owner` (the connected wallet).
 * WETH is one pooled balance across all of the owner's coins; fees taken in a coin are per coin.
 */
export function CreatorFees({ owner, tokens, loading }: { owner: Address; tokens: Token[]; loading: boolean }) {
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const live = !env.useMock;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [contracts.weth, ...tokens.map((t) => t.id)].map((feeToken) => ({
      address: contracts.feeLocker,
      abi: feeLockerAbi,
      functionName: 'availableFees' as const,
      args: [owner, feeToken] as const,
      chainId: appChain.id,
    })),
    query: { enabled: live && tokens.length > 0 },
  });

  const amount = (i: number, feeToken: Address, kind: 'weth' | 'coin'): bigint | null => {
    if (!live) return mock.claimable(owner, feeToken, kind);
    const r = reads.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : null;
  };
  const weth = amount(0, contracts.weth, 'weth');

  const claim = async (feeToken: Address, label: string) => {
    if (!live) return void toast.success(`Mock: ${label} sent`);
    const r = await run(label, () =>
      write.mutateAsync({
        address: contracts.feeLocker,
        abi: feeLockerAbi,
        functionName: 'claim',
        args: [owner, feeToken],
        chainId: appChain.id,
        dataSuffix: builderDataSuffix,
      }),
    );
    if (r) void reads.refetch();
  };

  const reading = live && reads.isPending && tokens.length > 0;

  return (
    <Panel
      title="Creator fees"
      bodyClassName="p-0"
      action={<span className="text-caption text-mute">Claims pay this wallet. Anyone can trigger them.</span>}
    >
      {loading ? (
        <div className="p-5">
          <Skeleton className="h-24" />
        </div>
      ) : tokens.length === 0 ? (
        <Empty>Launch a coin to earn its creator share of the LP fee.</Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
            <div>
              <div className="text-caption text-mute">Claimable WETH, all your coins</div>
              <div className="font-mono text-base text-ink tabular" data-testid="creator-weth">
                {reading ? <Skeleton className="h-5 w-24" /> : weth == null ? '—' : `${units(weth, 18, 6)} WETH`}
              </div>
            </div>
            <Button size="sm" variant="secondary" onClick={() => void claim(contracts.weth, 'Claim WETH fees')} disabled={!weth} loading={pending === 'Claim WETH fees'}>
              Claim WETH
            </Button>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] border-collapse">
              <thead className="bg-canvas-soft">
                <tr>
                  <th scope="col" className={th}>Coin</th>
                  <th scope="col" className={`${th} text-right`}>Claimable in coin</th>
                  <th scope="col" className={`${th} text-right`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t, i) => {
                  const own = amount(i + 1, t.id, 'coin');
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
                        {reading ? '…' : own == null ? '—' : `${units(own, 18, 2)} ${t.symbol}`}
                      </td>
                      <td className={`${td} text-right`}>
                        <Button size="sm" variant="secondary" onClick={() => void claim(t.id, label)} disabled={!own} loading={pending === label}>
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
            Amounts show what the fee locker holds now; fees still in the pool appear after they are collected into it.
          </p>
        </>
      )}
    </Panel>
  );
}
