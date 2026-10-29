'use client';

import { useMemo } from 'react';
import { useReadContracts } from 'wagmi';
import { multicall3Abi, type Address } from 'viem';
import { appChain } from './chains';
import { env } from './env';
import { entryPoint, entryPointAbi, type KernelGas } from './gas';
import { mock } from './mock';

/**
 * Gas of one or more kernels: `EntryPoint.balanceOf(kernel)` plus the kernel's ETH balance (read as
 * `Multicall3.getEthBalance`, so the whole list is one multicall). Mock mode resolves from lib/mock.ts.
 */
export function useKernelGas(kernels: readonly Address[]) {
  const multicall = appChain.contracts.multicall3.address;
  const live = !env.useMock;
  const read = useReadContracts({
    allowFailure: true,
    contracts: [
      ...kernels.map((k) => ({ address: entryPoint, abi: entryPointAbi, functionName: 'balanceOf' as const, args: [k] as const, chainId: appChain.id })),
      ...kernels.map((k) => ({ address: multicall, abi: multicall3Abi, functionName: 'getEthBalance' as const, args: [k] as const, chainId: appChain.id })),
    ],
    query: { enabled: live && kernels.length > 0, staleTime: 30_000 },
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
    refetch: () => (live ? read.refetch() : Promise.resolve()),
  };
}
