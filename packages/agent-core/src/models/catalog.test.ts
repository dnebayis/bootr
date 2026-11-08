import { describe, expect, it } from 'vitest';
import {
  BLOCKRUN_CALL_FEE_MICRO_USDC,
  BLOCKRUN_MIN_QUOTE_MICRO_USDC,
  catalogGaps,
  catalogModel,
  DEFAULT_COIN_IMAGE_MODEL,
  DEFAULT_MIND_MODEL,
  DEFAULT_PLATFORM_IMAGE_MODEL,
  directModelId,
  imageModels,
  isAlias,
  mindModels,
  MODEL_CATALOG,
  modelDisplayName,
  pictureQuoteMicroUsdc,
  RELAY_DEFAULT_MARGIN,
  RELAY_IMAGE_PRICES_FALLBACK,
  relayModelId,
  relayPictureMicroUsdc,
  retiredModelIds,
  thoughtQuoteMicroUsdc,
  vendorName,
} from './catalog.js';
import { maxQuoteFor } from '../inference/request.js';

describe('the model catalog', () => {
  it('has one entry per id, no retired id twice, and every default in it', () => {
    const ids = MODEL_CATALOG.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const retired = retiredModelIds().map((r) => r.from);
    expect(new Set(retired).size).toBe(retired.length);
    for (const r of retired) expect(ids).not.toContain(r);
    expect(catalogModel(DEFAULT_MIND_MODEL)?.role).toBe('decide');
    expect(catalogModel(DEFAULT_PLATFORM_IMAGE_MODEL)?.role).toBe('image');
    expect(catalogModel(DEFAULT_COIN_IMAGE_MODEL)?.role).toBe('image');
  });

  it('names every model plainly and prices every role', () => {
    for (const m of MODEL_CATALOG) {
      expect(m.name).not.toMatch(/preview|openrouter|blockrun|\//i);
      expect(vendorName(m.vendor)).not.toBe(m.vendor);
      if (m.role === 'image') expect(pictureQuoteMicroUsdc(m)).toBeGreaterThan(BLOCKRUN_CALL_FEE_MICRO_USDC);
      else expect(thoughtQuoteMicroUsdc(m)).toBeGreaterThanOrEqual(BLOCKRUN_MIN_QUOTE_MICRO_USDC);
      expect(m.maxQuoteMicroUsdc).toBeGreaterThan(m.role === 'image' ? pictureQuoteMicroUsdc(m)! : thoughtQuoteMicroUsdc(m)!);
    }
    expect(mindModels().every((m) => m.role !== 'image')).toBe(true);
    expect(imageModels().every((m) => m.role === 'image')).toBe(true);
  });

  it('maps the retired launch-form ids to their BlockRun stand-ins, and tells a rename from a replacement', () => {
    expect(directModelId('x-ai/grok-4.20')).toBe('xai/grok-4.3');
    expect(directModelId('deepseek/deepseek-v3.2')).toBe('deepseek/deepseek-chat');
    expect(directModelId('meta-llama/llama-4-maverick')).toBe('deepseek/deepseek-chat');
    expect(directModelId('google/gemini-3.1-pro-preview')).toBe('google/gemini-3.1-pro');
    expect(directModelId('google/gemini-3-pro-image')).toBe('google/nano-banana-pro');
    expect(directModelId('google/gemini-3.1-flash-image')).toBe('google/nano-banana-2');
    expect(directModelId('anthropic/claude-haiku-4.5')).toBe('anthropic/claude-haiku-4.5');
    expect(directModelId('vendor/unknown')).toBeNull();
    expect(isAlias('google/gemini-3.1-pro-preview')).toBe(true);
    expect(isAlias('x-ai/grok-4.20')).toBe(false);
    expect(relayModelId('google/gemini-3.1-pro')).toBe('google/gemini-3.1-pro-preview');
    expect(relayModelId('xai/grok-4.3')).toBe('xai/grok-4.3');
  });

  it('quotes a thought the way BlockRun’s 402 did on 2026-11-08: prompt plus the whole output allowance plus the fee, never under the floor', () => {
    const haiku = catalogModel('anthropic/claude-haiku-4.5')!;
    // 17 prompt tokens, max_tokens 1024: 17 * 1 + 1024 * 5 + 1000 = 6137 micro-USDC, as the live 402 said
    expect(thoughtQuoteMicroUsdc(haiku, { promptTokens: 17, outputTokens: 1024 })).toBe(6137);
    const deepseek = catalogModel('deepseek/deepseek-chat')!;
    expect(thoughtQuoteMicroUsdc(deepseek, { promptTokens: 17, outputTokens: 1024 })).toBe(BLOCKRUN_MIN_QUOTE_MICRO_USDC);
    expect(pictureQuoteMicroUsdc(catalogModel('google/nano-banana-2')!)).toBe(95_500);
    expect(pictureQuoteMicroUsdc(catalogModel('openai/gpt-image-1')!)).toBe(22_000);
    expect(thoughtQuoteMicroUsdc(catalogModel('google/nano-banana')!)).toBeNull();
  });

  it('prices a picture on the relay as the relay charges it: image tokens, the prompt with its reference, a sentence of text, the margin', () => {
    const byId = Object.fromEntries(RELAY_IMAGE_PRICES_FALLBACK.map((m) => [m.id, m]));
    // Nano Banana 2 at the relay: 1120 image tokens at $60/M = 67 200, 2200 prompt tokens at $0.5/M = 1 100, 64 text tokens at $3/M = 192; +10 % and 100
    expect(relayPictureMicroUsdc(byId['google/gemini-3.1-flash-image']!)).toBe(75_442);
    expect(relayPictureMicroUsdc(byId['google/gemini-3-pro-image']!)).toBe(153_625);
    expect(relayPictureMicroUsdc(byId['openai/gpt-5.4-image-2']!)).toBe(157_796);
    // the relay's own margin wins when its list carries one
    expect(relayPictureMicroUsdc(byId['google/gemini-3.1-flash-image']!, { bps: 0, fixedMicroUsdc: 0 })).toBe(68_492);
    expect(RELAY_DEFAULT_MARGIN).toEqual({ bps: 1000, fixedMicroUsdc: 100 });
    // no image price, no number; a missing text rate counts as zero
    expect(relayPictureMicroUsdc({ inputMicroUsdcPerKTokens: 1, outputMicroUsdcPerKTokens: 1, imageOutputMicroUsdcPerKTokens: null, imageOutputTokensPerImage: null })).toBeNull();
    expect(relayPictureMicroUsdc({ inputMicroUsdcPerKTokens: null, outputMicroUsdcPerKTokens: null, imageOutputMicroUsdcPerKTokens: 1000, imageOutputTokensPerImage: 1000 }, { bps: 0, fixedMicroUsdc: 0 })).toBe(1000);
    // every relay image id names a catalog model, so the console can store the catalog id
    for (const m of RELAY_IMAGE_PRICES_FALLBACK) expect(catalogModel(m.id)?.role).toBe('image');
  });

  it('gives every catalog id its own quote cap, retired ids the cap of their stand-in, and names the rest', () => {
    for (const m of MODEL_CATALOG) expect(maxQuoteFor(m.id)).toBe(m.maxQuoteMicroUsdc);
    expect(maxQuoteFor('x-ai/grok-4.20')).toBe(catalogModel('xai/grok-4.3')!.maxQuoteMicroUsdc);
    expect(modelDisplayName('xai/grok-4.3')).toBe('Grok 4.3');
    expect(modelDisplayName('vendor/some-new-model')).toBe('Some New Model');
  });

  it('reports what the live list lacks, marks unavailable or prices differently', () => {
    const live = MODEL_CATALOG.map((m) => ({
      id: m.id,
      available: true,
      pricing: 'perImageMicroUsdc' in m.price ? { per_image: m.price.perImageMicroUsdc / 1_000_000 } : { input: m.price.inputMicroUsdcPerKTokens / 1000, output: m.price.outputMicroUsdcPerKTokens / 1000 },
    }));
    expect(catalogGaps(live)).toEqual([]);
    const broken = live.filter((m) => m.id !== 'xai/grok-4.3').map((m) => (m.id === 'anthropic/claude-haiku-4.5' ? { ...m, pricing: { input: 2, output: 5 } } : m.id === 'google/nano-banana' ? { ...m, available: false } : m));
    expect(catalogGaps(broken)).toEqual([
      { id: 'xai/grok-4.3', kind: 'missing', detail: expect.any(String) },
      { id: 'anthropic/claude-haiku-4.5', kind: 'price', detail: expect.stringContaining('2000/5000') },
      { id: 'google/nano-banana', kind: 'unavailable', detail: expect.any(String) },
    ]);
  });
});
