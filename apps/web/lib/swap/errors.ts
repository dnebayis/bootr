/**
 * Every way a swap can fail, in words a person can act on. Nothing here shows a raw revert: known errors are matched by
 * name or by selector anywhere in the revert data (the router and the pool manager wrap the error that matters, so it
 * sits inside `ExecutionFailed`, `WrappedError` or `UnexpectedRevertBytes`).
 */
import { toFunctionSelector } from 'viem';
import { launchWindowActive, type LaunchWindow } from './core';

export type SwapFailureCode =
  | 'not_connected'
  | 'wrong_chain'
  | 'no_balance'
  | 'rejected'
  | 'slippage'
  | 'no_liquidity'
  | 'no_pool'
  | 'launch_window'
  | 'approval'
  | 'expired'
  | 'gas'
  | 'network'
  | 'reverted';

const MESSAGES: Record<SwapFailureCode, string> = {
  not_connected: 'Connect a wallet to swap.',
  wrong_chain: 'Your wallet is on another network. Switch to Base to swap.',
  no_balance: 'Your balance is too low for this amount.',
  rejected: 'You rejected the request in your wallet, so the swap did not go through.',
  slippage: 'The price moved past your slippage setting, so the swap did not go through. Get a new quote, or raise the setting.',
  no_liquidity: 'The pool does not have enough liquidity for this amount. Try a smaller amount.',
  no_pool: 'This coin has no trading pool yet.',
  launch_window:
    'This coin launched moments ago. Clanker blocks swaps for the first seconds after a launch, then charges a very high fee that falls over about 15 seconds. Try again shortly.',
  approval: 'The approval for this sell is missing or has expired. Start the sell again to approve it.',
  expired: 'This swap waited too long and expired. Get a new quote and try again.',
  gas: 'Your wallet does not have enough ETH for the network fee.',
  network: 'Could not reach the network. Check your connection and try again.',
  reverted: 'The swap failed on chain and nothing was exchanged. Get a new quote and try again.',
};

const sel = (signature: string) => toFunctionSelector(`function ${signature}`).slice(2).toLowerCase();

/** In match order: the error that names the cause wins over anything that merely wraps it. */
const KNOWN: readonly { code: SwapFailureCode; names: readonly string[]; selectors: readonly string[] }[] = [
  {
    code: 'slippage',
    names: ['V4TooLittleReceived', 'V4TooMuchRequested', 'InsufficientETH'],
    selectors: [sel('V4TooLittleReceived(uint256,uint256)'), sel('V4TooMuchRequested(uint256,uint256)'), sel('InsufficientETH()')],
  },
  // `PartialFill`: the RWAGMI hook refuses a swap the pool cannot fill completely.
  { code: 'no_liquidity', names: ['NotEnoughLiquidity', 'PartialFill'], selectors: [sel('NotEnoughLiquidity(bytes32)'), sel('PartialFill()')] },
  { code: 'no_pool', names: ['PoolNotInitialized'], selectors: [sel('PoolNotInitialized()')] },
  { code: 'expired', names: ['TransactionDeadlinePassed'], selectors: [sel('TransactionDeadlinePassed()')] },
  {
    code: 'approval',
    names: ['InsufficientAllowance', 'AllowanceExpired', 'ERC20InsufficientAllowance'],
    selectors: [sel('InsufficientAllowance(uint256)'), sel('AllowanceExpired(uint256)'), sel('ERC20InsufficientAllowance(address,uint256,uint256)')],
  },
  { code: 'no_balance', names: ['ERC20InsufficientBalance'], selectors: [sel('ERC20InsufficientBalance(address,uint256,uint256)')] },
];

type ErrorLike = {
  name?: unknown;
  code?: unknown;
  message?: unknown;
  shortMessage?: unknown;
  details?: unknown;
  data?: unknown;
  raw?: unknown;
  signature?: unknown;
  errorName?: unknown;
  args?: unknown;
  cause?: unknown;
};

/** All the text and revert data an error and its causes carry. */
function collect(e: unknown): { text: string; codes: unknown[] } {
  const parts: string[] = [];
  const codes: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (v: unknown) => {
    if (v === null || v === undefined || seen.has(v)) return;
    if (typeof v === 'string') {
      parts.push(v);
      return;
    }
    if (typeof v !== 'object') return;
    seen.add(v);
    const o = v as ErrorLike;
    if (o.code !== undefined) codes.push(o.code);
    for (const f of [o.name, o.errorName, o.message, o.shortMessage, o.details, o.raw, o.signature]) if (typeof f === 'string') parts.push(f);
    if (Array.isArray(o.args)) for (const a of o.args) if (typeof a === 'string') parts.push(a);
    visit(o.data);
    visit(o.cause);
  };
  visit(e);
  return { text: parts.join('\n'), codes };
}

type Context = { launchWindow?: LaunchWindow | null; now?: number };

export function classifySwapError(e: unknown, ctx?: Context): SwapFailureCode {
  if (e instanceof SwapFailure) return e.code;
  const { text, codes } = collect(e);
  const lower = text.toLowerCase();
  if (codes.includes(4001) || codes.includes('ACTION_REJECTED') || /user rejected|user denied|rejected the request|request rejected|denied transaction|user cancel/.test(lower)) {
    return 'rejected';
  }
  for (const { code, names, selectors } of KNOWN) {
    if (names.some((n) => text.includes(n)) || selectors.some((s) => lower.includes(s))) return code;
  }
  if (codes.includes(4902) || /does not match the|chain mismatch|chain not configured|unrecognized chain/.test(lower)) return 'wrong_chain';
  if (/connector not connected|connector not found/.test(lower)) return 'not_connected';
  if (/transfer_from_failed|transfer amount exceeds balance/.test(lower)) return 'no_balance';
  if (/insufficient funds|exceeds the balance of the account/.test(lower)) return 'gas';
  const reverted = /revert|execution failed|wrappederror|unexpectedrevertbytes/.test(lower);
  // A revert the hook gives no useful name to, in the seconds Clanker's launch fee runs: that is the cause.
  if (reverted && launchWindowActive(ctx?.launchWindow, ctx?.now ?? Date.now() / 1000)) return 'launch_window';
  if (reverted) return 'reverted';
  if (/failed to fetch|fetch failed|network|timeout|timed out|http request failed|rate limit|429|503/.test(lower)) return 'network';
  return 'reverted';
}

export class SwapFailure extends Error {
  constructor(readonly code: SwapFailureCode) {
    super(MESSAGES[code]);
    this.name = 'SwapFailure';
  }

  static from(e: unknown, ctx?: Context): SwapFailure {
    return e instanceof SwapFailure ? e : new SwapFailure(classifySwapError(e, ctx));
  }
}
