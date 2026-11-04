import { describe, expect, it } from 'vitest';
import { FALLBACK_IMAGE_MODELS, formatThoughtPrice, groupByProvider, imagePriceUsd, modelLabel, thoughtPriceUsd } from './models';

describe('imagePriceUsd', () => {
  it('mirrors the relay quote for one picture: text tokens at the text rates, the picture at the image rate, then the margin', () => {
    // Nano Banana Pro: 2000 * 2000 + 256 * 12000 + 1120 * 120000 = 4_000_000 + 3_072_000 + 134_400_000 micro-USDC*tokens / 1000
    const pro = imagePriceUsd({ inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, imageOutputMicroUsdcPerKTokens: 120_000, imageOutputTokensPerImage: 1120 });
    const cost = 4000 + 3072 + 134_400;
    expect(pro).toBeCloseTo((cost + Math.ceil(cost * 0.1) + 100) / 1_000_000, 9);
    expect(pro).toBeGreaterThan(0.14);
    expect(pro).toBeLessThan(0.16);
    // the floor applies to a model priced at nothing
    expect(imagePriceUsd({ inputMicroUsdcPerKTokens: 0, outputMicroUsdcPerKTokens: 0, imageOutputMicroUsdcPerKTokens: 0, imageOutputTokensPerImage: 0 })).toBe(0.001);
  });

  it('prices the built-in image models and labels them', () => {
    const ids = FALLBACK_IMAGE_MODELS.map((m) => m.id);
    expect(ids).toEqual(['google/gemini-3-pro-image', 'google/gemini-3.1-flash-image', 'openai/gpt-5.4-image-2']);
    for (const m of FALLBACK_IMAGE_MODELS) {
      expect(m.pricePerImageUsd).toBeGreaterThan(0.05);
      expect(m.pricePerImageUsd).toBeLessThan(0.2);
    }
    expect(modelLabel('google/gemini-3-pro-image')).toBe('Nano Banana Pro (Gemini 3 Pro Image)');
    expect(FALLBACK_IMAGE_MODELS[0]).toMatchObject({ provider: 'Google' });
    expect(formatThoughtPrice(FALLBACK_IMAGE_MODELS[1]!.pricePerImageUsd)).toMatch(/^\$0\.0\d+$/);
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
    const images = groupByProvider(FALLBACK_IMAGE_MODELS);
    expect(images.map((g) => g.provider)).toEqual(['OpenAI', 'Google']);
    expect(images[1]!.models.map((m) => m.id)).toEqual(['google/gemini-3.1-flash-image', 'google/gemini-3-pro-image']);
  });
});
