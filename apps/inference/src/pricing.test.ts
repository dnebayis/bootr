import { describe, expect, it } from 'vitest';
import {
  actualChargeMicroUsdc,
  computeQuote,
  DEFAULT_PRICE_TABLE,
  estimateInputTokens,
  IMAGE_INPUT_TOKENS_PER_IMAGE,
  loadPriceTable,
  marginMicroUsdc,
  microUsdcToDollarString,
  priceMicroUsdc,
  tokenCostMicroUsdc,
  type PriceTable,
} from './pricing.js';

const table: PriceTable = {
  marginBps: 1000,
  marginFixedMicroUsdc: 100,
  minQuoteMicroUsdc: 0,
  models: {
    'test/model': {
      inputMicroUsdcPerKTokens: 3000,
      outputMicroUsdcPerKTokens: 15000,
      contextLength: 10_000,
      maxOutputTokens: 2_000,
    },
    'test/cheap': {
      inputMicroUsdcPerKTokens: 150,
      outputMicroUsdcPerKTokens: 600,
      contextLength: 10_000,
      maxOutputTokens: 2_000,
    },
  },
};

describe('token cost', () => {
  it('is rate-per-1K times tokens, exact', () => {
    // 3000 * 1.234 + 15000 * 0.5 = 3702 + 7500
    expect(tokenCostMicroUsdc(table.models['test/model']!, 1234, 500)).toBe(11_202n);
  });

  it('rounds fractional micro-USDC up', () => {
    // 150 * 0.007 + 600 * 0.003 = 1.05 + 1.8 = 2.85 -> 3
    expect(tokenCostMicroUsdc(table.models['test/cheap']!, 7, 3)).toBe(3n);
  });

  it('handles fractional rates without float drift', () => {
    const p = {
      inputMicroUsdcPerKTokens: 0.1,
      outputMicroUsdcPerKTokens: 0.2,
      contextLength: 1,
      maxOutputTokens: 1,
    };
    // 0.1 * 10 + 0.2 * 20 = 1 + 4 = 5 (micro-USDC per 1K tokens -> 0.005, ceil -> 1)
    expect(tokenCostMicroUsdc(p, 10_000, 20_000)).toBe(5n);
    expect(tokenCostMicroUsdc(p, 1, 0)).toBe(1n);
    expect(tokenCostMicroUsdc(p, 0, 0)).toBe(0n);
  });

  it('adds proportional (rounded up) and fixed margin', () => {
    expect(marginMicroUsdc(table, 11_202n)).toBe(1_121n + 100n);
    expect(priceMicroUsdc(table, table.models['test/model']!, 1234, 500)).toBe(11_202n + 1_221n);
  });
});

describe('computeQuote', () => {
  it('raises the margin so the quote never falls under minQuoteMicroUsdc (CDP facilitator minimum)', () => {
    const floored: PriceTable = { ...table, minQuoteMicroUsdc: 1000 };
    const req = {
      model: 'test/cheap',
      messages: [{ role: 'user' as const, content: 'hi' }],
      max_tokens: 1,
    };
    const base = computeQuote(table, req);
    const res = computeQuote(floored, req);
    if (!base.ok || !res.ok) throw new Error('quote failed');
    expect(base.quote.quoteMicroUsdc < 1000n).toBe(true);
    expect(res.quote.quoteMicroUsdc).toBe(1000n);
    expect(res.quote.costMicroUsdc).toBe(base.quote.costMicroUsdc);
    expect(res.quote.marginMicroUsdc).toBe(1000n - base.quote.costMicroUsdc);
    const big = computeQuote(floored, { ...req, max_tokens: 2000 });
    if (!big.ok) throw new Error('quote failed');
    expect(big.quote.quoteMicroUsdc > 1000n).toBe(true);
  });

  it('quote = ceil(in*estimatedIn + out*max_tokens) + margin', () => {
    const req = {
      model: 'test/model',
      messages: [{ role: 'user', content: 'hello world' }],
      max_tokens: 1000,
    };
    const est = estimateInputTokens(req);
    const r = computeQuote(table, req);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const cost = tokenCostMicroUsdc(table.models['test/model']!, est, 1000);
    expect(r.quote.estimatedInputTokens).toBe(est);
    expect(r.quote.costMicroUsdc).toBe(cost);
    expect(r.quote.quoteMicroUsdc).toBe(cost + marginMicroUsdc(table, cost));
  });

  it('grows with max_tokens and with the prompt', () => {
    const base = {
      model: 'test/model',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 100,
    };
    const q = (r: typeof base) => {
      const out = computeQuote(table, r);
      if (!out.ok) throw new Error(out.error.code);
      return out.quote.quoteMicroUsdc;
    };
    expect(q({ ...base, max_tokens: 200 })).toBeGreaterThan(q(base));
    expect(q({ ...base, messages: [{ role: 'user', content: 'hi'.repeat(500) }] })).toBeGreaterThan(
      q(base),
    );
  });

  it('counts tools in the prompt estimate', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    const tools = [
      {
        type: 'function',
        function: {
          name: 'lookup',
          parameters: { type: 'object', properties: { q: { type: 'string' } } },
        },
      },
    ];
    expect(estimateInputTokens({ messages: msgs, tools })).toBeGreaterThan(
      estimateInputTokens({ messages: msgs }),
    );
  });

  it('rejects unknown models, oversized max_tokens and context overflow', () => {
    const msgs = [{ role: 'user', content: 'hi' }];
    expect(computeQuote(table, { model: 'nope/x', messages: msgs, max_tokens: 10 })).toMatchObject({
      ok: false,
      error: { code: 'model_not_allowed' },
    });
    expect(
      computeQuote(table, { model: 'test/model', messages: msgs, max_tokens: 2_001 }),
    ).toMatchObject({ ok: false, error: { code: 'max_tokens_too_large' } });
    expect(
      computeQuote(table, {
        model: 'test/model',
        messages: [{ role: 'user', content: 'x'.repeat(30_000) }],
        max_tokens: 2_000,
      }),
    ).toMatchObject({ ok: false, error: { code: 'context_length_exceeded' } });
  });

  it('estimate is conservative for English text (>= chars/4)', () => {
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(100);
    expect(
      estimateInputTokens({ messages: [{ role: 'user', content: text }] }),
    ).toBeGreaterThanOrEqual(text.length / 4);
  });
});

describe('usage-based charge (upto)', () => {
  it('prices actual usage and never exceeds the quote', () => {
    const quote = 50_000n;
    const actual = actualChargeMicroUsdc(
      table,
      'test/model',
      { prompt_tokens: 100, completion_tokens: 10 },
      quote,
    );
    // 3000*0.1 + 15000*0.01 = 300 + 150 = 450; margin 45 + 100
    expect(actual).toBe(595n);
    expect(
      actualChargeMicroUsdc(
        table,
        'test/model',
        { prompt_tokens: 100_000, completion_tokens: 100_000 },
        quote,
      ),
    ).toBe(quote);
    expect(actualChargeMicroUsdc(table, 'test/model', undefined, quote)).toBe(quote);
  });
});

describe('price table', () => {
  it('ships defaults for the required models', () => {
    for (const id of [
      'anthropic/claude-sonnet-4.6',
      'anthropic/claude-haiku-4.5',
      'openai/gpt-4.1-mini',
      'openai/gpt-5.4-mini',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-v3.2',
      'x-ai/grok-4.7',
    ]) {
      expect(DEFAULT_PRICE_TABLE.models[id], id).toBeDefined();
    }
    expect(Object.keys(DEFAULT_PRICE_TABLE.models).length).toBeGreaterThanOrEqual(20);
  });

  it('loads an override from JSON and validates it', () => {
    const t = loadPriceTable(
      JSON.stringify({
        models: {
          'a/b': {
            inputMicroUsdcPerKTokens: 1,
            outputMicroUsdcPerKTokens: 2,
            contextLength: 100,
            maxOutputTokens: 10,
          },
        },
      }),
    );
    expect(Object.keys(t.models)).toEqual(['a/b']);
    expect(t.marginBps).toBe(1000);
    expect(loadPriceTable(undefined)).toBe(DEFAULT_PRICE_TABLE);
    expect(() => loadPriceTable('{')).toThrow(/not valid JSON/);
    expect(() => loadPriceTable(JSON.stringify({ models: {} }))).toThrow();
  });

  it('formats micro-USDC as an exact dollar string', () => {
    expect(microUsdcToDollarString(1n)).toBe('$0.000001');
    expect(microUsdcToDollarString(12_345_678n)).toBe('$12.345678');
  });
});

describe('input token estimate (M-5)', () => {
  it('counts adversarial Unicode with a real tokenizer (not bytes / 3)', () => {
    const rare = '\u{20000}\u{20001}\u{2A6D6}'.repeat(500); // CJK extension B, 4 UTF-8 bytes each
    const est = estimateInputTokens({ messages: [{ role: 'user', content: rare }] });
    const bytes = Buffer.byteLength(JSON.stringify({ role: 'user', content: rare }), 'utf8');
    expect(est).toBeGreaterThan(Math.ceil(bytes / 2));
    expect(est).toBeGreaterThan(1500); // >= one token per code point
  });

  it('never estimates fewer than one token per 2 bytes', () => {
    const english = 'the quick brown fox jumps over the lazy dog '.repeat(200);
    const msg = { role: 'user', content: english };
    const bytes = Buffer.byteLength(JSON.stringify(msg), 'utf8');
    expect(estimateInputTokens({ messages: [msg] })).toBeGreaterThanOrEqual(Math.ceil(bytes / 2));
  });
});

describe('image generation pricing', () => {
  const imageTable: PriceTable = {
    ...table,
    models: {
      ...table.models,
      'test/image': {
        inputMicroUsdcPerKTokens: 300,
        outputMicroUsdcPerKTokens: 2500,
        contextLength: 32_768,
        maxOutputTokens: 8_192,
        imageOutputMicroUsdcPerKTokens: 30_000,
        imageOutputTokensPerImage: 1290,
      },
    },
  };
  const req = { model: 'test/image', messages: [{ role: 'user', content: 'a fox' }], max_tokens: 64 };

  it('quotes one image as its token allowance at the image rate on top of the text tokens', () => {
    const text = computeQuote(imageTable, req);
    const image = computeQuote(imageTable, { ...req, modalities: ['image', 'text'] });
    if (!text.ok || !image.ok) throw new Error('quote failed');
    expect(text.quote.imageOutputTokens).toBe(0);
    expect(image.quote.imageOutputTokens).toBe(1290);
    // 30000 micro-USDC per 1K image tokens * 1290 tokens = 38_700
    expect(image.quote.costMicroUsdc - text.quote.costMicroUsdc).toBe(38_700n);
    expect(image.quote.quoteMicroUsdc).toBe(image.quote.costMicroUsdc + marginMicroUsdc(imageTable, image.quote.costMicroUsdc));
  });

  it('refuses image output on a model without an image price', () => {
    const q = computeQuote(imageTable, { ...req, model: 'test/model', modalities: ['image', 'text'] });
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.error.code).toBe('image_output_not_supported');
    // a text-only request on the image model is an ordinary text quote
    expect(computeQuote(imageTable, { ...req, modalities: ['text'] }).ok).toBe(true);
  });

  it('the default table prices the OpenRouter image models', () => {
    const gemini = DEFAULT_PRICE_TABLE.models['google/gemini-2.5-flash-image']!;
    expect(gemini).toMatchObject({ inputMicroUsdcPerKTokens: 300, outputMicroUsdcPerKTokens: 2500, imageOutputMicroUsdcPerKTokens: 30_000, imageOutputTokensPerImage: 1290 });
    const q = computeQuote(DEFAULT_PRICE_TABLE, { ...req, model: 'google/gemini-2.5-flash-image', modalities: ['image', 'text'] });
    if (!q.ok) throw new Error(q.error.code);
    // one Gemini image ($0.0387) plus a few text tokens and the 10% + 100 margin stays well under 0.05 USDC
    expect(q.quote.quoteMicroUsdc).toBeGreaterThan(38_700n);
    expect(q.quote.quoteMicroUsdc).toBeLessThan(50_000n);
    const mini = DEFAULT_PRICE_TABLE.models['openai/gpt-5-image-mini']!;
    expect(mini).toMatchObject({ inputMicroUsdcPerKTokens: 2500, outputMicroUsdcPerKTokens: 2000, imageOutputMicroUsdcPerKTokens: 8000, imageOutputTokensPerImage: 4160 });
  });

  it('prices the advanced image models: Nano Banana Pro, Nano Banana 2 and GPT Image 2 (OpenRouter, 2026-11-04)', () => {
    const quoteOf = (model: string) => {
      const q = computeQuote(DEFAULT_PRICE_TABLE, { ...req, model, modalities: ['image', 'text'] });
      if (!q.ok) throw new Error(q.error.code);
      return q.quote;
    };
    const pro = DEFAULT_PRICE_TABLE.models['google/gemini-3-pro-image']!;
    expect(pro).toMatchObject({ inputMicroUsdcPerKTokens: 2000, outputMicroUsdcPerKTokens: 12000, imageOutputMicroUsdcPerKTokens: 120_000, imageOutputTokensPerImage: 1120 });
    // one 1K picture is 1120 tokens at $120/M = $0.1344; with a few text tokens and the margin it stays under $0.16
    expect(quoteOf('google/gemini-3-pro-image').imageOutputTokens).toBe(1120);
    expect(quoteOf('google/gemini-3-pro-image').quoteMicroUsdc).toBeGreaterThan(134_400n);
    expect(quoteOf('google/gemini-3-pro-image').quoteMicroUsdc).toBeLessThan(160_000n);

    const flash = DEFAULT_PRICE_TABLE.models['google/gemini-3.1-flash-image']!;
    expect(flash).toMatchObject({ inputMicroUsdcPerKTokens: 500, outputMicroUsdcPerKTokens: 3000, imageOutputMicroUsdcPerKTokens: 60_000, imageOutputTokensPerImage: 1120 });
    expect(quoteOf('google/gemini-3.1-flash-image').quoteMicroUsdc).toBeGreaterThan(67_200n);
    expect(quoteOf('google/gemini-3.1-flash-image').quoteMicroUsdc).toBeLessThan(80_000n);

    const gpt = DEFAULT_PRICE_TABLE.models['openai/gpt-5.4-image-2']!;
    expect(gpt).toMatchObject({ inputMicroUsdcPerKTokens: 8000, outputMicroUsdcPerKTokens: 15000, imageOutputMicroUsdcPerKTokens: 30_000, imageOutputTokensPerImage: 4160 });
    expect(quoteOf('openai/gpt-5.4-image-2').quoteMicroUsdc).toBeGreaterThan(124_800n);
    expect(quoteOf('openai/gpt-5.4-image-2').quoteMicroUsdc).toBeLessThan(150_000n);
  });

  it('allows a fixed token budget per attached picture on image models and refuses pictures on text models', () => {
    const picture = { type: 'image_url', image_url: { url: 'https://example.com/coin.png' } };
    const plain = { role: 'user', content: [{ type: 'text', text: 'a fox' }] };
    const withPicture = { role: 'user', content: [{ type: 'text', text: 'a fox' }, picture] };
    const extra = estimateInputTokens({ messages: [withPicture] }) - estimateInputTokens({ messages: [plain] });
    // the URL itself is a handful of tokens; the picture adds the allowance on top
    expect(extra).toBeGreaterThanOrEqual(IMAGE_INPUT_TOKENS_PER_IMAGE);
    expect(extra).toBeLessThan(IMAGE_INPUT_TOKENS_PER_IMAGE + 60);
    expect(estimateInputTokens({ messages: [withPicture, withPicture] }) - estimateInputTokens({ messages: [plain, plain] })).toBeGreaterThanOrEqual(2 * IMAGE_INPUT_TOKENS_PER_IMAGE);

    const text = computeQuote(imageTable, { ...req, messages: [plain] });
    const image = computeQuote(imageTable, { ...req, messages: [withPicture] });
    if (!text.ok || !image.ok) throw new Error('quote failed');
    expect(image.quote.estimatedInputTokens - text.quote.estimatedInputTokens).toBe(extra);
    // 300 micro-USDC per 1K input tokens * 1600 tokens = 480 more, at least
    expect(image.quote.costMicroUsdc - text.quote.costMicroUsdc).toBeGreaterThanOrEqual(480n);

    const refused = computeQuote(imageTable, { ...req, model: 'test/model', messages: [withPicture] });
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('image_input_not_supported');
  });

  it('settles actual usage with image tokens at the image rate (upto), capped at the quote', () => {
    const quote = 1_000_000n;
    const usage = { prompt_tokens: 100, completion_tokens: 1300, completion_tokens_details: { image_tokens: 1290 } };
    const charge = actualChargeMicroUsdc(imageTable, 'test/image', usage, quote, ['image', 'text']);
    // 300*0.1 + 2500*0.01 + 30000*1.29 = 30 + 25 + 38700 = 38755, plus 10% + 100
    expect(charge).toBe(38_755n + marginMicroUsdc(imageTable, 38_755n));
    // no breakdown: every completion token at the higher rate
    const flat = actualChargeMicroUsdc(imageTable, 'test/image', { prompt_tokens: 100, completion_tokens: 1300 }, quote, ['image', 'text']);
    expect(flat).toBe(39_030n + marginMicroUsdc(imageTable, 39_030n));
    // text-only request on the image model: text rate
    const text = actualChargeMicroUsdc(imageTable, 'test/image', { prompt_tokens: 100, completion_tokens: 1300 }, quote);
    expect(text).toBe(3_280n + marginMicroUsdc(imageTable, 3_280n));
    expect(actualChargeMicroUsdc(imageTable, 'test/image', usage, 10n, ['image', 'text'])).toBe(10n);
  });
});
