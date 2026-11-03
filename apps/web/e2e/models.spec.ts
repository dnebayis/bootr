import { expect, test } from '@playwright/test';

const RELAY_IDS = [
  'anthropic/claude-haiku-4.5',
  'anthropic/claude-sonnet-4.6',
  'openai/gpt-5.4-mini',
  'openai/gpt-4.1-mini',
  'google/gemini-3.5-flash-lite',
  'deepseek/deepseek-v3.2',
  'x-ai/grok-4.20',
  'meta-llama/llama-4-maverick',
];

test('/api/models serves the priced, allow-listed fallback list when no relay is configured', async ({ request }) => {
  const res = await request.get('/api/models');
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('max-age=60');
  const body = await res.json();
  expect(body.source).toBe('fallback');
  expect(body.thought).toEqual({ promptTokens: 4000, outputTokens: 1024 });
  expect(body.models.map((m: { id: string }) => m.id).sort()).toEqual([...RELAY_IDS].sort());
  for (const m of body.models) {
    expect(m.pricePerThoughtUsd).toBeGreaterThan(0);
    expect(m.pricePerThoughtUsd).toBeLessThan(0.1);
  }
  const haiku = body.models.find((m: { id: string }) => m.id === 'anthropic/claude-haiku-4.5');
  expect(haiku).toMatchObject({ label: 'Claude Haiku 4.5', provider: 'Anthropic' });
  expect(haiku.pricePerThoughtUsd).toBeCloseTo(0.010132, 6);
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
  expect(groups).toEqual(['Anthropic', 'OpenAI', 'Google', 'xAI', 'DeepSeek', 'Meta']);
  const haiku = listbox.getByRole('option', { name: /Claude Haiku 4\.5/ });
  await expect(haiku).toContainText('Recommended');
  await expect(haiku).toContainText('$0.0101');
  await page.keyboard.press('Escape');
  const summary = page.getByTestId('model-summary');
  await expect(summary).toContainText('per thought');
  await expect(summary).toContainText('Recommended');
  await expect(page.getByText('A thought is one model call')).toBeVisible();

  await select.click();
  await page.getByRole('listbox').getByRole('option', { name: /DeepSeek V3\.2/ }).click();
  await expect(select).toHaveAttribute('value', 'deepseek/deepseek-v3.2');
  await expect(summary).toContainText('DeepSeek V3.2');
  await expect(summary).not.toContainText('Recommended');
});
