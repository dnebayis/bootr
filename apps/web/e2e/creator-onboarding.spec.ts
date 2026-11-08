import { expect, test, type Page } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/** The coin page of a named mock coin; everyone is the creator in mock mode. */
async function openCoin(page: Page, name: string) {
  await fakeInjectedWallet(page);
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: name }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  return console_;
}

test('a brand-new agent gets the first-steps card and a hint per tab; the buttons open the right place; Hide sticks (mock mode)', async ({ page }) => {
  // Night Shift is the mock's fresh coin: no X account, no instructions, no fuel, no gas.
  const console_ = await openCoin(page, 'Night Shift');
  await expect(page.getByTestId('agent-status')).toContainText('waiting for an X account');
  await expect(page.getByTestId('creator-x-banner')).toBeVisible();

  const card = console_.getByTestId('onboarding-checklist');
  await expect(card).toBeVisible();
  await expect(card.getByTestId('onboarding-progress')).toHaveText('0/4');
  const items = card.getByTestId('onboarding-item');
  await expect(items).toHaveCount(4);
  for (const key of ['x', 'instructions', 'fuel', 'gas']) await expect(card.locator(`[data-key="${key}"]`)).toHaveAttribute('data-done', 'false');
  await expect(card).not.toContainText(/x402|session key|kernel|supervisor/i);

  // A console nobody has edited says in one line what each tab is for.
  await expect(console_.getByTestId('section-hint-mind')).toBeVisible();
  await expect(console_.getByLabel('Instructions')).toHaveValue('');

  // "Write" opens Mind and puts the cursor in the instructions; "Add gas" opens Fuel.
  await card.locator('[data-key="gas"]').getByRole('button', { name: 'Add gas' }).click();
  await expect(console_.getByRole('tab', { name: 'Fuel' })).toHaveAttribute('aria-selected', 'true');
  await expect(console_.getByTestId('section-hint-fuel')).toBeVisible();
  await expect(console_.getByTestId('gas-notice')).toContainText('Out of gas');
  await card.locator('[data-key="instructions"]').getByRole('button', { name: 'Write' }).click();
  await expect(console_.getByRole('tab', { name: 'Mind' })).toHaveAttribute('aria-selected', 'true');
  await expect(console_.getByLabel('Instructions')).toBeFocused();

  // Writing and saving the instructions ticks that step off, and the hints go with the first edit.
  await console_.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins. Dated facts only.');
  await console_.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Agent updated/)).toBeVisible();
  await expect(card.locator('[data-key="instructions"]')).toHaveAttribute('data-done', 'true');
  await expect(card.getByTestId('onboarding-progress')).toHaveText('1/4');
  await expect(console_.getByTestId('section-hint-mind')).toHaveCount(0);

  // Hide puts the card away for this viewer, and it stays away after a reload.
  await card.getByTestId('onboarding-hide').click();
  await expect(console_.getByTestId('onboarding-checklist')).toHaveCount(0);
  await page.reload();
  await expect(page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) })).toBeVisible();
  await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);
});

test('an agent with everything in place shows no first-steps card (mock mode)', async ({ page }) => {
  const console_ = await openCoin(page, 'Ledger Owl');
  await expect(console_.getByLabel('Instructions')).not.toHaveValue('');
  await expect(console_.getByTestId('onboarding-checklist')).toHaveCount(0);
});
