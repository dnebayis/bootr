'use client';

import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { cn } from '@/components/ui/cn';
import { appChain, chainBadge, explorer } from '@/lib/chains';
import { shortAddr } from '@/lib/format';

const subscribe = () => () => {};

function useMounted() {
  return useSyncExternalStore(subscribe, () => true, () => false);
}

function useOutside<T extends HTMLElement>(open: boolean, close: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

const menu =
  'absolute right-0 top-[calc(100%+6px)] z-50 w-64 overflow-hidden rounded-md border border-hairline bg-canvas p-1 shadow-[0_1px_1px_#00000005,0_8px_16px_-4px_#0000000a,0_24px_32px_-8px_#0000000f]';
const item = 'flex w-full items-center justify-between gap-2 rounded-sm px-2.5 py-2 text-left text-sm text-ink hover:bg-canvas-sub disabled:opacity-50';

export function ConnectButton({ className, block = false }: { className?: string; block?: boolean }) {
  const mounted = useMounted();
  const { address, chainId, isConnected, connector } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [open, setOpen] = useState(false);
  const ref = useOutside<HTMLDivElement>(open, () => setOpen(false));

  if (!mounted) {
    return (
      <Button variant="ink" size="md" className={cn(block && 'w-full', className)} disabled>
        Connect wallet
      </Button>
    );
  }

  const wrongChain = isConnected && chainId !== appChain.id;

  if (isConnected && address) {
    return (
      <div ref={ref} className={cn('relative', block && 'w-full', className)}>
        <Button
          variant="secondary"
          size="md"
          onClick={() => setOpen((o) => !o)}
          aria-haspopup="menu"
          aria-expanded={open}
          className={cn('gap-2', block && 'w-full')}
        >
          <span
            className={cn(
              'rounded-xs border px-1 font-mono text-micro',
              wrongChain ? 'border-danger text-danger' : 'border-hairline text-mute',
            )}
          >
            {wrongChain ? 'WRONG NETWORK' : chainBadge(chainId)}
          </span>
          <span className="font-mono tabular">{shortAddr(address, 6, 4)}</span>
        </Button>
        {open ? (
          <div role="menu" className={menu}>
            <div className="px-2.5 py-2">
              <div className="text-caption text-mute">Connected with {connector?.name ?? 'wallet'}</div>
              <div className="mt-0.5 font-mono text-caption text-ink">{shortAddr(address, 10, 8)}</div>
            </div>
            <div className="my-1 h-px bg-hairline" />
            {wrongChain ? (
              <button role="menuitem" className={item} onClick={() => switchChain.mutate({ chainId: appChain.id })}>
                Switch to {appChain.name}
              </button>
            ) : null}
            <button
              role="menuitem"
              className={item}
              onClick={async () => {
                await navigator.clipboard.writeText(address);
                toast('Address copied');
                setOpen(false);
              }}
            >
              Copy address
            </button>
            <a role="menuitem" className={item} href={explorer.address(address, chainId)} target="_blank" rel="noopener noreferrer">
              View on explorer
            </a>
            <button
              role="menuitem"
              className={item}
              onClick={() => {
                disconnect.mutate();
                setOpen(false);
              }}
            >
              Disconnect
            </button>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div ref={ref} className={cn('relative', block && 'w-full', className)}>
      <Button
        variant="ink"
        size="md"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        loading={connect.isPending}
        loadingLabel="Connecting…"
        className={cn(block && 'w-full')}
      >
        Connect wallet
      </Button>
      {open ? (
        <div role="menu" className={menu}>
          <div className="px-2.5 pb-1 pt-2 text-caption text-mute">Choose a wallet</div>
          {connectors.map((c) => (
            <button
              key={c.uid}
              role="menuitem"
              className={item}
              onClick={() =>
                connect.mutate(
                  { connector: c, chainId: appChain.id },
                  {
                    onSuccess: () => setOpen(false),
                    onError: (e) => toast.error(e.message.split('\n')[0] ?? 'Connection failed'),
                  },
                )
              }
            >
              <span>{c.name === 'Injected' ? 'Browser wallet' : c.name}</span>
              <span className="font-mono text-micro text-mute">{c.type === 'injected' ? 'EXT' : c.type === 'walletConnect' ? 'QR' : 'SDK'}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
