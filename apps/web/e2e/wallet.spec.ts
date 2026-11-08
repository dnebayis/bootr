import { expect, test } from '@playwright/test';
import { ADMIN_COOKIE, newSessionId, signToken } from '../lib/server/session-core';
import { fakeInjectedWallet } from './fake-wallet';

const SLUG = process.env.ADMIN_CONSOLE_SLUG!;
const ADMIN = process.env.ADMIN_ADDRESSES!.split(',')[0]!;

test('connect menu lists Base Account first, then Coinbase Wallet and the browser wallet', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  const button = page.getByRole('button', { name: 'Connect wallet' }).filter({ visible: true }).first();
  await expect(button).toBeEnabled();
  await button.click();
  // The menu is named by its trigger (Base UI sets aria-labelledby); "Choose a wallet" is its visible caption.
  const menu = page.getByRole('menu', { name: 'Connect wallet' });
  await expect(menu).toBeVisible();
  await expect(menu).toContainText('Choose a wallet');
  const items = menu.getByRole('menuitem');
  await expect(items.nth(0)).toContainText('Sign in with Base');
  await expect(items.nth(0)).toContainText('Passkey smart wallet');
  await expect(items.nth(1)).toContainText('Coinbase Wallet');
  await expect(items.nth(2)).toContainText('Browser wallet');
  // WalletConnect is listed only with NEXT_PUBLIC_WC_PROJECT_ID (unset in the e2e build).
  const labels = await items.allTextContents();
  if (process.env.NEXT_PUBLIC_WC_PROJECT_ID) expect(labels.at(-1)).toContain('WalletConnect');
  else expect(labels.join(' ')).not.toContain('WalletConnect');
  expect(errors.filter((e) => /hydrat/i.test(e))).toEqual([]);
});

/** Every menu item lies inside the viewport: the whole list is visible, not just its top edge. */
async function expectMenuOnScreen(page: import('@playwright/test').Page, menu: import('@playwright/test').Locator) {
  const viewport = page.viewportSize()!;
  const items = menu.getByRole('menuitem');
  const n = await items.count();
  expect(n).toBeGreaterThanOrEqual(3);
  for (let i = 0; i < n; i++) {
    const box = (await items.nth(i).boundingBox())!;
    expect(box.x, `item ${i} starts past the left edge`).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, `item ${i} runs past the right edge`).toBeLessThanOrEqual(viewport.width);
    expect(box.y, `item ${i} starts above the top`).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height, `item ${i} runs below the bottom`).toBeLessThanOrEqual(viewport.height);
  }
}

test.describe('on a phone', () => {
  // Phone-shaped, touch, mobile user agent: no browser wallet is injected, as on a real phone outside a wallet app.
  test.use({
    viewport: { width: 375, height: 812 },
    isMobile: true,
    hasTouch: true,
    userAgent:
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });

  test('the drawer’s Connect wallet opens the wallet list on screen, above the button', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    const drawer = page.getByRole('dialog');
    const button = drawer.getByRole('button', { name: 'Connect wallet' });
    await expect(button).toBeVisible();
    await button.click();
    const menu = page.getByRole('menu', { name: 'Connect wallet' });
    await expect(menu).toBeVisible();
    const items = menu.getByRole('menuitem');
    await expect(items.nth(0)).toContainText('Sign in with Base');
    await expect(items.nth(1)).toContainText('Coinbase Wallet');
    await expect(items.nth(2)).toContainText('Browser wallet');
    await expectMenuOnScreen(page, menu);
    // The button is the last thing in the bottom sheet, so the list opens upward.
    const menuBox = (await menu.boundingBox())!;
    const buttonBox = (await button.boundingBox())!;
    expect(menuBox.y + menuBox.height).toBeLessThanOrEqual(buttonBox.y + 1);
    // Still part of the drawer: opening the list did not close it.
    await expect(drawer).toBeVisible();
  });

  test('a left-aligned Connect wallet (profile) keeps the list inside the screen', async ({ page }) => {
    await page.goto('/profile');
    await page.getByRole('main').getByRole('button', { name: 'Connect wallet' }).click();
    const menu = page.getByRole('menu', { name: 'Connect wallet' });
    await expect(menu).toBeVisible();
    await expectMenuOnScreen(page, menu);
  });

  test('the coin page Trade panel lists the wallets on screen', async ({ page }) => {
    await page.goto('/');
    await page.locator('a[href^="/token/0x"]').first().click();
    await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);
    const button = page.getByRole('main').getByRole('button', { name: 'Connect wallet' }).first();
    await button.scrollIntoViewIfNeeded();
    await button.click();
    const menu = page.getByRole('menu', { name: 'Connect wallet' });
    await expect(menu).toBeVisible();
    await expectMenuOnScreen(page, menu);
  });

  test('a browser wallet still connects from the drawer when one is injected (wallet in-app browser)', async ({ page }) => {
    await fakeInjectedWallet(page);
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Connect wallet' }).click();
    await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: /0x0000/ })).toBeVisible();
  });
});

test('profile shows creator fees with claim controls (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto('/profile');
  await page.getByRole('main').getByRole('button', { name: 'Connect wallet' }).click();
  await page.getByRole('menuitem', { name: /Browser wallet/ }).click();
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Creator fees' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByTestId('creator-weth')).toContainText('WETH');
  await expect(panel.getByRole('button', { name: 'Claim WETH' })).toBeVisible();
  const claims = panel.getByRole('button', { name: 'Claim fees' });
  expect(await claims.count()).toBeGreaterThan(0);
  // The agents table carries each coin's gas with a status chip (the creator funds the first gas).
  const agents = page.locator('table', { has: page.getByRole('columnheader', { name: 'Gas' }) });
  await expect(agents).toBeVisible();
  expect(await agents.getByTestId('gas-status').count()).toBeGreaterThan(0);
});

test('console lists platform fees with per-token and claim-all actions (mock mode)', async ({ page, context, baseURL }) => {
  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600, s: newSessionId() });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  await page.goto(`/console-${SLUG}`);
  const panel = page.locator('section', { has: page.getByRole('heading', { name: 'Platform fees' }) });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('button', { name: /^Claim all/ })).toBeVisible();
  await expect(panel.getByTestId('platform-weth')).toContainText('WETH');
  expect(await panel.getByRole('button', { name: 'Claim', exact: true }).count()).toBeGreaterThan(0);
});

test('coin page shows the agent status line, the activity tape and the creator console (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  await page.goto('/');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);

  // Status line under the name: the status plus its reason.
  await expect(page.getByTestId('agent-status')).toContainText(/awake · (posted .+|no posts yet)|sleeping · (waiting for an X account|fuel below 1 USDC|quiet for .+)|paused by creator|dormant|claimed/);

  // The activity tape replaces "Latest posts": tabs All / Posts / Treasury, rows link to X or the explorer.
  const tape = page.locator('section', { has: page.getByRole('heading', { name: 'Activity' }) });
  await expect(tape).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Latest posts' })).toHaveCount(0);
  await expect(tape.getByRole('tab', { name: 'All' })).toHaveAttribute('aria-selected', 'true');
  await expect(tape.locator('li').first()).toBeVisible();
  await tape.getByRole('tab', { name: 'Treasury' }).click();
  await expect(tape.getByTestId('activity-tape')).toHaveAttribute('data-filter', 'treasury');
  expect(await tape.locator('li[data-kind="fee_claim"]').count()).toBeGreaterThan(0);
  await expect(tape.locator('li[data-kind="post"]')).toHaveCount(0);
  await tape.getByRole('tab', { name: 'Posts' }).click();
  await expect(tape.locator('li[data-kind="fee_claim"]')).toHaveCount(0);

  // Creator console (everyone is the creator in mock mode): prefilled from /api/agent/[kernel]/config, saved with a POST.
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  await expect(console_.getByTestId('config-revision')).toHaveText('not edited yet');
  const instructions = console_.getByLabel('Instructions');
  await expect(instructions).not.toHaveValue('');
  expect(await console_.getByRole('switch').count()).toBe(7);
  await expect(console_.getByText('Memory · always on')).toBeVisible();
  // Post approval mode: on by default in mock mode, with the pending count on the console title.
  const review = console_.getByRole('switch', { name: 'Review posts before they go out' });
  await expect(review).toHaveAttribute('aria-checked', 'true');
  await expect(console_.getByTestId('approvals-pending')).toHaveText('2 pending');
  await expect(console_.locator('#console-posts-per-day')).toBeVisible();
  await expect(console_.getByLabel('Model')).toBeVisible();
  const save = console_.getByRole('button', { name: 'Save changes' });
  await expect(save).toBeDisabled();
  await instructions.fill('Post one dated fact about the pool per cycle and never tell anyone to buy.');
  await console_.getByRole('switch', { name: 'Web research' }).click();
  await expect(save).toBeEnabled();
  const saved = page.waitForResponse((r) => /\/api\/agent\/0x[0-9a-f]{40}\/config$/.test(r.url()) && r.request().method() === 'POST');
  await save.click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(/Agent updated/)).toBeVisible();
  await expect(console_.getByTestId('config-revision')).toHaveText('edited once');
  await expect(save).toBeDisabled();
  // The edit lands on the tape.
  await tape.getByRole('tab', { name: 'All' }).click();
  await expect(tape.locator('li[data-kind="config_updated"]').first()).toContainText('instructions, capabilities');

  // The review queue: one signature (skipped in mock mode) opens the agent's queued posts; Approve sends, Reject notes.
  const queue = console_.getByTestId('approval-queue');
  await expect(queue.getByTestId('approval-queue-count')).toHaveText('2 pending');
  const listed = page.waitForResponse((r) => /\/api\/agent\/0x[0-9a-f]{40}\/approvals\/list$/.test(r.url()) && r.request().method() === 'POST');
  await queue.getByRole('button', { name: 'Review posts' }).click();
  expect((await listed).status()).toBe(200);
  const items = queue.getByTestId('approval-item');
  await expect(items).toHaveCount(2);
  await expect(items.first()).toHaveAttribute('data-kind', 'post');
  await expect(items.first().getByTestId('approval-image')).toBeVisible();
  await expect(items.nth(1)).toHaveAttribute('data-kind', 'reply');
  const approved = page.waitForResponse((r) => /\/approvals\/decide$/.test(r.url()) && r.request().method() === 'POST');
  await items.first().getByRole('button', { name: 'Approve' }).click();
  expect((await approved).status()).toBe(200);
  await expect(page.getByText(/Approved and posted on X/)).toBeVisible();
  await expect(items).toHaveCount(1);
  await expect(queue.getByTestId('approval-queue-count')).toHaveText('1 pending');
  await items.first().getByLabel('Note for the agent').fill('Too long; keep replies to one sentence.');
  await items.first().getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/Rejected\. The agent will see your note/)).toBeVisible();
  await expect(queue.getByTestId('approval-queue-empty')).toBeVisible();
  await expect(console_.getByTestId('approvals-pending')).toHaveCount(0);
  // Both decisions land on the tape: the approved post as a post with its link, the rejection as a note-free row.
  await expect(tape.locator('li[data-kind="approval_approved"]').first()).toContainText('Post approved by the creator');
  await expect(tape.locator('li[data-kind="approval_rejected"]').first()).toContainText('Reply rejected by the creator');
  await expect(tape.locator('li[data-kind="post"]').first()).toContainText('Week in numbers');
  // Switching review off is a config change like any other.
  await review.click();
  await expect(save).toBeEnabled();
  const savedAgain = page.waitForResponse((r) => /\/api\/agent\/0x[0-9a-f]{40}\/config$/.test(r.url()) && r.request().method() === 'POST');
  await save.click();
  expect((await savedAgain).status()).toBe(200);
  await expect(console_.getByTestId('config-revision')).toHaveText('edited 2 times');
  await expect(review).toHaveAttribute('aria-checked', 'false');
  await expect(tape.locator('li[data-kind="config_updated"]').first()).toContainText('post review');

  // Fuel and gas live in the console now.
  await expect(console_.getByRole('button', { name: 'Fuel the agent' })).toBeVisible();
  await expect(console_.getByRole('button', { name: 'Add gas' })).toBeVisible();
  await expect(page.getByTestId('agent-wallet')).toBeVisible();
});
