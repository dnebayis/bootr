import { expect, test, type Page } from '@playwright/test';
import { fakeInjectedWallet } from './fake-wallet';

/** The console of a coin in mock mode, where everyone is the creator and nothing is signed. */
async function openConsole(page: Page) {
  await fakeInjectedWallet(page);
  await page.goto('/?tab=active');
  await page.locator('a[href^="/token/0x"]').first().click();
  await expect(page).toHaveURL(/\/token\/0x[0-9a-fA-F]{40}/);
  const console_ = page.locator('section', { has: page.getByRole('heading', { name: 'Creator console' }) });
  await expect(console_).toBeVisible();
  // The inbox, the review queue and the chat share the Inbox tab.
  await console_.getByRole('tab', { name: 'Inbox' }).click();
  return console_;
}

test('the inbox lists what needs the creator, turns an event off and connects Telegram', async ({ page }) => {
  const console_ = await openConsole(page);
  const inbox = console_.getByTestId('notification-inbox');
  await expect(inbox.getByTestId('notification-count')).toHaveText('3 open');
  await inbox.getByRole('button', { name: 'Open inbox' }).click();
  await expect(inbox.locator('[data-event="fuel_low"][data-state="active"]')).toContainText('Low on fuel');
  await expect(inbox.locator('[data-event="gas_out"][data-state="resolved"]')).toContainText('cleared');
  // the two notices that ask for the X account again carry the way to do it (lib/notification-reconnect.ts)
  await expect(inbox.locator('[data-event="x_revoked"][data-state="active"]').getByTestId('connect-agent-x').getByRole('button', { name: /Connect X/ })).toBeVisible();
  await expect(inbox.locator('[data-event="x_forbidden"][data-state="active"]').getByTestId('connect-agent-x').getByRole('button', { name: /Connect X/ })).toBeVisible();
  await expect(inbox.locator('[data-event="fuel_low"]').getByTestId('connect-agent-x')).toHaveCount(0);

  await inbox.getByTestId('notification-settings-toggle').click();
  await inbox.getByRole('switch', { name: 'Low on fuel' }).click();
  await expect(inbox.locator('[data-event="fuel_low"]')).toHaveCount(0);
  await expect(inbox.getByTestId('notification-count')).toHaveText('2 open');
  await inbox.getByRole('switch', { name: 'Low on fuel' }).click();
  await expect(inbox.locator('[data-event="fuel_low"]')).toHaveCount(1);

  await inbox.getByTestId('telegram-connect').click();
  await expect(inbox.getByTestId('telegram-deep-link')).toHaveAttribute('href', /^https:\/\/t\.me\//);
  await expect(inbox.getByTestId('telegram-linked')).toBeVisible({ timeout: 10_000 });
});

test('the chat shows the cost, answers and takes a note', async ({ page }) => {
  const console_ = await openConsole(page);
  const chat = console_.getByTestId('agent-chat');
  await chat.getByRole('button', { name: 'Open chat' }).click();
  await expect(chat.getByTestId('chat-cost')).toContainText('per message, from the agent’s fuel');
  await chat.getByTestId('chat-input').fill('What did you do today?');
  await chat.getByTestId('chat-send').click();
  await expect(chat.getByTestId('chat-message-agent')).toContainText('Quiet day');
  await chat.getByTestId('chat-input').fill('Please remember that we launch on Friday');
  await chat.getByTestId('chat-send').click();
  await expect(chat.getByTestId('chat-message-agent').last()).toContainText('Saved to its memory');
});
