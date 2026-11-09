import { expect, test } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

test('the coin page header carries the creator’s way into the console page under Trade, with the pending count, and the page leads back (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto('/');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
  const coinUrl = new URL(page.url()).pathname;

  // Under the header's Trade button, right-aligned with it: one secondary link with the pending reviews in mono.
  // No console on this page, and nothing of it in the Trade panel.
  const open = page.getByTestId('open-console');
  await expect(open).toHaveAttribute('href', `${coinUrl}/console`);
  await expect(open).toContainText('Creator console');
  await expect(open.getByTestId('approvals-pending')).toHaveText('· 3 pending');
  const trade = page.locator('main header a[href="#trade"]');
  const [tradeBox, openBox] = [await trade.boundingBox(), await open.boundingBox()];
  expect(openBox!.y).toBeGreaterThan(tradeBox!.y + tradeBox!.height - 1);
  expect(Math.abs(openBox!.x + openBox!.width - (tradeBox!.x + tradeBox!.width))).toBeLessThan(2);
  await expect(page.getByTestId('trade-panel').getByTestId('open-console')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Creator console' })).toHaveCount(0);
  await expect(page.getByLabel('Instructions')).toHaveCount(0);
  await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);

  await open.click();
  await expect(page).toHaveURL(new RegExp(`${coinUrl}/console$`));
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_.getByTestId('approvals-pending')).toHaveText('3 pending');
  await expect(console_.getByRole('tab', { name: 'Mind' })).toHaveAttribute('aria-selected', 'true');
  await expect(console_.getByLabel('Instructions')).not.toHaveValue('');
  await expect(console_.getByTestId('config-revision')).toHaveText('not edited yet');
  // Moving between sections keeps the URL in step, so a section can be linked to.
  await console_.getByRole('tab', { name: 'Powers' }).click();
  await expect(page).toHaveURL(new RegExp(`${coinUrl}/console\\?section=powers$`));
  expect(await console_.getByRole('switch').count()).toBe(7);
  await console_.getByTestId('back-to-coin').click();
  await expect(page).toHaveURL(new RegExp(`${coinUrl}$`));
  await expect(page.getByTestId('open-console')).toBeVisible();
});

test('at 375px the console button sits under the price and Trade row, full width (mock mode)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fakeInjectedWallet(page);
  await page.goto('/');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
  const open = page.getByTestId('open-console');
  const trade = page.locator('main header a[href="#trade"]');
  const [tradeBox, openBox] = [await trade.boundingBox(), await open.boundingBox()];
  expect(openBox!.y).toBeGreaterThan(tradeBox!.y + tradeBox!.height - 1);
  expect(openBox!.width).toBeGreaterThan(300);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});

test('the console page at 375px keeps the sections as a tab strip with no horizontal scroll (mock mode)', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fakeInjectedWallet(page);
  await page.goto('/');
  const href = await page.locator('a[href^="/token/0x"]').first().getAttribute('href');
  await page.goto(`${href}/console?section=powers`);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_.getByRole('tab', { name: 'Powers' })).toHaveAttribute('aria-selected', 'true');
  expect(await console_.getByRole('switch').count()).toBe(7);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
});
