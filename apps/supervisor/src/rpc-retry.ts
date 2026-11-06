/**
 * Waits out a rate-limited RPC instead of skipping work. CDP answers HTTP 429 with a JSON-RPC body `-32002 rate limited`;
 * viem turns that into `ResourceUnavailableRpcError`, which its own retry treats as final, so without this every limited
 * read failed at once. The limit is 7,500 billing units per 5 seconds across all services on the key, so the attempts
 * together span more than one window.
 */
import type { Transport } from 'viem';

/** Delays before the retries, in ms: about 8 s in all, plus up to a quarter of jitter on each. */
export const RATE_LIMIT_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000];

/** Whether an error, or one it wraps, says the provider refused for rate: nothing happened, so asking again is safe. */
export function isRateLimited(err: unknown): boolean {
  let e = err as { status?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 8; depth++) {
    if (e.status === 429 || e.code === 429 || e.code === -32002 || e.code === -32005 || e.code === -32007) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** For reads with a default: a call that really answered with a revert gets the default, a rate-limited one stays an error (unknown is not zero). */
export function defaultUnlessRateLimited<T>(fallback: T): (err: unknown) => T {
  return (err) => {
    if (isRateLimited(err)) throw err;
    return fallback;
  };
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

export function withRateLimitRetry(inner: Transport, opts: RetryOptions = {}): Transport {
  const delays = opts.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  return (params) => {
    const transport = inner(params);
    const request = async (...args: Parameters<typeof transport.request>) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await transport.request(...args);
        } catch (err) {
          const delay = delays[attempt];
          if (delay === undefined || !isRateLimited(err)) throw err;
          await sleep(delay * (1 + random() / 4));
        }
      }
    };
    return { ...transport, request: request as typeof transport.request };
  };
}
