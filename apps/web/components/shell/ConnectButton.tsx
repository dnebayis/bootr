'use client';

import { useState, useSyncExternalStore, type ReactNode, type RefObject } from 'react';
import { useConnect, useConnection, useConnectors, useDisconnect, useSwitchChain } from 'wagmi';
import { toast } from 'sonner';
import { Button } from '@/components/ui/Button';
import { Menu, MenuItem, MenuSeparator } from '@/components/ui/Menu';
import { cn } from '@/components/ui/cn';
import { appChain, chainBadge, explorer } from '@/lib/chains';
import { shortAddr } from '@/lib/format';
import { connectedWith, connectorCopy, sortConnectors, type ConnectorCopy } from './connect-menu';

const subscribe = () => () => {};

function useMounted() {
  return useSyncExternalStore(subscribe, () => true, () => false);
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

function Art({ art }: { art: ConnectorCopy['art'] }): ReactNode {
  switch (art.kind) {
    case 'mark':
      return <BaseMark />;
    case 'letter':
      return <Slot>{art.letter}</Slot>;
    case 'icon':
      // eslint-disable-next-line @next/next/no-img-element -- data: URI announced by the wallet
      return <img src={art.src} alt="" width={16} height={16} className="size-4 shrink-0 rounded-xs" />;
  }
}

/** Both menus: 288px wide, never wider than the phone minus the 16px gutters. */
const popup = 'w-72 max-w-[calc(100vw-16px)]';
/** Two-line rows (label + hint) need more than the 32px default. */
const row = 'h-auto justify-between gap-2 px-2.5 py-2';

/**
 * Connect / account button with its menu. The menu is a Base UI `Menu` (portalled, collision-aware),
 * so it stays on screen wherever the button sits: the bottom of the phone drawer flips it upward and
 * a left-aligned button on a narrow screen shifts it right. A hand-positioned dropdown put it below
 * the viewport from the drawer and past the left edge from the profile card, which on a phone read
 * as "no wallet options appear".
 *
 * `menuContainer` is where the menu is portalled: the mobile drawer passes its own content element
 * so the drawer's focus trap and outside-press dismissal see the menu as part of the drawer.
 */
export function ConnectButton({
  className,
  block = false,
  menuContainer,
}: {
  className?: string;
  block?: boolean;
  menuContainer?: RefObject<HTMLElement | null>;
}) {
  const mounted = useMounted();
  const { address, chainId, isConnected, connector } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const disconnect = useDisconnect();
  const switchChain = useSwitchChain();
  const [open, setOpen] = useState(false);

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
      <div className={cn('relative', block && 'w-full', className)}>
        <Menu
          open={open}
          onOpenChange={setOpen}
          align="end"
          className={popup}
          container={menuContainer}
          trigger={
            <Button variant="secondary" size="md" className={cn('gap-2', block && 'w-full')}>
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
          }
        >
          <div className="px-2.5 py-2">
            <div className="text-caption text-mute">Connected with {connectedWith(connector)}</div>
            <div className="mt-0.5 font-mono text-caption text-ink">{shortAddr(address, 10, 8)}</div>
          </div>
          <MenuSeparator />
          {wrongChain ? (
            <MenuItem className={row} onClick={() => switchChain.mutate({ chainId: appChain.id })}>
              Switch to {appChain.name}
            </MenuItem>
          ) : null}
          <MenuItem
            className={row}
            onClick={() => {
              void navigator.clipboard.writeText(address).then(() => toast('Address copied'));
            }}
          >
            Copy address
          </MenuItem>
          <MenuItem className={row} href={explorer.address(address, chainId)}>
            View on explorer
          </MenuItem>
          <MenuItem className={row} onClick={() => disconnect.mutate()}>
            Disconnect
          </MenuItem>
        </Menu>
      </div>
    );
  }

  return (
    <div className={cn('relative', block && 'w-full', className)}>
      <Menu
        open={open}
        onOpenChange={setOpen}
        align="end"
        className={popup}
        container={menuContainer}
        trigger={
          <Button variant="ink" size="md" loading={connect.isPending} loadingLabel="Connecting…" className={cn(block && 'w-full')}>
            Connect wallet
          </Button>
        }
      >
        <div className="px-2.5 pb-1 pt-2 text-caption text-mute">Choose a wallet</div>
        {sortConnectors(connectors).map((c) => {
          const o = connectorCopy(c);
          return (
            <MenuItem
              key={c.uid}
              className={row}
              data-connector={c.id}
              onClick={() =>
                connect.mutate(
                  { connector: c, chainId: appChain.id },
                  { onError: (e) => toast.error(e.message.split('\n')[0] ?? 'Connection failed') },
                )
              }
            >
              <span className="flex min-w-0 items-center gap-2.5">
                <Art art={o.art} />
                <span className="flex min-w-0 flex-col">
                  <span className="truncate">{o.label}</span>
                  {o.hint ? <span className="truncate text-caption text-mute">{o.hint}</span> : null}
                </span>
              </span>
              <span className="shrink-0 font-mono text-micro text-mute">{o.tag}</span>
            </MenuItem>
          );
        })}
      </Menu>
    </div>
  );
}
