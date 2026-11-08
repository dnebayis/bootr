import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATALOG_IMAGE_MODELS, FALLBACK_RELAY_IMAGE_MODELS } from '@/lib/models';
import { relayImageRows, relayModels, resetRelayModelsCache } from './relay-models';

/** The relay's `GET /v1/models` as apps/inference answers it: minds and, with `output_modalities`, the image models. */
const relayList = {
  margin: { bps: 1000, fixedMicroUsdc: 100 },
  data: [
    { id: 'anthropic/claude-haiku-4.5', output_modalities: ['text'], pricing: { input_micro_usdc_per_1k_tokens: 1000, output_micro_usdc_per_1k_tokens: 5000 } },
    { id: 'google/gemini-3.1-flash-image', output_modalities: ['text', 'image'], pricing: { input_micro_usdc_per_1k_tokens: 500, output_micro_usdc_per_1k_tokens: 3000, image_output_micro_usdc_per_1k_tokens: 60000, image_output_tokens_per_image: 1120 } },
    { id: 'google/gemini-3-pro-image', output_modalities: ['text', 'image'], pricing: { input_micro_usdc_per_1k_tokens: 2000, output_micro_usdc_per_1k_tokens: 12000, image_output_micro_usdc_per_1k_tokens: 120000, image_output_tokens_per_image: 1120 } },
    { id: 'vendor/new-image', output_modalities: ['image'] },
  ],
};

describe('the image model list follows the route pictures take', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetRelayModelsCache();
  });

  it('on the default relay route it is the relay’s list, each model under its catalog id at the relay’s price; minds stay the catalog', async () => {
    vi.stubEnv('BLOCKRUN_IMAGE_ROUTE', '');
    vi.stubEnv('INFERENCE_URL', 'http://relay.test');
    const fetchMock = vi.fn(async (url: string | URL | Request) => {
      expect(String(url)).toBe('http://relay.test/v1/models');
      return new Response(JSON.stringify(relayList), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    const lists = await relayModels();
    expect(lists.source).toBe('blockrun');
    expect(lists.models.map((m) => m.id)).toContain('anthropic/claude-haiku-4.5');
    expect(lists.imageSource).toBe('relay');
    expect(lists.imageModels).toEqual([
      { id: 'google/nano-banana-2', label: 'Nano Banana 2', provider: 'Google', pricePerImageUsd: 0.075442 },
      { id: 'google/nano-banana-pro', label: 'Nano Banana Pro', provider: 'Google', pricePerImageUsd: 0.153625 },
      { id: 'vendor/new-image', label: 'New Image', provider: 'vendor', pricePerImageUsd: null },
    ]);
    // cached: a second read asks the relay nothing
    await relayModels();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('when the relay cannot be read, the relay’s built-in list of 2026-11-04 stands in, marked as such', async () => {
    vi.stubEnv('INFERENCE_URL', 'http://relay.test');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('down', { status: 503 })));
    const lists = await relayModels();
    expect(lists.imageSource).toBe('fallback');
    expect(lists.imageModels).toEqual([...FALLBACK_RELAY_IMAGE_MODELS]);
    expect(lists.imageModels.map((m) => m.id)).toEqual(['google/nano-banana-pro', 'google/nano-banana-2', 'openai/gpt-image-2']);
    expect(lists.imageModels.find((m) => m.id === 'google/nano-banana-2')!.pricePerImageUsd).toBe(0.075442);
  });

  it('with BLOCKRUN_IMAGE_ROUTE=direct it is the catalog at BlockRun’s fixed prices and the relay is not asked', async () => {
    vi.stubEnv('BLOCKRUN_IMAGE_ROUTE', 'direct');
    vi.stubEnv('INFERENCE_URL', 'http://relay.test');
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const lists = await relayModels();
    expect(lists.imageSource).toBe('blockrun');
    expect(lists.imageModels).toEqual([...CATALOG_IMAGE_MODELS]);
    expect(lists.imageModels.find((m) => m.id === 'google/nano-banana-2')!.pricePerImageUsd).toBe(0.0955);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reads only image entries with sane ids from the relay list, and the relay’s margin when it gives one', () => {
    const { rows, margin } = relayImageRows({ margin: { bps: 500, fixedMicroUsdc: 50 }, data: [...relayList.data, { id: 'bad id!', output_modalities: ['image'] }, { id: 'x/y', output_modalities: ['image'], pricing: { image_output_tokens_per_image: 0 } }] });
    expect(margin).toEqual({ bps: 500, fixedMicroUsdc: 50 });
    expect(rows.map((r) => r.id)).toEqual(['google/gemini-3.1-flash-image', 'google/gemini-3-pro-image', 'vendor/new-image', 'x/y']);
    expect(rows[3]).toMatchObject({ imageOutputTokensPerImage: null });
    expect(relayImageRows({}).margin).toEqual({ bps: 1000, fixedMicroUsdc: 100 });
  });
});
