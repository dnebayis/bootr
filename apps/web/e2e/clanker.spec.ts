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

test('a wallet whose coins all went through Clanker sees the Clanker fee panel alone (mock mode)', async ({ page }) => {
  // The creator of $BWATCH, the mock Clanker coin, has launched nothing else: its public page link carries the address.
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'Basewatch' }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  const creator = (await page.locator('a[href^="/u/0x"]').first().getAttribute('href'))!.slice('/u/'.length);
  await fakeInjectedWallet(page, creator);
  await page.goto('/profile');
  await connectBrowserWallet(page);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees, Clanker coins' }) });
  await expect(panel).toBeVisible();
  await expect(panel).toContainText('$BWATCH');
  // No RWAGMI-path coin, so no RWAGMI panel telling the wallet to launch a coin.
  await expect(page.getByRole('heading', { name: 'Creator fees', exact: true })).toHaveCount(0);
  await expect(page.getByText('Launch a coin to earn the creator share of its trading fees.')).toHaveCount(0);
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
  // Both Clanker columns (v4 and v5) are listed on clanker.world too.
  await expect(page.getByText('bootr.fun and clanker.world')).toHaveCount(2);
  await expect(page.getByRole('columnheader', { name: 'Through Clanker v5' })).toBeVisible();
  const full = await (await request.get('/llms-full.txt')).text();
  expect(full).toContain('Launch through RWAGMI or Clanker');
  expect(full).toContain('Through Clanker v5');
  expect(full).toContain('ends in `cccc`');
  expect(full.toLowerCase()).not.toContain('console');
});

/**
 * Clanker v5 (docs/design/clanker-v5-migration.md). The e2e build has no v5 launcher configured, so the form shows the v4
 * card (tests above); mock mode's `/launch?clanker=v5` shows it as a deployment with NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS
 * set does. The mock v5 coin is $GAS.
 */
test('with the v5 launcher set, the Clanker card shows the tax and Clanker’s opening cap, and the launch mines a cccc address', async ({ page }) => {
  await page.goto('/launch?clanker=v5');
  const choice = page.getByTestId('launch-through');
  const clanker = page.getByRole('radio', { name: /^Clanker / });
  await expect(choice).toContainText('A tax on every buy and sell that you set, 1% to 5% (1.5% by default)');
  await expect(choice).toContainText('Opens at about 1.9 ETH of market cap');
  await expect(choice).toContainText('1 billion coins, paired with ETH or USDC. Listed on bootr.fun and clanker.world.');
  // v4's terms are not offered once v5 is the Clanker path.
  await expect(choice).not.toContainText('Clanker adds 20% on top');

  await page.locator('label', { has: clanker }).click();
  const summary = page.getByTestId('launch-summary');
  await expect(summary).toContainText('Launch throughClanker');
  await expect(summary).toContainText('Trading tax1.50%');
  await expect(summary).toContainText('0.65% of volume');
  await expect(summary.getByTestId('fee-sentence')).toContainText('A 1.50% tax on every buy and sell: Clanker keeps its share');

  await page.getByLabel('Name').fill('Gas Meter');
  await page.getByLabel('Symbol').fill('GMTR');
  await page.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins.');
  await page.getByLabel('Launch without an X account; I will connect one later from the coin page.').check();
  const drafted = page.waitForRequest((r) => r.url().endsWith('/api/launch/draft') && r.method() === 'POST');
  await page.locator('#image-file').setInputFiles({ name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('image-status')).toContainText('ipfs://');
  const started = Date.now();
  await page.getByTestId('launch-submit').click();
  expect((await drafted).postDataJSON()).toMatchObject({ launchThrough: 'clanker-v5', tokenSettings: { pairedAsset: 'ETH', buyTaxPct: 1.5, sellTaxPct: 1.5, sniperTax: true, editableMetadata: true } });
  // The salt is mined in the page before the (mock) launch: the coin's address ends in cccc, as Clanker v5 requires.
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{36}cccc$/i, { timeout: 30_000 });
  console.info(`[clanker-v5 e2e] launch with salt mining took ${Date.now() - started} ms`);
  // A coin seconds old: buys wait out Clanker's 20-second anti-snipe window instead of paying up to 99%.
  // (No wallet is connected here, so the panel's button is Connect; the notice is what holds the buy.)
  await expect(page.getByTestId('trade-opens-in')).toContainText(/Trading opens in \d+ s/);
  // The window passes on the clock: the notice goes once the coin is 20 seconds old.
  await expect(page.getByTestId('trade-opens-in')).toHaveCount(0, { timeout: 25_000 });
});

test('the mock Clanker v5 coin shows the tax as its fee, trades, and claims ETH from Clanker’s fee escrow', async ({ page }) => {
  await page.goto('/?path=clanker-v5');
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'Gas Station' }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  await expect(page.getByRole('heading', { name: 'Gas Station' })).toBeVisible();
  await expect(page.getByTestId('token-source')).toHaveText(/launched through clanker/);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Locked fee split' }) });
  await expect(panel.getByTestId('fee-sentence')).toContainText('A 1.50% tax on every trade: Clanker keeps its share (0.50%), the rest goes to the recipients above. Fees arrive as ETH');
  await expect(panel).toContainText('locked in the coin’s Clanker pool');
  // The trade panel: the tax is the fee, and the coin trades (it launched long ago).
  await expect(page.getByTestId('trade-panel')).toContainText('Trading tax');
  await expect(page.getByTestId('trade-fee')).toContainText('1.50%');
  await expect(page.getByTestId('trade-opens-in')).toHaveCount(0);
  // The creator's line: ETH from Clanker's fee escrow, claimed with claimFor(creator, 0x0).
  const line = page.getByTestId('clanker-fee-line');
  await expect(line).toHaveAttribute('data-claim-via', 'fee-escrow');
  await expect(line.getByTestId('clanker-fee-amount')).toContainText(/^0\.\d+ ETH$/);
  await expect(line).toContainText('from Clanker’s fee escrow');
  await line.getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText('Mock: Claim $GAS fees sent')).toBeVisible();
});

test('profile and console keep a separate Clanker v5 panel that pays ETH from the fee escrow (mock mode)', async ({ page, context, baseURL }) => {
  await fakeInjectedWallet(page);
  await page.goto('/profile');
  await connectBrowserWallet(page);
  const v5 = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees, Clanker v5 coins' }) });
  await expect(v5).toBeVisible();
  await expect(v5.getByTestId('clanker-v5-creator-fees')).toHaveAttribute('data-claim-via', 'fee-escrow');
  await expect(v5.getByTestId('clanker-v5-creator-eth')).toContainText(/^0\.\d+ ETH$/);
  await expect(v5).toContainText('$GAS');
  await expect(v5).toContainText('1.50% tax, Clanker’s share inside it');
  // The v4 panel keeps v4 coins only.
  const v4 = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees, Clanker coins' }) });
  await expect(v4).not.toContainText('$GAS');

  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600, s: newSessionId() });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  await page.goto(`/console-${SLUG}`);
  const fees = page.locator('section', { has: page.getByRole('heading', { name: 'Platform fees' }) });
  const console5 = fees.getByTestId('platform-fees-clanker-v5');
  await expect(console5).toContainText('Through Clanker v5: Clanker’s fee escrow');
  await expect(console5).toContainText('claimFor(treasury, 0x0)');
  await expect(console5).toContainText('$GAS');
  await expect(console5).toContainText('1.50% tax per trade, Clanker’s 0.50% inside it');
  await expect(console5.getByTestId('platform-eth-clanker-v5')).toContainText(/ETH/);
  await expect(console5.getByRole('button', { name: 'Claim on Clanker v5' })).toBeVisible();
});
