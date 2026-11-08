import { describe, expect, it } from 'vitest';
import { LOW_FUEL_THOUGHTS } from '@bootr/shared/fuel';
import { pictureFits } from '../src/fuel.js';
import { BLOCKRUN_IMAGE_CATALOG, FALLBACK_IMAGE_CATALOG, imageModelEntry, picturePriceFor, picturePriceMicroUsdc, picturesOnBlockRun, relayImageCatalog, usdcText } from '../src/image-models.js';
import { DEFAULT_COIN_IMAGE_MODEL, DEFAULT_IMAGE_MODEL, PICTURES_UNAVAILABLE_MESSAGE } from '../src/images.js';
import { PICTURE_FITS, PICTURE_NEVER, PICTURE_SPACING_MS, pictureHint } from '../src/picture-hint.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent } from './helpers.js';

const withImages = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };
const D = 86_400_000;

describe('the price of a picture, from the relay\'s list', () => {
  it('prices one picture as the relay charges it: image tokens, the prompt with its reference, a sentence of text, the margin', () => {
    // the built-in relay list names the models the relay's way; the defaults are catalog ids, so look them up through the entry finder
    const pro = imageModelEntry(FALLBACK_IMAGE_CATALOG, DEFAULT_IMAGE_MODEL)!;
    const pricePro = picturePriceMicroUsdc(pro)!;
    // Nano Banana Pro: 1120 image tokens at $120/M = $0.134, plus about $0.005 of prompt and text, plus the 10 % margin: about $0.156
    expect(pricePro).toBeGreaterThan(150_000);
    expect(pricePro).toBeLessThan(165_000);
    const two = imageModelEntry(FALLBACK_IMAGE_CATALOG, DEFAULT_COIN_IMAGE_MODEL)!;
    const priceTwo = picturePriceMicroUsdc(two)!;
    // Nano Banana 2: about half of Pro
    expect(priceTwo).toBeGreaterThan(70_000);
    expect(priceTwo).toBeLessThan(85_000);
    expect(usdcText(pricePro)).toMatch(/^0\.1\d\d?$/);
    expect(usdcText(80_000)).toBe('0.08');
    // no image price, no number
    expect(picturePriceMicroUsdc({ id: 'x', inputMicroUsdcPerKTokens: 1, outputMicroUsdcPerKTokens: 1, imageOutputMicroUsdcPerKTokens: null, imageOutputTokensPerImage: null })).toBeNull();
  });

  it('reads the relay\'s list with its prices and margin, and falls back to the built-in list when the relay is down', async () => {
    const w = await makeWorld();
    try {
      // the test relay answers '{}' to GET /v1/models: the built-in list stands in, marked as such
      const down = await relayImageCatalog(w.ctx);
      expect(down.live).toBe(false);
      expect(picturePriceFor(down, DEFAULT_IMAGE_MODEL)).toMatchObject({ live: false });
      expect(picturePriceFor(down, 'vendor/unknown')).toBeNull();

      const live = await makeWorld();
      try {
        const inner = live.ctx.fetch;
        live.ctx.fetch = (async (input, init) => {
          const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
          if (url.endsWith('/v1/models')) {
            return new Response(
              JSON.stringify({
                margin: { bps: 500, fixedMicroUsdc: 50 },
                data: [
                  { id: 'google/gemini-3-pro-image', output_modalities: ['text', 'image'], pricing: { input_micro_usdc_per_1k_tokens: 2000, output_micro_usdc_per_1k_tokens: 12000, image_output_micro_usdc_per_1k_tokens: 100000, image_output_tokens_per_image: 1000 } },
                  { id: 'vendor/new-image', output_modalities: ['text', 'image'] },
                  { id: 'openai/gpt-4.1-mini', output_modalities: ['text'] },
                ],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          return inner(input, init);
        }) as typeof fetch;
        const catalog = await relayImageCatalog(live.ctx);
        expect(catalog.live).toBe(true);
        expect(catalog.margin).toEqual({ bps: 500, fixedMicroUsdc: 50 });
        expect(catalog.models.map((m) => m.id)).toEqual(['google/gemini-3-pro-image', 'vendor/new-image']);
        // the relay's price, not the built-in one: 1000 tokens at $100/M = $0.10 + prompt $0.0044 + text $0.0008, +5 % and 50
        const price = picturePriceFor(catalog, 'google/gemini-3-pro-image')!;
        expect(price.live).toBe(true);
        expect(price.microUsdc).toBe(Math.ceil((100_000 + 4_400 + 768) * 1.05 + 50));
        // a listed model without prices has no number (and no built-in price to borrow)
        expect(picturePriceFor(catalog, 'vendor/new-image')).toBeNull();
      } finally {
        await live.close();
      }
    } finally {
      await w.close();
    }
  });

  it('with direct mode on and pictures on the relay (the default route), the list is still the relay’s, at the relay’s prices', async () => {
    const w = await makeWorld({ config: { BLOCKRUN_DIRECT_MODE: 'all' } });
    try {
      expect(w.ctx.config.BLOCKRUN_IMAGE_ROUTE).toBe('relay');
      expect(picturesOnBlockRun(w.ctx.config, { agentId: AGENT_ID })).toBe(false);
      expect(picturesOnBlockRun(w.ctx.config)).toBe(false);
      // the test relay answers '{}' to GET /v1/models: the relay's built-in list stands in, never BlockRun's catalog
      const catalog = await relayImageCatalog(w.ctx, { agentId: AGENT_ID });
      expect(catalog).not.toBe(BLOCKRUN_IMAGE_CATALOG);
      expect(catalog.live).toBe(false);
      expect(catalog.models.map((m) => m.id)).toEqual(['google/gemini-3-pro-image', 'google/gemini-3.1-flash-image', 'openai/gpt-5.4-image-2']);
      // a catalog id finds the relay's entry for the same model, priced the relay's way: Nano Banana 2 about 0.075, not BlockRun's 0.0955
      expect(picturePriceFor(catalog, DEFAULT_COIN_IMAGE_MODEL)).toEqual({ microUsdc: 75_442, live: false });
      expect(picturePriceFor(catalog, 'google/gemini-3.1-flash-image')).toEqual({ microUsdc: 75_442, live: false });
      expect(picturePriceFor(catalog, DEFAULT_IMAGE_MODEL)).toEqual({ microUsdc: 153_625, live: false });
      // a catalog model the relay does not serve has no price
      expect(picturePriceFor(catalog, 'openai/gpt-image-1')).toBeNull();
      expect(imageModelEntry(catalog, 'openai/gpt-image-1')).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('with BLOCKRUN_IMAGE_ROUTE=direct the list is the catalog at BlockRun’s fixed prices plus its fee, and no relay is asked', async () => {
    const w = await makeWorld({ config: { BLOCKRUN_DIRECT_MODE: 'all', BLOCKRUN_IMAGE_ROUTE: 'direct' } });
    try {
      expect(picturesOnBlockRun(w.ctx.config, { agentId: AGENT_ID })).toBe(true);
      expect(picturesOnBlockRun(w.ctx.config)).toBe(true);
      w.ctx.fetch = (() => {
        throw new Error('no listing is fetched in direct mode');
      }) as unknown as typeof fetch;
      const catalog = await relayImageCatalog(w.ctx, { agentId: AGENT_ID });
      expect(catalog).toBe(BLOCKRUN_IMAGE_CATALOG);
      expect(catalog.live).toBe(true);
      expect(catalog.models.map((m) => m.id)).toEqual(['google/nano-banana-2', 'google/nano-banana-pro', 'google/nano-banana', 'openai/gpt-image-2', 'openai/gpt-image-1']);
      // Nano Banana 2: 94 500 plus the 1 000 fee, as BlockRun's 402 quoted on 2026-11-08; the relay's name for it finds the same entry
      expect(picturePriceFor(catalog, DEFAULT_COIN_IMAGE_MODEL)).toEqual({ microUsdc: 95_500, live: true });
      expect(picturePriceFor(catalog, 'google/gemini-3.1-flash-image')).toEqual({ microUsdc: 95_500, live: true });
      expect(picturePriceFor(catalog, DEFAULT_IMAGE_MODEL)).toEqual({ microUsdc: 106_000, live: true });
      expect(picturePriceFor(catalog, 'vendor/unknown')).toBeNull();
      // with `agents`, only the named agent is on the catalog
      const some = await makeWorld({ config: { BLOCKRUN_DIRECT_MODE: 'agents', BLOCKRUN_DIRECT_AGENTS: '7', BLOCKRUN_IMAGE_ROUTE: 'direct' } });
      try {
        expect(await relayImageCatalog(some.ctx, { agentId: '7' })).toBe(BLOCKRUN_IMAGE_CATALOG);
        expect((await relayImageCatalog(some.ctx, { agentId: '8' })).live).toBe(false);
        expect(picturesOnBlockRun(some.ctx.config)).toBe(false);
      } finally {
        await some.close();
      }
      // the route alone does nothing without direct mode
      const off = await makeWorld({ config: { BLOCKRUN_IMAGE_ROUTE: 'direct' } });
      try {
        expect((await relayImageCatalog(off.ctx, { agentId: AGENT_ID })).live).toBe(false);
      } finally {
        await off.close();
      }
    } finally {
      await w.close();
    }
  });
});

describe('pictureFits: a picture must leave the thoughts behind', () => {
  it('needs the price plus LOW_FUEL_THOUGHTS thoughts at the average cost, or SLEEP_USDC without an estimate', () => {
    const price = 156_000;
    const avg = 100_000;
    expect(pictureFits(price + LOW_FUEL_THOUGHTS * avg, avg, price)).toBe(true);
    expect(pictureFits(price + LOW_FUEL_THOUGHTS * avg - 1, avg, price)).toBe(false);
    expect(pictureFits(price - 1, avg, price)).toBe(false);
    expect(pictureFits(price + 1_000_000, null, price)).toBe(true);
    expect(pictureFits(price + 999_999, null, price)).toBe(false);
    expect(pictureFits(0, null, price)).toBe(false);
  });
});

describe('pictureHint: steady and bounded', () => {
  const base = { config: { platform: false }, model: DEFAULT_COIN_IMAGE_MODEL, priceMicroUsdc: 80_000, live: true, leftToday: 6, affordable: true, postDue: true, digestDue: false, newLaunch: false, lastImageAgoMs: null as number | null };

  it('carries the price, the count, the rules, and suggests a first picture for a due post', () => {
    const hint = pictureHint(base);
    expect(hint).toMatchObject({ model: DEFAULT_COIN_IMAGE_MODEL, costUsdc: '0.08', leftToday: 6, affordable: true, suggested: true, fits: PICTURE_FITS, never: PICTURE_NEVER });
    expect(hint.approx).toBeUndefined();
    expect(hint.reason).toMatch(/never used a picture/);
    expect(pictureHint({ ...base, live: false }).approx).toBe(true);
    expect(pictureHint({ ...base, priceMicroUsdc: null }).costUsdc).toBeNull();
    expect(PICTURE_NEVER.join(' ')).toMatch(/on request/);
    expect(PICTURE_NEVER.join(' ')).toMatch(/real person/);
    expect(PICTURE_NEVER.join(' ')).toMatch(/logo/);
    expect(PICTURE_NEVER.join(' ')).toMatch(/chart/);
  });

  it('spaces a coin agent\'s pictures: not again within PICTURE_SPACING_MS, again after it', () => {
    expect(pictureHint({ ...base, lastImageAgoMs: D })).toMatchObject({ suggested: false, reason: expect.stringMatching(/used a picture recently/) });
    expect(pictureHint({ ...base, lastImageAgoMs: PICTURE_SPACING_MS })).toMatchObject({ suggested: true, reason: expect.stringMatching(/3 days ago/) });
  });

  it('never suggests when the cap or the fuel says no, nor without a due post', () => {
    expect(pictureHint({ ...base, leftToday: 0 })).toMatchObject({ suggested: false, reason: expect.stringMatching(/daily limit/) });
    // the picture hold (the relay's provider refused its account today) wins over everything and says so in the words the tool result uses
    expect(pictureHint({ ...base, held: true, config: { platform: true }, digestDue: true })).toMatchObject({ suggested: false, reason: PICTURES_UNAVAILABLE_MESSAGE, costUsdc: '0.08' });
    expect(pictureHint({ ...base, affordable: false })).toMatchObject({ suggested: false, reason: expect.stringMatching(/too little fuel/) });
    expect(pictureHint({ ...base, postDue: false })).toMatchObject({ suggested: false, reason: expect.stringMatching(/replies are words/) });
    // the cap wins over everything
    expect(pictureHint({ ...base, config: { platform: true }, digestDue: true, leftToday: 0 }).suggested).toBe(false);
  });

  it('suggests the digest picture and a welcome picture to the platform agent only', () => {
    expect(pictureHint({ ...base, config: { platform: true }, model: DEFAULT_IMAGE_MODEL, digestDue: true, postDue: false, lastImageAgoMs: D })).toMatchObject({ suggested: true, reason: expect.stringMatching(/weekly digest/) });
    expect(pictureHint({ ...base, config: { platform: true }, newLaunch: true, lastImageAgoMs: D })).toMatchObject({ suggested: true, reason: expect.stringMatching(/welcome/) });
    expect(pictureHint({ ...base, digestDue: true, postDue: false })).toMatchObject({ suggested: false });
    expect(pictureHint({ ...base, newLaunch: true, lastImageAgoMs: D })).toMatchObject({ suggested: false });
  });
});

describe('the picture section in a turn', () => {
  it('is in the first observation with the images power on, and absent without it', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const w = await makeWorld({ script: [finishResponse(start + 3_600_000), finishResponse(start + 7_200_000)] });
    try {
      await seedAgent(w, { config: withImages });
      await tick(w.ctx);
      const first = w.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
      const observation = JSON.parse((first.body as { messages: { content: string }[] }).messages[1]!.content) as { picture?: Record<string, unknown>; fuel?: Record<string, unknown> };
      expect(observation.picture).toMatchObject({ model: DEFAULT_COIN_IMAGE_MODEL, leftToday: 6, approx: true, affordable: true, suggested: true });
      expect(observation.picture!.costUsdc).toMatch(/^0\.0\d\d?$/);
      expect(observation.picture!.meaning).toMatch(/imageId/);
      expect(observation.fuel).toBeTruthy();
    } finally {
      await w.close();
    }
    const off = await makeWorld({ script: [finishResponse(start + 3_600_000)] });
    try {
      await seedAgent(off);
      await tick(off.ctx);
      const first = off.inference.calls.find((c) => c.url.includes('/v1/chat/completions'))!;
      const observation = JSON.parse((first.body as { messages: { content: string }[] }).messages[1]!.content) as { picture?: unknown };
      expect(observation.picture).toBeUndefined();
    } finally {
      await off.close();
    }
  });

  it('refuses the paid call when the picture would leave too little fuel, naming the amounts', async () => {
    const { executeAction } = await import('../src/broker/index.js');
    const { parseAgentConfig } = await import('@bootr/agent-core');
    // the spender holds 0.20 USDC: a 0.08 picture would leave less than SLEEP_USDC behind
    const w = await makeWorld({ chain: { spenderUsdc: 200_000n } });
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      const pending = { id: 'act_fuel', cycleKey: 'cycle:x', action: { tool: 'generate_image', input: { prompt: 'a fox on a hill', altText: 'A fox on a hill' } }, status: 'sent', createdAt: 0, attempts: 1 } as unknown as Parameters<typeof executeAction>[3];
      const res = await executeAction(w.ctx, agent, config, pending, { inbox: new Map(), eligibility: new Map(), cycle: 1 });
      expect(res).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_fuel_low: a picture costs about 0\.0\d+ USDC and your spendable fuel is 0\.20 USDC/) });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      expect(AGENT_ID).toBe('7');
    } finally {
      await w.close();
    }
  });
});
