import { expect, test, type Page } from '@playwright/test';

/** The mock coin whose agent runs Bounties ($OWL). */
const OWL = '/token/0x9216be96ac924edd35ad86c0a638e1c8b8db86fa';
const RULE_BY = '2026-11-14T16:00:00.000Z';

type Job = Record<string, unknown> & { status: string; verdict: Record<string, unknown> | null };

/**
 * Answers the card's read (`/api/agent/:kernel/bounties`) with the mock's own jobs, changed by `patch`: what the agent
 * service answers for a coin whose agent runs in its creator's own AI client.
 */
async function serveJobs(page: Page, patch: (jobs: Job[]) => Job[]) {
  await page.route(/\/api\/agent\/0x[0-9a-fA-F]{40}\/bounties(\?.*)?$/, async (route) => {
    const res = await route.fetch();
    const body = (await res.json()) as { jobs: Job[] };
    await route.fulfill({ response: res, json: { jobs: patch(body.jobs) } });
  });
}

const noVerdict = { winner: null, winningEntryUrl: null, perCriterion: {}, reason: '', invalid: null, deliveryHash: null, reasonHash: null, judgedAt: null };

test('a bounty of a coin whose agent runs in its creator’s own AI client says the entries are judged when that agent is next online, within 48 hours (mock mode)', async ({ page }) => {
  // The open job's window has closed and its entries wait for the creator's own agent; the job with no winner closed because no ruling came.
  await serveJobs(page, (jobs) =>
    jobs.map((job) => {
      if (job.status === 'open') return { ...job, status: 'judging', closesAt: '2026-11-12T16:00:00.000Z', entries: { received: 3, eligible: 2, considered: 2, ineligible: { no_address: 1 } }, verdict: null, ownJudge: { ruleBy: RULE_BY } };
      if (job.status === 'no_winner') return { ...job, verdict: { ...noVerdict, invalid: 'judge_absent', judgedAt: '2026-11-10T16:00:00.000Z' }, ownJudge: null };
      return job;
    }),
  );
  await page.goto(OWL);
  const card = page.getByTestId('bounties-card');
  await expect(card).toBeVisible();
  const jobs = card.getByTestId('bounty-job');
  await expect(jobs).toHaveCount(4);

  // Waiting for the ruling: still in motion, with the plain line and the time the wait ends on hover.
  const waiting = card.locator('[data-testid="bounty-job"][data-status="judging"]');
  await expect(waiting).toHaveCount(1);
  await expect(waiting).toContainText('Judging');
  const line = waiting.getByTestId('bounty-job-outcome');
  await expect(line).toHaveText('Judged when the creator’s agent is next online, within 48 hours. If it is not, the job closes with no winner and nothing is paid.');
  await expect(line).toHaveAttribute('data-own-judge', 'waiting');
  await expect(line).toHaveAttribute('title', 'Waits until 14 Nov 2026, 16:00 UTC');
  await expect(waiting.getByTestId('bounty-job-entries')).toHaveText('3 entries, 2 could be judged (1 no address)');
  await expect(waiting.getByTestId('bounty-job-payment')).toHaveCount(0);
  await expect(waiting.getByTestId('bounty-job-winner')).toHaveCount(0);

  // Closed without a ruling: it says why in plain words, and not the service's own code for it.
  const closed = card.locator('[data-testid="bounty-job"][data-status="no_winner"]');
  await expect(closed.getByTestId('bounty-job-outcome')).toHaveText('The creator’s agent did not judge the entries within 48 hours; nothing paid.');
  await expect(closed.getByTestId('bounty-job-outcome')).toHaveAttribute('data-own-judge', 'absent');
  await expect(closed).not.toContainText('judge_absent');
  await expect(closed).not.toContainText('set aside');
  await expect(closed).not.toContainText(/judged .* ago/);
  await expect(closed.getByTestId('bounty-job-payment')).toHaveCount(0);

  // Public copy only: nothing of how the agent is run under the hood.
  await expect(card).not.toContainText(/own-agent|runner|MCP|session key|supervisor/i);
  // The jobs that were judged and paid as before read as before.
  await expect(card.locator('[data-testid="bounty-job"][data-status="proposed"]').getByTestId('bounty-job-outcome')).toContainText('Nothing is paid until they say yes.');
  await expect(card.locator('[data-testid="bounty-job"][data-status="paid"]').getByTestId('bounty-job-payment')).toContainText(/Paid 0\.50 USDC/);
});

test('a job being judged for a coin Bootr runs says nothing about waiting (mock mode)', async ({ page }) => {
  // The same closed window on a coin whose agent is run by Bootr: the judge rules within the minute, so the card adds no line.
  await serveJobs(page, (jobs) => jobs.map((job) => (job.status === 'open' ? { ...job, status: 'judging', closesAt: '2026-11-12T16:00:00.000Z', verdict: null } : job)));
  await page.goto(OWL);
  const judging = page.getByTestId('bounties-card').locator('[data-testid="bounty-job"][data-status="judging"]');
  await expect(judging).toHaveCount(1);
  await expect(judging).toContainText('Judging');
  await expect(judging.getByTestId('bounty-job-outcome')).toHaveCount(0);
  await expect(page.getByTestId('bounties-card')).not.toContainText('next online');
});
