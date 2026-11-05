import { expect, test, type Page } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/** The console of a coin whose agent is awake: everyone is the creator in mock mode. */
async function openConsole(page: Page) {
  await fakeInjectedWallet(page);
  await page.goto('/?tab=active');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  return console_;
}

const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const fuelBody = (thoughts: number, chargedMicroUsdc: string, firstAgoMs = 2 * 86_400_000) => ({
  days: 7,
  since: new Date(Date.now() - 7 * 86_400_000).toISOString(),
  firstAt: new Date(Date.now() - firstAgoMs).toISOString(),
  byModel: [{ model: 'anthropic/claude-sonnet-4.6', thoughts, chargedMicroUsdc }],
});

test('the creator console says how long the fuel lasts (mock mode)', async ({ page }) => {
  const console_ = await openConsole(page);
  await expect(console_.getByTestId('fuel-runway')).toHaveText(/^(About \d+ (hour|day)s? of fuel at the recent rate|More than 60 days of fuel at the recent rate|Less than an hour of fuel at the recent rate)\.$/);
  await expect(console_.getByTestId('fuel-warning-ops_failing')).toHaveCount(0);
});

test('the creator console warns when fuel runs low and treasury operations keep failing (mock mode)', async ({ page }) => {
  // $10 over 20 thoughts is $0.50 each; a mock agent holds at most $4.50 ready to spend, so fewer than 24 thoughts are covered.
  await page.route('**/api/agent/*/fuel*', (route) => route.fulfill(json(fuelBody(20, '10000000'))));
  const at = (ago: number) => new Date(Date.now() - ago).toISOString();
  await page.route('**/api/agent/*/activity*', (route) =>
    route.fulfill(json({ items: [{ at: at(60_000), kind: 'claim', summary: 'Fee claim failed' }, { at: at(3_600_000), kind: 'fuel', summary: 'Fuel top-up failed' }, { at: at(7_200_000), kind: 'claim', summary: 'Fee claim failed' }] })),
  );
  const console_ = await openConsole(page);
  const outlook = console_.getByTestId('fuel-outlook');
  await expect(outlook.getByTestId('fuel-warning-low_fuel')).toContainText(/(Low on fuel: enough for about \d+ more thoughts? right now|Out of fuel to think with right now)/);
  await expect(outlook.getByTestId('fuel-warning-ops_failing')).toHaveText('The last 3 fee claims, swaps or top-ups failed, so new fuel may not arrive.');
  await expect(outlook).not.toContainText(/spender|kernel|x402|EOA/i);
});

test('the creator console says nothing about the runway on thin data (mock mode)', async ({ page }) => {
  await page.route('**/api/agent/*/fuel*', (route) => route.fulfill(json(fuelBody(3, '270000'))));
  const console_ = await openConsole(page);
  await expect(console_.getByTestId('config-revision')).toBeVisible();
  await expect(console_.getByTestId('fuel-by-model')).toBeVisible();
  await expect(console_.getByTestId('fuel-runway')).toHaveCount(0);
  await expect(console_.getByTestId('fuel-warning-low_fuel')).toHaveCount(0);
});
