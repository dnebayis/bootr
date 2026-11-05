import { expect, test } from '@playwright/test';
import { ADMIN_COOKIE, newSessionId, signToken } from '../lib/server/session-core';
import { connectBrowserWallet, fakeInjectedWallet } from './fake-wallet';

const SLUG = process.env.ADMIN_CONSOLE_SLUG!;
const ADMIN = process.env.ADMIN_ADDRESSES!.split(',')[0]!;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * Launch through RWAGMI or Clanker (docs/design/clanker-launch.md, task D). Mock mode offers both paths; a Clanker coin
 * shows its source label, the whole-fee split with Clanker's 20% on top, and still links to the swap aggregator from its trade panel.
 */
test('launch form offers RWAGMI and Clanker; the summary and fee preview follow the choice, the coin page shows the source', async ({ page }) => {
  await page.goto('/launch');
  const choice = page.getByTestId('launch-through');
  // Page-rooted, so they can serve as `has:` inside the card label (an inner locator is re-rooted on the outer one).
  const bootr = page.getByRole('radio', { name: /^RWAGMI / });
  const clanker = page.getByRole('radio', { name: /^Clanker / });
  await expect(bootr).toBeChecked();
  await expect(choice).toContainText('Opens at about 2.7 ETH of market cap');
  await expect(choice).toContainText('Opens at about 10 ETH of market cap');
  await expect(choice).toContainText('Listed on bootr.fun and clanker.world.');

  const summary = page.getByTestId('launch-summary');
  await expect(summary).toContainText('Launch throughRWAGMI');
  await expect(summary).toContainText('0.585% of volume');
  await expect(summary).toContainText('of the 90% share');
  await expect(summary.getByTestId('fee-sentence')).toContainText('Swappers pay 1.00% in total: 0.90% goes to the recipients above and 0.10% to RWAGMI');

  await page.locator('label', { has: clanker }).click();
  await expect(clanker).toBeChecked();
  await expect(summary).toContainText('Launch throughClanker');
  await expect(summary).toContainText('0.65% of volume');
  await expect(summary).toContainText('20% on top for Clanker (1.20% in total)');
  await expect(summary.getByTestId('fee-sentence')).toContainText('plus 20% on top for Clanker (0.20%): a trader pays 1.20% in total');
  await expect(summary).toContainText('Clanker');

  // A mock launch through Clanker: the draft records the choice and the coin page carries the label.
  await page.getByLabel('Name').fill('Night Watch');
  await page.getByLabel('Symbol').fill('NWATCH');
  await page.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins.');
  await page.getByLabel('Launch without an X account; I will connect one later from the coin page.').check();
  const drafted = page.waitForRequest((r) => r.url().endsWith('/api/launch/draft') && r.method() === 'POST');
  await page.locator('#image-file').setInputFiles({ name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('image-status')).toContainText('ipfs://');
  const launch = page.getByRole('button', { name: 'Launch', exact: true });
  await expect(launch).toBeEnabled();
  await launch.click();
  expect((await drafted).postDataJSON()).toMatchObject({ launchThrough: 'clanker' });
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);

  const label = page.getByTestId('token-source');
  await expect(label).toHaveText(/launched through clanker/);
  await expect(label).toHaveAttribute('href', /^https:\/\/clanker\.world\/clanker\/0x[0-9a-fA-F]{40}$/);
  // Scoped to the coin page's panel: the launch summary stays mounted for a moment during the client navigation.
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Locked fee split' }) });
  await expect(panel.getByTestId('fee-sentence')).toContainText('a trader pays 1.20% in total');
  await expect(panel.getByText('locked in Clanker’s LP locker')).toBeVisible();
  await expect(page.getByRole('link', { name: /Swap on another site/ })).toHaveAttribute('href', /^https:\/\/(app\.uniswap\.org|swap\.defillama\.com)\//);
});

test('the mock Clanker coin shows its label, the whole-fee split and the swap link; a Bootr coin shows none of it', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'BWATCH' }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  await expect(page.getByRole('heading', { name: 'Basewatch' })).toBeVisible();
  await expect(page.getByTestId('token-source')).toHaveText(/launched through clanker/);
  await expect(page.getByRole('heading', { name: 'Locked fee split' })).toBeVisible();
  await expect(page.getByTestId('fee-sentence')).toContainText('The swap fee is 1.00%, all of it to the recipients above, plus 20% on top for Clanker (0.20%)');
  await expect(page.getByText('Clanker', { exact: true })).toBeVisible(); // the legend's launcher entry
  await expect(page.getByRole('link', { name: /Swap on another site/ })).toBeVisible();
  // The creator (everyone in mock mode) gets one line with the WETH waiting in Clanker's fee locker and the claim.
  const line = page.getByTestId('clanker-fee-line');
  await expect(line).toContainText('Your claimable fees:');
  await expect(line.getByTestId('clanker-fee-amount')).toContainText(/^0\.\d+ WETH$/);
  await expect(line.getByRole('link', { name: 'Profile' })).toHaveAttribute('href', '/profile');
  await line.getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText('Mock: Claim $BWATCH fees sent')).toBeVisible();

  await page.goto('/');
  const first = page.locator('a[href^="/token/0x"]').first();
  await page.goto((await first.getAttribute('href'))!);
  await expect(page.getByRole('heading', { name: 'Locked fee split' })).toBeVisible();
  await expect(page.getByTestId('token-source')).toHaveCount(0);
  await expect(page.getByTestId('fee-sentence')).toContainText('0.10% to RWAGMI, the launcher');
  await expect(page.getByTestId('clanker-fee-line')).toHaveCount(0);
});

test('profile shows the creator fees of Clanker coins with one claim for all of them (mock mode)', async ({ page }) => {
  // Mock mode gives a freshly connected wallet a few demo coins, the Clanker one ($BWATCH) among them.
  await fakeInjectedWallet(page);
  await page.goto('/profile');
  await connectBrowserWallet(page);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees, Clanker coins' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('clanker-creator-weth')).toContainText(/^0\.\d+ WETH$/);
  await expect(panel).toContainText('$BWATCH');
  await expect(panel.getByRole('columnheader', { name: 'Launched' })).toBeVisible();
  await expect(panel.getByRole('cell', { name: /\b20\d\d\b/ }).first()).toBeVisible();
  await expect(panel).toContainText('1.00% fee, plus 20% on top for Clanker');
  await expect(panel).toContainText('arrives as WETH in Clanker’s fee locker. Claim sends it to your wallet.');
  // The RWAGMI panel keeps the Bootr coins only.
  const rwagmi = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees', exact: true }) });
  await expect(rwagmi).toBeVisible();
  await expect(rwagmi).not.toContainText('$BWATCH');
  const claim = panel.getByRole('button', { name: 'Claim', exact: true });
  await expect(claim).toBeEnabled();
  await claim.click();
  await expect(page.getByText('Mock: Claim Clanker fees sent')).toBeVisible();
});

test('the admin fee panel lists platform fees per source with the Clanker claim instructions', async ({ page, context, baseURL }) => {
  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600, s: newSessionId() });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  await page.goto(`/console-${SLUG}`);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Platform fees' }) });
  await expect(panel).toContainText('Through RWAGMI: RWAGMI’s locker');
  const clanker = panel.getByTestId('platform-fees-clanker');
  await expect(clanker).toContainText('Through Clanker: Clanker’s fee locker');
  await expect(clanker).toContainText('claim(treasury, WETH)');
  await expect(clanker).toContainText('always pays that wallet, whoever sends it');
  await expect(clanker).toContainText('$BWATCH');
  await expect(clanker).toContainText('1.00% fee, plus 20% on top for Clanker: 1.20% per trade');
  await expect(clanker.getByTestId('platform-weth-clanker')).toContainText(/WETH/);
  await expect(clanker.getByRole('button', { name: 'Claim on Clanker' })).toBeVisible();
});

test('docs explain the two launch paths without naming anything private', async ({ page, request }) => {
  await page.goto('/docs/launch');
  await expect(page.getByRole('heading', { name: 'Launch through RWAGMI or Clanker' })).toBeVisible();
  await expect(page.getByText('bootr.fun and clanker.world')).toBeVisible();
  const full = await (await request.get('/llms-full.txt')).text();
  expect(full).toContain('Launch through RWAGMI or Clanker');
  expect(full.toLowerCase()).not.toContain('console');
});
