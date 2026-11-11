/**
 * Buying and selling a coin on its Uniswap v4 pool, in the user's own wallet: no React, no wagmi, no env, so the panel
 * and the Base fork test (`swap.fork.test.ts`) run the same bytes.
 *
 * Every Bootr coin has one pool: paired with WETH on the RWAGMI and Clanker v4 paths, with native ETH on Clanker v5
 * (`currency0 = 0x0`). People hold ETH, so:
 *
 * - Buy, WETH pool: `WRAP_ETH` into the router, `V4_SWAP` (exact in, `amountOutMinimum` = the minimum received, the coin
 *   goes to the caller), `UNWRAP_WETH` of whatever the swap did not use back to the caller.
 * - Sell, WETH pool: `V4_SWAP` (exact in, `amountOutMinimum` = the minimum received, the coin is pulled through Permit2,
 *   WETH stays in the router), `UNWRAP_WETH` to the caller with the same minimum.
 * - Buy, ETH pool (Clanker v5): `V4_SWAP` settling the ETH sent with the call, the coin to the caller, then `SWEEP` of
 *   any ETH the swap did not use back to the caller.
 * - Sell, ETH pool: `V4_SWAP` with `TAKE_ALL` of the ETH to the caller, at least the minimum received.
 * - Buy and sell, USDC pool (Clanker v5 coins paired with USDC, docs/design/clanker-v5-token-settings.md): an ERC-20 on
 *   both sides, so `V4_SWAP` with `SETTLE_ALL` of what goes in (pulled through Permit2, the same exact approvals a sell
 *   needs, for USDC on a buy) and `TAKE_ALL` of what comes out to the caller, at least the minimum received. No ETH moves.
 * - Buy with ETH, USDC pool (`buildEthViaPairedBuyTx`): one transaction of two hops, `WRAP_ETH` into the router,
 *   `V3_SWAP_EXACT_IN` WETH → USDC on Uniswap v3's WETH/USDC 0.05% pool (the route the launcher's own USDC dev buy takes)
 *   to the router, then `V4_SWAP` settling the router's whole USDC balance into the coin's pool, swapping all of that
 *   credit and taking the coin to the caller, at least the minimum received. Not fork-tested yet: calldata unit tests only.
 *
 * Every swap is exact in: Clanker v5 refuses exact-output swaps during its anti-snipe window, and the panel never builds
 * one anyway.
 *
 * The router keeps nothing between transactions and Bootr adds no fee: the only recipient in the calldata is the caller.
 */
import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  encodePacked,
  erc20Abi,
  keccak256,
  type Address,
  type Hex,
} from 'viem';
import { addresses } from '@bootr/shared/addresses';

export type SwapSide = 'buy' | 'sell';
export type PoolSource = 'bootr' | 'clanker' | 'clanker-v5';

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** A transaction, ready for the wallet. */
export type SwapTx = { to: Address; data: Hex; value: bigint };

const A = addresses[8453];

/**
 * Base mainnet only: RWAGMI has no Base Sepolia deployment and the Clanker path is mainnet-only.
 * Quoter and StateView: developers.uniswap.org/docs/protocols/v4/deployments, Base mainnet row;
 * `V4Quoter.poolManager()` reads as the PoolManager in the shared address book.
 */
export const SWAP_CONTRACTS = {
  chainId: 8453,
  quoter: '0x0d5e0f971ed27fbff6c2837bf31316121532048d' as Address,
  stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71' as Address,
  universalRouter: A.uniswap.universalRouter as Address,
  permit2: A.uniswap.permit2 as Address,
  weth: A.weth as Address,
  rwagmiHook: A.rwagmiHookV3 as Address,
  clankerHook: A.clanker.hookStaticFeeV2 as Address,
  /** Clanker v5's TaxLaunchHook: one hook for every v5 pool. */
  clankerV5Hook: (A.clankerV5?.hook ?? null) as Address | null,
  usdc: A.usdc as Address,
} as const;

/** Native ETH as a v4 currency (and as the Universal Router's `SWEEP` token). Clanker v5 pools are paired with it. */
export const NATIVE_ETH: Address = '0x0000000000000000000000000000000000000000';

/**
 * Clanker v5's anti-snipe window: for this many seconds after launch a buy pays a fee that falls from 99% to the tax
 * (`taxPolicy().antiSnipeConfiguration`, read on Base on 2026-11-10), and exact-output swaps revert.
 */
export const CLANKER_V5_ANTI_SNIPE_SECONDS = 20;

/** Whole seconds until a v5 coin launched at `launchedAt` leaves the anti-snipe window; 0 once trading is open. */
export function v5TradingOpensIn(launchedAt: number, now: number): number {
  const left = launchedAt + CLANKER_V5_ANTI_SNIPE_SECONDS - now;
  return left > 0 ? Math.ceil(left) : 0;
}

/** `LPFeeLibrary.DYNAMIC_FEE_FLAG`: Clanker pools are dynamic-fee pools, the hook sets the fee. */
const DYNAMIC_FEE_FLAG = 0x800000;
const TICK_SPACING = 200;

/** Universal Router commands (`Commands.sol`). */
const CMD = { V3_SWAP_EXACT_IN: 0x00, SWEEP: 0x04, WRAP_ETH: 0x0b, UNWRAP_WETH: 0x0c, V4_SWAP: 0x10 } as const;
/** v4-periphery `ActionConstants.CONTRACT_BALANCE`: settle whatever the router holds of the currency. */
const CONTRACT_BALANCE = 1n << 255n;
/**
 * Uniswap v3's WETH/USDC 0.05% pool on Base (packages/shared addresses, the launcher's USDC dev-buy route): the first hop of
 * an ETH buy of a USDC-paired coin. token0 is WETH, token1 USDC.
 */
export const V3_WETH_USDC = { pool: '0xd0b53D9277642d899DF5C87A3966A349A798F224' as Address, fee: 500 } as const;
/** v4-periphery `Actions.sol`. */
const ACTION = { SWAP_EXACT_IN_SINGLE: 0x06, SETTLE: 0x0b, SETTLE_ALL: 0x0c, TAKE: 0x0e, TAKE_ALL: 0x0f } as const;
/** v4-periphery `ActionConstants.sol`: placeholders the router maps to the caller, to itself and to "what is owed". */
const MSG_SENDER: Address = '0x0000000000000000000000000000000000000001';
const ADDRESS_THIS: Address = '0x0000000000000000000000000000000000000002';
const OPEN_DELTA = 0n;

export const DEFAULT_SLIPPAGE_BPS = 100;
export const MAX_SLIPPAGE_BPS = 2_000;
/** A transaction not included by then reverts instead of filling at a price from long ago. */
export const SWAP_DEADLINE_SECONDS = 20 * 60;
/** A Permit2 allowance outlives a sell's signing and confirmation by a little, no more. */
export const PERMIT2_EXPIRY_SECONDS = 30 * 60;

export const universalRouterAbi = [
  {
    type: 'function',
    name: 'execute',
    stateMutability: 'payable',
    inputs: [
      { name: 'commands', type: 'bytes' },
      { name: 'inputs', type: 'bytes[]' },
      { name: 'deadline', type: 'uint256' },
    ],
    outputs: [],
  },
] as const;

export const permit2Abi = [
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
      { name: 'nonce', type: 'uint48' },
    ],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'token', type: 'address' },
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint160' },
      { name: 'expiration', type: 'uint48' },
    ],
    outputs: [],
  },
] as const;

/**
 * The pool key each launch path builds for a coin (`BootrLauncher.poolKeyFor`, `BootrClankerLauncher.poolKeyFor`,
 * `BootrClankerLauncherV5.poolKeyFor`: the coin's paired asset (native ETH unless `paired` says otherwise), fee 0, the
 * factory's tick spacing of 200, the v5 hook). Null for Clanker v5 where this chain has no v5 hook.
 */
export function poolKeyOf(token: Address, source: 'bootr' | 'clanker'): PoolKey;
export function poolKeyOf(token: Address, source: PoolSource, paired?: Address | null): PoolKey | null;
export function poolKeyOf(token: Address, source: PoolSource, paired?: Address | null): PoolKey | null {
  if (source === 'clanker-v5') {
    if (!SWAP_CONTRACTS.clankerV5Hook) return null;
    const quote = paired && BigInt(paired) !== 0n ? paired : NATIVE_ETH;
    const quoteFirst = BigInt(quote) < BigInt(token);
    return {
      currency0: quoteFirst ? quote : token,
      currency1: quoteFirst ? token : quote,
      fee: 0,
      tickSpacing: TICK_SPACING,
      hooks: SWAP_CONTRACTS.clankerV5Hook,
    };
  }
  const coinFirst = BigInt(token) < BigInt(SWAP_CONTRACTS.weth);
  return {
    currency0: coinFirst ? token : SWAP_CONTRACTS.weth,
    currency1: coinFirst ? SWAP_CONTRACTS.weth : token,
    fee: source === 'clanker' ? DYNAMIC_FEE_FLAG : 0,
    tickSpacing: TICK_SPACING,
    hooks: source === 'clanker' ? SWAP_CONTRACTS.clankerHook : SWAP_CONTRACTS.rwagmiHook,
  };
}

/** `PoolIdLibrary.toId(key)`. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

/**
 * The key to trade on, or null when it does not hash to the coin's indexed pool id. The id commits to all five fields,
 * so a coin on an unexpected hook gets no trade rather than a trade on the wrong pool.
 */
export function verifiedPoolKey(token: Address, source: PoolSource, poolId: string, paired?: Address | null): PoolKey | null {
  const key = poolKeyOf(token, source, paired);
  return key && poolIdOf(key).toLowerCase() === poolId.toLowerCase() ? key : null;
}

/** True for a pool paired with native ETH (Clanker v5), whose currency0 is the zero address. */
export function isNativePool(key: PoolKey): boolean {
  return BigInt(key.currency0) === 0n;
}

/** The assets a Bootr coin can be paired with: native ETH and WETH, and USDC on Clanker v5. */
const PAIRED_CURRENCIES = new Set([BigInt(NATIVE_ETH), BigInt(SWAP_CONTRACTS.weth), BigInt(SWAP_CONTRACTS.usdc)]);

/** The pool's paired side: WETH, native ETH (the zero address) or USDC on a Clanker v5 pool. */
export function pairedCurrency(key: PoolKey): Address {
  return PAIRED_CURRENCIES.has(BigInt(key.currency0)) ? key.currency0 : key.currency1;
}

/** The coin's side of the pool. */
export function coinCurrency(key: PoolKey): Address {
  return BigInt(pairedCurrency(key)) === BigInt(key.currency0) ? key.currency1 : key.currency0;
}

/** True for a pool paired with an ERC-20 the user pays and receives as is (USDC): no ETH is wrapped or sent. */
export function isErc20Paired(key: PoolKey): boolean {
  const p = BigInt(pairedCurrency(key));
  return p !== 0n && p !== BigInt(SWAP_CONTRACTS.weth);
}

/** What a swap spends: the paired asset on a buy (ETH on the ETH and WETH pools), the coin on a sell. */
export function inputToken(key: PoolKey, side: SwapSide): Address {
  if (side === 'sell') return coinCurrency(key);
  return isErc20Paired(key) ? pairedCurrency(key) : NATIVE_ETH;
}

/** True when the swap's input is currency0 (`zeroForOne`). Buying spends (W)ETH, selling spends the coin. */
export function zeroForOne(key: PoolKey, side: SwapSide): boolean {
  const currency0IsPaired = BigInt(key.currency0) === BigInt(pairedCurrency(key));
  return side === 'buy' ? currency0IsPaired : !currency0IsPaired;
}

/** `quoted` less the slippage allowance, rounded down. */
export function minReceived(quoted: bigint, slippageBps: number): bigint {
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

function exactInSingle(key: PoolKey, side: SwapSide, amountIn: bigint, amountOutMinimum: bigint): Hex {
  return encodeAbiParameters(
    [
      {
        type: 'tuple',
        components: [
          {
            name: 'poolKey',
            type: 'tuple',
            components: [
              { name: 'currency0', type: 'address' },
              { name: 'currency1', type: 'address' },
              { name: 'fee', type: 'uint24' },
              { name: 'tickSpacing', type: 'int24' },
              { name: 'hooks', type: 'address' },
            ],
          },
          { name: 'zeroForOne', type: 'bool' },
          { name: 'amountIn', type: 'uint128' },
          { name: 'amountOutMinimum', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    [{ poolKey: key, zeroForOne: zeroForOne(key, side), amountIn, amountOutMinimum, hookData: '0x' }],
  );
}

const packedBytes = (values: readonly number[]): Hex => encodePacked(values.map(() => 'uint8'), [...values]);

function v4Swap(actions: readonly number[], params: readonly Hex[]): Hex {
  return encodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], [packedBytes(actions), [...params]]);
}

const settleParams = (currency: Address, amount: bigint, payerIsUser: boolean) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currency, amount, payerIsUser]);
const settleAllParams = (currency: Address, maxAmount: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, maxAmount]);
const takeParams = (currency: Address, recipient: Address, amount: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [currency, recipient, amount]);
const wethParams = (recipient: Address, amount: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [recipient, amount]);
const takeAllParams = (currency: Address, minAmount: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [currency, minAmount]);
const sweepParams = (token: Address, recipient: Address, amountMin: bigint) =>
  encodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], [token, recipient, amountMin]);

function execute(commands: readonly number[], inputs: readonly Hex[], deadline: bigint): Hex {
  return encodeFunctionData({
    abi: universalRouterAbi,
    functionName: 'execute',
    args: [packedBytes(commands), [...inputs], deadline],
  });
}

type SwapArgs = {
  key: PoolKey;
  coin: Address;
  amountIn: bigint;
  /** The on-chain floor: the transaction reverts below it. */
  minOut: bigint;
  /** Unix seconds. */
  deadline: bigint;
  /** ERC-8021 builder code suffix; the router's ABI decoding ignores trailing bytes. */
  dataSuffix?: Hex;
};

const suffixed = (data: Hex, suffix?: Hex): Hex => (suffix ? concat([data, suffix]) : data);

/** Paired ERC-20 in, the other side out, both through the router: `SETTLE_ALL` pulls through Permit2, `TAKE_ALL` pays the caller. */
function erc20Swap({ key, amountIn, minOut, deadline, dataSuffix }: SwapArgs, side: SwapSide): SwapTx {
  const paying = side === 'buy' ? pairedCurrency(key) : coinCurrency(key);
  const getting = side === 'buy' ? coinCurrency(key) : pairedCurrency(key);
  const data = execute(
    [CMD.V4_SWAP],
    [
      v4Swap(
        [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL],
        [exactInSingle(key, side, amountIn, minOut), settleAllParams(paying, amountIn), takeAllParams(getting, minOut)],
      ),
    ],
    deadline,
  );
  return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: 0n };
}

/** ETH (or USDC on a USDC pool) to coin. On the ETH pools `value` is the amount in; nothing else leaves the wallet. */
export function buildBuyTx(args: SwapArgs): SwapTx {
  const { key, coin, amountIn, minOut, deadline, dataSuffix } = args;
  if (isErc20Paired(key)) return erc20Swap(args, 'buy');
  if (isNativePool(key)) {
    const data = execute(
      [CMD.V4_SWAP, CMD.SWEEP],
      [
        v4Swap(
          [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE, ACTION.TAKE],
          [
            exactInSingle(key, 'buy', amountIn, minOut),
            // The router pays the pool from the ETH sent with the call.
            settleParams(NATIVE_ETH, OPEN_DELTA, false),
            takeParams(coin, MSG_SENDER, OPEN_DELTA),
          ],
        ),
        // ETH the swap did not use comes back to the caller.
        sweepParams(NATIVE_ETH, MSG_SENDER, 0n),
      ],
      deadline,
    );
    return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: amountIn };
  }
  const data = execute(
    [CMD.WRAP_ETH, CMD.V4_SWAP, CMD.UNWRAP_WETH],
    [
      wethParams(ADDRESS_THIS, amountIn),
      v4Swap(
        [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE, ACTION.TAKE],
        [
          exactInSingle(key, 'buy', amountIn, minOut),
          settleParams(SWAP_CONTRACTS.weth, OPEN_DELTA, false),
          takeParams(coin, MSG_SENDER, OPEN_DELTA),
        ],
      ),
      // A swap that stops at the end of the pool's liquidity leaves WETH in the router: it comes back as ETH.
      wethParams(MSG_SENDER, 0n),
    ],
    deadline,
  );
  return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: amountIn };
}

/**
 * ETH to coin on a USDC-paired pool, in one transaction of two hops (see the header). `amountIn` is wei and `value`;
 * `minOut` is the floor on the coins received; the USDC leg has no floor of its own, the final one covers it.
 */
export function buildEthViaPairedBuyTx(args: SwapArgs): SwapTx {
  const { key, amountIn, minOut, deadline, dataSuffix } = args;
  const paired = pairedCurrency(key);
  const path = encodePacked(['address', 'uint24', 'address'], [SWAP_CONTRACTS.weth, V3_WETH_USDC.fee, paired]);
  const v3Params = encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
    [ADDRESS_THIS, amountIn, 0n, path, false],
  );
  const data = execute(
    [CMD.WRAP_ETH, CMD.V3_SWAP_EXACT_IN, CMD.V4_SWAP],
    [
      wethParams(ADDRESS_THIS, amountIn),
      v3Params,
      v4Swap(
        [ACTION.SETTLE, ACTION.SWAP_EXACT_IN_SINGLE, ACTION.TAKE_ALL],
        [
          // Pays the pool manager the router's whole USDC balance (the first hop's output) and swaps all of that credit.
          settleParams(paired, CONTRACT_BALANCE, false),
          exactInSingle(key, 'buy', OPEN_DELTA, minOut),
          takeAllParams(coinCurrency(key), minOut),
        ],
      ),
    ],
    deadline,
  );
  return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: amountIn };
}

/** The first hop's USDC for `wei` at the v3 pool's price less its 0.05% fee (a spot estimate; the final floor guards it). */
export function wethToPairedEstimate(wei: bigint, sqrtPriceX96: bigint): bigint {
  const out = (wei * sqrtPriceX96 * sqrtPriceX96) >> 192n;
  return (out * (1_000_000n - BigInt(V3_WETH_USDC.fee))) / 1_000_000n;
}

/** Coin to ETH (or USDC on a USDC pool). Needs the allowances of `approvalCalls`. */
export function buildSellTx(args: SwapArgs): SwapTx {
  const { key, coin, amountIn, minOut, deadline, dataSuffix } = args;
  if (isErc20Paired(key)) return erc20Swap(args, 'sell');
  if (isNativePool(key)) {
    const data = execute(
      [CMD.V4_SWAP],
      [
        v4Swap(
          [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE_ALL],
          [exactInSingle(key, 'sell', amountIn, minOut), settleAllParams(coin, amountIn), takeAllParams(NATIVE_ETH, minOut)],
        ),
      ],
      deadline,
    );
    return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: 0n };
  }
  const data = execute(
    [CMD.V4_SWAP, CMD.UNWRAP_WETH],
    [
      v4Swap(
        [ACTION.SWAP_EXACT_IN_SINGLE, ACTION.SETTLE_ALL, ACTION.TAKE],
        [
          exactInSingle(key, 'sell', amountIn, minOut),
          settleAllParams(coin, amountIn),
          takeParams(SWAP_CONTRACTS.weth, ADDRESS_THIS, OPEN_DELTA),
        ],
      ),
      wethParams(MSG_SENDER, minOut),
    ],
    deadline,
  );
  return { to: SWAP_CONTRACTS.universalRouter, data: suffixed(data, dataSuffix), value: 0n };
}

export type Allowances = {
  /** `coin.allowance(owner, permit2)`. */
  token: bigint;
  /** `permit2.allowance(owner, coin, router)`. */
  permit2Amount: bigint;
  /** Unix seconds. */
  permit2Expiration: number;
};

export type ApprovalCall = SwapTx & { kind: 'token' | 'permit2' };

/**
 * What a swap paying `amount` of the ERC-20 `coin` still needs (the coin on a sell, USDC on a buy on a USDC pool), with
 * exact amounts and nothing more. The swap spends both allowances, so neither stays open afterwards. An allowance that
 * already covers it is left alone.
 */
export function approvalCalls({
  coin,
  amount,
  allowances,
  now,
  dataSuffix,
}: {
  coin: Address;
  amount: bigint;
  allowances: Allowances;
  /** Unix seconds. */
  now: number;
  dataSuffix?: Hex;
}): ApprovalCall[] {
  const calls: ApprovalCall[] = [];
  if (allowances.token < amount) {
    calls.push({
      kind: 'token',
      to: coin,
      value: 0n,
      data: suffixed(
        encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [SWAP_CONTRACTS.permit2, amount] }),
        dataSuffix,
      ),
    });
  }
  // The allowance has to last through signing and confirming the sell itself.
  if (allowances.permit2Amount < amount || allowances.permit2Expiration < now + 120) {
    calls.push({
      kind: 'permit2',
      to: SWAP_CONTRACTS.permit2,
      value: 0n,
      data: suffixed(
        encodeFunctionData({
          abi: permit2Abi,
          functionName: 'approve',
          args: [coin, SWAP_CONTRACTS.universalRouter, amount, now + PERMIT2_EXPIRY_SECONDS],
        }),
        dataSuffix,
      ),
    });
  }
  return calls;
}

/** The output before any fee or price impact, at the pool's current price. */
export function idealOut(amountIn: bigint, sqrtPriceX96: bigint, inputIsCurrency0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  const q192 = 1n << 192n;
  const price = sqrtPriceX96 * sqrtPriceX96;
  return inputIsCurrency0 ? (amountIn * price) / q192 : (amountIn * q192) / price;
}

/** 1 - a / b as a percent, never below 0. */
export function shortfallPct(a: bigint, b: bigint): number {
  if (b <= 0n) return 0;
  const ppm = 1_000_000n - (a * 1_000_000n) / b;
  return ppm <= 0n ? 0 : Number(ppm) / 10_000;
}

/** The price impact: how much worse `amountIn` fills than a tiny reference swap on the same pool. */
export function impactPct(amountIn: bigint, amountOut: bigint, refIn: bigint, refOut: bigint): number {
  if (refIn === amountIn) return 0;
  return shortfallPct(amountOut * refIn, refOut * amountIn);
}

/** Clanker's launch fee, as the coin's hook reports it. */
export type LaunchWindow = {
  /** The hook has not switched its anti-sniper module off for this pool yet. */
  armed: boolean;
  /** Unix seconds: the module has no effect after this, even if nobody has traded to switch it off. */
  endsAt: number;
  /** Unix seconds: when the pool was created. */
  startedAt: number;
};

/**
 * Seconds after a launch in which a nameless revert is put down to Clanker's block on swaps. On chain the block lasts two
 * blocks, 0.4 s at Base's 200 ms; the rest is the difference between this device's clock and the chain's.
 */
export const LAUNCH_BLOCK_SEC = 5;

/** Whether Clanker may still be refusing swaps on this pool at `now` (unix seconds). */
export function launchBlocksSwaps(w: LaunchWindow | null | undefined, now: number): boolean {
  return !!w && w.armed && now < w.startedAt + LAUNCH_BLOCK_SEC;
}

/** Whether the hook's window is running at `now` (unix seconds). */
export function launchWindowActive(w: LaunchWindow | null | undefined, now: number): boolean {
  return !!w && w.armed && now < w.endsAt;
}
