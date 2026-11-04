'use client';

import { useMemo, useState } from 'react';
import { useConnection, useReadContract, useReadContracts, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import type { Address, Hex } from 'viem';
import { clankerFeeLockerAbi } from '@/lib/abi/clankerFeeLocker';
import { rwagmiLpLockerV3Abi } from '@/lib/abi/rwagmiLpLockerV3';
import { builderDataSuffix } from '@/lib/attribution';
import { DEFAULT_LP_FEE_BPS, feeModelOf, pctLabel, platformSlot, swapFeePct, traderPaysPct, type Slot } from '@/lib/fee-split';
import { appChain, explorer } from '@/lib/chains';
import { contracts } from '@/lib/contracts';
import { env } from '@/lib/env';
import { shortAddr, units } from '@/lib/format';
import { mock } from '@/lib/mock';
import { useTxRunner } from '@/lib/tx';
import type { AgentWithToken, LaunchSource } from '@/lib/types';
import { Button } from '@/components/ui/Button';
import { Empty, Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';

const th = 'px-4 py-2 text-left text-caption font-normal text-mute';
const td = 'px-4 py-2.5 align-middle';

/** Mock-mode platform recipient (no on-chain reads). */
const MOCK_RECIPIENT = '0x00000000000000000000000000000000000b0075' as Address;
/** Pools settled per `settleAndClaim` transaction. */
const CHUNK = 50;

type Claim = { recipient: Address; poolIds: Hex[]; amount: bigint; label: string };

type Coin = { token: Address; name: string; symbol: string; source: LaunchSource; lpFeeBps: number };

/**
 * Platform fees, per launch path.
 *
 * Through Bootr: the platform share of the WETH swap fees in RWAGMI's LP locker. Each coin's platform recipient and pool ids come
 * from `launchInfo(token)` (the last Bootr slot, before RWAGMI's appended one). A recipient's claimable WETH is
 * its settled balance (`claimableQuote`) plus each coin's unsettled share (`pendingQuote`). Claims pay
 * `msg.sender`'s own balance, so only the connected platform recipient wallet can claim:
 * `settleAndClaim(poolIds, WETH, me)` when pools have unsettled fees, else `claimQuote(WETH, me)`.
 *
 * Through Clanker: Clanker's LP locker converts the platform slot's share to WETH and deposits it in ClankerFeeLocker
 * (`availableFees(treasury, WETH)`); `claim(treasury, WETH)` pays the treasury whoever calls it. The panel claims for
 * the connected wallet, which is the platform wallet when the admin signs in with it.
 */
export function PlatformFeesPanel({ agents, loading }: { agents: AgentWithToken[]; loading: boolean }) {
  const locker = contracts.lpLocker;
  const live = !env.useMock && !!locker;
  const { address: me } = useConnection();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const [allRunning, setAllRunning] = useState(false);

  const allCoins = useMemo(() => {
    const seen = new Map<string, Coin>();
    for (const a of agents) {
      if (!seen.has(a.token.toLowerCase())) {
        seen.set(a.token.toLowerCase(), {
          token: a.token,
          name: a.tokenInfo?.name ?? shortAddr(a.token),
          symbol: a.tokenInfo?.symbol ?? '',
          source: a.tokenInfo?.source === 'clanker' ? 'clanker' : 'bootr',
          lpFeeBps: a.tokenInfo?.lpFeeBps ?? DEFAULT_LP_FEE_BPS,
        });
      }
    }
    return [...seen.values()];
  }, [agents]);
  /** Bootr-path coins: their platform share sits in RWAGMI's locker. */
  const coins = useMemo(() => allCoins.filter((c) => c.source === 'bootr'), [allCoins]);
  const clankerCoins = useMemo(() => allCoins.filter((c) => c.source === 'clanker'), [allCoins]);

  // Clanker path: one balance per wallet in the fee locker, claimed with `claim(wallet, WETH)`.
  const feeLocker = contracts.clankerFeeLocker;
  const clankerLive = !env.useMock && !!feeLocker;
  const clankerRead = useReadContract({
    address: feeLocker ?? undefined,
    abi: clankerFeeLockerAbi,
    functionName: 'availableFees',
    args: me ? [me, contracts.weth] : undefined,
    chainId: appChain.id,
    query: { enabled: clankerLive && !!me && clankerCoins.length > 0 },
  });
  const clankerAmount: bigint | null = env.useMock ? (clankerCoins.length ? mock.claimable(MOCK_RECIPIENT, 'clanker') : 0n) : clankerLive ? (clankerRead.data ?? null) : null;
  const claimClanker = async () => {
    if (env.useMock) return void toast.success('Mock: Claim on Clanker sent');
    if (!feeLocker || !me) return;
    const r = await run('Claim on Clanker', () =>
      write.mutateAsync({ address: feeLocker, abi: clankerFeeLockerAbi, functionName: 'claim', args: [me, contracts.weth], chainId: appChain.id, dataSuffix: builderDataSuffix }),
    );
    if (r) void clankerRead.refetch();
  };

  const infos = useReadContracts({
    allowFailure: true,
    contracts: coins.map((c) => ({ address: locker ?? undefined, abi: rwagmiLpLockerV3Abi, functionName: 'launchInfo' as const, args: [c.token] as const, chainId: appChain.id })),
    query: { enabled: live && coins.length > 0 },
  });

  const launchOf = (i: number): { recipient: Address; poolIds: readonly Hex[] } | null => {
    if (!live) return { recipient: MOCK_RECIPIENT, poolIds: [coins[i]!.token.toLowerCase().padEnd(66, '0') as Hex] };
    const r = infos.data?.[i];
    if (r?.status !== 'success') return null;
    const { rewards, poolIds } = r.result as { rewards: readonly Slot[]; poolIds: readonly Hex[] };
    const platform = platformSlot(rewards);
    return platform ? { recipient: platform.recipient, poolIds } : null;
  };
  const launches = coins.map((_, i) => launchOf(i));
  const distinct = [...new Set(launches.filter((l) => !!l).map((l) => l.recipient.toLowerCase()))] as Address[];
  const pairs = launches.flatMap((l, i) => (l ? l.poolIds.map((poolId) => ({ coin: i, poolId, recipient: l.recipient })) : []));

  const fees = useReadContracts({
    allowFailure: true,
    contracts: [
      ...distinct.map((r) => ({ address: locker ?? undefined, abi: rwagmiLpLockerV3Abi, functionName: 'claimableQuote' as const, args: [r, contracts.weth] as const, chainId: appChain.id })),
      ...pairs.map((p) => ({ address: locker ?? undefined, abi: rwagmiLpLockerV3Abi, functionName: 'pendingQuote' as const, args: [p.poolId, p.recipient] as const, chainId: appChain.id })),
    ],
    query: { enabled: live && distinct.length > 0 },
  });

  const read = (i: number): bigint | null => {
    const r = fees.data?.[i];
    return r?.status === 'success' ? (r.result as bigint) : null;
  };
  const settledOf = (k: number): bigint | null => (live ? read(k) : mock.claimable(distinct[k]!, 'settled'));
  const pendingOf = (j: number): bigint | null => (live ? read(distinct.length + j) : mock.claimable(MOCK_RECIPIENT, pairs[j]!.poolId));
  /** Unsettled WETH of coin `i` for its platform recipient (summed over its pools). */
  const coinPending = (i: number): bigint | null => {
    let sum = 0n;
    for (const [j, p] of pairs.entries()) {
      if (p.coin !== i) continue;
      const v = pendingOf(j);
      if (v == null) return null;
      sum += v;
    }
    return launches[i] ? sum : null;
  };
  const pendingPoolsOf = (recipient: Address): Hex[] =>
    pairs.filter((p, j) => p.recipient.toLowerCase() === recipient.toLowerCase() && (pendingOf(j) ?? 0n) > 0n).map((p) => p.poolId);
  const totalOf = (k: number): bigint | null => {
    const settled = settledOf(k);
    if (settled == null) return null;
    let sum = settled;
    for (const [j, p] of pairs.entries()) if (p.recipient.toLowerCase() === distinct[k]) sum += pendingOf(j) ?? 0n;
    return sum;
  };
  /** Claims pay the caller's own balance: only the recipient's wallet can claim (any wallet in mock mode). */
  const canClaim = (recipient: Address) => !live || (!!me && me.toLowerCase() === recipient.toLowerCase());

  // One transaction per CHUNK pools with unsettled fees; a recipient with only a settled balance gets one claimQuote.
  const claims: Claim[] = distinct.flatMap((r, k) => {
    const amount = totalOf(k) ?? 0n;
    if (amount === 0n || !canClaim(r)) return [];
    const pools = pendingPoolsOf(r);
    if (pools.length === 0) return [{ recipient: r, poolIds: [], amount, label: `Claim WETH for ${shortAddr(r, 6, 4)}` }];
    const out: Claim[] = [];
    for (let at = 0; at < pools.length; at += CHUNK) {
      out.push({ recipient: r, poolIds: pools.slice(at, at + CHUNK), amount, label: `Claim WETH for ${shortAddr(r, 6, 4)} (${at / CHUNK + 1})` });
    }
    return out;
  });

  const claimOne = async (c: Claim): Promise<boolean> => {
    if (!live) {
      toast.success(`Mock: ${c.label} sent`);
      return true;
    }
    if (!locker || !me) return false;
    const r = await run(c.label, () =>
      write.mutateAsync(
        c.poolIds.length > 0
          ? { address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'settleAndClaim', args: [c.poolIds, contracts.weth, me], chainId: appChain.id, dataSuffix: builderDataSuffix }
          : { address: locker, abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [contracts.weth, me], chainId: appChain.id, dataSuffix: builderDataSuffix },
      ),
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

  const reading = live && (infos.isPending || fees.isPending) && coins.length > 0;

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
        Fees are paid in WETH, per launch path. Through RWAGMI a claim pays the caller&rsquo;s own balance in RWAGMI&rsquo;s locker, so connect the platform
        recipient&rsquo;s wallet to claim; each claim settles the coins&rsquo; unsettled fees first, and Claim all sends one transaction per {CHUNK} coins, in order.
        Through Clanker the fees wait in Clanker&rsquo;s fee locker, claimed below.
      </p>
      {loading || reading ? (
        <div className="p-4">
          <Skeleton className="h-32" />
        </div>
      ) : allCoins.length === 0 ? (
        <Empty>No coins launched yet.</Empty>
      ) : (
        <>
          {clankerCoins.length > 0 ? <div className="border-b border-hairline bg-canvas-soft px-4 py-1.5 text-caption font-medium text-ink">Through RWAGMI: RWAGMI&rsquo;s locker</div> : null}
          {coins.length === 0 ? <p className="border-b border-hairline px-4 py-3 text-caption text-mute">No coins launched through RWAGMI yet.</p> : null}
          <div className="divide-y divide-hairline border-b border-hairline">
            {distinct.map((r, k) => {
              const amount = totalOf(k);
              const c: Claim = { recipient: r, poolIds: pendingPoolsOf(r).slice(0, CHUNK), amount: amount ?? 0n, label: `Claim WETH for ${shortAddr(r, 6, 4)}` };
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
                  <Button size="sm" variant="secondary" onClick={() => void claimSingle(c)}
                    disabled={!amount || !canClaim(r) || !!pending || allRunning}
                    loading={!allRunning && pending === c.label}
                    title={canClaim(r) ? undefined : 'Connect this recipient wallet to claim'}
                  >
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
                  <th className={`${th} text-right`}>Unsettled WETH</th>
                  <th className={`${th} text-right`}>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {coins.map((coin, i) => {
                  const amount = coinPending(i);
                  const launch = launches[i];
                  const recipient = launch?.recipient;
                  const c: Claim = { recipient: recipient!, poolIds: [...(launch?.poolIds ?? [])], amount: amount ?? 0n, label: `Claim $${coin.symbol} platform fees` };
                  return (
                    <tr key={coin.token} className="border-t border-hairline">
                      <td className={td}>
                        <a href={`/token/${coin.token}`} className="text-sm text-ink hover:text-link">
                          {coin.name} <span className="font-mono text-caption text-mute">${coin.symbol}</span>
                        </a>
                      </td>
                      <td className={`${td} font-mono text-caption text-body`}>{recipient ? shortAddr(recipient, 6, 4) : '—'}</td>
                      <td className={`${td} text-right font-mono text-sm tabular`}>{amount == null ? '—' : `${units(amount, 18, 6)} WETH`}</td>
                      <td className={`${td} text-right`}>
                        <Button size="sm" variant="secondary" onClick={() => void claimSingle(c)} disabled={!amount || !recipient || !canClaim(recipient) || !!pending || allRunning} loading={!allRunning && pending === c.label}>
                          Claim
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {clankerCoins.length > 0 ? (
            <div className="border-t border-hairline" data-testid="platform-fees-clanker">
              <div className="bg-canvas-soft px-4 py-1.5 text-caption font-medium text-ink">Through Clanker: Clanker&rsquo;s fee locker</div>
              <p className="border-t border-hairline px-4 py-2 text-caption text-mute">
                These coins pay their fees into Clanker&rsquo;s fee locker, as WETH. Clanker&rsquo;s LP locker collects a coin&rsquo;s fees first (on swaps, or when
                anyone asks it to collect); once collected, the platform&rsquo;s share is paid out with one call on the fee locker,{' '}
                <span className="font-mono text-ink">claim(treasury, WETH)</span>, where the treasury is the platform wallet. The claim always pays that wallet,
                whoever sends it: connect the platform wallet here, or send the call from anywhere.
              </p>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hairline px-4 py-3">
                <div>
                  <div className="text-caption text-mute">
                    Collected, waiting for a claim
                    {me ? (
                      <>
                        {' '}
                        for{' '}
                        <a href={explorer.address(me)} target="_blank" rel="noopener noreferrer" className="font-mono hover:text-link">
                          {shortAddr(me, 6, 4)}
                        </a>
                      </>
                    ) : null}
                  </div>
                  <div className="font-mono text-base text-ink tabular" data-testid="platform-weth-clanker">
                    {clankerAmount == null ? '—' : `${units(clankerAmount, 18, 6)} WETH`}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => void claimClanker()}
                  disabled={!clankerAmount || (!env.useMock && !me) || !!pending || allRunning}
                  loading={pending === 'Claim on Clanker'}
                  title={!env.useMock && !me ? 'Connect the platform wallet to claim' : undefined}
                >
                  Claim on Clanker
                </Button>
              </div>
              <ul className="divide-y divide-hairline border-t border-hairline">
                {clankerCoins.map((coin) => {
                  const fee = feeModelOf(coin);
                  return (
                    <li key={coin.token} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                      <a href={`/token/${coin.token}`} className="text-sm text-ink hover:text-link">
                        {coin.name} <span className="font-mono text-caption text-mute">${coin.symbol}</span>
                      </a>
                      <span className="font-mono text-caption text-body">
                        {pctLabel(swapFeePct(fee))} fee, plus 20% on top for Clanker: {pctLabel(traderPaysPct(fee))} per trade
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ) : null}
        </>
      )}
    </Panel>
  );
}
