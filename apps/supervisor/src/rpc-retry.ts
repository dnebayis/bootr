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

/**
 * CDP's billing units per method (docs.cdp.coinbase.com/data/node/pricing): the block, log, receipt and gas-estimate reads
 * are "enhanced" at 100, everything else the supervisor sends is 30. The same table as the indexer's rpc-budget.ts.
 */
const ENHANCED_BU: Record<string, number> = { eth_getLogs: 100, eth_getBlockByNumber: 100, eth_getBlockByHash: 100, eth_getTransactionReceipt: 100, eth_getBlockReceipts: 100, eth_estimateGas: 100 };
export const billingUnitsOf = (method: string): number => ENHANCED_BU[method] ?? 30;

export interface RpcUsage {
  /** Requests sent since the last drain, by JSON-RPC method (a retry counts again: the provider bills it again). */
  requests: Record<string, number>;
  /** Requests in all. */
  total: number;
  /** Their cost in CDP billing units, by the table above. */
  bu: number;
  /** Answers that were a rate limit (each one is also a request above). */
  rateLimited: number;
}

/** Counts what goes out over a transport, so the tick line can say what a tick cost the RPC key; `drain` reads and resets. */
export interface RpcCounter {
  sent(method: string): void;
  limited(): void;
  drain(): RpcUsage;
  /** The counts without resetting them. */
  peek(): RpcUsage;
}

export function createRpcCounter(): RpcCounter {
  let requests: Record<string, number> = {};
  let rateLimited = 0;
  const usage = (): RpcUsage => {
    let total = 0;
    let bu = 0;
    for (const [method, n] of Object.entries(requests)) {
      total += n;
      bu += n * billingUnitsOf(method);
    }
    return { requests: { ...requests }, total, bu, rateLimited };
  };
  return {
    sent(method) {
      requests[method] = (requests[method] ?? 0) + 1;
    },
    limited() {
      rateLimited += 1;
    },
    peek: usage,
    drain() {
      const out = usage();
      requests = {};
      rateLimited = 0;
      return out;
    },
  };
}

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
  /** Told of every request sent and every rate-limited answer. */
  counter?: RpcCounter;
}

export function withRateLimitRetry(inner: Transport, opts: RetryOptions = {}): Transport {
  const delays = opts.delaysMs ?? RATE_LIMIT_DELAYS_MS;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  return (params) => {
    const transport = inner(params);
    const request = async (...args: Parameters<typeof transport.request>) => {
      const method = (args[0] as { method?: string } | undefined)?.method ?? 'unknown';
      for (let attempt = 0; ; attempt++) {
        opts.counter?.sent(method);
        try {
          return await transport.request(...args);
        } catch (err) {
          const limited = isRateLimited(err);
          if (limited) opts.counter?.limited();
          const delay = delays[attempt];
          if (delay === undefined || !limited) throw err;
          await sleep(delay * (1 + random() / 4));
        }
      }
    };
    return { ...transport, request: request as typeof transport.request };
  };
}
