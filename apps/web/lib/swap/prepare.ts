/**
 * `POST /api/agent/swap` as plain functions (docs/design/agent-tools-2.md section 8): a buy or a sell of one Bootr coin,
 * prepared for a person as unsigned transactions. Everything that touches the chain is the trade panel's own code
 * (`core.ts`, fork-tested on the three launch paths); this file only checks a request, picks the coin's verified pool
 * and writes the answer. `app/api/agent/swap/route.ts` reads the indexer and the chain and calls it. Nothing here
 * reads the network, signs or sends.
 *
 * What a caller can and cannot steer, since a person signs the result with real money:
 * - The pool is the coin's own. Its key is built from the coin's address and the address book's hooks and paired
 *   assets, and is used only when it hashes to the pool id the indexer holds for that coin (`verifiedPoolKey`).
 * - The targets are the address book's Universal Router and Permit2, and the token being spent. No field of a
 *   request reaches a `to`.
 * - There is no recipient to name. The swap's calldata pays "the sender" (the router's own placeholder), so the coins
 *   or the ETH go to whichever wallet sends the transaction. `wallet` is read for its balance and its allowances and
 *   is repeated as `sendFrom`; it is in no calldata.
 * - Approvals are for the exact amount, to Permit2 and from Permit2 to the router, never more, the second for 30
 *   minutes.
 * - The minimum received is the live quote less the slippage, and that same number is the floor inside the calldata.
 */
import { formatUnits, getAddress, isAddress, type Address, type Hex } from 'viem';
import {
  approvalCalls,
  buildBuyTx,
  buildEthViaPairedBuyTx,
  buildSellTx,
  CLANKER_V5_ANTI_SNIPE_SECONDS,
  isErc20Paired,
  launchWindowActive,
  MAX_SLIPPAGE_BPS,
  minReceived,
  pairedCurrency,
  PERMIT2_EXPIRY_SECONDS,
  poolKeyOf,
  SWAP_CONTRACTS,
  SWAP_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  v5TradingOpensIn,
  verifiedPoolKey,
  type Allowances,
  type PoolKey,
  type PoolSource,
  type SwapSide,
} from './core';
import { SwapFailure, type SwapFailureCode } from './errors';
import type { SwapQuote } from './quote';
import { COIN_DECIMALS, GAS_RESERVE_WEI, parseAmount } from './view';

// ---------------------------------------------------------------------------
// Limits (docs/design/agent-tools-2.md section 13)
// ---------------------------------------------------------------------------

/** Calls a minute per address, as the claim route's. Fixed in code: the catalog states it. */
export const SWAP_PREPARE_PER_MIN = 20;
/** Calls a minute over all callers: each one is an indexer read and two chain reads. 0 switches the route off. */
export const SWAP_PREPARE_PER_MIN_ALL = 240;
/** A quote whose measured fee is above this percent is not prepared (the launch fee of a new Clanker coin). */
export const SWAP_PREPARE_MAX_FEE_PCT = 15;
/** A price impact above this percent is a line in `warnings`; the floor is what protects the trade. */
export const SWAP_IMPACT_WARNING_PCT = 5;
const SLIPPAGE_WARNING_BPS = 500;

export type SwapPrepareLimits = { enabled: boolean; perMinute: number; perMinuteAll: number; maxFeePct: number };

function numberFrom(value: string | undefined, fallback: number, max: number): number {
  const s = (value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(s)) return fallback;
  return Math.min(Number(s), max);
}

/**
 * The route's limits. `SWAP_PREPARE_PER_MIN_ALL` and `SWAP_PREPARE_MAX_FEE_PCT` can be set in the environment under
 * those names; `SWAP_PREPARE_PER_MIN_ALL=0` switches the route off (it answers 404 and leaves the catalog).
 */
export function swapPrepareLimits(env: Record<string, string | undefined> = process.env): SwapPrepareLimits {
  const perMinuteAll = Math.floor(numberFrom(env.SWAP_PREPARE_PER_MIN_ALL, SWAP_PREPARE_PER_MIN_ALL, 100_000));
  const maxFeePct = numberFrom(env.SWAP_PREPARE_MAX_FEE_PCT, SWAP_PREPARE_MAX_FEE_PCT, 100);
  return { enabled: perMinuteAll > 0, perMinute: SWAP_PREPARE_PER_MIN, perMinuteAll, maxFeePct };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

/** A refusal as the route answers it: `{error, message, field?}` with this status, and `Retry-After` when it helps. */
export type SwapRefusal = { status: number; error: string; message: string; field?: string; retryAfter?: number };

export const SWAP_NOTHING_PREPARED = 'Nothing was prepared.';

const invalid = (field: string, message: string): SwapRefusal => ({ status: 400, error: 'invalid_request', field, message: `${message} ${SWAP_NOTHING_PREPARED}` });

export const SWAP_REFUSALS = {
  unknownCoin: (): SwapRefusal => ({ status: 404, error: 'unknown_coin', message: 'No Bootr coin has that address.' }),
  notTradable: (): SwapRefusal => ({ status: 409, error: 'not_tradable', message: 'This coin cannot be traded here: its pool does not match a Bootr launch. Nothing was prepared.' }),
  wrongChain: (): SwapRefusal => ({ status: 409, error: 'not_tradable', message: 'Swaps are prepared for Base only, and this site runs on another chain. Nothing was prepared.' }),
  tradingNotOpen: (seconds: number): SwapRefusal => ({
    status: 409,
    error: 'trading_not_open',
    retryAfter: seconds,
    message: `This coin launched moments ago. For its first ${CLANKER_V5_ANTI_SNIPE_SECONDS} seconds Clanker charges buyers up to 99%, so nothing was prepared. Trading opens in ${seconds} ${seconds === 1 ? 'second' : 'seconds'}.`,
  }),
  feeTooHigh: (feePct: number): SwapRefusal => ({ status: 409, error: 'fee_too_high', retryAfter: 5, message: `This trade would pay a fee of ${Math.round(feePct * 10) / 10}% right now. Nothing was prepared; ask again in a moment.` }),
  noQuote: (): SwapRefusal => ({ status: 409, error: 'no_quote', retryAfter: 5, message: 'The pool gave no quote for this trade just now. Nothing was prepared; ask again in a moment.' }),
  switchedOff: (): SwapRefusal => ({ status: 404, error: 'not_available', message: 'Preparing swaps is switched off on this site for now. Nothing was prepared.' }),
  indexerDown: (): SwapRefusal => ({ status: 502, error: 'indexer_unavailable', message: 'Could not read this coin from the indexer. Nothing was prepared: try again in a moment.' }),
  bodyTooLarge: (): SwapRefusal => ({ status: 413, error: 'payload_too_large', message: 'The request body is too large: this route takes a small JSON object. Nothing was prepared.' }),
} as const;

/** The panel's own words (`errors.ts`), with the status this route gives each. Any other failure of a quote is `no_quote`. */
const PANEL_STATUS: Partial<Record<SwapFailureCode, number>> = { no_balance: 409, no_liquidity: 409, no_pool: 409, launch_window: 409, network: 502 };

export function panelRefusal(code: SwapFailureCode): SwapRefusal {
  const status = PANEL_STATUS[code];
  if (status === undefined) return SWAP_REFUSALS.noQuote();
  return { status, error: code, message: `${new SwapFailure(code).message} ${SWAP_NOTHING_PREPARED}`, ...(code === 'launch_window' ? { retryAfter: 5 } : {}) };
}

// ---------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------

export type PayWith = 'ETH' | 'USDC';

export type SwapRequest = {
  token: Address;
  side: SwapSide;
  /** What goes in, as the caller wrote it: a plain decimal. Its units depend on the coin, so it is parsed with the plan. */
  amount: string;
  wallet: Address;
  payWith: PayWith | null;
  slippageBps: number;
};

const FIELDS = ['token', 'side', 'amount', 'wallet', 'payWith', 'slippagePct'] as const;
const DECIMAL = /^(\d+\.?\d*|\.\d+)$/;
const MAX_AMOUNT_CHARS = 60;

function addressOf(value: unknown): Address | null {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? getAddress(value) : null;
}

/** The body of a request, checked field by field. An unknown field is refused: there is nothing else to set, a recipient least of all. */
export function parseSwapRequest(body: unknown): { ok: true; request: SwapRequest } | { ok: false; refusal: SwapRefusal } {
  const no = (refusal: SwapRefusal) => ({ ok: false as const, refusal });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return no(invalid('body', 'The body must be a JSON object: {token, side, amount, wallet, payWith?, slippagePct?}.'));
  const b = body as Record<string, unknown>;
  const unknown = Object.keys(b).find((k) => !(FIELDS as readonly string[]).includes(k));
  if (unknown !== undefined) {
    // The name is the caller's own text: only a plain word of it is repeated.
    const shown = /^[A-Za-z0-9_]{1,32}$/.test(unknown) ? unknown : 'that';
    return no(invalid(shown === 'that' ? 'body' : shown, `${shown} is not a field of this route: it takes token, side, amount, wallet, payWith and slippagePct. What a swap pays goes to the wallet that sends it.`));
  }

  const token = addressOf(b.token);
  if (!token) return no(invalid('token', 'token must be the coin’s 0x address of 40 hex characters.'));
  if (b.side !== 'buy' && b.side !== 'sell') return no(invalid('side', 'side must be "buy" or "sell".'));
  const wallet = addressOf(b.wallet);
  if (!wallet || BigInt(wallet) === 0n) return no(invalid('wallet', 'wallet must be the 0x address of the wallet that will send the steps.'));

  const amount = typeof b.amount === 'number' && Number.isFinite(b.amount) ? String(b.amount) : typeof b.amount === 'string' ? b.amount.trim() : '';
  if (amount.length === 0 || amount.length > MAX_AMOUNT_CHARS || !DECIMAL.test(amount) || /^[0.]*$/.test(amount))
    return no(invalid('amount', 'amount must be a positive decimal such as "0.01", written as a string: what goes in, in ETH or USDC on a buy and in the coin on a sell.'));

  let payWith: PayWith | null = null;
  if (b.payWith !== undefined && b.payWith !== null) {
    const p = typeof b.payWith === 'string' ? b.payWith.trim().toUpperCase() : '';
    if (p !== 'ETH' && p !== 'USDC') return no(invalid('payWith', 'payWith must be "ETH" or "USDC".'));
    if (b.side === 'sell') return no(invalid('payWith', 'payWith belongs to a buy: a sell pays out in the coin’s paired asset.'));
    payWith = p;
  }

  let slippageBps = DEFAULT_SLIPPAGE_BPS;
  if (b.slippagePct !== undefined && b.slippagePct !== null) {
    const raw = typeof b.slippagePct === 'string' ? b.slippagePct.trim() : b.slippagePct;
    const pct = typeof raw === 'number' ? raw : typeof raw === 'string' && DECIMAL.test(raw) ? Number(raw) : NaN;
    const bps = Math.round(pct * 100);
    if (!Number.isFinite(pct) || bps < 1 || bps > MAX_SLIPPAGE_BPS || Math.abs(pct * 100 - bps) > 1e-6)
      return no(invalid('slippagePct', `slippagePct must be a number from 0.01 to ${MAX_SLIPPAGE_BPS / 100}, with at most two decimals. Leave it out for ${DEFAULT_SLIPPAGE_BPS / 100}.`));
    slippageBps = bps;
  }
  return { ok: true, request: { token, side: b.side, amount, wallet, payWith, slippageBps } };
}

// ---------------------------------------------------------------------------
// The plan: the coin's pool and what the swap spends
// ---------------------------------------------------------------------------

/** The fields of the indexer's token row this route reads. */
export type SwapCoinRow = {
  id: string;
  symbol: string;
  poolId: string;
  source?: string | null;
  pairedToken?: string | null;
  /** Unix seconds. */
  launchedAt?: number | string | null;
  /** Whether a Clanker v5 coin was launched with the sniper tax; unknown counts as on. */
  antiSnipe?: boolean | null;
};

export type AssetView = { symbol: string; decimals: number };

export type SwapPlan = {
  key: PoolKey;
  path: PoolSource;
  pairedAsset: PayWith;
  /** `eth-via-paired`: a buy of a USDC-paired coin with ETH, two hops in one transaction. */
  route: 'direct' | 'eth-via-paired';
  amountIn: bigint;
  input: AssetView;
  output: AssetView;
  /** The ERC-20 the swap spends through Permit2 (the coin on a sell, USDC on a buy that pays USDC); null when ETH pays. */
  spent: Address | null;
};

/** A coin's symbol as this route writes it in a sentence: letters, digits and `_`, whatever the row holds. */
export function plainSymbol(symbol: unknown): string {
  return String(symbol ?? '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16) || 'COIN';
}

const USDC_DECIMALS = 6;
const ETH: AssetView = { symbol: 'ETH', decimals: 18 };
const USDC: AssetView = { symbol: 'USDC', decimals: USDC_DECIMALS };

/**
 * The pool to trade the coin on, by the panel's own rule (`tradePoolKey` in use-swap.ts): the key each launch path
 * builds for the coin, used only when it hashes to the coin's indexed pool id. The pool id commits to both currencies,
 * the fee, the tick spacing and the hook, so a row cannot name a pool this site did not build the key for. The only
 * thing read from the row besides the id is whether a Clanker v5 coin is paired with USDC; any other pair than ETH or
 * USDC matches nothing. `unverified` is mock mode, where no pool exists to check against.
 */
function poolOf(coin: SwapCoinRow, token: Address, unverified: boolean): { key: PoolKey; path: PoolSource } | null {
  const paired = typeof coin.pairedToken === 'string' && isAddress(coin.pairedToken, { strict: false }) && BigInt(coin.pairedToken) === BigInt(SWAP_CONTRACTS.usdc) ? SWAP_CONTRACTS.usdc : null;
  if (unverified) {
    const path: PoolSource = coin.source === 'clanker-v5' ? 'clanker-v5' : coin.source === 'clanker' ? 'clanker' : 'bootr';
    const key = poolKeyOf(token, path, path === 'clanker-v5' ? paired : null);
    return key ? { key, path } : null;
  }
  if (typeof coin.poolId !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(coin.poolId)) return null;
  const tries: [PoolSource, Address | null][] = [['clanker-v5', paired], ['clanker', null], ['bootr', null]];
  for (const [path, quote] of tries) {
    const key = verifiedPoolKey(token, path, coin.poolId, quote);
    if (key) return { key, path };
  }
  return null;
}

/**
 * From the coin's row and a checked request: the pool, the route and the amount in base units, or the refusal.
 * `now` is unix seconds.
 */
export function planSwap(coin: SwapCoinRow, request: SwapRequest, now: number, options: { unverified?: boolean } = {}): { ok: true; plan: SwapPlan } | { ok: false; refusal: SwapRefusal } {
  const no = (refusal: SwapRefusal) => ({ ok: false as const, refusal });
  // The row must be the coin that was asked for: nothing is ever prepared for another address than the request's.
  if (typeof coin.id !== 'string' || coin.id.toLowerCase() !== request.token.toLowerCase()) return no(SWAP_REFUSALS.unknownCoin());
  const pool = poolOf(coin, request.token, options.unverified === true);
  if (!pool) return no(SWAP_REFUSALS.notTradable());
  const { key, path } = pool;
  const usdcPaired = isErc20Paired(key);
  // An ERC-20 pair that is not USDC never gets this far (poolOf); said again where the money is.
  if (usdcPaired && BigInt(pairedCurrency(key)) !== BigInt(SWAP_CONTRACTS.usdc)) return no(SWAP_REFUSALS.notTradable());
  const pairedAsset: PayWith = usdcPaired ? 'USDC' : 'ETH';
  const coinAsset: AssetView = { symbol: plainSymbol(coin.symbol), decimals: COIN_DECIMALS };

  if (request.side === 'buy' && request.payWith === 'USDC' && !usdcPaired)
    return no(invalid('payWith', 'payWith "USDC" is for a coin paired with USDC. This coin is paired with ETH: leave payWith out.'));
  const viaEth = request.side === 'buy' && usdcPaired && request.payWith === 'ETH';
  const input = request.side === 'sell' ? coinAsset : usdcPaired && !viaEth ? USDC : ETH;
  const output = request.side === 'sell' ? (usdcPaired ? USDC : ETH) : coinAsset;

  const amountIn = parseAmount(request.amount, input.decimals);
  if (amountIn === null)
    return no(invalid('amount', `amount must be a positive decimal with at most ${input.decimals} decimals: this ${request.side} takes it in ${input.symbol === coinAsset.symbol && request.side === 'sell' ? 'the coin' : input.symbol}.`));

  // The panel's rule: a v5 coin launched with the sniper tax on (unknown counts as on) takes no buy for its first 20 seconds.
  const launchedAt = Number(coin.launchedAt);
  if (path === 'clanker-v5' && request.side === 'buy' && coin.antiSnipe !== false && Number.isFinite(launchedAt) && launchedAt > 0) {
    const opensIn = v5TradingOpensIn(launchedAt, now);
    if (opensIn > 0) return no(SWAP_REFUSALS.tradingNotOpen(opensIn));
  }

  const spent = request.side === 'sell' ? request.token : usdcPaired && !viaEth ? SWAP_CONTRACTS.usdc : null;
  return { ok: true, plan: { key, path, pairedAsset, route: viaEth ? 'eth-via-paired' : 'direct', amountIn, input, output, spent } };
}

// ---------------------------------------------------------------------------
// The answer
// ---------------------------------------------------------------------------

export type SwapAmount = { raw: string; formatted: string; asset: string };

export type SwapStep = {
  kind: 'approve_token' | 'approve_permit2' | 'swap';
  to: Address;
  data: Hex;
  /** Decimal wei. */
  value: string;
  /** The wallet that must send it: the request's own. */
  sendFrom: Address;
  description: string;
};

export type PreparedSwap = {
  chainId: 8453;
  token: Address;
  symbol: string;
  side: SwapSide;
  path: PoolSource;
  pairedAsset: PayWith;
  amountIn: SwapAmount;
  quote: { amountOut: SwapAmount; feePct: number | null; impactPct: number | null; quotedAt: number };
  minReceived: SwapAmount;
  slippagePct: number;
  /** Unix seconds: the swap reverts when it is mined after this. */
  deadline: number;
  steps: SwapStep[];
  warnings: string[];
  note: string;
  mock?: true;
};

/** What the route read about the wallet. */
export type WalletState = {
  /** The wallet's ETH. */
  eth: bigint;
  /** Its balance of `plan.spent`; null when ETH pays. */
  spent: bigint | null;
  /** Its two allowances for `plan.spent`; null when ETH pays. */
  allowances: Allowances | null;
};

const amountOf = (raw: bigint, asset: AssetView): SwapAmount => ({ raw: raw.toString(), formatted: formatUnits(raw, asset.decimals), asset: asset.symbol });
const pct1 = (value: number) => `${Math.round(value * 10) / 10}%`;

export const SWAP_NOTE =
  'Nothing was signed or sent. These are unsigned transactions for the wallet in sendFrom to send, in order, each after the one before is mined, and only if its owner decides to. What the swap pays goes to the wallet that sends it. The quote is as read just now: the swap reverts if it would give less than minReceived or is mined after the deadline.';

/**
 * The answer of section 8.1 from what was read, or the refusal. Pure: the same inputs give the same bytes.
 * `now` is unix seconds; `dataSuffix` is the site's builder code, as on the panel's own transactions.
 */
export function prepareSwap(input: {
  coin: SwapCoinRow;
  request: SwapRequest;
  plan: SwapPlan;
  quote: SwapQuote;
  wallet: WalletState;
  now: number;
  maxFeePct?: number;
  dataSuffix?: Hex;
}): { ok: true; prepared: PreparedSwap } | { ok: false; refusal: SwapRefusal } {
  const { coin, request, plan, quote, wallet, now, dataSuffix } = input;
  const no = (refusal: SwapRefusal) => ({ ok: false as const, refusal });
  const maxFeePct = input.maxFeePct ?? SWAP_PREPARE_MAX_FEE_PCT;
  const { key, amountIn } = plan;

  // The quote must be for this very trade: the floor below is cut from it.
  if (quote.side !== request.side || quote.amountIn !== amountIn || quote.amountOut <= 0n) return no(SWAP_REFUSALS.noQuote());

  // A swap that spends an ERC-20 needs that token's balance and both allowances read; without them nothing is prepared.
  if (plan.spent && (wallet.spent === null || !wallet.allowances)) return no(panelRefusal('network'));
  const balance = plan.spent ? wallet.spent! : wallet.eth;
  if (balance < amountIn) return no(panelRefusal('no_balance'));

  // A fee that could not be measured while Clanker's launch fee may still run is not prepared either.
  if (quote.feePct !== null && quote.feePct > maxFeePct) return no(SWAP_REFUSALS.feeTooHigh(quote.feePct));
  if (quote.feePct === null && launchWindowActive(quote.launchWindow, now)) return no(panelRefusal('launch_window'));

  const minOut = minReceived(quote.amountOut, request.slippageBps);
  if (minOut <= 0n) return no(invalid('amount', 'amount is too small to trade: the minimum received would be 0.'));
  const deadline = now + SWAP_DEADLINE_SECONDS;

  const args = { key, coin: request.token, amountIn, minOut, deadline: BigInt(deadline), ...(dataSuffix ? { dataSuffix } : {}) };
  const tx = request.side === 'sell' ? buildSellTx(args) : plan.route === 'eth-via-paired' ? buildEthViaPairedBuyTx(args) : buildBuyTx(args);

  const symbol = plainSymbol(coin.symbol);
  const inText = `${formatUnits(amountIn, plan.input.decimals)} ${plan.input.symbol}`;
  const minText = `${formatUnits(minOut, plan.output.decimals)} ${plan.output.symbol}`;
  const until = new Date(deadline * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const step = (kind: SwapStep['kind'], call: { to: Address; data: Hex; value: bigint }, description: string): SwapStep => ({ kind, to: call.to, data: call.data, value: call.value.toString(), sendFrom: request.wallet, description });

  const steps: SwapStep[] = [];
  if (plan.spent) {
    for (const call of approvalCalls({ coin: plan.spent, amount: amountIn, allowances: wallet.allowances!, now, ...(dataSuffix ? { dataSuffix } : {}) })) {
      steps.push(
        call.kind === 'token'
          ? step('approve_token', call, `Lets Permit2, Uniswap’s allowance contract, move exactly ${inText} from the sending wallet, and no more. Nothing moves yet.`)
          : step('approve_permit2', call, `Lets Uniswap’s Universal Router take exactly ${inText} through Permit2, for ${PERMIT2_EXPIRY_SECONDS / 60} minutes. Nothing moves yet.`),
      );
    }
  }
  steps.push(
    step(
      'swap',
      tx,
      request.side === 'buy'
        ? `Buys ${symbol} with ${inText}${plan.route === 'eth-via-paired' ? ', through USDC in one transaction' : ''}. The sending wallet receives at least ${minText}, or the transaction reverts. It also reverts when mined after ${until}.`
        : `Sells ${inText}. The sending wallet receives at least ${minText}, or the transaction reverts. It also reverts when mined after ${until}.`,
    ),
  );

  const warnings: string[] = [];
  if (quote.impactPct !== null && quote.impactPct > SWAP_IMPACT_WARNING_PCT) warnings.push(`This trade moves the pool’s price by about ${pct1(quote.impactPct)}. A smaller amount fills closer to the current price.`);
  if (quote.feePct === null) warnings.push('The fee of this trade could not be measured. The quote and the minimum received are after every fee.');
  if (request.slippageBps > SLIPPAGE_WARNING_BPS) warnings.push(`With this slippage the swap can fill up to ${request.slippageBps / 100}% below the quote.`);
  if (plan.route === 'eth-via-paired') warnings.push('The ETH is swapped to USDC on Uniswap v3 first and the USDC buys the coin, in one transaction. The quote for the first part is an estimate; the minimum received covers both parts.');
  const ethLeft = plan.spent ? wallet.eth : wallet.eth - amountIn;
  if (ethLeft < GAS_RESERVE_WEI) warnings.push(`The wallet would have ${formatUnits(ethLeft, 18)} ETH left for the network fee of ${steps.length === 1 ? 'this transaction' : `these ${steps.length} transactions`}, which may not be enough.`);

  return {
    ok: true,
    prepared: {
      chainId: SWAP_CONTRACTS.chainId,
      token: request.token,
      symbol: String(coin.symbol ?? ''),
      side: request.side,
      path: plan.path,
      pairedAsset: plan.pairedAsset,
      amountIn: amountOf(amountIn, plan.input),
      quote: { amountOut: amountOf(quote.amountOut, plan.output), feePct: quote.feePct, impactPct: quote.impactPct, quotedAt: now },
      minReceived: amountOf(minOut, plan.output),
      slippagePct: request.slippageBps / 100,
      deadline,
      steps,
      warnings,
      note: SWAP_NOTE,
    },
  };
}
