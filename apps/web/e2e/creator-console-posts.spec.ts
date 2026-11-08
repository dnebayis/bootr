import { expect, test, type Page } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/** The console of a coin in mock mode, where everyone is the creator and nothing is signed. */
async function openConsole(page: Page) {
  await fakeInjectedWallet(page);
  await page.goto('/?tab=active');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  return console_;
}

test('posts per day: one control sets the budget, the note explains the cadence and the fuel, and a save records it', async ({ page }) => {
  const console_ = await openConsole(page);
  const block = console_.getByTestId('posts-per-day');
  const slider = block.locator('#console-posts-per-day');
  await expect(slider).toHaveValue('24');
  await expect(slider).toHaveAttribute('min', '2');
  await expect(slider).toHaveAttribute('max', '48');
  await expect(block.getByTestId('posts-per-day-value')).toHaveText(/24 a day · every 2 h/);
  const note = block.getByTestId('posts-per-day-note');
  await expect(note).toContainText('Original posts and replies together, over a rolling day.');
  await expect(note).toContainText('about every 2 h');
  await expect(note).toContainText(/Roughly \$[\d.]+ a day in fuel/);
  await expect(note).not.toContainText(/sender|supervisor|quota/i);
  // The cadence select is gone: the budget is the one pacing control.
  await expect(console_.locator('#console-cadence')).toHaveCount(0);

  await slider.fill('12');
  await expect(block.getByTestId('posts-per-day-value')).toHaveText(/12 a day · every 4 h/);
  await expect(note).toContainText('about every 4 h');
  await slider.fill('2');
  await expect(block.getByTestId('posts-per-day-value')).toHaveText(/2 a day · once a day/);

  await slider.fill('12');
  await console_.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/Agent updated/)).toBeVisible();
  await expect(console_.getByTestId('config-revision')).toHaveText('edited once');
  await expect(slider).toHaveValue('12');
  await expect(block.getByTestId('posts-per-day-value')).toHaveText(/12 a day · every 4 h/);
  // The tape says what changed.
  await expect(page.getByText(/changed posts per day, cadence/)).toBeVisible();
});
