'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { multicall3Abi, type Address } from 'viem';
import { appChain } from './chains';
import { env } from './env';
import { entryPoint, entryPointAbi, type KernelGas } from './gas';
import { useMounted } from './hooks';
import { mock } from './mock';

/** Mock mode has no read: its figures count as read when the first page asked for them (client only, never while prerendering). */
let mockReadAt: number | null = null;

/**
 * Gas of one or more kernels: `EntryPoint.balanceOf(kernel)` plus the kernel's ETH balance (read as
 * `Multicall3.getEthBalance`, so the whole list is one multicall), read from the chain through the site's RPC and
 * read again every minute while the page is open. Mock mode resolves from lib/mock.ts.
 *
 * The indexer's `/treasury/:kernel` reports the kernel's ETH balance only, not the EntryPoint deposit, so its `eth`
 * can be 0 while the gas here is not: the agent's gas usually sits in the deposit. `updatedAt` says when the figure
 * was read, so a page can show it.
 */
export function useKernelGas(kernels: readonly Address[]) {
  const multicall = appChain.contracts.multicall3.address;
  const live = !env.useMock;
  const mounted = useMounted();
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      ...kernels.map((k) => ({ address: entryPoint, abi: entryPointAbi, functionName: 'balanceOf' as const, args: [k] as const, chainId: appChain.id })),
      ...kernels.map((k) => ({ address: multicall, abi: multicall3Abi, functionName: 'getEthBalance' as const, args: [k] as const, chainId: appChain.id })),
    ],
    query: { enabled: live && kernels.length > 0, staleTime: 30_000, refetchInterval: 60_000 },
  });

  const data = read.data;
  const byKernel = useMemo(() => {
    const out = new Map<string, KernelGas>();
    kernels.forEach((k, i) => {
      if (!live) return void out.set(k.toLowerCase(), mock.gas(k));
      const deposit = data?.[i];
      const balance = data?.[kernels.length + i];
      if (deposit?.status === 'success' && balance?.status === 'success') {
        out.set(k.toLowerCase(), { deposit: deposit.result as bigint, balance: balance.result as bigint });
      }
    });
    return out;
  }, [kernels, data, live]);

  return {
    /** Gas of `kernel`, or null while loading / when the read failed. */
    of: (kernel: Address): KernelGas | null => byKernel.get(kernel.toLowerCase()) ?? null,
    isPending: live && kernels.length > 0 && read.isPending,
    /** When the figures were read from the chain (ms), null before the first read. */
    updatedAt: live ? (read.dataUpdatedAt > 0 ? read.dataUpdatedAt : null) : mounted ? (mockReadAt ??= Date.now()) : null,
    refetch: () => (live ? read.refetch() : Promise.resolve()),
  };
}
