import { expect, test, type Locator, type Page } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/**
 * The console's controls for the agent's newer tools (docs/design/agent-tools-2.md): comments and who gets a reply
 * and the posts written ahead (Posting), and the agent's note on what works (Mind). Mock
 * mode, where everyone is the creator and nothing is signed. The scheduled-posts routes belong to another part of the
 * release, so this spec answers them itself.
 *
 * Mock mode keeps one store for the whole run, and these tests save settings and clear a note. Each test therefore
 * works on a coin of its own (`coin`, counted from the end of the home page's Active tab), and never on the first coin
 * of the home page or of that tab, which the other specs use and expect to find unedited.
 */

const JARGON = /\b(runner|kernel|session key|relay|lease|tick|supervisor)\b/i;

const coinLinks = async (page: Page, path: string): Promise<string[]> => {
  await page.goto(path);
  const links = page.locator('a[href^="/token/0x"]');
  await expect(links.first()).toBeVisible();
  return [...new Set(await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')!.split('?')[0]!)))];
};

async function openConsole(page: Page, section: 'mind' | 'posting', coin: number) {
  await fakeInjectedWallet(page);
  const [first] = await coinLinks(page, '/');
  const active = await coinLinks(page, '/?tab=active');
  const own = active.slice(1).filter((href) => href !== first);
  expect(own.length).toBeGreaterThan(coin);
  const href = own[own.length - 1 - coin]!;
  expect(href).toMatch(/^\/token\/0x[0-9a-fA-F]{40}$/);
  await page.goto(`${href}/console?section=${section}`);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  return console_;
}

const hours = (n: number) => new Date(Date.now() + n * 3_600_000).toISOString();
const SCHEDULED = () => [
  { id: 'sch_00000000000000a1', sendAt: hours(3), status: 'waiting', text: 'Holders passed 300 this week. Here is what changed since the last count.', parts: 1, picture: false },
  { id: 'sch_00000000000000a2', sendAt: hours(20), status: 'waiting_review', text: 'A short thread on how the fee split of this coin works, in three posts.', parts: 3, picture: true, thread: ['Second: the agent’s share pays for its own thinking.', 'Third: the split is locked at launch.'] },
];

/** Answers the two scheduled-posts routes: the list, and a cancel that removes the post from it. */
async function answerScheduled(page: Page) {
  let items = SCHEDULED();
  const cancelled: string[] = [];
  await page.route('**/api/agent/*/scheduled/list', (route) => route.fulfill({ json: { items, mayQueue: 6 - items.length, token: 'mock-review-token' } }));
  await page.route('**/api/agent/*/scheduled/cancel', async (route) => {
    const { id } = route.request().postDataJSON() as { id: string };
    cancelled.push(id);
    items = items.filter((i) => i.id !== id);
    await route.fulfill({ json: { items, mayQueue: 6 - items.length, token: 'mock-review-token' } });
  });
  return cancelled;
}

async function save(console_: Locator, page: Page) {
  await console_.getByRole('button', { name: 'Save changes' }).click();
  // a second save can land while the first one's toast is still up
  await expect(page.getByText(/Agent updated/).last()).toBeVisible();
}

test('posting: comments can be switched off and replies widened, and both are saved', async ({ page }) => {
  const console_ = await openConsole(page, 'posting', 0);
  const comments = console_.getByRole('switch', { name: 'Comment on posts it read' });
  await expect(comments).toHaveAttribute('aria-checked', 'true');
  await expect(console_.getByTestId('comments-switch')).toContainText('The author is not notified.');
  await expect(console_.getByTestId('comments-switch')).not.toContainText(JARGON);

  const audience = console_.locator('#console-reply-audience');
  await expect(audience).toContainText('Verified accounts and other Bootr agents');
  await expect(console_.getByTestId('reply-audience-note')).toContainText('Everyone else is read and not answered.');

  await comments.click();
  await expect(comments).toHaveAttribute('aria-checked', 'false');
  await audience.click();
  await page.getByRole('option', { name: 'Also anyone who replies under its own posts' }).click();
  await expect(console_.getByTestId('reply-audience-note')).toContainText('It never replies to someone who did not write to it first.');
  await expect(console_.getByTestId('reply-audience-note')).not.toContainText(JARGON);
  await expect(console_.getByTestId('console-dirty-posting')).toBeVisible();
  await expect(console_.getByTestId('console-save-state')).toHaveText('Unsaved changes in Posting');
  await save(console_, page);

  // what was saved is what the page shows after a reload
  await page.reload();
  await expect(console_.getByRole('switch', { name: 'Comment on posts it read' })).toHaveAttribute('aria-checked', 'false');
  await expect(console_.locator('#console-reply-audience')).toContainText('Also anyone who replies under its own posts');
});

test('posting: the posts written ahead are listed with their time, and one can be cancelled', async ({ page }) => {
  const cancelled = await answerScheduled(page);
  const console_ = await openConsole(page, 'posting', 1);
  const box = console_.getByTestId('scheduled-posts');
  await expect(box).toHaveAttribute('data-open', 'false');
  await expect(box).toContainText('Opening the list takes one wallet signature.');
  await box.getByTestId('scheduled-open').click();

  await expect(box.getByTestId('scheduled-count')).toHaveText('2 waiting');
  const rows = box.getByTestId('scheduled-post');
  await expect(rows).toHaveCount(2);
  // soonest first; a thread says how long it is and that it carries a picture, a post in review says where it waits
  await expect(rows.nth(0)).toContainText('Holders passed 300 this week.');
  await expect(rows.nth(0)).toContainText('in 3 h');
  await expect(rows.nth(0)).toContainText('Waiting');
  await expect(rows.nth(1)).toContainText('Waits for your review');
  await expect(rows.nth(1)).toContainText('thread of 3 · with a picture');
  // the creator can read every post of a thread before it goes out
  await rows.nth(1).getByText('The rest of the thread').click();
  await expect(rows.nth(1).getByTestId('scheduled-thread')).toContainText('Third: the split is locked at launch.');
  await expect(box.getByTestId('scheduled-note')).toContainText('4 more posts may wait.');
  await expect(box).not.toContainText(JARGON);

  // cancelling asks once, and "Keep it" changes nothing
  await rows.nth(0).getByTestId('scheduled-cancel').click();
  await rows.nth(0).getByRole('button', { name: 'Keep it' }).click();
  expect(cancelled).toEqual([]);
  await rows.nth(0).getByTestId('scheduled-cancel').click();
  await rows.nth(0).getByTestId('scheduled-cancel-confirm').click();
  await expect(page.getByText('Post cancelled. It will not go out.')).toBeVisible();
  await expect(rows).toHaveCount(1);
  await expect(box.getByTestId('scheduled-count')).toHaveText('1 waiting');
  expect(cancelled).toEqual(['sch_00000000000000a1']);
});

test('posting: an empty schedule and an unreachable one each say so in a sentence', async ({ page }) => {
  let down = false;
  await page.route('**/api/agent/*/scheduled/list', (route) =>
    down ? route.fulfill({ status: 503, json: { error: 'supervisor_unavailable', message: 'The agent service is unavailable right now.' } }) : route.fulfill({ json: { items: [], mayQueue: 6, token: 'mock-review-token' } }),
  );
  const console_ = await openConsole(page, 'posting', 1);
  const box = console_.getByTestId('scheduled-posts');
  await box.getByTestId('scheduled-open').click();
  await expect(box.getByTestId('scheduled-empty')).toHaveText('Nothing is scheduled.');
  await expect(box.getByTestId('scheduled-count')).toHaveText('0 waiting');

  down = true;
  await page.reload();
  const again = console_.getByTestId('scheduled-posts');
  await again.getByTestId('scheduled-open').click();
  await expect(page.getByText('The scheduled posts are unavailable right now.').first()).toBeVisible();
  await expect(again.getByTestId('scheduled-post')).toHaveCount(0);
});

test('mind: a coin has no list of accounts to follow', async ({ page }) => {
  const console_ = await openConsole(page, 'mind', 2);
  await expect(console_.locator('#console-instructions')).toBeVisible();
  await expect(console_.getByTestId('what-works-card')).toBeVisible();
  await expect(console_.getByTestId('watchlist')).toHaveCount(0);
  await expect(console_.getByText('Accounts to follow')).toHaveCount(0);
  await expect(console_.getByRole('button', { name: 'Add an account' })).toHaveCount(0);
});

test('mind: the agent’s note on what works shows with its numbers and earlier versions, and can be cleared', async ({ page }) => {
  const console_ = await openConsole(page, 'mind', 3);
  const card = console_.getByTestId('what-works-card');
  await expect(card).toHaveAttribute('data-open', 'false');
  await expect(card).toContainText('no rule and no limit depends on it');
  await card.getByTestId('what-works-open').click();

  const current = card.getByTestId('what-works-current');
  await expect(current).toContainText('Posts with a picture draw about twice the responses of plain ones.');
  await expect(current).toContainText(/Written 3d ago · may be rewritten from /);
  await current.getByText('The numbers it was written from').click();
  await expect(current.getByTestId('what-works-facts')).toContainText('with a picture: 14 posts, median 9 responses; without: 31 posts, median 4');
  const earlier = card.getByTestId('what-works-earlier');
  await expect(earlier).toContainText('Earlier versions 1');
  await earlier.getByText('Earlier versions').click();
  await expect(earlier.getByTestId('what-works-earlier-item')).toContainText('Too early to say more.');
  await expect(card).not.toContainText(JARGON);

  // clearing asks once; afterwards there is no note in force and the cleared one is among the earlier versions
  await current.getByTestId('what-works-clear').click();
  await expect(current).toContainText('Clear this note?');
  await current.getByTestId('what-works-clear-confirm').click();
  await expect(page.getByText('Note cleared. Your agent starts its next turn without it.')).toBeVisible();
  await expect(card.getByTestId('what-works-current')).toHaveCount(0);
  await expect(card.getByTestId('what-works-empty')).toContainText('You cleared the note.');
  await expect(card.getByTestId('what-works-earlier')).toContainText('Earlier versions 3');
});

test('on a phone every new control fits the screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await answerScheduled(page);
  const fits = async () => expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);

  const console_ = await openConsole(page, 'posting', 4);
  await console_.getByTestId('scheduled-posts').getByTestId('scheduled-open').click();
  await expect(console_.getByTestId('scheduled-post')).toHaveCount(2);
  await console_.getByTestId('scheduled-post').nth(0).getByTestId('scheduled-cancel').click();
  for (const id of ['comments-switch', 'reply-audience', 'scheduled-posts']) await expect(console_.getByTestId(id)).toBeVisible();
  await fits();

  await console_.getByRole('tab', { name: 'Mind' }).click();
  // the console session is open since the scheduled list asked for it, so the note loads without another signature
  await expect(console_.getByTestId('what-works-card').getByTestId('what-works-open')).toHaveCount(0);
  await expect(console_.getByTestId('what-works-current')).toBeVisible();
  await console_.getByTestId('what-works-current').getByTestId('what-works-clear').click();
  await fits();
});

test('the coin page tells the creator what X asks of an automated account, where they connect it', async ({ page }) => {
  await fakeInjectedWallet(page);
  const hrefs = await coinLinks(page, '/?tab=active');
  // about one mock coin in ten has no X account yet: its page opens with the connect panel
  let found = false;
  for (const href of hrefs.slice(0, 60)) {
    await page.goto(href);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    if ((await page.getByTestId('creator-x-banner').count()) === 0) continue;
    const note = page.getByTestId('connect-agent-x').getByTestId('x-automated-note');
    await expect(note).toContainText('turn on the Automated label in that X account’s settings');
    await expect(note).toContainText('run by an AI agent on Bootr and who is behind it');
    await expect(note).toContainText('X’s rules for automated accounts ask for both.');
    found = true;
    break;
  }
  expect(found, 'a mock coin without an X account').toBe(true);
});
