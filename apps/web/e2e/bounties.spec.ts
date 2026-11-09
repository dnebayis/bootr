import { expect, test } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/** The mock coin whose agent runs Bounties ($OWL, the newest) and the brand-new one that has none (Night Shift). */
const OWL = '/token/0x9216be96ac924edd35ad86c0a638e1c8b8db86fa';
const NIGHT_SHIFT = '/token/0x3c0f41a1daa59c5f2865183183ac6cdc7e7beb2e';

test('the coin page lists the agent’s bounties: open first, criteria numbered, the paid one with its payee and transaction, the one with no winner says so (mock mode)', async ({ page, request }) => {
  await page.goto(OWL);
  const card = page.getByTestId('bounties-card');
  await expect(card).toBeVisible();
  await expect(page.getByTestId('bounties-count')).toHaveText('1 open · 4 jobs');
  const jobs = card.getByTestId('bounty-job');
  await expect(jobs).toHaveCount(4);
  expect(await jobs.evaluateAll((els) => els.map((e) => e.getAttribute('data-status')))).toEqual(['open', 'proposed', 'paid', 'no_winner']);

  // The open job: taking entries, closes at a relative and an absolute UTC time, no entries yet, three numbered criteria, the post on X.
  const open = jobs.nth(0);
  await expect(open).toContainText('Taking entries');
  await expect(open.getByTestId('bounty-job-amount')).toHaveText('0.50 USDC');
  await expect(open.getByTestId('bounty-job-closes')).toHaveText(/^closes in \d+ h · \d{1,2} \w{3} \d{4}, \d\d:\d\d UTC$/);
  await expect(open.getByTestId('bounty-job-entries')).toHaveText('No entries yet');
  await expect(open.getByTestId('bounty-job-criteria').locator('li')).toHaveCount(3);
  await expect(open.getByRole('link', { name: 'Job post' })).toHaveAttribute('href', /^https:\/\/x\.com\//);
  // The anchor the job post links to carries the 16-hex short id (a post cannot carry the full id).
  expect(await open.getAttribute('id')).toMatch(/^bounty-0x[0-9a-f]{16}$/);

  // The proposed one waits for the creator; the paid one shows the winner's marks, the reason, the payee and the transaction.
  await expect(jobs.nth(1).getByTestId('bounty-job-outcome')).toContainText('Nothing is paid until they say yes.');
  const paid = jobs.nth(2);
  await expect(paid).toContainText('Paid');
  await expect(paid.getByTestId('bounty-job-criteria').locator('[data-mark="pass"]')).toHaveCount(3);
  await expect(paid.getByTestId('bounty-job-reason')).toContainText('Why: An owl at a desk');
  await expect(paid.getByTestId('bounty-job-winner')).toHaveAttribute('href', /^https:\/\/x\.com\//);
  await expect(paid.getByTestId('bounty-job-payment')).toContainText(/Paid 0\.50 USDC to\s*0x7a1e…a291/);
  await expect(paid.getByTestId('bounty-job-payment').getByRole('link', { name: /^tx 0x/ })).toHaveAttribute('href', /basescan\.org\/tx\/0x[0-9a-f]{64}$/);
  await expect(paid.getByTestId('bounty-job-entries')).toHaveText('7 entries, 4 could be judged (2 no address, 1 same picture as an earlier entry)');

  // A closed job with no winner says so in plain words.
  const none = jobs.nth(3);
  await expect(none).toContainText('No winner');
  await expect(none.getByTestId('bounty-job-outcome')).toHaveText('No entry met the job; nothing paid.');
  await expect(none.getByTestId('bounty-job-payment')).toHaveCount(0);

  // The public API behind the card: the same jobs, no store, nothing about authors or reply texts, one job by id, 404 for an unknown one.
  const kernel = /0x[0-9a-fA-F]{40}/.exec((await page.getByTestId('agent-wallet').getByRole('link').getAttribute('href'))!)![0];
  const list = await request.get(`/api/agent/${kernel}/bounties`);
  expect(list.status()).toBe(200);
  expect(list.headers()['cache-control']).toBe('no-store');
  const body = (await list.json()) as { jobs: { id: string; shortId: string; status: string; payment: { txHash: string } | null }[] };
  expect(body.jobs.map((j) => j.status)).toEqual(['open', 'proposed', 'paid', 'no_winner']);
  expect(JSON.stringify(body)).not.toMatch(/authorId|"text"|"author"/);
  const one = await request.get(`/api/agent/${kernel}/bounties/${body.jobs[2]!.id}`);
  expect(one.status()).toBe(200);
  expect(((await one.json()) as { job: { payment: { txHash: string } } }).job.payment.txHash).toMatch(/^0x[0-9a-f]{64}$/);
  // The short id the job post carries answers too.
  const byShort = await request.get(`/api/agent/${kernel}/bounties/${body.jobs[2]!.shortId}`);
  expect(byShort.status()).toBe(200);
  expect(((await byShort.json()) as { job: { id: string } }).job.id).toBe(body.jobs[2]!.id);
  expect((await request.get(`/api/agent/${kernel}/bounties/0x${'0'.repeat(64)}`)).status()).toBe(404);
  expect((await request.get(`/api/agent/${kernel}/bounties/nope`)).status()).toBe(400);

  // A coin whose agent posted no job has no card.
  await page.goto(NIGHT_SHIFT);
  await expect(page.getByTestId('agent-wallet')).toBeVisible();
  await expect(page.getByTestId('bounties-card')).toHaveCount(0);
});

test('the console switches Bounties on with its bounds, and the Inbox shows the proposed payment with the hash form (mock mode)', async ({ page }) => {
  await fakeInjectedWallet(page);
  // The Powers switch is saved on the second coin, so the first coin's revision, which other specs read, stays as it was.
  await page.goto('/');
  const href = await page.locator('a[href^="/token/0x"]', { hasText: 'Quiet Engine' }).first().getAttribute('href');
  await page.goto(`${href}/console?section=powers`);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_.getByRole('tab', { name: 'Powers' })).toHaveAttribute('aria-selected', 'true');
  const row = console_.getByTestId('power-row-bounties');
  await expect(row).toHaveAttribute('data-on', 'false');
  await expect(console_.getByTestId('bounties-caps')).toHaveCount(0);
  await console_.getByRole('switch', { name: 'Bounties' }).click();
  await expect(row).toHaveAttribute('data-on', 'true');
  const caps = console_.getByTestId('bounties-caps');
  await expect(caps.getByTestId('bounties-copy')).toContainText('In this stage you pay each winner yourself');
  await expect(caps).toContainText('Nothing is paid without your yes.');
  await expect(caps).toContainText('The agent gets a separate hourly turn for its treasury while this is on.');
  await expect(caps).not.toContainText(/session key|kernel|relay|supervisor|x402/i);
  await expect(caps.locator('#console-bounties-daily')).toHaveValue('5.00');
  await expect(caps.locator('#console-bounties-max-open')).toHaveValue('2');
  await expect(caps.locator('#console-bounties-cooldown')).toHaveValue('7');
  await expect(caps.locator('#console-bounties-hours')).toHaveValue('6');
  await expect(caps.getByTestId('bounties-bounds')).toContainText('Per day at most 20 USDC');
  const save = console_.getByRole('button', { name: 'Save changes' });
  await caps.locator('#console-bounties-daily').fill('25');
  await expect(console_.getByTestId('console-save-state')).toHaveText('Fix the marked fields to save');
  await expect(save).toBeDisabled();
  await caps.locator('#console-bounties-daily').fill('3.50');
  await caps.locator('#console-bounties-max-open').fill('3');
  await caps.getByRole('switch', { name: 'Review every job text first' }).click();
  await expect(console_.getByTestId('console-save-state')).toHaveText('Unsaved changes in Powers');
  await expect(save).toBeEnabled();
  const saved = page.waitForResponse((r) => /\/api\/agent\/0x[0-9a-f]{40}\/config$/.test(r.url()) && r.request().method() === 'POST');
  await save.click();
  const res = await saved;
  expect(res.status()).toBe(200);
  const cfg = (await res.json()) as { worker: { capabilities: Record<string, boolean> }; bounties: Record<string, unknown> };
  expect(cfg.worker.capabilities.bounties).toBe(true);
  expect(cfg.bounties).toEqual({ dailyCapMicroUsdc: 3_500_000, maxOpen: 3, cooldownSeconds: 604_800, defaultHoursOpen: 6, review: true });
  await expect(page.getByText(/Agent updated/)).toBeVisible();
  await expect(caps.locator('#console-bounties-daily')).toHaveValue('3.50');
  await expect(save).toBeDisabled();

  // The first coin's Inbox holds the payment its agent proposes: the job, the amount, the payee, the reason, the entry, the expiry, and the hash form.
  await page.goto(`${OWL}/console?section=inbox`);
  const queue = console_.getByTestId('approval-queue');
  await queue.getByRole('button', { name: 'Review posts' }).click();
  const item = queue.locator('[data-testid="approval-item"][data-kind="bounty_payout"]');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('Bounty payment');
  await expect(item.getByTestId('bounty-amount')).toHaveText('0.40 USDC');
  await expect(item).toContainText('A public page, in your own words');
  await expect(item.getByTestId('bounty-payee')).toContainText('0x7a1e4c3b9d2f8e6a5c4b3a2918f7e6d5c4b3a291');
  await expect(item.getByTestId('bounty-payee').getByRole('link')).toHaveAttribute('href', /basescan\.org\/address\/0x7a1e4c3b9d2f8e6a5c4b3a2918f7e6d5c4b3a291$/);
  await expect(item.getByRole('button', { name: 'Copy the payee address' })).toBeVisible();
  await expect(item.getByTestId('bounty-reason')).toContainText('names the four shares');
  await expect(item.getByRole('link', { name: 'The winning entry on X' })).toHaveAttribute('href', /^https:\/\/x\.com\//);
  await expect(item.getByTestId('bounty-instructions')).toHaveText('Send 0.40 USDC from your wallet to this address, then paste the transaction hash.');
  await expect(item).toContainText(/expires in \d+ h/);
  const paidButton = item.getByTestId('bounty-paid');
  await expect(paidButton).toBeDisabled();
  await item.getByTestId('bounty-tx-hash').fill('0x1234');
  await expect(item).toContainText('A transaction hash is 0x followed by 64 hex characters.');
  await expect(paidButton).toBeDisabled();
  await item.getByTestId('bounty-tx-hash').fill(`0x${'ab'.repeat(32)}`);
  await expect(paidButton).toBeEnabled();
  await expect(item.getByTestId('bounty-reject')).toHaveText('Do not pay');
  // Not submitted: the mock store is shared by every spec, and the payment is the creator's to make.
});
