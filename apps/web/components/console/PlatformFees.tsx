'use client';

import { useMemo, useState } from 'react';
import { useReadContracts, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address } from 'viem';
import { feeLockerAbi } from '@/lib/abi/feeLocker';
import { lpLockerAbi } from '@/lib/abi/lpLocker';
import { builderDataSuffix } from '@/lib/attribution';
import { appChain, explorer } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { shortAddr, units } from '@/lib/format';
import { mock } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';
import type { AgentWithToken } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Empty, Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';

const th = 'px-4 py-2 text-left text-caption font-normal text-mute';
const td = 'px-4 py-2.5 align-middle';

/** Mock-mode platform recipient (no on-chain reads). */
const MOCK_RECIPIENT = '0x00000000000000000000000000000000000b0075' as Address;

type Claim = { recipient: Address; feeToken: Address; amount: bigint; label: string };

/**
 * Platform share of LP fees waiting in Clanker's fee locker. The platform recipient of each coin is
 * the last reward recipient in the LP locker (BootrLauncher puts it there); WETH is one pooled
 * balance per recipient, fees taken in a coin are per coin. `claim` is permissionless and always
 * pays the recipient, so any connected wallet (the admin's) can trigger it.
 */
export function PlatformFeesPanel({ agents, loading }: { agents: AgentWithToken[]; loading: boolean }) {
  const live = !env.useMock;
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const [allRunning, setAllRunning] = useState(false);

  const coins = useMemo(() => {
    const seen = new Map<string, { token: Address; name: string; symbol: string }>();
    for (const a of agents) {
      if (!seen.has(a.token.toLowerCase())) seen.set(a.token.toLowerCase(), { token: a.token, name: a.tokenInfo?.name ?? shortAddr(a.token), symbol: a.tokenInfo?.symbol ?? '' });
    }
    return [...seen.values()];
  }, [agents]);

  const rewards = useReadContracts({
    allowFailure: true,
    contracts: coins.map((c) => ({ address: contracts.lpLocker, abi: lpLockerAbi, functionName: 'tokenRewards' as const, args: [c.token] as const, chainId: appChain.id })),
    query: { enabled: live && coins.length > 0 },
  });

  const recipientOf = (i: number): Address | null => {
    if (!live) return MOCK_RECIPIENT;
    const r = rewards.data?.[i];
    if (r?.status !== 'success') return null;
    const list = (r.result as { rewardRecipients: readonly Address[] }).rewardRecipients;
    return list.length ? list[list.length - 1]! : null;
  };
  const recipients = coins.map((_, i) => recipientOf(i));
  const distinct = [...new Set(recipients.filter((r): r is Address => !!r).map((r) => r.toLowerCase()))] as Address[];

  const fees = useReadContracts({
    allowFailure: true,
    contracts: [
      ...distinct.map((r) => ({ address: contracts.feeLocker, abi: feeLockerAbi, functionName: 'availableFees' as const, args: [r, contracts.weth] as const, chainId: appChain.id })),
      ...coins.map((c, i) => ({
        address: contracts.feeLocker,
        abi: feeLockerAbi,
        functionName: 'availableFees' as const,
        args: [recipients[i] ?? contracts.feeLocker, c.token] as const,
        chainId: appChain.id,
      })),
    ],
    query: { enabled: live && distinct.length > 0 },
  });

  const read = (i: number): bigint | null => {
    const r = fees.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : null;
  };
  const wethOf = (k: number): bigint | null => (live ? read(k) : mock.claimable(distinct[k]!, contracts.weth, 'weth'));
  const coinOf = (i: number): bigint | null => {
    if (!recipients[i]) return null;
    return live ? read(distinct.length + i) : mock.claimable(MOCK_RECIPIENT, coins[i]!.token, 'coin');
  };

  const claims: Claim[] = [
    ...distinct.map((r, k) => ({ recipient: r, feeToken: contracts.weth, amount: wethOf(k) ?? 0n, label: `Claim WETH for ${shortAddr(r, 6, 4)}` })),
    ...coins.map((c, i) => ({ recipient: recipients[i]!, feeToken: c.token, amount: coinOf(i) ?? 0n, label: `Claim $${c.symbol} platform fees` })),
  ].filter((c) => c.recipient && c.amount > 0n);

  const claimOne = async (c: Claim): Promise<boolean> => {
    if (!live) {
      toast.success(`Mock: ${c.label} sent`);
      return true;
    }
    const r = await run(c.label, () =>
      write.mutateAsync({ address: contracts.feeLocker, abi: feeLockerAbi, functionName: 'claim', args: [c.recipient, c.feeToken], chainId: appChain.id, dataSuffix: builderDataSuffix }),
    );
    return !!r;
  };

  const claimSingle = async (c: Claim) => {
    if ((await claimOne(c)) && live) void fees.refetch();
  };

  const claimAll = async () => {
    // Sequential: one wallet prompt at a time; stop at the first rejection or failure.
    let done = 0;
    setAllRunning(true);
    try {
      for (const c of claims) {
        if (!(await claimOne(c))) break;
        done += 1;
      }
    } finally {
      setAllRunning(false);
    }
    if (done > 0 && live) void fees.refetch();
    if (done < claims.length) toast(`Claimed ${done} of ${claims.length}.`);
  };

  const reading = live && (rewards.isPending || fees.isPending) && coins.length > 0;

  return (
    <Panel
      title="Platform fees"
      bodyClassName="p-0"
      action={
        <Button size="sm" variant="ink" onClick={() => void claimAll()} disabled={claims.length === 0 || !!pending} loading={allRunning} loadingLabel="Claiming…">
          Claim all{claims.length ? ` (${claims.length})` : ''}
        </Button>
      }
    >
      <p className="border-b border-hairline px-4 py-2 text-caption text-mute">
        Claiming is permissionless and always pays the platform recipient, so the connected wallet only pays gas. Claim all sends one transaction per
        balance, in order.
      </p>
      {loading || reading ? (
        <div className="p-4">
          <Skeleton className="h-32" />
        </div>
      ) : coins.length === 0 ? (
        <Empty>No coins launched yet.</Empty>
      ) : (
        <>
          <div className="divide-y divide-hairline border-b border-hairline">
            {distinct.map((r, k) => {
              const amount = wethOf(k);
              const c = { recipient: r, feeToken: contracts.weth, amount: amount ?? 0n, label: `Claim WETH for ${shortAddr(r, 6, 4)}` };
              return (
                <div key={r} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                  <div>
                    <div className="text-caption text-mute">
                      Claimable WETH, recipient{' '}
                      <a href={explorer.address(r)} target="_blank" rel="noopener noreferrer" className="font-mono hover:text-link">
                        {shortAddr(r, 6, 4)}
                      </a>
                    </div>
                    <div className="font-mono text-base text-ink tabular" data-testid="platform-weth">
                      {amount == null ? '—' : `${units(amount, 18, 6)} WETH`}
                    </div>
                  </div>
                  <Button size="sm" variant="secondary" onClick={() => void claimSingle(c)} disabled={!amount || !!pending || allRunning} loading={!allRunning && pending === c.label}>
                    Claim WETH
                  </Button>
                </div>
              );
            })}
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full min-w-[640px] border-collapse">
              <thead className="sticky top-0 bg-canvas-soft">
                <tr>
                  <th className={th}>Coin</th>
                  <th className={th}>Recipient</th>
                  <th className={`${th} text-right`}>Claimable in coin</th>
                  <th className={`${th} text-right`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {coins.map((coin, i) => {
                  const amount = coinOf(i);
                  const recipient = recipients[i];
                  const c = { recipient: recipient!, feeToken: coin.token, amount: amount ?? 0n, label: `Claim $${coin.symbol} platform fees` };
                  return (
                    <tr key={coin.token} className="border-t border-hairline">
                      <td className={td}>
                        <a href={`/token/${coin.token}`} className="text-sm text-ink hover:text-link">
                          {coin.name} <span className="font-mono text-caption text-mute">${coin.symbol}</span>
                        </a>
                      </td>
                      <td className={`${td} font-mono text-caption text-body`}>{recipient ? shortAddr(recipient, 6, 4) : '—'}</td>
                      <td className={`${td} text-right font-mono text-sm tabular`}>{amount == null ? '—' : `${units(amount, 18, 2)} ${coin.symbol}`}</td>
                      <td className={`${td} text-right`}>
                        <Button size="sm" variant="secondary" onClick={() => void claimSingle(c)} disabled={!amount || !recipient || !!pending || allRunning} loading={!allRunning && pending === c.label}>
                          Claim
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Panel>
  );
}
