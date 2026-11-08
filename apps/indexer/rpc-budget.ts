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

const URL_IN_TEXT = /\b(?:https?|wss?):\/\/[^\s"'`<>)\]}]+/gi;

/** Every url in a text cut down to its origin: a provider keeps the API key in the path or the query. */
export function scrubUrls(text: string): string {
  return text.replace(URL_IN_TEXT, (found) => {
    try {
      return new URL(found).origin;
    } catch {
      return '[url]';
    }
  });
}

/**
 * Takes the urls out of an error and everything it wraps, in place, so its class, `code`, `status` and `details` stay what
 * Ponder and viem go by. viem names the full url in `message`, `metaMessages` and `url`, and Ponder logs the error whole.
 */
export function scrubError<T>(err: T): T {
  const seen = new Set<object>();
  let e: unknown = err;
  for (let depth = 0; e && typeof e === 'object' && !seen.has(e) && depth < 8; depth++) {
    seen.add(e);
    const target = e as Record<string, unknown>;
    for (const key of Object.getOwnPropertyNames(target)) {
      if (key === 'cause') continue;
      const value = target[key];
      try {
        if (typeof value === 'string') target[key] = scrubUrls(value);
        else if (Array.isArray(value)) target[key] = value.map((v: unknown) => (typeof v === 'string' ? scrubUrls(v) : v));
      } catch {
        // A read-only field stays as it was; `message` and `stack` of an Error are writable.
      }
    }
    e = target.cause;
  }
  return err;
}

/** An error's message for a log line, for callers that do not know where the error came from. */
export function safeMessage(err: unknown): string {
  return scrubUrls(err instanceof Error ? err.message : String(err));
}

function parseUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    // Node's own error carries the input, which holds the key.
    throw new Error('An RPC url in BASE_RPC_URL, BASE_SEPOLIA_RPC_URL, BASE_RPC_FALLBACK_URL or INDEXER_BLOCKS_RPC_URL is not a valid url');
  }
}

/** The form Ponder recognises (`status === 429` pauses its provider and retries), naming only the origin: the path holds the API key. */
function rateLimitedError(url: string, body: unknown): HttpRequestError {
  return new HttpRequestError({ body: body as { [x: string]: unknown }, details: 'rate limited', status: 429, url: parseUrl(url).origin });
}

/** Spends nothing: for a provider without a budget, whose errors still have to lose their url. */
const NO_BUDGET: Budget = { take: async () => {}, tryTake: () => true };

export interface BudgetedTransportOptions {
  url: string;
  buPerSecond: number;
  /** Takes what the primary has no budget for, and what it answers 429 to. Without one, requests wait for the budget. */
  fallbackUrl?: string;
  budget?: Budget;
  /** viem's own retries of a failed request (5xx, a dropped connection), which Ponder does not need: it retries by itself. */
  httpRetries?: number;
  /**
   * A url for the block reads alone (`BLOCK_READ_METHODS`), which spend nothing from the budget. Following 200 ms blocks
   * costs one `eth_getBlockByNumber` and one `eth_getLogs` per block, and the public Base endpoint serves the first
   * (measured 2026-11-08: 180 of 180 full blocks answered at 3 a second) but refuses the second (180 of 180 `eth_getLogs`
   * answered 429), so this url takes half the load off the keyed one. A failed read goes to the primary as if there were
   * no such url, and the url is left alone for `BLOCKS_URL_REST_MS` so a dead endpoint costs one failure, not one per block.
   */
  blocksUrl?: string;
  now?: () => number;
}

/** The methods `blocksUrl` serves: the block tail and the finality search, never logs or state. */
export const BLOCK_READ_METHODS: ReadonlySet<string> = new Set(['eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_blockNumber']);
/** How long the blocks url is left alone after a failed read. */
export const BLOCKS_URL_REST_MS = 10_000;

export function budgetedTransport(opts: BudgetedTransportOptions): Transport {
  const budget = opts.budget ?? createBudget(opts.buPerSecond);
  const now = opts.now ?? Date.now;
  return ({ chain, timeout }) => {
    const connect = (url: string) => http(url, { retryCount: opts.httpRetries ?? 0 })({ chain, retryCount: 0, timeout });
    const primary = connect(opts.url);
    const spare = opts.fallbackUrl ? connect(opts.fallbackUrl) : null;
    const blocks = opts.blocksUrl ? connect(opts.blocksUrl) : null;
    let blocksRestUntil = 0;
    const send = async (transport: typeof primary, url: string, args: { method: string; params?: unknown }) => {
      try {
        return await transport.request(args as never);
      } catch (err) {
        throw isRateLimited(err) ? rateLimitedError(url, args) : scrubError(err);
      }
    };
    const request = async (args: { method: string; params?: unknown }) => {
      if (blocks && BLOCK_READ_METHODS.has(args.method) && now() >= blocksRestUntil) {
        try {
          return await send(blocks, opts.blocksUrl!, args);
        } catch (err) {
          blocksRestUntil = now() + BLOCKS_URL_REST_MS;
          console.warn(`[indexer] block read failed on the blocks url (${parseUrl(opts.blocksUrl!).origin}); using the primary for ${BLOCKS_URL_REST_MS / 1000} s: ${safeMessage(err)}`);
        }
      }
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

export interface IndexerRpcArgs {
  urls: readonly string[];
  /** `INDEXER_RPC_BU_PER_SEC`: unset = the CDP default on a CDP url and no budget elsewhere (other providers count differently), 0 = no budget. */
  budget?: string;
  fallbackUrl?: string;
  /** `INDEXER_BLOCKS_RPC_URL`: where the block reads go (`budgetedTransport`); empty = the primary, as before. */
  blocksUrl?: string;
}

function budgetOf(args: IndexerRpcArgs): number {
  const [url] = args.urls;
  if (!url) throw new Error('indexerRpc needs an RPC url');
  const raw = args.budget?.trim();
  const parsed = raw ? Number(raw) : parseUrl(url).hostname.endsWith('developer.coinbase.com') ? DEFAULT_CDP_BUDGET : 0;
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error('INDEXER_RPC_BU_PER_SEC must be a number of billing units per second, 0 for no budget');
  return parsed;
}

const SHARED_BUDGETS = Symbol.for('bootr.indexer.rpc-budgets');

/**
 * One budget per process, for Ponder and for the indexer's own reads (`src/lib/rpc.ts`) together: the limit is per key. It
 * sits on `globalThis` because Ponder loads ponder.config.ts and src/ through its own module runner, which may give each a
 * copy of this file.
 */
function sharedBudget(buPerSecond: number): Budget {
  const store = globalThis as unknown as Record<symbol, Map<number, Budget> | undefined>;
  const budgets = (store[SHARED_BUDGETS] ??= new Map<number, Budget>());
  let budget = budgets.get(buPerSecond);
  if (!budget) {
    budget = createBudget(buPerSecond);
    budgets.set(buPerSecond, budget);
  }
  return budget;
}

/** The transport of every indexer read: within the shared budget, the second url as fallback, no url in any error. */
export function indexerTransport(args: IndexerRpcArgs & { httpRetries?: number }): Transport {
  const buPerSecond = budgetOf(args);
  const [url, listed] = args.urls;
  const fallbackUrl = args.fallbackUrl?.trim() || listed;
  const blocksUrl = args.blocksUrl?.trim();
  if (blocksUrl) parseUrl(blocksUrl);
  return budgetedTransport({
    url: url!,
    buPerSecond,
    budget: buPerSecond > 0 ? sharedBudget(buPerSecond) : NO_BUDGET,
    ...(fallbackUrl ? { fallbackUrl } : {}),
    ...(blocksUrl ? { blocksUrl } : {}),
    ...(args.httpRetries !== undefined ? { httpRetries: args.httpRetries } : {}),
  });
}

/** Whether a url has anything in it to hide: a provider's key sits in the path, the query or the credentials. */
function holdsSecret(raw: string): boolean {
  const u = parseUrl(raw);
  return (u.pathname !== '' && u.pathname !== '/') || u.search !== '' || u.username !== '' || u.password !== '';
}

/**
 * The `rpc` of Ponder's chain config. A url string goes to Ponder's own HTTP client, which puts the full url in its errors
 * and logs them whole, and Ponder has no setting against that. So a plain string is only for urls with nothing to hide
 * (a public endpoint, a local fork); anything else, or anything with a budget, gets a transport that scrubs its errors.
 */
export function indexerRpc(args: IndexerRpcArgs): string | string[] | Transport {
  const buPerSecond = budgetOf(args);
  const fallbackUrl = args.fallbackUrl?.trim() || args.urls[1];
  const all = [...args.urls, ...(fallbackUrl ? [fallbackUrl] : [])];
  // A blocks url is a routing rule, which only the transport applies.
  if (buPerSecond > 0 || args.blocksUrl?.trim() || all.some(holdsSecret)) return indexerTransport(args);
  if (fallbackUrl) return [args.urls[0]!, fallbackUrl];
  return args.urls[0]!;
}

/** Delays before the retries, in ms: about 8 s in all, past CDP's 5 second window, plus up to a quarter of jitter on each. */
export const RATE_LIMIT_DELAYS_MS: readonly number[] = [250, 500, 1_000, 2_000, 4_000];

export interface RetryOptions {
  delaysMs?: readonly number[];
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

/**
 * Waits out a 429 for a caller that has no retry of its own (Ponder has one; the fuel scan and the REST reads do not). The
 * same behaviour as the supervisor's `withRateLimitRetry`: a refused request did nothing, so asking again is safe.
 */
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
