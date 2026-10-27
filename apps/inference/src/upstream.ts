import type { Usage } from './pricing.js';
import type { ChatRequest } from './request.js';

export const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';

/**
 * Result of forwarding one request upstream.
 * - `ok`: a completion was produced (deliverable once paid).
 * - `rejected`: the provider definitively refused (4xx / error body); no completion exists.
 * - `unknown`: we cannot tell whether the provider produced a completion (timeout, network
 *   error, 5xx, unparseable 200). The row stays `unknown`; the client must not pay again.
 */
export type UpstreamResult =
  | { kind: 'ok'; body: Record<string, unknown>; usage: Usage | undefined }
  | { kind: 'rejected'; status: number; body: unknown }
  | { kind: 'unknown'; reason: string };

export interface UpstreamClient {
  complete(req: ChatRequest, meta: { requestId: string }): Promise<UpstreamResult>;
}

export interface OpenRouterOptions {
  apiKey: string;
  baseUrl?: string;
  timeoutMs: number;
  fetch?: typeof globalThis.fetch;
}

export function createOpenRouterClient(opts: OpenRouterOptions): UpstreamClient {
  const baseUrl = (opts.baseUrl ?? OPENROUTER_BASE_URL).replace(/\/+$/, '');
  const doFetch = opts.fetch ?? globalThis.fetch;

  return {
    async complete(req, meta) {
      let res: Response;
      try {
        res = await doFetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            authorization: `Bearer ${opts.apiKey}`,
            'content-type': 'application/json',
            'http-referer': 'https://bootr.fun',
            'x-title': 'Bootr',
            'x-bootr-request-id': meta.requestId,
          },
          body: JSON.stringify({ ...req, stream: false, usage: { include: true } }),
          signal: AbortSignal.timeout(opts.timeoutMs),
        });
      } catch (err) {
        const name = err instanceof Error ? err.name : '';
        return {
          kind: 'unknown',
          reason:
            name === 'TimeoutError' || name === 'AbortError'
              ? 'upstream_timeout'
              : 'upstream_network_error',
        };
      }

      let text: string;
      try {
        text = await res.text();
      } catch {
        return { kind: 'unknown', reason: 'upstream_body_read_failed' };
      }
      let body: unknown;
      try {
        body = text ? JSON.parse(text) : undefined;
      } catch {
        body = undefined;
      }

      if (res.status >= 500 || res.status === 408) {
        return { kind: 'unknown', reason: `upstream_status_${res.status}` };
      }
      if (res.status >= 400) {
        return {
          kind: 'rejected',
          status: res.status,
          body: body ?? { error: { message: text.slice(0, 500) } },
        };
      }
      if (!isObject(body)) return { kind: 'unknown', reason: 'upstream_unparseable_body' };
      // OpenRouter can answer 200 with an error object (e.g. provider failure before output).
      if (!Array.isArray(body.choices) || body.choices.length === 0) {
        return { kind: 'rejected', status: 502, body };
      }
      return { kind: 'ok', body, usage: readUsage(body.usage) };
    },
  };
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function readUsage(u: unknown): Usage | undefined {
  if (!isObject(u)) return undefined;
  if (typeof u.prompt_tokens !== 'number' || typeof u.completion_tokens !== 'number')
    return undefined;
  return u as Usage;
}
