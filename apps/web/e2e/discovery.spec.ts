import { expect, test } from '@playwright/test';

const CREATOR = '0x1111111111111111111111111111111111111111';

test('a leaderboard names its period and read time, and the link keeps both', async ({ page }) => {
  await page.goto('/leaderboards?board=volume&period=7d');
  await expect(page.getByRole('heading', { name: 'Leaderboards' })).toBeVisible();
  const period = page.getByRole('navigation', { name: 'Period' });
  await expect(period.getByRole('link', { name: '7 d' })).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('board-read-time')).toContainText(/Read \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/);
  await expect(page.locator('tbody tr').first()).toBeVisible();
});

test('a board with one period offers no switch, and an unknown count is left out, not zero', async ({ page }) => {
  await page.goto('/leaderboards?board=agent-activity');
  await expect(page.getByRole('navigation', { name: 'Period' })).toHaveCount(0);
  await expect(page.getByTestId('board-read-time')).toContainText('with no recent report, left out');
});

test('the Trending tab says what it measures', async ({ page }) => {
  await page.goto('/?tab=trending');
  await expect(page.getByTestId('trending-note')).toContainText('different wallets');
  await expect(page.getByTestId('trending-note')).toContainText('not quality or what the price does next');
});

test('filters come back from a shared link, and the tabs keep them', async ({ page }) => {
  await page.goto(`/?creator=${CREATOR}&path=clanker&sort=holders`);
  await expect(page.getByTestId('token-filters')).toBeVisible();
  await expect(page.locator('#filter-creator')).toHaveValue(CREATOR);
  await page.getByRole('navigation', { name: 'Token lists' }).getByRole('link', { name: 'Market cap' }).click();
  await expect(page).toHaveURL(new RegExp(`tab=mcap&creator=${CREATOR}&path=clanker&sort=holders`));
});

test('a creator page needs no wallet, and the badge is only there with an account behind it', async ({ page }) => {
  await page.goto(`/u/${CREATOR}`);
  await expect(page.getByRole('heading', { name: 'Creator' })).toBeVisible();
  const rows = page.locator('main li');
  await expect(rows.first()).toBeVisible();
  // In the mock data the coin with the handle has the badge and the one without has none.
  const noAccount = rows.filter({ hasNot: page.locator('a[href^="/agent/"]', { hasText: '@' }) }).first();
  await expect(noAccount).toBeVisible();
  await expect(noAccount.getByTestId('x-linked')).toHaveCount(0);
  await expect(rows.filter({ has: page.locator('a[href^="/agent/"]', { hasText: '@' }) }).first().getByTestId('x-linked')).toBeVisible();
});

test('the creator changes the image shown on Bootr, and the page says others may keep the original', async ({ page }) => {
  await page.goto('/');
  await page.locator('main a[href^="/token/0x"]').first().click();
  // The coin's image is on the creator console's Look tab.
  await page.getByRole('tab', { name: 'Look' }).click();
  const form = page.getByTestId('coin-image-form');
  await expect(form).toContainText('wallets and other sites may still show the original');
  await expect(form.getByRole('button', { name: 'Save image' })).toBeDisabled();
  await form.locator('input[type=file]').setInputFiles({
    name: 'coin.png',
    mimeType: 'image/png',
    buffer: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]),
  });
  await form.getByRole('button', { name: 'Save image' }).click();
  await expect(form.getByRole('button', { name: 'Use the original image' })).toBeVisible();
  await expect(page.locator('main header img').first()).toHaveAttribute('src', /^data:image\/png/);
  await form.getByRole('button', { name: 'Use the original image' }).click();
  await expect(form.getByRole('button', { name: 'Use the original image' })).toHaveCount(0);
});
