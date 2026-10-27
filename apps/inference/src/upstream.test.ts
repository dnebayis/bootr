import { describe, expect, it } from 'vitest';
import { completionBody, jsonResponse } from './test/helpers.js';
import { createOpenRouterClient } from './upstream.js';

const req = {
  model: 'openai/gpt-4.1-mini',
  messages: [{ role: 'user' as const, content: 'ping' }],
  max_tokens: 16,
  stream: false as const,
};

function client(fetchImpl: (r: Request) => Promise<Response>, timeoutMs = 1_000) {
  return createOpenRouterClient({
    apiKey: 'k',
    timeoutMs,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      fetchImpl(new Request(input, init))) as typeof fetch,
  });
}

describe('OpenRouter upstream', () => {
  it('forwards a non-streaming request with usage accounting and attribution headers', async () => {
    let seen: Request | undefined;
    const res = await client(async (r) => {
      seen = r;
      return jsonResponse(completionBody());
    }).complete(req, { requestId: 'rid' });
    expect(res).toEqual({ kind: 'ok', body: completionBody(), usage: completionBody().usage });
    expect(seen!.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(seen!.headers.get('authorization')).toBe('Bearer k');
    expect(seen!.headers.get('x-title')).toBe('Bootr');
    expect(await seen!.json()).toEqual({ ...req, stream: false, usage: { include: true } });
  });

  it('classifies outcomes: 4xx rejected, 5xx/timeout/network/garbage unknown', async () => {
    expect(
      await client(async () => jsonResponse({ error: { message: 'bad' } }, 400)).complete(req, {
        requestId: 'r',
      }),
    ).toMatchObject({
      kind: 'rejected',
      status: 400,
    });
    expect(
      await client(async () => jsonResponse({ error: { message: 'rate' } }, 429)).complete(req, {
        requestId: 'r',
      }),
    ).toMatchObject({
      kind: 'rejected',
      status: 429,
    });
    expect(
      await client(async () => jsonResponse({}, 502)).complete(req, { requestId: 'r' }),
    ).toEqual({
      kind: 'unknown',
      reason: 'upstream_status_502',
    });
    expect(
      await client(async () => new Response('not json', { status: 200 })).complete(req, {
        requestId: 'r',
      }),
    ).toEqual({
      kind: 'unknown',
      reason: 'upstream_unparseable_body',
    });
    expect(
      await client(async () => {
        throw new TypeError('fetch failed');
      }).complete(req, { requestId: 'r' }),
    ).toEqual({ kind: 'unknown', reason: 'upstream_network_error' });
    expect(
      await client(
        (r) =>
          new Promise((_, reject) => {
            r.signal.addEventListener('abort', () => reject(r.signal.reason));
          }),
        20,
      ).complete(req, { requestId: 'r' }),
    ).toEqual({ kind: 'unknown', reason: 'upstream_timeout' });
  });

  it('treats a 200 without choices (provider error body) as rejected', async () => {
    const res = await client(async () =>
      jsonResponse({ error: { code: 502, message: 'provider error' } }),
    ).complete(req, { requestId: 'r' });
    expect(res).toMatchObject({ kind: 'rejected', status: 502 });
  });
});
