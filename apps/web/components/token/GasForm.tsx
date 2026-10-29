'use client';

import { useState, type ChangeEvent } from 'react';
import { parseEther, type Address } from 'viem';
import { useConnection, useWriteContract } from 'wagmi';
import { toast } from 'sonner';
import { entryPoint, entryPointAbi, GAS_STATUS_LABEL, GAS_TOPUP_DEFAULT_ETH, GAS_TOPUP_MIN_ETH, validTopUp, type GasStatus } from '@/lib/gas';
import { appChain } from '@/lib/chains';
import { env } from '@/lib/env';
import { builderDataSuffix } from '@/lib/attribution';
import { useTxRunner } from '@/lib/tx';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { cn } from '@/components/ui/cn';

const PRESETS = ['0.0005', '0.001', '0.005'];

/** ok / low / out of gas, in the Base palette (green, yellow on ink, red). */
export function GasChip({ status, className }: { status: GasStatus; className?: string }) {
  return (
    <span
      data-testid="gas-status"
      data-status={status}
      className={cn(
        'inline-flex h-5 shrink-0 items-center gap-1 rounded-xs border px-1.5 text-micro font-medium',
        status === 'ok' && 'border-hairline bg-canvas-soft text-positive-text',
        status === 'low' && 'border-warning-surface bg-warning-surface text-warning',
        status === 'empty' && 'border-danger bg-canvas text-danger',
        className,
      )}
    >
      <span className={cn('inline-block size-1.5 rounded-full', status === 'ok' ? 'bg-positive' : status === 'low' ? 'bg-warning' : 'bg-negative')} aria-hidden="true" />
      {GAS_STATUS_LABEL[status]}
    </span>
  );
}

/**
 * "Add gas": `EntryPoint.depositTo(kernel)` with ETH from the connected wallet. Anyone can top a kernel up, and
 * a deposit can only ever be spent as gas (the agent's session key cannot move ETH).
 *
 * `layout="stack"` (token page) shows a button that opens the form; `layout="row"` (console) renders the form
 * inline, open, and leaves opening to the parent (`onCancel` closes it).
 */
export function GasForm({
  kernel,
  symbol,
  disabled,
  layout = 'stack',
  label = 'Add gas',
  onDone,
  onCancel,
}: {
  kernel: Address;
  symbol?: string;
  disabled?: boolean;
  layout?: 'stack' | 'row';
  label?: string;
  /** Called after a confirmed deposit (or the mock equivalent), so the caller can refresh the gas figure. */
  onDone?: () => void;
  onCancel?: () => void;
}) {
  const [open, setOpen] = useState(layout === 'row');
  const [amount, setAmount] = useState(GAS_TOPUP_DEFAULT_ETH);
  const { isConnected } = useConnection();
  const write = useWriteContract();
  const { run, pending } = useTxRunner();
  const txLabel = `${label} ${symbol ? `$${symbol}` : kernel.slice(0, 8)}`;

  const valid = validTopUp(amount);
  const close = () => {
    setOpen(layout === 'row');
    onCancel?.();
  };

  const submit = async () => {
    if (!valid) return;
    if (env.useMock) {
      toast.success(`Mock: added ${amount} ETH of gas to ${symbol ? `$${symbol}'s agent` : kernel.slice(0, 10)}`);
      close();
      onDone?.();
      return;
    }
    const receipt = await run(txLabel, () =>
      write.mutateAsync({
        address: entryPoint,
        abi: entryPointAbi,
        functionName: 'depositTo',
        args: [kernel],
        value: parseEther(amount),
        chainId: appChain.id,
        dataSuffix: builderDataSuffix,
      }),
    );
    if (receipt) {
      close();
      onDone?.();
    }
  };

  if (!open) {
    return (
      <Button variant="secondary" size="md" className="w-full" onClick={() => setOpen(true)} disabled={disabled}>
        {label}
      </Button>
    );
  }

  const id = `gas-amount-${kernel.slice(2, 10)}`;
  const inputProps = {
    id,
    inputMode: 'decimal' as const,
    mono: true,
    suffix: 'ETH',
    value: amount,
    onChange: (e: ChangeEvent<HTMLInputElement>) => setAmount(e.target.value.trim()),
    'aria-invalid': !valid,
    'aria-label': `${label} amount in ETH`,
  };

  if (layout === 'row') {
    return (
      <form
        className="flex items-center justify-end gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Input {...inputProps} className="w-32" />
        {isConnected || env.useMock ? (
          <Button type="submit" size="sm" variant="ink" disabled={!valid} loading={pending === txLabel}>
            Send
          </Button>
        ) : (
          <ConnectButton />
        )}
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
      </form>
    );
  }

  return (
    <form
      className="flex flex-col gap-3 rounded-sm border border-hairline p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={id} className="text-caption text-mute">
        Send ETH to the agent&rsquo;s EntryPoint deposit. It pays the gas of the agent&rsquo;s own transactions and can be spent on nothing else. Minimum{' '}
        {GAS_TOPUP_MIN_ETH} ETH.
      </label>
      <Input {...inputProps} />
      <div className="flex gap-1.5">
        {PRESETS.map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setAmount(p)}
            className="h-6 rounded-xs border border-hairline px-2 font-mono text-caption text-body hover:border-hairline-strong hover:text-ink"
          >
            {p}
          </button>
        ))}
      </div>
      <div className="flex gap-2">
        <Button variant="ghost" size="md" onClick={close}>
          Cancel
        </Button>
        {isConnected || env.useMock ? (
          <Button type="submit" variant="ink" size="md" className="flex-1" disabled={!valid} loading={pending === txLabel}>
            Add {valid ? amount : ''} ETH
          </Button>
        ) : (
          <ConnectButton className="flex-1" block />
        )}
      </div>
    </form>
  );
}
