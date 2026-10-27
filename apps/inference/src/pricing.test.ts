import { describe, expect, it } from 'vitest';
import {
  actualChargeMicroUsdc,
  computeQuote,
  DEFAULT_PRICE_TABLE,
  estimateInputTokens,
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
    const req = { model: 'test/cheap', messages: [{ role: 'user' as const, content: 'hi' }], max_tokens: 1 };
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
