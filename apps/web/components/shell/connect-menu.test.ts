import { describe, expect, it } from 'vitest';
import { connectedWith, connectorCopy, sortConnectors } from './connect-menu';

const base = { id: 'baseAccount', name: 'Base Account', type: 'baseAccount' };
const coinbase = { id: 'coinbaseWalletSDK', name: 'Coinbase Wallet', type: 'coinbaseWallet' };
const injected = { id: 'injected', name: 'Injected', type: 'injected' };
const walletConnect = { id: 'walletConnect', name: 'WalletConnect', type: 'walletConnect' };
const rabby = { id: 'io.rabby', name: 'Rabby Wallet', type: 'injected', icon: 'data:image/svg+xml;base64,AAAA' };

describe('connect menu order', () => {
  it('lists Base Account, Coinbase Wallet and the browser wallet in that order whatever wagmi hands over', () => {
    expect(sortConnectors([injected, coinbase, base]).map((c) => c.id)).toEqual(['baseAccount', 'coinbaseWalletSDK', 'injected']);
  });

  it('puts announced browser wallets after the generic one and WalletConnect last', () => {
    expect(sortConnectors([walletConnect, rabby, injected, coinbase, base]).map((c) => c.id)).toEqual([
      'baseAccount',
      'coinbaseWalletSDK',
      'injected',
      'io.rabby',
      'walletConnect',
    ]);
  });

  it('keeps the phone list (no browser wallet injected) intact: Base Account first, then Coinbase Wallet', () => {
    // On a phone outside a wallet's in-app browser nothing is injected; wagmi still lists the generic
    // injected connector, so the menu never filters down to an empty list.
    expect(sortConnectors([coinbase, base, injected]).map((c) => c.id)).toEqual(['baseAccount', 'coinbaseWalletSDK', 'injected']);
  });
});

describe('connect menu copy', () => {
  it('names the built-in options in plain words', () => {
    expect(connectorCopy(base)).toMatchObject({ label: 'Sign in with Base', hint: 'Passkey smart wallet', tag: 'PASSKEY', art: { kind: 'mark' } });
    expect(connectorCopy(coinbase)).toMatchObject({ label: 'Coinbase Wallet', tag: 'APP', art: { kind: 'letter', letter: 'C' } });
    expect(connectorCopy(injected)).toMatchObject({ label: 'Browser wallet', tag: 'EXT', art: { kind: 'letter', letter: 'B' } });
    expect(connectorCopy(walletConnect)).toMatchObject({ label: 'WalletConnect', tag: 'QR', art: { kind: 'letter', letter: 'W' } });
  });

  it('uses an announced wallet’s own name and icon, with a letter when the icon is not a data: URI', () => {
    expect(connectorCopy(rabby)).toMatchObject({ label: 'Rabby Wallet', tag: 'EXT', art: { kind: 'icon', src: rabby.icon } });
    expect(connectorCopy({ ...rabby, icon: 'https://example.com/x.png' }).art).toEqual({ kind: 'letter', letter: 'R' });
    expect(connectorCopy({ id: 'x', name: '', type: 'injected' }).art).toEqual({ kind: 'letter', letter: '?' });
  });

  it('describes the connected wallet without connector ids', () => {
    expect(connectedWith(undefined)).toBe('wallet');
    expect(connectedWith(injected)).toBe('browser wallet');
    expect(connectedWith(coinbase)).toBe('Coinbase Wallet');
  });
});
