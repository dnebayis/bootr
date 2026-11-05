import { expect, test } from '@playwright/test';

const FILE = 'https://bootr.fun/skill/skill.md';

test('the Skill nav item opens the page, with the URL, the sentence and the raw link', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await nav.getByRole('link', { name: 'Skill', exact: true }).click();
  await expect(page).toHaveURL(/\/skill$/);
  await expect(nav.getByRole('link', { name: 'Skill', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'Skill', level: 1 })).toBeVisible();
  await expect(page.getByText(FILE, { exact: true })).toBeVisible();
  await expect(page.getByText(`Read ${FILE} and follow it to launch a coin on Bootr`, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy the skill URL' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy the sentence' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open the raw file' })).toHaveAttribute('href', '/skill/skill.md');
});

test('the copy button puts the skill URL on the clipboard', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/skill');
  await page.getByRole('button', { name: 'Copy the skill URL' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(FILE);
});

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 720 } });

  test('the mobile menu has Skill, and the page fits the width', async ({ page }) => {
    await page.goto('/');
    await page.getByRole('button', { name: 'Open menu' }).click();
    await page.getByRole('navigation', { name: 'Mobile' }).getByRole('link', { name: 'Skill', exact: true }).click();
    await expect(page).toHaveURL(/\/skill$/);
    await expect(page.getByText(FILE, { exact: true })).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    const copy = await page.getByRole('button', { name: 'Copy the skill URL' }).boundingBox();
    expect(copy!.width).toBeGreaterThanOrEqual(36);
  });
});

const headerOverflow = () => {
  const header = document.querySelector('header')!;
  return header.scrollWidth - header.clientWidth;
};

test.describe('on a tablet', () => {
  test.use({ viewport: { width: 768, height: 600 } });

  test('the menu holds the nav items, and the wallet button fits the header', async ({ page }) => {
    await page.goto('/skill');
    await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
    await expect(page.getByRole('button', { name: /connect wallet/i })).toBeVisible();
    expect(await page.evaluate(headerOverflow)).toBeLessThanOrEqual(0);
  });
});

test.describe('on a small laptop', () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test('all seven nav items and the wallet button fit the header', async ({ page }) => {
    await page.goto('/skill');
    await expect(page.getByRole('navigation', { name: 'Primary' }).getByRole('link')).toHaveCount(7);
    await expect(page.getByRole('button', { name: /connect wallet/i })).toBeVisible();
    expect(await page.evaluate(headerOverflow)).toBeLessThanOrEqual(0);
  });
});

test('the raw file is served as Markdown through the proxy, unchanged', async ({ request }) => {
  const res = await request.get('/skill/skill.md', { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toBe('text/markdown; charset=utf-8');
  expect(res.headers()['cache-control']).toBe('public, max-age=0, must-revalidate');
  const body = await res.text();
  expect(body).toMatch(/^---\nname: launch-on-bootr\ndescription: .+\n---\n/);
  expect(body).toContain('## Safety Rules');
});
