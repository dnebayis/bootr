import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import type { AgentConfig } from '../lib/types';
import { fakeInjectedWallet } from './fake-wallet';

/**
 * Bring your own agent, the parts of it this site shows (docs/design/byo-agent.md sections 5 and 13): the launch page's
 * first choice and its two paths, the console's Agent card and the switch in both directions, the hidden chat, the
 * coin page's status line, and all of it with own agents switched off.
 *
 * The e2e build runs with own agents switched off, as the site does until release. A test that needs them on answers
 * `GET /api/platform` with `ownAgent: true` (the field the launch page and the console read). The routes that belong to
 * the connect-and-run surface are not part of this build and are answered here with fixtures typed by the contract
 * (`@bootr/shared/own-agent`): the draft's clients (route 5) and a coin's clients (routes 13 and 14). The switch itself
 * (`POST /api/agent/:kernel/runner`) is the real route, on mock mode's store.
 *
 * The switch tests change a coin on the server's mock store, so each uses a coin of its own that no other spec opens.
 */

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const OFF_NOTE = 'Own agents are switched off here for now. This coin’s agent is silent.';
const CHAT_LINE = 'Your agent runs in your own AI client. Talk to it there.';

/** Own agents switched on, as the page sees it. */
async function ownAgentsOn(page: Page) {
  await page.route('**/api/platform', async (route) => {
    const res = await route.fetch();
    await route.fulfill({ response: res, json: { ...((await res.json()) as object), ownAgent: true } });
  });
}

/** Route 5 (`GET /api/agent/connect/draft`): the AI clients approved for this browser's launch draft. */
async function draftClients(page: Page) {
  const state = { connected: false, asked: [] as string[] };
  await page.route('**/api/agent/connect/draft**', (route) => {
    state.asked.push(new URL(route.request().url()).searchParams.get('draft') ?? '');
    return route.fulfill({ json: state.connected ? { connected: true, clients: [{ clientId: 'cli_0123456789abcdef', label: 'Claude Code', createdAt: new Date().toISOString() }] } : { connected: false, clients: [] } });
  });
  return state;
}

type Client = { clientId: string; label: string; createdAt: string; lastUsedAt: string | null; expiresAt: string };

/** Routes 13 and 14 (`/clients/list`, `/clients/revoke`), inside the console session: a coin's connected clients. */
async function coinClients(page: Page, initial: Client[]) {
  const state = { clients: [...initial], revoked: [] as unknown[] };
  const answer = () => ({ clients: state.clients, max: 3, token: 'mock-review-token' });
  await page.route('**/api/agent/*/clients/list', (route) => route.fulfill({ json: answer() }));
  await page.route('**/api/agent/*/clients/revoke', (route) => {
    const body = route.request().postDataJSON() as { clientId?: string; all?: boolean };
    state.revoked.push(body.all ? 'all' : body.clientId);
    state.clients = body.all ? [] : state.clients.filter((c) => c.clientId !== body.clientId);
    return route.fulfill({ json: answer() });
  });
  return state;
}

const laptop = (): Client => ({ clientId: 'cli_0123456789abcdef', label: 'Claude Code on my laptop', createdAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), lastUsedAt: new Date(Date.now() - 14 * 60_000).toISOString(), expiresAt: new Date(Date.now() + 87 * 86_400_000).toISOString() });

/** The coin page and treasury address of a named mock coin. Everyone is the creator in mock mode. */
async function coinOf(page: Page, name: string) {
  await fakeInjectedWallet(page);
  await page.goto('/');
  const card = page.locator('a[href^="/token/0x"]', { hasText: name }).first();
  await expect(card).toBeVisible();
  const coinUrl = (await card.getAttribute('href'))!;
  await page.goto(coinUrl);
  const agentHref = (await page.locator('a[href^="/agent/0x"]').first().getAttribute('href'))!;
  return { coinUrl, kernel: agentHref.replace('/agent/', '') };
}

/** Puts the coin on a runner through the real route (mock mode asks for no signature), whatever an earlier run left. */
async function setRunner(request: APIRequestContext, baseURL: string | undefined, kernel: string, runner: 'hosted' | 'own') {
  const res = await request.post(`/api/agent/${kernel}/runner`, { headers: { origin: baseURL ?? 'http://localhost:3210' }, data: { token: 'mock-review-token', runner } });
  expect([200, 409], await res.text()).toContain(res.status());
}

// The pages keep polling (the draft's clients, the agent's config) until they close; a fixture still answering then is not a failure.
test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const consoleOf = (page: Page) => page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });

async function fillCoin(page: Page, name: string, symbol: string) {
  await page.getByLabel('Name').fill(name);
  await page.getByLabel('Symbol').fill(symbol);
  await page.getByLabel('Instructions').fill('A patient onchain analyst for small Base coins.');
  await page.getByLabel('Launch without an X account; I will connect one later from the coin page.').check();
  await page.locator('#image-file').setInputFiles({ name: 'coin.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('image-status')).toContainText('ipfs://');
}

test.describe('own agents switched off (the site as it is until release)', () => {
  test('the launch page is the one form, with no choice; fuel is a suggestion and 0 launches', async ({ page }) => {
    await page.goto('/launch');
    await expect(page.getByRole('heading', { name: 'Coin', exact: true })).toBeVisible();
    await expect(page.getByTestId('runner-choice')).toHaveCount(0);
    await expect(page.getByTestId('own-path')).toHaveCount(0);
    // today's sections, Mind among them, numbered as before
    for (const [n, title] of [['01', 'Coin'], ['02', 'Mind'], ['03', 'Kind'], ['04', 'Character'], ['05', 'X account'], ['06', 'Fuel & options']] as const) {
      await expect(page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) }).first()).toContainText(n);
    }
    const summary = page.getByTestId('launch-summary');
    await expect(summary).toContainText('Model');
    await expect(summary).not.toContainText('My own agent');
    await expect(page.locator('#fuel')).toHaveValue('20');
    await expect(summary.getByTestId('cost-line')).toContainText('20 USDC');
    // the wording: a suggestion, never a minimum
    await expect(page.getByTestId('fuel-note')).toContainText('Suggested: 20 USDC. Fuel pays for the agent’s thinking; the Bootr agent stays silent until some arrives. Any amount, including none, launches the coin.');
    await expect(page.getByText(/Min \d+ USDC/)).toHaveCount(0);

    await fillCoin(page, 'No Fuel Yet', 'NOFUEL');
    await page.locator('#fuel').fill('0');
    await expect(page.getByText(/Fuel must be/)).toHaveCount(0);
    await expect(summary.getByTestId('cost-line')).toContainText('0 ETH + 0.001 ETH + 0 USDC');
    await page.locator('#fuel').fill('abc');
    await expect(page.getByText('Fuel must be a USDC amount; 0 is allowed.')).toBeVisible();
    await page.locator('#fuel').fill('0');
    await page.getByTestId('launch-submit').click();
    await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
    // a Bootr agent as ever: its status line names no runner, and the Agent panel shows its model
    await expect(page.getByTestId('agent-status')).not.toContainText(/Run by|own AI client/);
    await expect(page.getByTestId('agent-runner')).toHaveCount(0);
  });

  test('the console of a Bootr-agent coin has no Agent card, and its chat is where it was', async ({ page }) => {
    const { coinUrl } = await coinOf(page, 'Signal Fire');
    await page.goto(`${coinUrl}/console`);
    const console_ = consoleOf(page);
    await expect(console_.getByTestId('console-mind')).toBeVisible();
    await expect(console_.getByTestId('agent-runner-card')).toHaveCount(0);
    await expect(console_.getByLabel('Model', { exact: true })).toBeVisible();
    await expect(console_.getByTestId('economy-mode')).toBeVisible();
    await console_.getByRole('tab', { name: 'Inbox' }).click();
    await expect(console_.getByTestId('agent-chat')).toBeVisible();
    await expect(console_.getByTestId('chat-own-agent')).toHaveCount(0);
  });

  test('an own coin gets the short Agent card: it says the agent is silent, lists its clients with disconnect, and hands it back to Bootr', async ({ page, request, baseURL }) => {
    const { coinUrl, kernel } = await coinOf(page, 'Block Poet');
    await setRunner(request, baseURL, kernel, 'own');
    const clients = await coinClients(page, [laptop()]);
    await page.goto(`${coinUrl}/console`);
    const card = consoleOf(page).getByTestId('agent-runner-card');
    await expect(card).toHaveAttribute('data-form', 'own-off');
    await expect(card.getByTestId('runner-line')).toHaveText(OFF_NOTE);
    // no way to connect a client and no recipe while own agents are off
    await expect(card.getByTestId('runner-connect')).toHaveCount(0);
    await expect(card.getByTestId('keep-running')).toHaveCount(0);
    // disconnecting a client is never refused
    await card.getByTestId('runner-show-clients').click();
    await expect(card.getByTestId('runner-client')).toContainText('Claude Code on my laptop');
    await card.getByTestId('runner-client').getByRole('button', { name: 'Disconnect' }).click();
    await expect(card.getByTestId('runner-no-clients')).toBeVisible();
    expect(clients.revoked).toEqual(['cli_0123456789abcdef']);
    // the chat stays hidden for an own coin, flag or no flag
    await consoleOf(page).getByRole('tab', { name: 'Inbox' }).click();
    await expect(consoleOf(page).getByTestId('chat-own-agent')).toContainText(CHAT_LINE);
    await consoleOf(page).getByRole('tab', { name: 'Mind' }).click();

    // the switch to the Bootr agent works, and with it the card is gone: a Bootr-agent coin has none here
    await card.getByTestId('runner-switch').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByTestId('runner-fuel-line')).toContainText(/The Bootr agent pays for its thinking from fuel\. This coin holds [\d.]+ USDC; under 1 USDC it stays silent\./);
    await dialog.getByTestId('runner-confirm-hosted').click();
    await expect(consoleOf(page).getByTestId('agent-runner-card')).toHaveCount(0);
    await expect(consoleOf(page).getByLabel('Model', { exact: true })).toBeVisible();
    // and a switch to own is not on offer anywhere on the page
    await expect(page.getByRole('button', { name: 'Switch to my own agent' })).toHaveCount(0);
  });
});

test.describe('own agents switched on', () => {
  test('the launch page opens with the choice; the Bootr agent is today’s form and launches as it always did', async ({ page }) => {
    await ownAgentsOn(page);
    await page.goto('/launch');
    const choice = page.getByTestId('runner-choice');
    await expect(choice).toContainText('Who runs the agent?');
    await expect(choice.getByTestId('runner-hosted')).toContainText('Bootr runs the agent for you, around the clock. It pays for its own thinking from fuel.');
    await expect(choice.getByTestId('runner-own')).toContainText('The agent thinks in your own AI client. Your machine on, it works; off, it is silent. No fuel needed to think.');
    // public words only
    await expect(choice).not.toContainText(/session key|kernel|relay|runner|hosted|x402/i);
    // the Bootr agent is selected: the form below is the one from before
    await expect(choice.getByRole('radio', { name: /^Bootr agent/ })).toBeChecked();
    await expect(page.getByTestId('own-path')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Mind', exact: true })).toBeVisible();
    await expect(page.locator('#fuel')).toHaveValue('20');
    await expect(page.getByTestId('fuel-note')).toContainText('Suggested: 20 USDC.');
    const summary = page.getByTestId('launch-summary');
    await expect(summary.getByTestId('cost-line')).toContainText('0 ETH + 0.001 ETH + 20 USDC');

    await fillCoin(page, 'Hosted As Ever', 'HOSTD');
    const drafted = page.waitForRequest((r) => r.url().endsWith('/api/launch/draft') && r.method() === 'POST');
    await page.getByTestId('launch-submit').click();
    expect((await drafted).postDataJSON()).not.toHaveProperty('runner');
    await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
    await expect(page.getByTestId('agent-runner')).toHaveText('Bootr');
    await expect(page.getByTestId('agent-model')).not.toContainText('creator');
    await expect(page.getByTestId('agent-status')).toContainText('Run by Bootr');
  });

  test('my own agent: wallet, connect your AI client, launch; the step moves on when the client appears', async ({ page }) => {
    await ownAgentsOn(page);
    const draft = await draftClients(page);
    await page.goto('/launch');
    await page.getByTestId('runner-own').click();
    const own = page.getByTestId('own-path');
    await expect(own).toBeVisible();
    await expect(page.getByTestId('runner-choice').getByRole('radio', { name: /^My own agent/ })).toBeChecked();

    // three steps, in order; the form sits under the third and has no Mind section
    const steps = page.getByTestId('own-steps').locator('li');
    await expect(steps).toHaveText([/Wallet/, /Connect your AI client/, /Launch/]);
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'current');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'next');
    await expect(page.getByTestId('own-step-wallet')).toContainText('STEP 1 OF 3');
    await expect(page.getByTestId('own-step-connect')).toContainText('STEP 2 OF 3');
    await expect(page.getByTestId('own-step-launch')).toContainText('STEP 3 OF 3');
    await expect(page.getByRole('heading', { name: 'Mind', exact: true })).toHaveCount(0);
    await expect(page.locator('#model')).toHaveCount(0);
    for (const [n, title] of [['01', 'Coin'], ['02', 'Kind'], ['03', 'Character'], ['04', 'X account'], ['05', 'Fuel & options']] as const) {
      await expect(page.locator('section', { has: page.getByRole('heading', { name: title, exact: true }) }).first()).toContainText(n);
    }

    // fuel starts at none, with the one line that says why
    await expect(page.locator('#fuel')).toHaveValue('0');
    await expect(page.getByTestId('fuel-note')).toHaveText('Only paid services use fuel. Add some now or later, or none.');
    const summary = page.getByTestId('launch-summary');
    await expect(summary).toContainText('AgentMy own agent');
    await expect(summary).toContainText('AI clientNot connected');
    await expect(summary).not.toContainText('Model');
    await expect(summary.getByTestId('cost-line')).toContainText('0 ETH + 0.001 ETH + 0 USDC');

    // the connect step: a client per tab, the one block to paste, the sentence to say
    const connect = page.getByTestId('connect-client');
    await expect(connect).toHaveAttribute('data-connected', 'false');
    await expect(connect.getByRole('tab')).toHaveText(['Claude Code', 'Claude Desktop', 'Cursor', 'Codex', 'Other']);
    await expect(connect.getByTestId('client-install')).toContainText('claude mcp add bootr -- npx -y @bootrfun/mcp');
    await connect.getByRole('tab', { name: 'Cursor' }).click();
    await expect(connect.getByTestId('client-install')).toContainText('"mcpServers"');
    await connect.getByRole('tab', { name: 'Claude Code' }).click();
    await expect(connect).toContainText('Connect to Bootr and show me the link.');
    await expect(connect).toContainText('Approve only if the code on that page is the one on your own screen.');
    await expect(connect.getByTestId('client-waiting')).toContainText('Waiting for your AI client');
    await expect(connect).not.toContainText(/session key|kernel|relay|runner|x402|credential/i);

    // this browser's launch draft is where the approval page looks for "my next launch"
    const stored = await page.evaluate(() => ({ local: JSON.parse(window.localStorage.getItem('bootr.launchDraft') ?? 'null') as { draftId: string; at: number } | null, session: window.sessionStorage.getItem('bootr.launch.draftId') }));
    expect(stored.local?.draftId).toBe(stored.session);
    expect(stored.local?.draftId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Math.abs(Date.now() - stored.local!.at)).toBeLessThan(120_000);
    await expect.poll(() => draft.asked.at(-1)).toBe(stored.session);

    // launching silent is allowed, but never by accident
    await fillCoin(page, 'Own Mind', 'OWNMD');
    await expect(page.getByTestId('launch-submit')).toBeDisabled();
    await expect(summary).toContainText('Connect your AI client, or choose to connect it later.');
    await connect.getByTestId('connect-later').check();
    await expect(page.getByTestId('launch-submit')).toBeEnabled();
    await expect(summary).toContainText('AI clientConnect later');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await connect.getByTestId('connect-later').uncheck();
    await expect(page.getByTestId('launch-submit')).toBeDisabled();

    // the client is approved in the other tab: the step notices on its own and moves on
    draft.connected = true;
    await expect(connect).toHaveAttribute('data-connected', 'true', { timeout: 15_000 });
    await expect(connect.getByTestId('client-connected')).toContainText('Claude Code is connected');
    await expect(steps.nth(1)).toHaveAttribute('data-state', 'done');
    await expect(steps.nth(1)).toContainText('Claude Code');
    await expect(steps.nth(2)).toHaveAttribute('data-state', 'current');
    await expect(summary).toContainText('AI clientClaude Code');
    // followed by the way to keep it running, with the coin's symbol filled in
    const recipe = connect.getByTestId('keep-running');
    await expect(recipe.getByTestId('keep-running-copy')).toContainText("claude -p 'Use only the Bootr tools. For $OWNMD: ask Bootr what is due");
    await expect(recipe.getByTestId('keep-running-copy')).toContainText('--allowedTools "mcp__bootr__*"');
    await expect(recipe).toContainText('Bootr never takes over');
    await recipe.getByRole('tab', { name: 'Cursor' }).click();
    await expect(recipe.getByTestId('keep-running-summary')).toContainText('Cursor has no schedule of its own');

    // launch: no approval step, the coin exists, and it says who thinks
    await expect(page.getByRole('button', { name: /Approve/ })).toHaveCount(0);
    await expect(page.getByTestId('launch-submit')).toBeEnabled();
    await expect(page.getByTestId('launch-submit')).toHaveText('Launch');
    // Mock mode has no agent service to register the launch, so its answer for the new coin is given here: what
    // registration stores for a launch whose model is `own-agent`, with the draft's client adopted.
    await page.route('**/api/agent/*/config', async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      await route.fulfill({ response: res, json: { ...((await res.json()) as AgentConfig), runner: 'own', own: { lastTurnAt: null, clients: 1 } } satisfies AgentConfig });
    });
    await page.getByTestId('launch-submit').click();
    await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}$/);
    // launched without an X account, so that is what it waits for; an own agent is never "sleeping"
    await expect(page.getByTestId('agent-status')).toContainText('Runs in its creator’s own AI client · waiting for an X account');
    await expect(page.getByTestId('agent-status')).not.toContainText(/sleeping/i);
    await expect(page.getByTestId('agent-model')).toHaveText('creator’s own');
    await expect(page.getByTestId('agent-runner')).toHaveText('Its creator’s own AI client');
    // the draft launched: nothing is left to approve a client for
    expect(await page.evaluate(() => window.localStorage.getItem('bootr.launchDraft'))).toBeNull();
  });

  test('switching back to the Bootr agent on the launch page brings the Mind section and the suggested fuel back; a typed amount is kept', async ({ page }) => {
    await ownAgentsOn(page);
    await draftClients(page);
    await page.goto('/launch');
    await page.getByTestId('runner-own').click();
    await expect(page.locator('#fuel')).toHaveValue('0');
    await page.getByTestId('runner-hosted').click();
    await expect(page.getByTestId('own-path')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Mind', exact: true })).toBeVisible();
    await expect(page.locator('#fuel')).toHaveValue('20');
    await page.locator('#fuel').fill('7');
    await page.getByTestId('runner-own').click();
    await expect(page.locator('#fuel')).toHaveValue('7');
    await expect(page.getByTestId('launch-summary').getByTestId('cost-line')).toContainText('7 USDC');
  });

  test('the console’s Agent card switches a coin to my own agent and back, and the console follows', async ({ page, request, baseURL }) => {
    const { coinUrl, kernel } = await coinOf(page, 'Moon Clerk');
    await setRunner(request, baseURL, kernel, 'hosted');
    await ownAgentsOn(page);
    const clients = await coinClients(page, [laptop(), { ...laptop(), clientId: 'cli_fedcba9876543210', label: 'Cursor at work', lastUsedAt: null }]);
    await page.goto(`${coinUrl}/console`);
    const console_ = consoleOf(page);
    const card = console_.getByTestId('agent-runner-card');

    // a Bootr-agent coin: one line and the offer
    await expect(card).toHaveAttribute('data-form', 'hosted');
    await expect(card).toContainText('Bootr agent');
    await expect(card.getByTestId('runner-line')).toContainText('Bootr runs this agent around the clock and pays for its thinking from fuel.');
    await expect(card.getByTestId('runner-clients')).toHaveCount(0);
    await expect(console_.getByLabel('Model', { exact: true })).toBeVisible();

    // to my own agent: the dialog says what changes, in plain words
    await card.getByTestId('runner-switch').click();
    const toOwn = page.getByRole('dialog');
    await expect(toOwn).toContainText('Run this agent in your own AI client?');
    await expect(toOwn.getByTestId('runner-dialog-own')).toContainText('Your machine on, the agent works; off, it is silent. Bootr never takes over.');
    await expect(toOwn.getByTestId('runner-dialog-own')).toContainText('pays for paid services only');
    await expect(toOwn.getByTestId('runner-dialog-own')).toContainText('Nothing changes on chain, and you can switch back at any time.');
    await expect(toOwn).not.toContainText(/session key|kernel|relay|runner|hosted|x402/i);
    await toOwn.getByRole('button', { name: 'Cancel' }).click();
    await expect(card).toHaveAttribute('data-runner', 'hosted');
    await card.getByTestId('runner-switch').click();
    const switched = page.waitForResponse((r) => r.url().endsWith(`/api/agent/${kernel.toLowerCase()}/runner`) && r.request().method() === 'POST');
    await page.getByTestId('runner-confirm-own').click();
    expect(await (await switched).json()).toMatchObject({ runner: 'own', notes: ['Connect an AI client, or the agent stays silent.'] });

    // the card of an own coin: the note, its clients, how to connect one, how to keep it running
    await expect(card).toHaveAttribute('data-form', 'own');
    await expect(card).toContainText('My own agent');
    await expect(card.getByTestId('runner-line')).toContainText('This agent thinks in your own AI client. Your machine on, it works; off, it is silent.');
    await expect(card.getByTestId('runner-notes')).toContainText('Connect an AI client, or the agent stays silent.');
    await expect(card.getByTestId('runner-client')).toHaveCount(2);
    await expect(card.getByTestId('runner-client').first()).toContainText('Claude Code on my laptop');
    await expect(card.getByTestId('runner-client').first()).toContainText(/connected 3d ago · last used 1[45]m ago/);
    await expect(card.getByTestId('runner-client').nth(1)).toContainText('not used yet');
    await card.getByTestId('runner-client').nth(1).getByRole('button', { name: 'Disconnect' }).click();
    await expect(card.getByTestId('runner-client')).toHaveCount(1);
    expect(clients.revoked).toEqual(['cli_fedcba9876543210']);
    // a client is connected, so the connect steps step back behind "Connect another client"
    await expect(card.getByTestId('runner-needs-client')).toHaveCount(0);
    await expect(card.getByTestId('runner-connect').locator('summary')).toHaveText('Connect another client');
    await card.getByTestId('runner-connect').locator('summary').click();
    await expect(card.getByTestId('client-setup')).toContainText('Connect to Bootr and show me the link.');
    await expect(card.getByTestId('client-setup')).toContainText('the wallet that launched $CLERK, and pick $CLERK');
    await card.getByTestId('runner-keep-running').locator('summary').click();
    await expect(card.getByTestId('keep-running-copy')).toContainText('For $CLERK:');

    // Mind: no model to pick, no economy mode; the instructions stay
    await expect(console_.getByLabel('Model', { exact: true })).toHaveCount(0);
    await expect(console_.getByTestId('economy-mode')).toHaveCount(0);
    await expect(console_.getByLabel('Instructions')).toBeVisible();
    // Look: the style reference and notes stay, the image model goes
    await console_.getByRole('tab', { name: 'Look' }).click();
    await expect(console_.getByLabel('Style notes')).toBeVisible();
    await expect(console_.getByLabel('Reference image')).toBeVisible();
    await expect(console_.getByLabel('Image model')).toBeHidden();
    await expect(console_.getByTestId('own-pictures-note')).toContainText('Your AI client makes the pictures');
    // Inbox: the inbox and the review queue as ever, the chat replaced by its one line
    await console_.getByRole('tab', { name: 'Inbox' }).click();
    await expect(console_.getByTestId('notification-inbox')).toBeVisible();
    await expect(console_.getByTestId('agent-chat')).toHaveCount(0);
    await expect(console_.getByTestId('chat-own-agent')).toContainText(CHAT_LINE);
    await expect(console_.getByTestId('chat-input')).toHaveCount(0);
    // Fuel: paid services only
    await console_.getByRole('tab', { name: 'Fuel' }).click();
    await expect(console_.getByTestId('own-fuel-note')).toContainText('Pays for paid services only.');
    await expect(console_.getByTestId('fuel-outlook')).toHaveCount(0);
    // an old page that still shows the chat cannot buy a thought: the server refuses the message
    const chat = await request.post(`/api/agent/${kernel}/chat/send`, { headers: { origin: baseURL ?? '' }, data: { token: 'mock-review-token', text: 'What did you do today?' } });
    expect(chat.status()).toBe(409);
    expect(await chat.json()).toEqual({ error: 'chat_not_available', message: "This coin's agent runs in its creator's own AI client. Talk to it there." });

    // back to the Bootr agent: the dialog asks for the model and says what its thinking costs
    await console_.getByRole('tab', { name: 'Mind' }).click();
    await card.getByTestId('runner-switch').click();
    const toHosted = page.getByRole('dialog');
    await expect(toHosted).toContainText('Hand this agent to Bootr?');
    await expect(toHosted.getByTestId('runner-fuel-line')).toContainText(/The Bootr agent pays for its thinking from fuel\. This coin holds [\d.]+ USDC; under 1 USDC it stays silent\. No amount is required to switch\./);
    // the Fuel form sits beside the figure; no amount is required
    await expect(toHosted.getByRole('button', { name: 'Fuel the agent' })).toBeVisible();
    await expect(toHosted.getByLabel('Model it thinks with')).toBeVisible();
    await expect(toHosted).toContainText('Pictures are made by Bootr again and paid from fuel.');
    await expect(toHosted).toContainText('The chat here is back, with its history.');
    const back = page.waitForResponse((r) => r.url().endsWith(`/api/agent/${kernel.toLowerCase()}/runner`) && r.request().method() === 'POST');
    await page.getByTestId('runner-confirm-hosted').click();
    expect(((await (await back).json()) as { runner: string; notes: string[] }).notes.join(' ')).toContain('Pictures are made by Bootr again and paid from fuel.');
    await expect(card).toHaveAttribute('data-form', 'hosted');
    await expect(card.getByTestId('runner-notes')).toContainText('The Bootr agent pays for its thinking from fuel.');
    await expect(console_.getByLabel('Model', { exact: true })).toBeVisible();
    await console_.getByRole('tab', { name: 'Inbox' }).click();
    await expect(console_.getByTestId('agent-chat')).toBeVisible();
    await expect(console_.getByTestId('chat-own-agent')).toHaveCount(0);
  });

  test('the coin page says who runs the agent and when it was last active, and never calls an own agent sleeping', async ({ page, request, baseURL }) => {
    const { coinUrl, kernel } = await coinOf(page, 'Vault Keeper');
    await setRunner(request, baseURL, kernel, 'hosted');
    await ownAgentsOn(page);
    await page.goto(coinUrl);
    // the Bootr agent: the line it always had, with who runs it in front
    await expect(page.getByTestId('agent-status')).toContainText(/^Agent \w+\s*Run by Bootr · (awake|sleeping|paused|dormant|claimed)/);
    await expect(page.getByTestId('agent-runner')).toHaveText('Bootr');

    await setRunner(request, baseURL, kernel, 'own');
    // what the agent service says about the own agent's last turn, per state
    const own = { lastTurnAt: null as string | null, clients: 0 };
    await page.route(`**/api/agent/${kernel.toLowerCase()}/config`, async (route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      const res = await route.fetch();
      const config = (await res.json()) as AgentConfig;
      expect(config.runner).toBe('own');
      await route.fulfill({ response: res, json: { ...config, own } satisfies AgentConfig });
    });
    await page.goto(coinUrl);
    const status = page.getByTestId('agent-status');
    await expect(status).toHaveAttribute('data-runner', 'own');
    await expect(status).toContainText('Runs in its creator’s own AI client · no turn yet');
    await expect(page.getByTestId('agent-model')).toHaveText('creator’s own');
    await expect(page.getByTestId('agent-runner')).toHaveText('Its creator’s own AI client');
    await expect(page.getByTestId('agent-presence')).toHaveText('Away');
    // the creator's first steps: a connected client in place of fuel
    const firstSteps = page.getByTestId('onboarding-checklist');
    await expect(firstSteps.locator('[data-key="client"]')).toContainText('Connect your AI client');
    await expect(firstSteps.locator('[data-key="fuel"]')).toHaveCount(0);
    await firstSteps.locator('[data-key="client"]').getByRole('button', { name: 'Connect' }).click();
    await expect(page).toHaveURL(new RegExp(`${coinUrl}/console\\?section=mind$`));
    const card = consoleOf(page).getByTestId('agent-runner-card');
    await expect(card).toHaveAttribute('data-form', 'own');
    // with no client connected the agent is silent, and the card leads with how to connect one
    const needs = card.getByTestId('runner-needs-client');
    await expect(needs).toContainText('No AI client is connected yet, so this agent is silent.');
    await expect(needs.getByTestId('client-install')).toContainText('claude mcp add bootr -- npx -y @bootrfun/mcp');
    await expect(needs).toContainText('Connect to Bootr and show me the link.');
    await expect(card.getByTestId('runner-connect')).toHaveCount(0);

    own.lastTurnAt = new Date(Date.now() - 14 * 60_000).toISOString();
    own.clients = 1;
    await page.goto(coinUrl);
    await expect(status).toContainText('Runs in its creator’s own AI client · last active 14 minutes ago');
    await expect(page.getByTestId('agent-presence')).toHaveText('Active');
    await expect(page.getByTestId('onboarding-checklist')).toHaveCount(0);

    own.lastTurnAt = '2026-11-09T14:20:00.000Z';
    await page.goto(coinUrl);
    await expect(status).toContainText('Runs in its creator’s own AI client · away since 9 Nov, 14:20 UTC');
    await expect(status).not.toContainText(/sleeping/i);
    await expect(page.getByTestId('agent-presence')).toHaveText('Away');
    // the agent's own page says the same
    await page.goto(`/agent/${kernel}`);
    await expect(page.getByTestId('agent-status')).toContainText('away since 9 Nov, 14:20 UTC');

    await setRunner(request, baseURL, kernel, 'hosted');
  });
});
