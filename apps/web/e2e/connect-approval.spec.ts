import { expect, test, type Page, type Route } from '@playwright/test';
import { connectCoinStatement, connectDraftStatement, OWN_ERRORS, type CoinRef, type ConnectApproveRequest, type ConnectApproveResponse, type ConnectCoinsResponse } from '@bootr/shared/own-agent';
import { MOCK_CODES, MOCK_WALLET_WITHOUT_COINS } from '../lib/mock-own';
import { LAUNCH_DRAFT_KEY } from '../lib/own-agent';
import { connectBrowserWallet, E2E_WALLET, fakeInjectedWallet } from './fake-wallet';

/**
 * `/connect/<code>`, where a creator approves an AI client for a coin's agent (docs/design/byo-agent.md section 3.2).
 * Mock mode: the connection requests and the coins come from `lib/mock-own.ts` through the real routes, and nothing is
 * signed. The suite's server runs with own agents switched off, so the flag is answered here (`/api/platform`), and so
 * is the approval itself, with answers shaped by the contract's types: with the flag off the real route refuses.
 */

const DRAFT = '8b7d05c6-a4b4-415c-93cf-46f36b679889';

async function ownAgents(page: Page, on: boolean) {
  await page.route('**/api/platform', (route) => route.fulfill({ json: { launchesPaused: false, allowedModels: [], ownAgent: on } }));
}

/** The wallet's coins as the page will list them, from the real route. */
async function coinsOf(page: Page, wallet = E2E_WALLET): Promise<CoinRef[]> {
  const res = await page.request.get(`/api/agent/connect/coins?creator=${wallet}`);
  expect(res.status()).toBe(200);
  return ((await res.json()) as ConnectCoinsResponse).coins;
}

/** Answers the approval with `answer` and keeps what the page sent. */
async function onApprove(page: Page, answer: (body: ConnectApproveRequest) => { status?: number; json: unknown }) {
  const sent: ConnectApproveRequest[] = [];
  await page.route('**/api/agent/connect/approve', async (route: Route) => {
    const body = route.request().postDataJSON() as ConnectApproveRequest;
    sent.push(body);
    const { status = 200, json } = answer(body);
    await route.fulfill({ status, json });
  });
  return sent;
}

test('with own agents switched off, the page says so and offers nothing to sign', async ({ page }) => {
  await ownAgents(page, false);
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await expect(page.getByTestId('connect-disabled')).toContainText('switched off on this site for now');
  await expect(page.getByTestId('connect-code')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Approve with wallet' })).toHaveCount(0);
});

test('the page follows what the site itself says about the flag', async ({ page }) => {
  const platform = (await (await page.request.get('/api/platform')).json()) as { ownAgent: boolean };
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  if (platform.ownAgent) await expect(page.getByTestId('connect-code')).toHaveText(MOCK_CODES.pending);
  else await expect(page.getByTestId('connect-disabled')).toBeVisible();
});

test('a pending code: the code, the warning, the client’s name, then the wallet, the coin and the exact sentence signed', async ({ page }) => {
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  const coins = await coinsOf(page);
  expect(coins.length).toBeGreaterThan(1);
  const coin = coins[0]!;
  const sent = await onApprove(page, (body) => ({ json: { ok: true, target: { kind: 'coin', coin }, label: body.label ?? 'Claude Code' } satisfies ConnectApproveResponse }));

  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await expect(page.getByRole('heading', { name: 'Connect an AI client' })).toBeVisible();
  await expect(page.getByTestId('connect-code')).toHaveText(MOCK_CODES.pending);
  await expect(page.getByTestId('connect-warning')).toContainText('Approve only if this code is on your own screen');
  await expect(page.getByTestId('connect-warning')).toContainText('If someone sent you this link');
  await expect(page.getByTestId('connect-client')).toHaveText('Claude Code');
  // Nothing can be approved before a wallet is connected.
  await expect(page.getByTestId('connect-approve')).toHaveCount(0);
  await expect(page.getByText('Connect the wallet that launched the coin')).toBeVisible();

  await connectBrowserWallet(page);
  for (const c of coins) await expect(page.getByTestId(`connect-choice-${c.symbol}`)).toBeVisible();
  // With more than one coin nothing is chosen for the creator.
  await expect(page.getByTestId('connect-approve')).toBeDisabled();
  await expect(page.getByTestId('connect-statement')).toHaveCount(0);
  await page.getByTestId(`connect-choice-${coin.symbol}`).check();
  const statement = connectCoinStatement(coin.symbol, coin.agentId, coin.kernel, MOCK_CODES.pending);
  await expect(page.getByTestId('connect-statement')).toHaveText(statement);
  await expect(page.getByText('Signing moves no funds.')).toBeVisible();
  await page.getByLabel('Your name for this client').fill('  My laptop ');
  await page.getByTestId('connect-approve').click();

  await expect(page.getByTestId('connect-done')).toContainText(`My laptop can now run the agent of $${coin.symbol}.`);
  await expect(page.getByTestId('connect-done')).toContainText('Go back to your AI client');
  await expect(page.getByRole('link', { name: 'Open the creator console' })).toHaveAttribute('href', `/token/${coin.token}/console`);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({ userCode: MOCK_CODES.pending, label: 'My laptop' });
  // The signed message carries the sentence the page showed, for the code the page showed, and the wallet that connected.
  expect(sent[0]!.message).toContain(statement);
  expect(sent[0]!.message.toLowerCase()).toContain(E2E_WALLET);
  // No secret is shown or stored by this page.
  expect(await page.content()).not.toContain('bootr_agt_');
});

test('the coin the client named comes first', async ({ page }) => {
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  const coins = await coinsOf(page);
  await page.goto(`/connect/${MOCK_CODES.hinted}`);
  await connectBrowserWallet(page);
  await expect(page.locator('input[name="connect-target"]').first()).toHaveAttribute('data-testid', `connect-choice-${coins[1]!.symbol}`);
});

test('a request for one coin shows that coin fixed, with its treasury address, and nothing else to choose', async ({ page }) => {
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  const coins = await coinsOf(page);
  const coin = coins[1]!;
  // This browser also holds a launch draft: a request for one coin does not offer it.
  await page.addInitScript(([key, draftId]) => window.localStorage.setItem(key!, JSON.stringify({ draftId, at: Date.now() - 60_000 })), [LAUNCH_DRAFT_KEY, DRAFT]);
  const sent = await onApprove(page, (body) => ({ json: { ok: true, target: { kind: 'coin', coin }, label: body.label ?? 'Claude Code' } satisfies ConnectApproveResponse }));
  await page.goto(`/connect/${MOCK_CODES.bound}`);
  await connectBrowserWallet(page);
  const fixed = page.getByTestId('connect-bound-coin');
  await expect(fixed).toContainText('The client asked to run the agent of this coin, and of no other');
  await expect(fixed).toContainText(`$${coin.symbol}`);
  await expect(fixed).toContainText(`treasury address ${coin.kernel}`);
  await expect(page.getByRole('heading', { name: '2. Check the coin and approve' })).toBeVisible();
  await expect(page.locator('input[name="connect-target"]')).toHaveCount(0);
  await expect(page.getByTestId('connect-choice-draft')).toHaveCount(0);
  // The sentence is there at once, for that coin, and that is what gets signed.
  const statement = connectCoinStatement(coin.symbol, coin.agentId, coin.kernel, MOCK_CODES.bound);
  await expect(page.getByTestId('connect-statement')).toHaveText(statement);
  await page.getByTestId('connect-approve').click();
  await expect(page.getByTestId('connect-done')).toContainText(`can now run the agent of $${coin.symbol}.`);
  expect(sent[0]!.message).toContain(statement);
});

test('a request for one coin cannot be approved for another, by the page or around it', async ({ page }) => {
  await ownAgents(page, true);
  const coins = await coinsOf(page);
  // The request itself says which coin it is for.
  const view = (await (await page.request.get(`/api/agent/connect/grant?code=${MOCK_CODES.bound}`)).json()) as { coin?: CoinRef | null };
  expect(view.coin).toEqual(coins[1]);
  expect(((await (await page.request.get(`/api/agent/connect/grant?code=${MOCK_CODES.hinted}`)).json()) as { coin?: CoinRef | null }).coin ?? null).toBeNull();
  // A wallet that did not launch that coin is told so and is offered nothing to sign, its other coins and its draft included.
  await fakeInjectedWallet(page, MOCK_WALLET_WITHOUT_COINS);
  await page.addInitScript(([key, draftId]) => window.localStorage.setItem(key!, JSON.stringify({ draftId, at: Date.now() - 60_000 })), [LAUNCH_DRAFT_KEY, DRAFT]);
  await page.goto(`/connect/${MOCK_CODES.bound}`);
  await connectBrowserWallet(page);
  await expect(page.getByTestId('connect-bound-other')).toContainText(`$${coins[1]!.symbol}`);
  await expect(page.getByTestId('connect-bound-other')).toContainText(coins[1]!.kernel);
  await expect(page.getByTestId('connect-bound-other')).toContainText('cannot be approved for any other coin');
  await expect(page.getByTestId('connect-approve')).toHaveCount(0);
  await expect(page.getByTestId('connect-choice-draft')).toHaveCount(0);
});

test('an expired code and a used code offer nothing to sign', async ({ page }) => {
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  await page.goto(`/connect/${MOCK_CODES.expired}`);
  await expect(page.getByTestId('connect-state')).toContainText('A connection request lasts 10 minutes');
  await expect(page.getByTestId('connect-state')).toContainText('Ask your AI client to connect again');
  await expect(page.getByTestId('connect-approve')).toHaveCount(0);
  await expect(page.getByRole('main').getByRole('button', { name: 'Connect wallet' })).toHaveCount(0);

  await page.goto(`/connect/${MOCK_CODES.used}`);
  await expect(page.getByTestId('connect-state')).toContainText('was approved already');
  await expect(page.getByTestId('connect-state')).toContainText('disconnect the client');
  await expect(page.getByTestId('connect-approve')).toHaveCount(0);
});

test('an unknown or malformed code asks for the code, and a typed one is made canonical', async ({ page }) => {
  await ownAgents(page, true);
  await page.goto('/connect/ZZZZ-ZZZZ');
  await expect(page.getByTestId('connect-state')).toContainText('No connection request has that code');
  await page.goto('/connect/hello');
  await expect(page.getByTestId('connect-state')).toContainText('This link carries no valid code');
  const field = page.getByLabel('The code your AI client shows');
  await field.fill('abcd-efgh');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('That is not a code')).toBeVisible();
  await field.fill('bcdf ghjk');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page).toHaveURL(new RegExp(`/connect/${MOCK_CODES.pending}$`));
  await expect(page.getByTestId('connect-code')).toHaveText(MOCK_CODES.pending);
  // A link typed in lower case reads the same request.
  await page.goto(`/connect/${MOCK_CODES.pending.toLowerCase()}`);
  await expect(page.getByTestId('connect-code')).toHaveText(MOCK_CODES.pending);
});

test('a wrong wallet: one that launched nothing is told so and is offered nothing to sign', async ({ page }) => {
  await fakeInjectedWallet(page, MOCK_WALLET_WITHOUT_COINS);
  await ownAgents(page, true);
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await connectBrowserWallet(page);
  await expect(page.getByTestId('connect-no-coins')).toContainText('has launched no Bootr coin');
  await expect(page.getByTestId('connect-approve')).toHaveCount(0);
});

test('a refusal keeps the page as it was and says what to do', async ({ page }) => {
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  const coin = (await coinsOf(page))[0]!;
  let answer: keyof typeof OWN_ERRORS = 'not_creator';
  await onApprove(page, () => ({ status: OWN_ERRORS[answer].status, json: { error: answer, message: '<b>text from the response is never shown</b>' } }));
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await connectBrowserWallet(page);
  await page.getByTestId(`connect-choice-${coin.symbol}`).check();
  await page.getByTestId('connect-approve').click();
  await expect(page.getByTestId('connect-problem')).toContainText('This wallet did not launch that coin');
  await expect(page.getByTestId('connect-done')).toHaveCount(0);
  answer = 'too_many_clients';
  await page.getByTestId('connect-approve').click();
  await expect(page.getByTestId('connect-problem')).toContainText('Disconnect one in the creator console');
  answer = 'own_agent_disabled';
  await page.getByTestId('connect-approve').click();
  await expect(page.getByTestId('connect-problem')).toContainText('switched off on this site right now');
  await expect(page.getByText('text from the response')).toHaveCount(0);
});

test('the draft of this browser’s next launch can be approved, and an old draft is not offered', async ({ page }) => {
  await fakeInjectedWallet(page, MOCK_WALLET_WITHOUT_COINS);
  await ownAgents(page, true);
  await page.addInitScript(([key, draftId]) => window.localStorage.setItem(key!, JSON.stringify({ draftId, at: Date.now() - 60_000 })), [LAUNCH_DRAFT_KEY, DRAFT]);
  const sent = await onApprove(page, () => ({ json: { ok: true, target: { kind: 'draft', draftId: DRAFT }, label: 'Claude Code' } satisfies ConnectApproveResponse }));
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await connectBrowserWallet(page);
  // The only choice, so it is chosen; the sentence names the draft and the code.
  await expect(page.getByTestId('connect-choice-draft')).toBeChecked();
  await expect(page.getByTestId('connect-statement')).toHaveText(connectDraftStatement(DRAFT, MOCK_CODES.pending));
  await page.getByTestId('connect-approve').click();
  await expect(page.getByTestId('connect-done')).toContainText('will run the agent of your next launch');
  await expect(page.getByRole('link', { name: 'Back to launch' })).toBeVisible();
  expect(sent[0]!.message).toContain(connectDraftStatement(DRAFT, MOCK_CODES.pending));
  expect(sent[0]!.label).toBeUndefined();
});

test('a draft older than a day is not offered', async ({ page }) => {
  await fakeInjectedWallet(page, MOCK_WALLET_WITHOUT_COINS);
  await ownAgents(page, true);
  await page.addInitScript(([key, draftId]) => window.localStorage.setItem(key!, JSON.stringify({ draftId, at: Date.now() - 2 * 86_400_000 })), [LAUNCH_DRAFT_KEY, DRAFT]);
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await connectBrowserWallet(page);
  await expect(page.getByTestId('connect-no-coins')).toBeVisible();
  await expect(page.getByTestId('connect-choice-draft')).toHaveCount(0);
});

test('on a phone the page fits and the code stays in view', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await fakeInjectedWallet(page);
  await ownAgents(page, true);
  await page.goto(`/connect/${MOCK_CODES.pending}`);
  await expect(page.getByTestId('connect-code')).toBeInViewport();
  await expect(page.getByTestId('connect-warning')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('the page is not indexed and cannot be framed', async ({ page }) => {
  const res = await page.goto(`/connect/${MOCK_CODES.pending}`);
  expect(res!.headers()['x-frame-options']).toBe('DENY');
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute('content', /noindex/);
});
