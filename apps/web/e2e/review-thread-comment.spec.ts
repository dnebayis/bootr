import { expect, test, type Page } from '@playwright/test';
import { sanitizeActivity, sanitizeApproval, sanitizeApprovals } from '../lib/server/supervisor';
import { fakeInjectedWallet } from './fake-wallet';

/**
 * A thread and a post written ahead in the creator's review queue, and a comment on the coin page's activity
 * (docs/design/agent-tools-2.md sections 3.5, 4.2 and 5.5). Mock mode keeps no thread, no schedule and no comment, so
 * this spec answers the two routes itself: with what the agent service sends (apps/supervisor/src/approvals.ts
 * `viewOf`, activity.ts `actionItem`), passed through the web's own sanitizers, the way the real routes answer.
 *
 * Nothing here saves a setting or decides one of the mock's own items, so the coins the other specs use stay as they are.
 */

const JARGON = /\b(runner|kernel|session key|relay|lease|tick|supervisor)\b/i;
const HOSTILE = '<img src=x onerror="window.__pwned=1"> [link](javascript:alert(1))';
const iso = (hoursFromNow: number) => new Date(Date.now() + hoursFromNow * 3_600_000).toISOString();

/** The queue as the agent service lists it: a thread written ahead, a thread that goes out on approval, a single post. */
const serviceQueue = () => ({
  items: [
    {
      id: 'sch_00000000000000a1',
      agentId: '7',
      kind: 'post',
      text: 'First: how the fee split of this coin works.',
      inReplyTo: null,
      image: null,
      status: 'pending_approval',
      decision: null,
      decidedBy: null,
      note: null,
      postId: null,
      url: null,
      createdAt: iso(-1),
      decidedAt: null,
      expiresAt: iso(47),
      bounty: null,
      thread: ['Second: the agent’s share pays for its own thinking.', 'Third: the split is locked at launch.'],
      scheduledFor: iso(3),
    },
    {
      id: 'act_thread_now',
      agentId: '7',
      kind: 'post',
      text: 'A thread that goes out as soon as it is approved.',
      inReplyTo: null,
      image: null,
      status: 'pending_approval',
      decision: null,
      decidedBy: null,
      note: null,
      postId: null,
      url: null,
      createdAt: iso(-2),
      decidedAt: null,
      expiresAt: iso(46),
      bounty: null,
      thread: [HOSTILE, 'Third and last.', 'x'.repeat(280)],
    },
    { id: 'act_single', agentId: '7', kind: 'post', text: 'One post, nothing after it.', inReplyTo: null, image: null, status: 'pending_approval', decision: null, decidedBy: null, note: null, postId: null, url: null, createdAt: iso(-3), decidedAt: null, expiresAt: iso(45), bounty: null },
    // a thread the console could not show in full is not listed at all
    { id: 'act_too_many', agentId: '7', kind: 'post', text: 'A thread of fifty.', inReplyTo: null, image: null, status: 'pending_approval', decision: null, decidedBy: null, note: null, postId: null, url: null, createdAt: iso(-4), decidedAt: null, expiresAt: iso(44), bounty: null, thread: Array.from({ length: 50 }, (_, i) => `post ${i + 2}`) },
  ],
  pending: 4,
});

const coinLinks = async (page: Page, path: string): Promise<string[]> => {
  await page.goto(path);
  const links = page.locator('a[href^="/token/0x"]');
  await expect(links.first()).toBeVisible();
  return [...new Set(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')!.split('?')[0]!)))];
};

/** The console's Inbox of a coin no other spec edits (counted from the end of the Active tab, past the ones agent-tools-console uses). */
async function openInbox(page: Page) {
  await fakeInjectedWallet(page);
  const [first] = await coinLinks(page, '/');
  const active = await coinLinks(page, '/?tab=active');
  const own = active.slice(1).filter((href) => href !== first);
  expect(own.length).toBeGreaterThan(6);
  await page.goto(`${own[own.length - 7]!}/console?section=inbox`);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  return console_;
}

/** Answers the queue's two routes; returns the decisions the page sent. */
async function answerQueue(page: Page) {
  const decided: { approvalId: string; decision: string }[] = [];
  await page.route('**/api/agent/*/approvals/list*', (route) => route.fulfill({ json: { ...sanitizeApprovals(serviceQueue()), token: 'mock-review-token' } }));
  await page.route('**/api/agent/*/approvals/decide', async (route) => {
    const body = route.request().postDataJSON() as { approvalId: string; decision: string };
    decided.push({ approvalId: body.approvalId, decision: body.decision });
    const item = serviceQueue().items.find((i) => i.id === body.approvalId)!;
    // The decision's answer for a post written ahead carries neither its thread nor its time (scheduled.ts `approvalViewOf`).
    const answer: Record<string, unknown> = { ...item, status: body.decision === 'approve' ? 'approved' : 'rejected', decision: body.decision, decidedAt: new Date().toISOString() };
    delete answer.thread;
    delete answer.scheduledFor;
    await route.fulfill({ json: sanitizeApproval(answer) });
  });
  return decided;
}

const fits = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

async function openQueue(page: Page) {
  const console_ = await openInbox(page);
  const queue = console_.getByTestId('approval-queue');
  await queue.getByRole('button', { name: /Review posts|Open queue/ }).click();
  await expect(queue.getByTestId('approval-item')).toHaveCount(3);
  return queue;
}

test('review queue: every post of a thread is shown, and a post written ahead says when it goes out', async ({ page }) => {
  const decided = await answerQueue(page);
  const queue = await openQueue(page);
  const items = queue.getByTestId('approval-item');
  // the thread of fifty was dropped by the sanitizer; the count is the service's own
  await expect(queue.locator('[data-approval-id="act_too_many"]')).toHaveCount(0);

  // a thread written ahead: all three posts are on the page without a click, numbered, with the time it goes out
  const ahead = queue.locator('[data-approval-id="sch_00000000000000a1"]');
  await expect(ahead).toHaveAttribute('data-parts', '3');
  await expect(ahead).toContainText('Thread of 3');
  await expect(ahead).toContainText('Written ahead');
  await expect(ahead.getByTestId('approval-text')).toContainText('First: how the fee split of this coin works.');
  const parts = ahead.getByTestId('approval-thread-part');
  await expect(parts).toHaveCount(2);
  await expect(parts.nth(0)).toBeVisible();
  await expect(parts.nth(0)).toContainText('2/3');
  await expect(parts.nth(0)).toContainText('Second: the agent’s share pays for its own thinking.');
  await expect(parts.nth(1)).toBeVisible();
  await expect(parts.nth(1)).toContainText('3/3');
  await expect(parts.nth(1)).toContainText('Third: the split is locked at launch.');
  await expect(ahead).toContainText('Approving sends all 3 posts, connected as one thread.');
  const when = ahead.getByTestId('approval-scheduled');
  await expect(when).toContainText(/^Goes out .+ \(in 3 h\), and only if you approve it\. Not approved in time, it is not sent\.$/);
  // its own time is its deadline: the queue's 48 hours are not shown on it
  await expect(ahead).not.toContainText('expires in');

  // a thread that goes out on approval: no time, the queue's own expiry, and a hostile text shown as text
  const now = queue.locator('[data-approval-id="act_thread_now"]');
  await expect(now).toContainText('Thread of 4');
  await expect(now).not.toContainText('Written ahead');
  await expect(now.getByTestId('approval-scheduled')).toHaveCount(0);
  await expect(now).toContainText('expires in');
  await expect(now.getByTestId('approval-thread-part')).toHaveCount(3);
  await expect(now.getByTestId('approval-thread-part').nth(0)).toContainText(HOSTILE);
  await expect(now.locator('img')).toHaveCount(0);
  await expect(now.getByTestId('approval-thread').locator('a')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();

  // a single post is what it always was
  const single = queue.locator('[data-approval-id="act_single"]');
  await expect(single).toHaveAttribute('data-parts', '1');
  await expect(single.getByTestId('approval-thread')).toHaveCount(0);
  await expect(single).not.toContainText(/Thread of|1\/1/);
  await expect(single).toContainText('expires in');
  await expect(queue).not.toContainText(JARGON);

  // approving the post written ahead says it goes out at its time, not that it was posted
  await ahead.getByRole('button', { name: 'Approve' }).click();
  await expect(page.getByText(/^Approved: it goes out .+\.$/)).toBeVisible();
  expect(decided).toEqual([{ approvalId: 'sch_00000000000000a1', decision: 'approve' }]);
  await expect(items).toHaveCount(2);
  // rejecting a thread rejects all of it: one decision
  await now.getByRole('button', { name: 'Reject' }).click();
  await expect(page.getByText(/Rejected\. The agent will see your note/)).toBeVisible();
  expect(decided).toHaveLength(2);
});

test('review queue on a phone: a thread written ahead fits the screen with every post readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await answerQueue(page);
  const queue = await openQueue(page);
  const ahead = queue.locator('[data-approval-id="sch_00000000000000a1"]');
  await expect(ahead.getByTestId('approval-scheduled')).toBeVisible();
  for (const part of await ahead.getByTestId('approval-thread-part').all()) await expect(part).toBeVisible();
  // the longest post a thread can hold, with no space in it, wraps inside the screen
  const long = queue.locator('[data-approval-id="act_thread_now"]').getByTestId('approval-thread-part').nth(2);
  await long.scrollIntoViewIfNeeded();
  const box = (await long.boundingBox())!;
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  await expect(ahead.getByRole('button', { name: 'Approve' })).toBeVisible();
  await fits(page);
});

const OWN_POST = 'https://x.com/quiet_engine/status/1850000000000000009';
const SOURCE = 'https://x.com/base/status/1850000000000000001';

/** The tape as the agent service sends it: a comment, a comment by an own agent, a cut thread, and rows with a hostile source. */
const serviceTape = () => ({
  items: [
    { at: iso(-0.1), kind: 'post', summary: 'Commented on a post by @base', url: OWN_POST, about: { handle: 'base', postId: '1850000000000000001', url: 'https://evil.example/not-x' } },
    { at: iso(-0.2), kind: 'post', summary: 'Commented on a post by @jessepollak · own agent', url: 'https://x.com/quiet_engine/status/1850000000000000008', about: { handle: 'jessepollak', postId: '1850000000000000002', url: 'https://x.com/jessepollak/status/1850000000000000002' } },
    { at: iso(-0.3), kind: 'post', summary: 'Posted a thread on X (2 of 4 posts)', url: 'https://x.com/quiet_engine/status/1850000000000000007' },
    { at: iso(-0.4), kind: 'post', summary: 'Commented on a post by @someone', url: 'https://x.com/quiet_engine/status/1850000000000000006', about: { handle: 'some/../one', postId: '1850000000000000003', url: 'https://x.com/someone/status/1850000000000000003' } },
    { at: iso(-0.5), kind: 'post', summary: 'Commented on a post by @other', url: 'https://x.com/quiet_engine/status/1850000000000000005', about: { handle: 'other', postId: '12"><script>window.__pwned=1</script>', url: 'javascript:alert(1)' } },
    { at: iso(-0.6), kind: 'post', summary: 'A scheduled post missed its time and was not sent' },
  ],
});

async function openTape(page: Page) {
  await page.route('**/api/agents/*/posts*', (route) => route.fulfill({ json: { handle: 'quiet_engine', items: [] } }));
  await page.route('**/api/agent/*/activity*', (route) => route.fulfill({ json: sanitizeActivity(serviceTape()) }));
  await page.goto('/');
  const href = await page.locator('main a[href^="/token/0x"]').first().getAttribute('href');
  await page.goto(href!);
  const tape = page.getByTestId('activity-tape');
  await expect(tape.getByRole('listitem')).toHaveCount(6);
  return tape;
}

test('activity: a comment names whose post it is about and links that post, beside the link to the agent’s own post', async ({ page }) => {
  const tape = await openTape(page);
  const rows = tape.getByRole('listitem');

  const comment = rows.nth(0);
  await expect(comment).toHaveAttribute('data-comment', 'true');
  await expect(comment).toContainText('Commented on a post by @base');
  const about = comment.getByTestId('activity-about');
  await expect(about).toHaveText('a post by @base');
  // the link is built from the handle and the post id: what the service sent as a link is not used
  await expect(about).toHaveAttribute('href', SOURCE);
  await expect(about).toHaveAttribute('target', '_blank');
  await expect(about).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(comment.getByTestId('activity-own-post')).toHaveAttribute('href', OWN_POST);
  await expect(comment.getByTestId('activity-own-post')).toHaveAttribute('aria-label', 'View the agent’s post on X');
  // two links side by side, never one inside the other
  await expect(comment.locator('a')).toHaveCount(2);
  await expect(comment.locator('a a')).toHaveCount(0);

  // what follows the name stays on the line
  await expect(rows.nth(1)).toContainText('Commented on a post by @jessepollak · own agent');
  await expect(rows.nth(1).getByTestId('activity-about')).toHaveAttribute('href', 'https://x.com/jessepollak/status/1850000000000000002');

  // a thread is one row that says how many of its posts went out
  await expect(rows.nth(2)).toContainText('Posted a thread on X (2 of 4 posts)');
  await expect(rows.nth(2).locator('a')).toHaveCount(1);

  // a source whose handle or post id is not in X's own form is not linked: the row is an ordinary post row
  for (const i of [3, 4]) {
    await expect(rows.nth(i)).not.toHaveAttribute('data-comment', 'true');
    await expect(rows.nth(i).getByTestId('activity-about')).toHaveCount(0);
    await expect(rows.nth(i).locator('a')).toHaveCount(1);
    await expect(rows.nth(i).locator('a')).toHaveAttribute('href', /^https:\/\/x\.com\/quiet_engine\/status\/\d+$/);
  }
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  for (const href of await tape.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href') ?? ''))) expect(href).toMatch(/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}(\/status\/\d{1,25})?$/);

  // a post that did not go out has no link at all
  await expect(rows.nth(5)).toContainText('A scheduled post missed its time and was not sent');
  await expect(rows.nth(5).locator('a')).toHaveCount(0);

  // comments are posts: the Posts filter keeps them
  await page.getByRole('tab', { name: 'Posts' }).click();
  await expect(tape.getByTestId('activity-about')).toHaveCount(2);
  await expect(tape).not.toContainText(JARGON);
});

test('activity on a phone: a comment’s two links fit the screen and can both be tapped', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const tape = await openTape(page);
  const comment = tape.getByRole('listitem').nth(0);
  await comment.scrollIntoViewIfNeeded();
  const about = (await comment.getByTestId('activity-about').boundingBox())!;
  const own = (await comment.getByTestId('activity-own-post').boundingBox())!;
  expect(about.x + about.width).toBeLessThanOrEqual(390);
  expect(own.x + own.width).toBeLessThanOrEqual(390);
  // the two do not sit on top of each other
  expect(about.x + about.width).toBeLessThanOrEqual(own.x);
  await fits(page);
});
