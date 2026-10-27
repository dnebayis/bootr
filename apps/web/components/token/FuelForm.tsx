'use client';

import { useState } from 'react';
import { parseUnits, type Address } from 'viem';
import { useConnection, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import { erc20Abi } from '@/lib/abi/erc20';
import { contracts, USDC_DECIMALS } from '@/lib/contracts';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { builderDataSuffix } from '@/lib/attribution';
import { useTxRunner } from '@/lib/tx';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConnectButton } from '@/components/shell/ConnectButton';

const PRESETS = [5, 20, 50];

/** "Fuel the agent": a plain USDC transfer to the agent's kernel. No approval needed. */
export function FuelForm({ kernel, symbol, disabled }: { kernel: Address; symbol: string; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('20');
  const { isConnected } = useConnection();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();

  const valid = /^\d+(\.\d{0,6})?$/.test(amount) && Number(amount) > 0;

  if (!open) {
    return (
      <Button variant="ink" size="md" className="w-full" onClick={() => setOpen(true)} disabled={disabled}>
        Fuel the agent
      </Button>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-sm border border-hairline p-3"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!valid) return;
        if (env.useMock) {
          toast.success(`Mock: sent ${amount} USDC to $${symbol}'s agent`);
          setOpen(false);
          return;
        }
        const receipt = await run('Fuel agent', () =>
          write.mutateAsync({
            address: contracts.usdc,
            abi: erc20Abi,
            functionName: 'transfer',
            args: [kernel, parseUnits(amount, USDC_DECIMALS)],
            chainId: appChain.id,
            dataSuffix: builderDataSuffix,
          }),
        );
        if (receipt) setOpen(false);
      }}
    >
      <label htmlFor="fuel-amount" className="text-caption text-mute">
        Send USDC to the agent treasury. It pays for thoughts and posts.
      </label>
      <Input id="fuel-amount" inputMode="decimal" mono suffix="USDC" value={amount} onChange={(e) => setAmount(e.target.value.trim())} aria-invalid={!valid} />
      <div className="flex gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(String(p))}
            className="h-6 rounded-xs border border-hairline px-2 font-mono text-caption text-body hover:border-hairline-strong hover:text-ink"
          >
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="md" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        {isConnected || env.useMock ? (
          <Button type="submit" variant="ink" size="md" className="flex-1" disabled={!valid} loading={!!pending}>
            Send {valid ? amount : ''} USDC
          </Button>
        ) : (
          <ConnectButton className="flex-1" block />
        )}
      </div>
    </form>
  );
}
