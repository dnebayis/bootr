import { expect, test } from '@playwright/test';
import { ADMIN_COOKIE, newSessionId, signToken } from '../lib/server/session-core';

const SLUG = process.env.ADMIN_CONSOLE_SLUG!;
const ADMIN = process.env.ADMIN_ADDRESSES!.split(',')[0]!;

test('home renders the hero, tabs and token cards (mock mode)', async ({ page }) => {
  await page.goto('/');
  // The hero: one headline, one input that opens the ⌘K palette on the first key, one Launch link; the field is a client-only canvas.
  const hero = page.getByTestId('hero');
  await expect(hero.getByRole('heading', { level: 1, name: 'Every coin gets an agent.' })).toBeVisible();
  await expect(hero.getByRole('link', { name: 'Launch' })).toHaveAttribute('href', '/launch');
  await expect(hero.getByTestId('ascii-field')).toBeAttached();
  const search = hero.getByRole('textbox', { name: 'Search tokens' });
  await expect(search).toBeVisible();
  await search.press('b');
  const palette = page.getByRole('dialog', { name: 'Search tokens' });
  await expect(palette).toBeVisible();
  await expect(palette.getByRole('combobox')).toHaveValue('b');
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();

  const tabs = page.getByRole('navigation', { name: 'Token lists' });
  for (const t of ['Newest', 'Graduated', 'Market cap', 'Active']) {
    await expect(tabs.getByRole('link', { name: t })).toBeVisible();
  }
  await expect(page.locator('a[href^="/token/0x"]').first()).toBeVisible();
  expect(await page.locator('a[href^="/token/0x"]').count()).toBeGreaterThan(8);
  await expect(page.getByText('$BOOTR', { exact: true })).toBeVisible();

  await tabs.getByRole('link', { name: 'Market cap' }).click();
  await expect(page).toHaveURL(/\?tab=mcap/);
  await expect(tabs.getByRole('link', { name: 'Market cap' })).toHaveAttribute('aria-current', 'page');
});

test('token page renders agent, fee split and trades', async ({ page }) => {
  await page.goto('/');
  const first = page.locator('a[href^="/token/0x"]').first();
  const href = await first.getAttribute('href');
  expect(href).toBeTruthy();
  await page.goto(href!);
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Locked fee split' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent trades' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Trade', exact: true })).toBeVisible();
  await expect(page.getByText(/Inactive for \d+ days/)).toBeVisible();
});

test("token page lists the coin's own links, the agent's own X account included when it is the only one (mock mode)", async ({ page }) => {
  await page.goto('/');
  // Ledger Owl, the newest mock coin, is the one with project links; its agent posts as @owl_agent.
  const card = page.locator('a[href^="/token/0x"]', { hasText: 'Ledger Owl' }).first();
  await expect(card).toBeVisible();
  await page.goto((await card.getAttribute('href'))!);
  const links = page.getByTestId('token-links');
  await expect(links.getByRole('link', { name: 'Website' })).toHaveAttribute('href', 'https://ledgerowl.example');
  await expect(links.getByRole('link', { name: 'X' })).toHaveAttribute('href', 'https://x.com/ledgerowl');
  await expect(links.getByRole('link', { name: 'X' })).toHaveAttribute('rel', 'noopener noreferrer nofollow');
  await expect(links.getByRole('link', { name: 'Telegram' })).toHaveAttribute('href', 'https://t.me/ledgerowl');
  await expect(links.getByRole('link', { name: 'Discord' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '@owl_agent' })).toBeVisible();
  // Quiet Engine's only X account is its agent's: the X button shows it all the same (the creator entered it).
  await page.goto('/');
  const second = page.locator('a[href^="/token/0x"]', { hasText: 'Quiet Engine' }).first();
  await expect(second).toBeVisible();
  await page.goto((await second.getAttribute('href'))!);
  await expect(page.getByRole('link', { name: '@qeng_agent' })).toBeVisible();
  await expect(page.getByTestId('token-links').getByRole('link', { name: 'X' })).toHaveAttribute('href', 'https://x.com/qeng_agent');
  await expect(page.getByTestId('token-links').getByRole('link', { name: 'Website' })).toHaveCount(0);
  // Other coins carry no links and show no links row.
  await page.goto('/');
  const other = page.locator('a[href^="/token/0x"]', { hasText: 'Paper Hands Club' }).first();
  await expect(other).toBeVisible();
  await page.goto((await other.getAttribute('href'))!);
  await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
  await expect(page.getByTestId('token-links')).toHaveCount(0);
});

test('agent panel shows gas with a status chip and an Add gas form (mock mode)', async ({ page }) => {
  await page.goto('/');
  const href = await page.locator('a[href^="/token/0x"]').first().getAttribute('href');
  await page.goto(href!);
  const gas = page.getByTestId('agent-gas');
  await expect(gas).toContainText(/\d ETH/);
  await expect(gas.getByTestId('gas-status')).toHaveAttribute('data-status', /^(ok|low|empty)$/);
  await page.getByRole('button', { name: 'Add gas' }).click();
  const amount = page.getByRole('textbox', { name: 'Add gas amount in ETH' });
  await expect(amount).toHaveValue('0.001');
  await amount.fill('0.00001');
  await expect(page.getByRole('button', { name: /^Add .*ETH$/ })).toBeDisabled();
  await amount.fill('0.002');
  await expect(page.getByRole('button', { name: 'Add 0.002 ETH' })).toBeDisabled(); // the acknowledgement is required
  await page.getByRole('checkbox', { name: /cannot be withdrawn or refunded/ }).check();
  await page.getByRole('button', { name: 'Add 0.002 ETH' }).click();
  await expect(page.getByText(/Mock: added 0.002 ETH of gas/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add gas' })).toBeVisible();
});

test('agent panel counts the spender float in treasury USDC (mock mode)', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('a[href^="/token/0x"]').first()).toBeVisible();
  const hrefs = [...new Set(await page.locator('a[href^="/token/0x"]').evaluateAll((els) => els.map((e) => e.getAttribute('href') ?? '')))].slice(0, 4);
  // three of every four mock agents hold a spender float, so one of the first four coins shows the caption
  let shown = false;
  for (const href of hrefs) {
    await page.goto(href);
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();
    await expect(page.getByText('USDC', { exact: true }).first()).toBeVisible();
    const note = page.getByTestId('usdc-spender-note');
    if ((await note.count()) > 0) {
      await expect(note).toHaveText('incl. spender float');
      await expect(note.locator('..')).toHaveAttribute('title', /^Kernel .+ USDC \+ spender .+ USDC/);
      shown = true;
      break;
    }
  }
  expect(shown).toBe(true);
});

test('docs fee math shows the 1% WETH fee with the RWAGMI share', async ({ page }) => {
  await page.goto('/docs/fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Fee math' })).toBeVisible();
  await expect(page.getByText('swappers pay (1%)        $1,000').first()).toBeVisible();
  await expect(page.getByText('RWAGMI (10% of the fee)')).toBeVisible();
});

test('/console-wrong is a 404', async ({ page }) => {
  const res = await page.goto('/console-wrong');
  expect(res?.status()).toBe(404);
});

test('/console-<slug> is a 404 without a session', async ({ page }) => {
  const res = await page.goto(`/console-${SLUG}`);
  expect(res?.status()).toBe(404);
  await expect(page.getByText('Splits of existing tokens are locked')).toHaveCount(0);
});

test('literal route path is not reachable directly', async ({ page }) => {
  const res = await page.goto('/console-admin');
  expect(res?.status()).toBe(404);
});

test('/console-<slug>/signin renders the SIWE sign-in', async ({ page }) => {
  const res = await page.goto(`/console-${SLUG}/signin`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Console' })).toBeVisible();
});

test('/console-<slug> renders with a valid admin session', async ({ page, context, baseURL }) => {
  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600, s: newSessionId() });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  const res = await page.goto(`/console-${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Splits of existing tokens are locked on-chain; defaults apply to future launches only.').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Launcher defaults' })).toBeVisible();
  // Agents table: a Gas column with a status chip per row and a per-row Top up (EntryPoint.depositTo) form.
  const agents = page.locator('section', { has: page.getByRole('heading', { name: 'Agents' }) });
  await expect(agents.getByRole('columnheader', { name: 'Gas' })).toBeVisible();
  expect(await agents.getByTestId('gas-status').count()).toBeGreaterThan(0);
  await agents.getByRole('button', { name: 'Top up' }).first().click();
  await expect(agents.getByRole('textbox', { name: 'Top up amount in ETH' })).toHaveValue('0.001');
  await agents.getByRole('button', { name: 'Send' }).click();
  await expect(page.getByText(/Mock: added 0.001 ETH of gas/)).toBeVisible();
});

test('robots disallows the console', async ({ request }) => {
  const res = await request.get('/robots.txt');
  expect(await res.text()).toContain('Disallow: /console-*');
});

/**
 * Background/hidden tabs never run requestAnimationFrame. React reveals streamed Suspense
 * boundaries via rAF, so primary content must not depend on streaming, and chart draw-in must
 * not depend on JS animation frames. See components/ui/ClientOnly.tsx.
 */
test.describe('renders without requestAnimationFrame (background tab)', () => {
  test.beforeEach(async ({ context }) => {
    await context.addInitScript(() => {
      window.requestAnimationFrame = () => 0;
    });
  });

  test('home, token page and charts', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('main a[href^="/token/0x"]').first()).toBeVisible();
    await expect(page.locator('section[aria-label="BOOTR token"] header')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

    const href = await page.locator('main a[href^="/token/0x"]').first().getAttribute('href');
    await page.goto(href!);
    await expect(page.getByRole('heading', { name: 'Agent', exact: true })).toBeVisible();

    await page.goto('/token/0x0000000000000000000000000000000000000001');
    await expect(page.getByRole('heading', { name: 'Token not found.' })).toBeVisible();

    await page.goto('/analytics');
    const line = page.locator('svg[aria-label="Total volume"] .visx-linepath');
    await expect(line).toBeVisible();
    await expect(line).toHaveCSS('stroke-dashoffset', '0px');
  });
});
