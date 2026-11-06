import { HttpRequestError, http, type Transport } from 'viem';

/**
 * Keeps Ponder under the CDP Node rate limit, which counts billing units and not requests: 7,500 BU every 5 seconds per
 * project, shared by every service on the key, with `eth_getLogs` and `eth_getBlockByNumber` at 100 BU each
 * (docs.cdp.coinbase.com/node/docs/rate-limiting, /data/node/pricing). That is 15 such calls a second, not the "about
 * 50 requests per second" the docs quote for an average call.
 *
 * Ponder 0.18 has no setting for this: `maxRequestsPerSecond` is deprecated and ignored, and its own dynamic limit starts
 * at 20 requests a second (up to 2,000 BU/s) and only comes down after 429s, which the supervisor's reads then share. Base's
 * 200 ms blocks (Denim, 2026-11-05) cost about 750 BU/s to follow, ten times what 2 s blocks did, and a restart refetches the
 * 180 s reorg window, about 1,000 blocks, so the room left is narrow.
 *
 * This file sits beside ponder.config.ts and not under src/ on purpose: Ponder's build id hashes every file under src/
 * and the config's `contracts`, `accounts`, `blocks` and `ordering`, never `chains`. Changing the budget or this file
 * needs no new DATABASE_SCHEMA and no backfill.
 */
export const CDP_BU_PER_SECOND = 1_500;
/** Leaves 200 BU/s (1,000 BU in each 5 second window) for the supervisor and the web routes while Ponder catches up. */
export const DEFAULT_CDP_BUDGET = 1_300;

const STANDARD_BU = 30;
const ENHANCED_BU: Record<string, number> = { eth_getLogs: 100, eth_getBlockByNumber: 100, eth_getTransactionReceipt: 100, eth_getBlockReceipts: 100, eth_estimateGas: 100 };

export const costOf = (method: string): number => ENHANCED_BU[method] ?? STANDARD_BU;

export interface Budget {
  /** Spends `cost`, waiting its turn when the budget is overdrawn. First come, first served. */
  take(cost: number): Promise<void>;
  /** Spends `cost` only when it is there right now. */
  tryTake(cost: number): boolean;
}

export function createBudget(
  buPerSecond: number,
  now: () => number = Date.now,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Budget {
  // At most half a second of burst, so a full bucket plus 5 seconds of refill stays under the window's 7,500 BU.
  const capacity = buPerSecond / 2;
  let tokens = capacity;
  let at = now();
  const refill = () => {
    const t = now();
    tokens = Math.min(capacity, tokens + ((t - at) / 1000) * buPerSecond);
    at = t;
  };
  return {
    async take(cost) {
      refill();
      tokens -= cost;
      if (tokens < 0) await sleep((-tokens / buPerSecond) * 1000);
    },
    tryTake(cost) {
      refill();
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    },
  };
}

/** CDP answers HTTP 429 with a JSON-RPC body `-32002 rate limited`, which viem surfaces as a resource error without a status. */
export function isRateLimited(err: unknown): boolean {
  let e = err as { status?: unknown; code?: unknown; cause?: unknown } | null | undefined;
  for (let depth = 0; e && depth < 6; depth++) {
    if (e.status === 429 || e.code === 429 || e.code === -32002 || e.code === -32005 || e.code === -32007) return true;
    e = e.cause as typeof e;
  }
  return false;
}

/** The form Ponder recognises (`status === 429` pauses its provider and retries), naming only the origin: the path holds the API key. */
function rateLimitedError(url: string, body: unknown): HttpRequestError {
  return new HttpRequestError({ body: body as { [x: string]: unknown }, details: 'rate limited', status: 429, url: new URL(url).origin });
}

export interface BudgetedTransportOptions {
  url: string;
  buPerSecond: number;
  /** Takes what the primary has no budget for, and what it answers 429 to. Without one, requests wait for the budget. */
  fallbackUrl?: string;
  budget?: Budget;
}

export function budgetedTransport(opts: BudgetedTransportOptions): Transport {
  const budget = opts.budget ?? createBudget(opts.buPerSecond);
  return ({ chain, timeout }) => {
    const connect = (url: string) => http(url, { retryCount: 0 })({ chain, retryCount: 0, timeout });
    const primary = connect(opts.url);
    const spare = opts.fallbackUrl ? connect(opts.fallbackUrl) : null;
    const send = async (transport: typeof primary, url: string, args: { method: string; params?: unknown }) => {
      try {
        return await transport.request(args as never);
      } catch (err) {
        throw isRateLimited(err) ? rateLimitedError(url, args) : err;
      }
    };
    const request = async (args: { method: string; params?: unknown }) => {
      const cost = costOf(args.method);
      if (!spare) {
        await budget.take(cost);
        return send(primary, opts.url, args);
      }
      if (!budget.tryTake(cost)) return send(spare, opts.fallbackUrl!, args);
      try {
        return await send(primary, opts.url, args);
      } catch (err) {
        if (isRateLimited(err)) return send(spare, opts.fallbackUrl!, args);
        throw err;
      }
    };
    return { ...primary, request: request as typeof primary.request };
  };
}

/** The `rpc` of Ponder's chain config. `INDEXER_RPC_BU_PER_SEC`: unset = the CDP default on a CDP url and no budget elsewhere (other providers count differently), 0 = no budget. */
export function indexerRpc(args: { urls: readonly string[]; budget?: string; fallbackUrl?: string }): string | string[] | Transport {
  const [url, listed] = args.urls;
  if (!url) throw new Error('indexerRpc needs an RPC url');
  const fallbackUrl = args.fallbackUrl?.trim() || listed;
  const raw = args.budget?.trim();
  const parsed = raw ? Number(raw) : new URL(url).hostname.endsWith('developer.coinbase.com') ? DEFAULT_CDP_BUDGET : 0;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('INDEXER_RPC_BU_PER_SEC must be a number of billing units per second, 0 for no budget');
  if (parsed > 0) return budgetedTransport({ url, buPerSecond: parsed, ...(fallbackUrl ? { fallbackUrl } : {}) });
  if (fallbackUrl) return [url, fallbackUrl];
  return args.urls.length > 1 ? [...args.urls] : url;
}
