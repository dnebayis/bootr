'use client';

import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
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

/** Base logo mark (the Base square), per base.org brand guidelines. */
function BaseMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" className="shrink-0">
      <rect width="16" height="16" rx="3" fill="#0000ff" />
    </svg>
  );
}

/** Neutral slot so labels line up for connectors without a brand mark. */
function Slot({ children }: { children: string }) {
  return (
    <span aria-hidden="true" className="flex size-4 shrink-0 items-center justify-center rounded-xs border border-hairline font-mono text-[9px] leading-none text-mute">
      {children}
    </span>
  );
}

type ConnectorLike = { id: string; name: string; type: string; icon?: string | undefined };

/** Menu order: Base Account, Coinbase Wallet, browser wallets (generic + EIP-6963 announced), WalletConnect. */
const RANK: Record<string, number> = { baseAccount: 0, coinbaseWalletSDK: 1, injected: 2, walletConnect: 4 };

function sortConnectors<T extends ConnectorLike>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => (RANK[a.id] ?? (a.type === 'injected' ? 3 : 5)) - (RANK[b.id] ?? (b.type === 'injected' ? 3 : 5)));
}

function connectorOption(c: ConnectorLike): { label: string; hint?: string; tag: string; icon: ReactNode } {
  switch (c.id) {
    case 'baseAccount':
      return { label: 'Sign in with Base', hint: 'Passkey smart wallet', tag: 'PASSKEY', icon: <BaseMark /> };
    case 'coinbaseWalletSDK':
      return { label: 'Coinbase Wallet', tag: 'APP', icon: <Slot>C</Slot> };
    case 'injected':
      return { label: 'Browser wallet', tag: 'EXT', icon: <Slot>B</Slot> };
    case 'walletConnect':
      return { label: 'WalletConnect', tag: 'QR', icon: <Slot>W</Slot> };
    default:
      // EIP-6963 wallets announce their own name and a data: URI icon.
      return {
        label: c.name,
        tag: 'EXT',
        icon: c.icon?.startsWith('data:image/') ? (
          // eslint-disable-next-line @next/next/no-img-element -- data: URI announced by the wallet
          <img src={c.icon} alt="" width={16} height={16} className="size-4 shrink-0 rounded-xs" />
        ) : (
          <Slot>{c.name.charAt(0).toUpperCase() || '?'}</Slot>
        ),
      };
  }
}

const menu =
  'absolute right-0 top-[calc(100%+6px)] z-50 w-72 overflow-hidden rounded-md border border-hairline bg-canvas p-1 shadow-[0_1px_1px_#00000005,0_8px_16px_-4px_#0000000a,0_24px_32px_-8px_#0000000f]';
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
              <div className="text-caption text-mute">Connected with {connector ? (connector.id === 'injected' ? 'browser wallet' : connector.name) : 'wallet'}</div>
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
        <div role="menu" aria-label="Choose a wallet" className={menu}>
          <div className="px-2.5 pb-1 pt-2 text-caption text-mute">Choose a wallet</div>
          {sortConnectors(connectors).map((c) => {
            const o = connectorOption(c);
            return (
              <button
                key={c.uid}
                role="menuitem"
                className={item}
                data-connector={c.id}
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
                <span className="flex min-w-0 items-center gap-2.5">
                  {o.icon}
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate">{o.label}</span>
                    {o.hint ? <span className="truncate text-caption text-mute">{o.hint}</span> : null}
                  </span>
                </span>
                <span className="shrink-0 font-mono text-micro text-mute">{o.tag}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
