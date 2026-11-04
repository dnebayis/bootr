import type { Page } from '@playwright/test';

/** The account the fake browser wallet connects with. */
export const E2E_WALLET = '0x00000000000000000000000000000000000e2e01';

/** Minimal EIP-1193 wallet on Base Sepolia, so the injected connector can connect without an extension. */
export async function fakeInjectedWallet(page: Page, account = E2E_WALLET) {
  await page.addInitScript((account) => {
    const listeners: Record<string, ((...a: unknown[]) => void)[]> = {};
    const answers: Record<string, unknown> = {
      eth_requestAccounts: [account],
      eth_accounts: [account],
      eth_chainId: '0x14a34',
      net_version: '84532',
      wallet_switchEthereumChain: null,
      wallet_requestPermissions: [{ parentCapability: 'eth_accounts' }],
      wallet_getPermissions: [{ parentCapability: 'eth_accounts' }],
      eth_blockNumber: '0x1',
    };
    (window as unknown as { ethereum: unknown }).ethereum = {
      isMetaMask: false,
      request: async ({ method }: { method: string }) => {
        if (method in answers) return answers[method];
        throw Object.assign(new Error(`unsupported ${method}`), { code: 4200 });
      },
      on: (e: string, f: (...a: unknown[]) => void) => void (listeners[e] = [...(listeners[e] ?? []), f]),
      removeListener: (e: string, f: (...a: unknown[]) => void) => void (listeners[e] = (listeners[e] ?? []).filter((x) => x !== f)),
    };
  }, account);
}

/** Connects the fake browser wallet through the page's own connect menu (the main-content button). */
export async function connectBrowserWallet(page: Page) {
  await page.getByRole('main').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
}
