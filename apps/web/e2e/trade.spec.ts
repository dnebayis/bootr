import { expect, test } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/**
 * The trade panel in mock mode: the figures come from the fixtures (`lib/swap/mock.ts`), the states are the panel's own.
 * Real calldata on real pools is covered by `lib/swap/swap.fork.test.ts`.
 */
async function firstCoin(page: import('@playwright/test').Page) {
  await page.goto('/');
  const href = await page.locator('a[href^="/token/0x"]').first().getAttribute('href');
  return href!;
}

test('without a wallet the panel asks to connect, and the other site is a small link', async ({ page }) => {
  await page.goto(await firstCoin(page));
  const panel = page.locator('#trade');
  await expect(panel.getByRole('button', { name: 'Connect wallet' })).toBeVisible();
  await expect(panel.getByRole('link', { name: /Swap on another site/ })).toHaveAttribute('href', /^https:\/\/(app\.uniswap\.org|swap\.defillama\.com)\//);
  // The header's Trade goes to the panel, not off the site.
  await expect(page.getByRole('link', { name: 'Trade', exact: true })).toHaveAttribute('href', '#trade');
  await page.getByLabel('You pay').fill('0.01');
  await expect(panel.getByTestId('trade-out')).not.toHaveText(/^0 /);
  await expect(panel.getByTestId('trade-fee')).toHaveText(/%/);
  await expect(panel.getByTestId('trade-impact')).toHaveText(/%/);
  await expect(panel.getByTestId('trade-min')).not.toHaveText('—');
});

test('connected: buy and sell quote, a too-large amount and bad slippage are refused in words, a mock swap confirms', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto(await firstCoin(page));
  const panel = page.locator('#trade');
  await panel.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
  await expect(panel.getByTestId('trade-balance')).toContainText('1 ETH');

  const submit = panel.getByTestId('trade-submit');
  await expect(submit).toHaveText('Enter an amount');
  await expect(submit).toBeDisabled();

  await page.getByLabel('You pay').fill('5');
  await expect(submit).toHaveText('Not enough ETH');

  await page.getByRole('button', { name: '0.01', exact: true }).click();
  await expect(submit).toHaveText(/^Buy \$/);
  const minAtOne = await panel.getByTestId('trade-min').textContent();

  await panel.getByRole('button', { name: '2%', exact: true }).click();
  await expect(panel.getByTestId('trade-min')).not.toHaveText(minAtOne!);

  await panel.getByLabel('Custom slippage in percent').fill('50');
  await expect(panel.getByText('Slippage goes from 0.01% to 20%.')).toBeVisible();
  await expect(submit).toBeDisabled();
  await panel.getByLabel('Custom slippage in percent').fill('');

  await submit.click();
  await expect(page.getByText(/^Bought \$/)).toBeVisible();
  await expect(page.getByLabel('You pay')).toHaveValue('');

  await panel.getByRole('tab', { name: 'Sell' }).click();
  await panel.getByRole('button', { name: '50%', exact: true }).click();
  await expect(submit).toHaveText(/^Sell \$/);
  await expect(panel.getByTestId('trade-approvals')).toContainText('3 confirmations in your wallet: two approvals for exactly this amount, then the sell.');
  await submit.click();
  await expect(page.getByText(/^Sold \$/)).toBeVisible();
});

test('an amount larger than the pool reads as no liquidity', async ({ page }) => {
  await page.goto(await firstCoin(page));
  await page.getByLabel('You pay').fill('100000');
  await expect(page.getByTestId('trade-error')).toContainText('does not have enough liquidity');
});

test('a wallet on another network is asked to switch, and a failed switch reads in words', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.addInitScript(() => {
    const w = window as unknown as { ethereum: { request: (a: { method: string }) => Promise<unknown> } };
    const inner = w.ethereum.request;
    w.ethereum.request = async (a) => {
      if (a.method === 'eth_chainId') return '0x2105';
      if (a.method === 'wallet_switchEthereumChain') throw Object.assign(new Error('cannot switch'), { code: -32000 });
      return inner(a);
    };
  });
  await page.goto(await firstCoin(page));
  const panel = page.locator('#trade');
  await panel.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
  const switchButton = panel.getByRole('button', { name: /^Switch to/ });
  await expect(switchButton).toBeVisible();
  await switchButton.click();
  await expect(panel.getByTestId('trade-error')).toContainText('Your wallet is on another network.');
});

test('the panel keeps to phone width', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.goto(await firstCoin(page));
  const box = await page.locator('#trade').boundingBox();
  expect(box!.width).toBeLessThanOrEqual(375);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});
