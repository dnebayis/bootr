/**
 * The connect menu's order and copy, kept free of React so they can be unit-tested.
 * The menu itself (`ConnectButton`) is a Base UI `Menu`, which keeps the list inside the viewport
 * wherever the button sits (the bottom of the phone drawer, a left-aligned card on the profile page).
 */

export type ConnectorLike = { id: string; name: string; type: string; icon?: string | undefined };

/** Menu order: Base Account, Coinbase Wallet, browser wallets (generic + EIP-6963 announced), WalletConnect. */
const RANK: Record<string, number> = { baseAccount: 0, coinbaseWalletSDK: 1, injected: 2, walletConnect: 4 };

function rank(c: ConnectorLike): number {
  return RANK[c.id] ?? (c.type === 'injected' ? 3 : 5);
}

export function sortConnectors<T extends ConnectorLike>(list: readonly T[]): T[] {
  return [...list].sort((a, b) => rank(a) - rank(b));
}

export type ConnectorCopy = {
  label: string;
  hint?: string;
  tag: string;
  /** `mark` is the Base square; `letter` is a neutral slot; `icon` is the data: URI a wallet announced. */
  art: { kind: 'mark' } | { kind: 'letter'; letter: string } | { kind: 'icon'; src: string };
};

/** Label, hint and tag for one connector. Plain words: what the option is, not how it works inside. */
export function connectorCopy(c: ConnectorLike): ConnectorCopy {
  switch (c.id) {
    case 'baseAccount':
      return { label: 'Sign in with Base', hint: 'Passkey smart wallet', tag: 'PASSKEY', art: { kind: 'mark' } };
    case 'coinbaseWalletSDK':
      return { label: 'Coinbase Wallet', tag: 'APP', art: { kind: 'letter', letter: 'C' } };
    case 'injected':
      return { label: 'Browser wallet', tag: 'EXT', art: { kind: 'letter', letter: 'B' } };
    case 'walletConnect':
      return { label: 'WalletConnect', tag: 'QR', art: { kind: 'letter', letter: 'W' } };
    default:
      // EIP-6963 wallets announce their own name and a data: URI icon.
      return {
        label: c.name,
        tag: 'EXT',
        art: c.icon?.startsWith('data:image/') ? { kind: 'icon', src: c.icon } : { kind: 'letter', letter: c.name.charAt(0).toUpperCase() || '?' },
      };
  }
}

/** What the connected menu calls the wallet in use. */
export function connectedWith(connector: { id: string; name: string } | undefined): string {
  if (!connector) return 'wallet';
  return connector.id === 'injected' ? 'browser wallet' : connector.name;
}
