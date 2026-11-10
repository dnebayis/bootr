import { expect, test, type Page } from '@playwright/test';
import { SiweMessage } from 'siwe';
import { decodeFunctionData } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { clankerLauncherV5Abi } from '../lib/abi/clankerLauncherV5.abi';
import { connectBrowserWallet, fakeInjectedWallet } from './fake-wallet';

/**
 * Clanker v5 token settings (docs/design/clanker-v5-token-settings.md). The e2e build has no v5 launcher, so the form
 * is opened as `/launch?clanker=v5` (mock mode's stand-in for NEXT_PUBLIC_CLANKER_V5_LAUNCHER_ADDRESS). The mock
 * USDC-paired settings coin is $SIGMA. clanker.world is never called from here: `/api/quote-market` is stubbed.
 */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OTHER = '0x2222222222222222222222222222222222222222';

const market = (asset: string, source: 'clanker.world' | 'bootr') => ({
  asset,
  quote: asset === 'USDC' ? '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' : '0x0000000000000000000000000000000000000000',
  decimals: asset === 'USDC' ? 6 : 18,
  priceUsd: asset === 'USDC' ? (source === 'clanker.world' ? 0.9998 : 1) : source === 'clanker.world' ? 2092.03 : null,
  liquidityUsd: source === 'clanker.world' && asset === 'USDC' ? 74_914_261 : null,
  startTick: asset === 'USDC' ? -400_600 : -201_000,
  startTickSource: 'fallback',
  openingCap: asset === 'USDC' ? 4008.2 : 1.8669,
  openingCapUsd: asset === 'USDC' ? 4008.2 : source === 'clanker.world' ? 3905.6 : null,
  source,
  readAt: 1_794_310_079,
});

async function stubMarket(page: Page, mode: 'ok' | 'fallback' | 'down') {
  await page.route('**/api/quote-market**', async (route) => {
    const asset = new URL(route.request().url()).searchParams.get('asset') ?? 'ETH';
    if (mode === 'down') return route.fulfill({ status: 502, contentType: 'application/json', body: '{"error":"down"}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify(market(asset, mode === 'ok' ? 'clanker.world' : 'bootr')) });
  });
}

async function openV5Form(page: Page) {
  await page.goto('/launch?clanker=v5');
  await page.locator('label', { has: page.getByRole('radio', { name: /^Clanker / }) }).click();
  await expect(page.getByTestId('token-settings')).toBeVisible();
}

test('token settings: tax bounds, the allocation with locked agent and platform shares, the per-trade line (mock mode)', async ({ page }) => {
  await stubMarket(page, 'ok');
  await openV5Form(page);
  const tax = page.getByTestId('settings-tax');
  await expect(page.getByLabel('Buy tax')).toHaveValue('1.5');
  await expect(page.getByLabel('Sell tax')).toHaveValue('1.5');
  await expect(tax.getByTestId('allocation-agent')).toContainText('5%');
  await expect(tax.getByTestId('allocation-platform')).toContainText('30%');
  await expect(tax.getByTestId('allocation-creator')).toContainText('65%');
  await expect(tax.getByTestId('tax-allocation-total')).toHaveText('Allocated: 100/100%');
  await expect(tax.getByTestId('per-trade')).toHaveText('Per trade: 0.5% Clanker · 0.05% agent · 0.3% Bootr · 0.65% creator funds');
  // Locked shares have no field.
  await expect(tax.getByTestId('allocation-agent').locator('input')).toHaveCount(0);
  await expect(page.getByRole('switch', { name: 'Sniper tax' })).toBeChecked();
  await expect(tax).toContainText('Falls from 99% to the tax in 20 seconds; the surcharge goes to Clanker.');
  await expect(page.getByRole('switch', { name: 'Editable metadata' })).toBeChecked();
  await expect(tax).toContainText('Only you can change the image and metadata after launch');

  // Out of bounds, on either side.
  await page.getByLabel('Buy tax').fill('6');
  await expect(page.getByTestId('settings-problems')).toContainText('Buy tax must be 1% to 5%');
  await expect(page.getByLabel('Buy tax')).toHaveAttribute('aria-invalid', 'true');
  await page.getByLabel('Buy tax').fill('0.5');
  await expect(page.getByTestId('settings-problems')).toContainText('Buy tax must be 1% to 5%');
  await page.getByLabel('Buy tax').fill('2');
  await page.getByLabel('Sell tax').fill('3');
  await expect(page.getByTestId('settings-problems')).toHaveCount(0);
  await expect(tax.getByTestId('per-trade')).toContainText('Per buy: 0.5% Clanker · 0.075% agent · 0.45% Bootr · 0.975% creator funds');
  await expect(tax.getByTestId('per-trade')).toContainText('Per sell: 0.5% Clanker · 0.125% agent · 0.75% Bootr · 1.625% creator funds');
  await expect(page.getByTestId('launch-summary')).toContainText('Trading tax2.00% buy · 3.00% sell');

  // Burn and dividends come out of the creator's 65%, never more.
  await page.getByLabel('Holder dividends').fill('30');
  await page.getByLabel('Burn allocation').fill('40');
  await expect(tax.getByTestId('tax-allocation-total')).toHaveText('Over by 5%');
  await expect(page.getByTestId('settings-problems')).toContainText('together they can take at most 65%');
  await page.getByLabel('Burn allocation').fill('15');
  await expect(tax.getByTestId('allocation-creator')).toContainText('20%');
  await expect(page.getByLabel('Minimum holding')).toHaveValue('10000');
  await page.getByLabel('Minimum holding').fill('500');
  await expect(page.getByTestId('settings-problems')).toContainText('minDividendHolding must be a whole number of coins from 10,000');
  await page.getByLabel('Minimum holding').fill('25000');
  await expect(page.getByTestId('settings-problems')).toHaveCount(0);
  await expect(tax.getByTestId('per-trade')).toContainText('holder dividends');
  await expect(tax.getByTestId('per-trade')).toContainText('burn');
});

test('token settings: the creator’s row plus up to four more, adding up to 100% (mock mode)', async ({ page }) => {
  await stubMarket(page, 'ok');
  await openV5Form(page);
  const rewards = page.getByTestId('settings-rewards');
  await expect(rewards.getByTestId('reward-row-0')).toContainText('Admin (you)');
  await expect(page.getByLabel('Admin (you)')).toHaveAttribute('placeholder', 'Your wallet');
  await expect(rewards.getByTestId('rewards-allocated')).toHaveText('Allocated: 100/100%');
  // A custom address on the creator's own row is allowed.
  await page.locator('#reward-recipient-0').fill(OTHER);
  await expect(page.getByTestId('settings-problems')).toHaveCount(0);

  for (let i = 1; i <= 4; i++) await rewards.getByRole('button', { name: '+ Add recipient' }).click();
  await expect(rewards.getByRole('button', { name: '+ Add recipient' })).toHaveCount(0);
  await expect(rewards).toContainText('Up to 4 recipients beside yours.');
  await expect(page.getByTestId('settings-problems')).toContainText('Row 2: the recipient must be a wallet address.');

  await page.locator('#reward-pct-0').fill('60');
  for (let i = 1; i <= 4; i++) {
    await page.locator(`#reward-recipient-${i}`).fill(`0x${String(i).repeat(40)}`);
    await page.locator(`#reward-pct-${i}`).fill('10');
  }
  await expect(rewards.getByTestId('rewards-allocated')).toHaveText('Allocated: 100/100%');
  await expect(page.getByTestId('settings-problems')).toHaveCount(0);
  await page.locator('#reward-pct-4').fill('5');
  await expect(rewards.getByTestId('rewards-allocated')).toHaveText('Allocated: 95/100%');
  await expect(page.getByTestId('settings-problems')).toContainText('Allocated: 95/100%. The rows must add up to exactly 100%.');
  await rewards.getByRole('button', { name: 'Remove recipient 5' }).click();
  await page.locator('#reward-pct-0').fill('70');
  await expect(rewards.getByTestId('rewards-allocated')).toHaveText('Allocated: 100/100%');

  // All of the creator's share to burn and dividends: nothing left for rows.
  await page.getByLabel('Burn allocation').fill('35');
  await page.getByLabel('Holder dividends').fill('30');
  await expect(rewards).toContainText('nothing for reward rows');
});

test('token settings: the paired asset, Market details from clanker.world, and the launch carries everything (mock mode)', async ({ page }) => {
  await stubMarket(page, 'ok');
  await openV5Form(page);
  const pool = page.getByTestId('settings-pool');
  await expect(pool.getByTestId('paired-asset')).toContainText('ETH');
  await expect(pool.getByTestId('paired-asset')).toContainText('USDC');
  const details = pool.getByTestId('market-details');
  await expect(details).toHaveAttribute('data-source', 'clanker.world');
  await expect(details.getByTestId('market-source')).toHaveText('From clanker.world');
  await expect(details.getByTestId('market-price')).toContainText('2,092');
  await expect(details.getByTestId('market-opening-cap')).toContainText('1.87 ETH');

  const asked = page.waitForRequest((r) => r.url().includes('/api/quote-market?asset=USDC'));
  await pool.locator('label', { hasText: 'USDC' }).first().click();
  await asked;
  await expect(pool).toContainText('Fees arrive in USDC: the agent’s thinking is paid from them; gas still comes from you.');
  await expect(details.getByTestId('market-liquidity')).toContainText('74.9M');
  await expect(details.getByTestId('market-opening-cap')).toContainText('4,008 USDC');
  await expect(page.getByTestId('launch-summary')).toContainText('Paired assetUSDC');
  await expect(page.getByLabel('Dev buy').locator('..').locator('..')).toContainText('through USDC (two swaps)');

  await page.getByLabel('Sell tax').fill('2.5');
  await page.getByLabel('Burn allocation').fill('10');
  await page.getByRole('switch', { name: 'Sniper tax' }).click();
  await page.getByTestId('settings-rewards').getByRole('button', { name: '+ Add recipient' }).click();
  await page.locator('#reward-recipient-1').fill(OTHER);
  await page.locator('#reward-pct-1').fill('25');
  await page.locator('#reward-pct-0').fill('75');

  await page.getByLabel('Name').fill('Stable Sigma');
  await page.getByLabel('Symbol').fill('SSIG');
  await page.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins.');
  await page.getByLabel('Launch without an X account; I will connect one later from the coin page.').check();
  await page.locator('#image-file').setInputFiles({ name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('image-status')).toContainText('ipfs://');
  const drafted = page.waitForRequest((r) => r.url().endsWith('/api/launch/draft') && r.method() === 'POST');
  await page.getByTestId('launch-submit').click();
  expect((await drafted).postDataJSON()).toMatchObject({
    launchThrough: 'clanker-v5',
    tokenSettings: { pairedAsset: 'USDC', buyTaxPct: 1.5, sellTaxPct: 2.5, burnPct: 10, dividendsPct: 0, sniperTax: false, editableMetadata: true, rewards: [{ pct: 75 }, { recipient: OTHER, admin: OTHER, pct: 25 }] },
  });
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{36}cccc$/i, { timeout: 30_000 });
  const settings = page.getByTestId('v5-settings');
  await expect(settings).toContainText('Paired assetUSDC');
  await expect(settings).toContainText('1.50% · 2.50%');
  await expect(settings).toContainText('Sniper taxOff');
  await expect(page.getByTestId('v5-reward-rows')).toContainText('0x2222');
});

test('token settings: Market details falls back to Bootr’s own figures, and says so (mock mode)', async ({ page }) => {
  await stubMarket(page, 'fallback');
  await openV5Form(page);
  const details = page.getByTestId('market-details');
  await expect(details).toHaveAttribute('data-source', 'bootr');
  await expect(details.getByTestId('market-source')).toHaveText('Bootr’s own figures: clanker.world did not answer');
  await expect(details.getByTestId('market-price')).toHaveText('—');
  await expect(details.getByTestId('market-opening-cap')).toHaveText('1.87 ETH');
  await page.getByTestId('settings-pool').locator('label', { hasText: 'USDC' }).first().click();
  await expect(details.getByTestId('market-price')).toContainText('$1');
});

test('token settings: a dead quote-market route leaves the form usable (mock mode)', async ({ page }) => {
  await stubMarket(page, 'down');
  await openV5Form(page);
  await expect(page.getByTestId('market-details')).toHaveAttribute('data-source', 'error');
  await expect(page.getByTestId('market-source')).toHaveText('Not available right now');
  await expect(page.getByTestId('settings-problems')).toHaveCount(0);
});

test('the quote-market route answers only for offered assets, from the server (mock mode)', async ({ request }) => {
  const bad = await request.get('/api/quote-market?asset=CBBTC');
  expect(bad.status()).toBe(400);
  expect(((await bad.json()) as { message: string }).message).toContain('ETH, USDC');
  const ok = await request.get('/api/quote-market?asset=USDC', { timeout: 20_000 });
  expect(ok.status()).toBe(200);
  const body = (await ok.json()) as { asset: string; source: string; openingCap: number; priceUsd: number };
  expect(body.asset).toBe('USDC');
  expect(['clanker.world', 'bootr']).toContain(body.source);
  expect(body.openingCap).toBeGreaterThan(3000);
  expect(body.priceUsd).toBeGreaterThan(0.9);
});

/** The mock USDC-paired settings coin, $SIGMA. */
async function sigma(page: Page): Promise<string> {
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'SIGMA' }).first();
  await expect(card).toBeVisible();
  return (await card.getAttribute('href'))!;
}

test('a USDC-paired v5 coin: its real split, USDC claims, and trading in USDC (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto(await sigma(page));
  await expect(page.getByRole('heading', { name: 'Sigma Desk' })).toBeVisible();
  const split = page.getByTestId('v5-split');
  await expect(split).toContainText('Buy: 2.00% tax');
  await expect(split).toContainText('Sell: 3.00% tax');
  await expect(split.getByTestId('fee-sentence')).toContainText('A 2.00% tax on buys and 3.00% on sells');
  await expect(split.getByTestId('fee-sentence')).toContainText('paid in USDC');
  const settings = page.getByTestId('v5-settings');
  await expect(settings).toContainText('Paired assetUSDC');
  await expect(settings).toContainText('Holder dividends5% of the tax pool, to wallets holding 10,000+ coins');
  await expect(settings).toContainText('Burn10% of the tax pool');
  await expect(page.getByTestId('v5-reward-rows')).toContainText('(creator)');
  await expect(page.getByTestId('coin-description')).toHaveText('Sigma Desk: an autonomous agent coin launched on Bootr.');

  // The creator's fees wait in Clanker's escrow in USDC, and the claim names USDC.
  const line = page.getByTestId('clanker-fee-line');
  await expect(line.getByTestId('clanker-fee-amount')).toContainText(/^\d+(\.\d+)? USDC$/);
  await expect(line).toContainText('v5 coins paid in USDC');
  await line.getByRole('button', { name: 'Claim' }).click();
  await expect(page.getByText('Mock: Claim $SIGMA fees sent')).toBeVisible();

  const panel = page.locator('#trade');
  await panel.getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
  await expect(panel.getByTestId('trade-balance')).toContainText('1,000 USDC');
  await expect(panel.getByTestId('trade-paired')).toContainText('This coin trades against USDC');
  await expect(panel.getByTestId('trade-fee')).toContainText('2.00%');
  await expect(panel.getByRole('button', { name: '50', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: '50', exact: true }).click();
  await expect(panel.getByTestId('trade-out')).toContainText('$SIGMA');
  await expect(panel.getByTestId('trade-fee')).toContainText('USDC');
  // Paying USDC needs the same exact approvals a sell does.
  await expect(panel.getByTestId('trade-approvals')).toContainText('for exactly this amount, then the buy');
  await panel.getByTestId('trade-submit').click();
  await expect(page.getByText(/^Bought \$SIGMA/)).toBeVisible();

  await panel.getByRole('tab', { name: 'Sell' }).click();
  await expect(panel.getByTestId('trade-fee')).toContainText('3.00%');
  await panel.getByRole('button', { name: '25%', exact: true }).click();
  await expect(panel.getByTestId('trade-out')).toContainText('USDC');
  await expect(panel.getByTestId('trade-min')).toContainText('USDC');
});

test('the creator edits a v5 coin’s on-chain image and description, then locks them after a confirmation (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  const href = await sigma(page);
  await page.goto(`${href}/console?section=look`);
  await connectBrowserWallet(page);
  const form = page.getByTestId('v5-metadata-form');
  await expect(form).toBeVisible();
  await expect(form).toHaveAttribute('data-locked', 'false');
  await expect(form.getByTestId('v5-metadata-current')).toHaveText('Sigma Desk: an autonomous agent coin launched on Bootr.');
  const save = form.getByRole('button', { name: 'Save on chain' });
  await expect(save).toBeDisabled();
  await form.getByLabel('New image URL').fill('http://not-https.example/a.png');
  await expect(form.getByLabel('New image URL')).toHaveAttribute('aria-invalid', 'true');
  await form.getByLabel('New image URL').fill('');
  await form.getByLabel('Description').fill('A desk that trades small Base coins in public.');
  await expect(save).toBeEnabled();
  await save.click();
  await expect(page.getByText('Mock: the coin’s image and metadata were updated on chain.')).toBeVisible();
  await expect(form.getByTestId('v5-metadata-current')).toHaveText('A desk that trades small Base coins in public.');

  // Locking asks first, and Cancel changes nothing.
  await form.getByRole('button', { name: 'Lock metadata' }).click();
  const confirm = form.getByTestId('v5-lock-confirm');
  await expect(confirm).toContainText('This cannot be undone.');
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(form).toHaveAttribute('data-locked', 'false');
  await form.getByRole('button', { name: 'Lock metadata' }).click();
  await form.getByTestId('v5-lock-confirm').getByRole('button', { name: 'Lock for good' }).click();
  await expect(page.getByText('Mock: the coin’s image and metadata are locked for good.')).toBeVisible();
  await expect(form).toHaveAttribute('data-locked', 'true');
  await expect(form).toContainText('Locked for good');
  await expect(form.getByLabel('Description')).toHaveCount(0);

  // The coin page reads the current description.
  await page.getByTestId('back-to-coin').click();
  await expect(page.getByTestId('coin-description')).toHaveText('A desk that trades small Base coins in public.');
  await expect(page.getByTestId('v5-settings')).toContainText('Locked by the creator');
});

test('a coin whose metadata is not editable has no on-chain edit block (mock mode)', async ({ page }) => {
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'GAS' }).first();
  await page.goto(`${(await card.getAttribute('href'))!}/console?section=look`);
  await expect(page.getByTestId('coin-image-form')).toBeVisible();
  await expect(page.getByTestId('v5-metadata-form')).toHaveCount(0);
});

/** A throwaway key for the e2e build only (its address owns nothing). */
const account = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');

async function sign(request: Parameters<Parameters<typeof test>[2]>[0]['request']) {
  const { nonce } = (await (await request.post('/api/agent/nonce')).json()) as { nonce: string };
  const message = new SiweMessage({ domain: 'bootr.fun', address: account.address, statement: 'Prepare a Bootr launch.', uri: 'https://bootr.fun', version: '1', chainId: 84532, nonce, issuedAt: new Date().toISOString() }).prepareMessage();
  return { message, signature: await account.signMessage({ message }) };
}

test('agent API: launch.token sets a v5 coin with the form’s bounds and encodes launch(p, s) (mock mode)', async ({ request }) => {
  const launch = { name: 'Agent Sigma', symbol: 'asig', identity: 'A patient onchain analyst for small Base coins.', image: { dataUrl: `data:image/png;base64,${PNG.toString('base64')}` }, launchThrough: 'clanker-v5' };
  const headers = { 'x-real-ip': '10.7.0.21' };
  const token = { pairedAsset: 'usdc', buyTaxPct: 2, sellTaxPct: '3', burnPct: 10, dividendsPct: 5, rewards: [{ recipient: account.address, pct: 80 }, { recipient: OTHER, admin: account.address, pct: 20 }], sniperTax: false };
  const res = await request.post('/api/agent/launch', { headers, data: { ...(await sign(request)), launch: { ...launch, token } } });
  expect(res.status(), await res.text()).toBe(200);
  const body = (await res.json()) as { token: Record<string, unknown>; tokenSettings: Record<string, unknown>; predictedToken: string; transactions: { step: string; data: `0x${string}` }[] };
  expect(body.token).toMatchObject({ pairedAsset: 'USDC', buyTaxPct: 2, sellTaxPct: 3, minDividendHolding: 10000, editableMetadata: true });
  expect(body.tokenSettings).toMatchObject({ quoteToken: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', buyTaxBps: 20000, sellTaxBps: 30000, burnBps: 1000, dividendBps: 500, minDividendHolding: '10000000000000000000000', antiSnipe: false, metadataEditable: true });
  expect(body.predictedToken.toLowerCase()).toMatch(/cccc$/);
  const call = decodeFunctionData({ abi: clankerLauncherV5Abi, data: body.transactions.find((t) => t.step === 'launch')!.data });
  expect(call.functionName).toBe('launch');
  const [, s] = call.args as unknown as [unknown, { rewards: { bps: number }[]; contractURI: string }];
  expect(s.rewards.map((r) => r.bps)).toEqual([8000, 2000]);
  expect(s.contractURI).toMatch(/^https:\/\/bootr\.fun\/tokens\/[0-9a-f-]{36}\.json$/);

  // The same bounds as the form: a 6% tax is refused, and settings off v5 are refused.
  const tooHigh = await request.post('/api/agent/launch', { headers, data: { ...(await sign(request)), launch: { ...launch, token: { buyTaxPct: 6 } } } });
  expect(tooHigh.status()).toBe(400);
  expect(await tooHigh.json()).toMatchObject({ error: 'invalid_request', field: 'token.buyTaxPct' });
  const offV5 = await request.post('/api/agent/launch', { headers, data: { ...(await sign(request)), launch: { ...launch, launchThrough: 'bootr', token } } });
  expect(offV5.status()).toBe(400);
  expect(await offV5.json()).toMatchObject({ field: 'token' });
});
