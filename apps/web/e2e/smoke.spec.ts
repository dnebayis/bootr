import { expect, test } from '@playwright/test';
import { ADMIN_COOKIE, signToken } from '../lib/server/session-core';

const SLUG = process.env.ADMIN_CONSOLE_SLUG!;
const ADMIN = process.env.ADMIN_ADDRESSES!.split(',')[0]!;

test('home renders tabs and token cards (mock mode)', async ({ page }) => {
  await page.goto('/');
  const tabs = page.getByRole('navigation', { name: 'Token lists' });
  for (const t of ['Newest', 'Graduated', 'Market cap', 'Active']) {
    await expect(tabs.getByRole('link', { name: t })).toBeVisible();
  }
  await expect(page.locator('a[href^="/token/0x"]').first()).toBeVisible();
  expect(await page.locator('a[href^="/token/0x"]').count()).toBeGreaterThan(8);
  await expect(page.getByText('$BOOT', { exact: true })).toBeVisible();

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
  await expect(page.getByRole('heading', { name: 'Agent' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Locked fee split' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Recent trades' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Trade/ })).toBeVisible();
  await expect(page.getByText(/Inactive for \d+ days/)).toBeVisible();
});

test('docs fee math shows the on-top Clanker example', async ({ page }) => {
  await page.goto('/docs/fees');
  await expect(page.getByRole('heading', { level: 1, name: 'Fee math' })).toBeVisible();
  await expect(page.getByText('$1,200').first()).toBeVisible();
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
  const res = await page.goto('/console-[slug]');
  expect(res?.status()).toBe(404);
});

test('/console-<slug>/signin renders the SIWE sign-in', async ({ page }) => {
  const res = await page.goto(`/console-${SLUG}/signin`);
  expect(res?.status()).toBe(200);
  await expect(page.getByRole('heading', { name: 'Console' })).toBeVisible();
});

test('/console-<slug> renders with a valid admin session', async ({ page, context, baseURL }) => {
  const token = await signToken({ k: 'admin', a: ADMIN, e: Math.floor(Date.now() / 1000) + 600 });
  await context.addCookies([{ name: ADMIN_COOKIE, value: token, url: baseURL! }]);
  const res = await page.goto(`/console-${SLUG}`);
  expect(res?.status()).toBe(200);
  await expect(page.getByText('Splits of existing tokens are locked on-chain; defaults apply to future launches only.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Launcher defaults' })).toBeVisible();
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
    await expect(page.locator('section[aria-label="BOOT token"] header')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);

    const href = await page.locator('main a[href^="/token/0x"]').first().getAttribute('href');
    await page.goto(href!);
    await expect(page.getByRole('heading', { name: 'Agent' })).toBeVisible();

    await page.goto('/token/0x0000000000000000000000000000000000000001');
    await expect(page.getByRole('heading', { name: 'Token not found.' })).toBeVisible();

    await page.goto('/analytics');
    const line = page.locator('svg[aria-label="Total volume"] .visx-linepath');
    await expect(line).toBeVisible();
    await expect(line).toHaveCSS('stroke-dashoffset', '0px');
  });
});
