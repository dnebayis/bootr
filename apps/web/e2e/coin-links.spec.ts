import { expect, test } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

test("the creator sets the coin's X account from the coin page and the links row shows it (mock mode)", async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto('/');
  // Paper Hands Club carries no links; everyone is the creator in mock mode, so the console shows.
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'Paper Hands Club' }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  await expect(page.getByTestId('token-links')).toHaveCount(0);

  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  const form = console_.getByTestId('coin-links-form');
  await expect(form).toBeVisible();
  const x = form.getByLabel('X', { exact: true });
  await expect(x).toHaveValue('');
  const save = form.getByRole('button', { name: 'Save links' });
  await expect(save).toBeDisabled();

  // Inline validation: a Telegram link off t.me is named, and the Save stays off until it is fixed.
  const telegram = form.getByLabel('Telegram');
  await telegram.fill('https://telegram.org/bootr');
  await expect(form.getByText('Telegram must be an https://t.me/ link.')).toBeVisible();
  await expect(telegram).toHaveAttribute('aria-invalid', 'true');
  await x.fill('@bootrfun');
  await expect(save).toBeDisabled();
  await telegram.fill('');
  await expect(form.getByText('Telegram must be an https://t.me/ link.')).toHaveCount(0);
  await expect(save).toBeEnabled();

  const saved = page.waitForResponse((r) => /\/api\/agent\/0x[0-9a-f]{40}\/links$/.test(r.url()) && r.request().method() === 'PUT');
  await save.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ website: null, x: 'https://x.com/bootrfun', telegram: null, discord: null });
  await expect(page.getByText(/Links updated/)).toBeVisible();

  // The links row appears at once with the project's X account; the agent's own handle stays on its own line.
  const link = page.getByTestId('token-links').getByRole('link', { name: 'X' });
  await expect(link).toHaveAttribute('href', 'https://x.com/bootrfun');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(page.getByRole('link', { name: '@phc_agent' })).toBeVisible();
  // The form is prefilled from the saved links and has nothing to save.
  await expect(x).toHaveValue('@bootrfun');
  await expect(save).toBeDisabled();
});
