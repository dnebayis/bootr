import { expect, test } from '@playwright/test';
import { mindModels } from '@bootr/agent-core';

/** Every mind in the model catalog: what the default admin allow-list offers. */
const CATALOG_IDS = mindModels().map((m) => m.id);

test('/api/models serves the catalog of the models BlockRun serves, priced per thought, under the default allow-list', async ({ request }) => {
  const res = await request.get('/api/models');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('max-age=60');
  const body = await res.json();
  expect(body.source).toBe('blockrun');
  expect(body.thought).toEqual({ promptTokens: 4000, outputTokens: 1024 });
  expect(body.models.map((m: { id: string }) => m.id).sort()).toEqual([...CATALOG_IDS].sort());
  for (const m of body.models) {
    expect(m.pricePerThoughtUsd).toBeGreaterThan(0);
    expect(m.pricePerThoughtUsd).toBeLessThan(0.1);
  }
  // Haiku 4.5 at BlockRun: 4000 prompt tokens at $1/M, 1024 output tokens at $5/M, plus the $0.001 fee
  const haiku = body.models.find((m: { id: string }) => m.id === 'anthropic/claude-haiku-4.5');
  expect(haiku).toMatchObject({ label: 'Claude Haiku 4.5', provider: 'Anthropic' });
  expect(haiku.pricePerThoughtUsd).toBeCloseTo(0.01012, 6);
  // Image models carry BlockRun's fixed price per picture
  const images = await (await request.get('/api/models?kind=image')).json();
  expect(images.source).toBe('blockrun');
  expect(images.models.find((m: { id: string }) => m.id === 'google/nano-banana-2')).toMatchObject({ label: 'Nano Banana 2', provider: 'Google', pricePerImageUsd: 0.0955 });
});

test('launch form groups models by provider and defaults to the recommended one', async ({ page }) => {
  await page.goto('/launch');
  // Base UI Select: the trigger is a combobox carrying the current value; options live in a popup listbox.
  const select = page.getByRole('combobox', { name: 'Model' });
  await expect(select).toHaveAttribute('value', 'anthropic/claude-haiku-4.5');
  await select.click();
  const listbox = page.getByRole('listbox');
  await expect(listbox).toBeVisible();
  const groups = await listbox.getByRole('group').evaluateAll((els) =>
    els.map((e) => e.getAttribute('aria-label') || document.getElementById(e.getAttribute('aria-labelledby') ?? '')?.textContent?.trim() || ''),
  );
  expect(groups).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Moonshot', 'MiniMax', 'Qwen', 'Mistral', 'Z.ai']);
  const haiku = listbox.getByRole('option', { name: /Claude Haiku 4\.5/ });
  await expect(haiku).toContainText('Recommended');
  await expect(haiku).toContainText('$0.0101');
  await page.keyboard.press('Escape');
  const summary = page.getByTestId('model-summary');
  await expect(summary).toContainText('per thought');
  await expect(summary).toContainText('Recommended');
  await expect(page.getByText('A thought is one model call')).toBeVisible();

  await select.click();
  await page.getByRole('listbox').getByRole('option', { name: /DeepSeek Chat/ }).click();
  await expect(select).toHaveAttribute('value', 'deepseek/deepseek-chat');
  await expect(summary).toContainText('DeepSeek Chat');
  await expect(summary).not.toContainText('Recommended');
  await expect(page.getByText('to BlockRun')).toBeVisible();
});
