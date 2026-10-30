import { expect, test, type Page } from '@playwright/test';
import { ADMIN_COOKIE, newSessionId, signToken } from '../lib/server/session-core';

const SLUG = process.env.ADMIN_CONSOLE_SLUG!;
const ADMIN = process.env.ADMIN_ADDRESSES!.split(',')[0]!;
const WALLET = '0x00000000000000000000000000000000000e2e01';

/** Minimal EIP-1193 wallet on Base Sepolia, so the injected connector can connect without an extension. */
async function fakeInjectedWallet(page: Page) {
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
  }, WALLET);
}

test('connect menu lists Base Account first, then Coinbase Wallet and the browser wallet', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first();
  await expect(button).toBeEnabled();
  await button.click();
  const menu = page.getByRole('menu', { name: 'Choose a wallet' });
  await expect(menu).toBeVisible();
  const items = menu.getByRole('menuitem');
  await expect(items.nth(0)).toContainText('Sign in with Base');
  await expect(items.nth(0)).toContainText('Passkey smart wallet');
  await expect(items.nth(1)).toContainText('Coinbase Wallet');
  await expect(items.nth(2)).toContainText('Browser wallet');
  // WalletConnect is listed only with NEXT_PUBLIC_WC_PROJECT_ID (unset in the e2e build).
  const labels = await items.allTextContents();
  if (process.env.NEXT_PUBLIC_WC_PROJECT_ID) expect(labels.at(-1)).toContain('WalletConnect');
  else expect(labels.join(' ')).not.toContain('WalletConnect');
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});

test('profile shows creator fees with claim controls (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto('/profile');
  await page.getByRole('main').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('creator-weth')).toContainText('WETH');
  await expect(panel.getByRole('button', { name: 'Claim WETH' })).toBeVisible();
  const claims = panel.getByRole('button', { name: 'Claim fees' });
  expect(await claims.count()).toBeGreaterThan(0);
  // The agents table carries each coin's gas with a status chip (the creator funds the first gas).
  const agents = page.locator('table', { has: page.getByRole('columnheader', { name: 'Gas' }) });
  await expect(agents).toBeVisible();
  expect(await agents.getByTestId('gas-status').count()).toBeGreaterThan(0);
});

test('console lists platform fees with per-token and claim-all actions (mock mode)', async ({ page, context, baseURL }) => {
  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600, s: newSessionId() });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  await page.goto(`/console-${SLUG}`);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Platform fees' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Claim all/ })).toBeVisible();
  await expect(panel.getByTestId('platform-weth')).toContainText('WETH');
  expect(await panel.getByRole('button', { name: 'Claim', exact: true }).count()).toBeGreaterThan(0);
});
