import { describe, expect, it } from 'vitest';
import { MODEL_CATALOG, mindModels } from '@bootr/agent-core';
import { CATALOG_IMAGE_MODELS, CATALOG_MODELS, cheapestModel, filterAllowedModels, formatThoughtPrice, groupByProvider, imagePriceUsd, modelLabel, RECOMMENDED_MODEL, thoughtPriceUsd } from './models';

describe('the priced lists', () => {
  it('price every mind per thought the way BlockRun quotes one, with its fee', () => {
    // Haiku 4.5: 4000 * 1 + 1024 * 5 micro-USDC + the 1000 micro-USDC fee
    expect(thoughtPriceUsd({ inputMicroUsdcPerKTokens: 1000, outputMicroUsdcPerKTokens: 5000 })).toBeCloseTo(0.01012, 9);
    // the floor applies to a model priced at next to nothing
    expect(thoughtPriceUsd({ inputMicroUsdcPerKTokens: 0, outputMicroUsdcPerKTokens: 0 })).toBe(0.002);
    expect(CATALOG_MODELS.map((m) => m.id)).toEqual(mindModels().map((m) => m.id));
    for (const m of CATALOG_MODELS) {
      expect(m.pricePerThoughtUsd).toBeGreaterThan(0.001);
      expect(m.pricePerThoughtUsd).toBeLessThan(0.1);
      expect(m.label).not.toContain('/');
    }
    expect(CATALOG_MODELS.find((m) => m.id === RECOMMENDED_MODEL)).toMatchObject({ label: 'Claude Haiku 4.5', provider: 'Anthropic' });
  });

  it('price every picture at BlockRun’s fixed price plus the fee, and label the image models', () => {
    expect(imagePriceUsd(94_500)).toBe(0.0955);
    const ids = CATALOG_IMAGE_MODELS.map((m) => m.id);
    expect(ids).toEqual(['google/nano-banana-2', 'google/nano-banana-pro', 'google/nano-banana', 'openai/gpt-image-2', 'openai/gpt-image-1']);
    for (const m of CATALOG_IMAGE_MODELS) {
      expect(m.pricePerImageUsd).toBeGreaterThan(0.02);
      expect(m.pricePerImageUsd).toBeLessThan(0.2);
    }
    expect(modelLabel('google/nano-banana-pro')).toBe('Nano Banana Pro');
    expect(modelLabel('google/gemini-3-pro-image')).toBe('Nano Banana Pro');
    expect(CATALOG_IMAGE_MODELS[0]).toMatchObject({ provider: 'Google' });
    expect(formatThoughtPrice(CATALOG_IMAGE_MODELS[0]!.pricePerImageUsd)).toBe('$0.0955');
  });

  it('matches an allow-list entry by full id or by its bare, dot-insensitive name', () => {
    expect(filterAllowedModels(CATALOG_MODELS, ['claude-haiku-4-5', 'OPENAI/GPT-4.1-MINI']).map((m) => m.id)).toEqual(['anthropic/claude-haiku-4.5', 'openai/gpt-4.1-mini']);
    expect(filterAllowedModels(CATALOG_MODELS, [])).toEqual([]);
  });

  it('finds the cheapest mind for economy mode, never the writer itself', () => {
    const cheapest = cheapestModel(CATALOG_MODELS);
    expect(cheapest?.id).toBe('deepseek/deepseek-chat');
    expect(cheapestModel(CATALOG_MODELS, 'deepseek/deepseek-chat')?.id).not.toBe('deepseek/deepseek-chat');
    expect(MODEL_CATALOG.find((m) => m.id === cheapest!.id)?.role).toBe('economy');
  });
});

describe('groupByProvider', () => {
  it('groups minds by provider price per thought and image models per image, cheapest first', () => {
    const minds = groupByProvider([
      { id: 'openai/a', label: 'A', provider: 'OpenAI', pricePerThoughtUsd: thoughtPriceUsd({ inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 8000 }) },
      { id: 'anthropic/b', label: 'B', provider: 'Anthropic', pricePerThoughtUsd: 0.02 },
      { id: 'openai/c', label: 'C', provider: 'OpenAI', pricePerThoughtUsd: 0.001 },
    ]);
    expect(minds.map((g) => [g.provider, g.models.map((m) => m.id)])).toEqual([
      ['Anthropic', ['anthropic/b']],
      ['OpenAI', ['openai/c', 'openai/a']],
    ]);
    const images = groupByProvider(CATALOG_IMAGE_MODELS);
    expect(images.map((g) => g.provider)).toEqual(['OpenAI', 'Google']);
    expect(images[1]!.models.map((m) => m.id)).toEqual(['google/nano-banana', 'google/nano-banana-2', 'google/nano-banana-pro']);
  });
});
