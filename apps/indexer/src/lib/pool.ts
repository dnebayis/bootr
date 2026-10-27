import { encodeAbiParameters, hexToBigInt, keccak256, pad, toHex, type Address, type Hex } from 'viem';

/** Uniswap v4 `LPFeeLibrary.DYNAMIC_FEE_FLAG`. Clanker V2 hooks always use dynamic-fee pools. */
export const DYNAMIC_FEE_FLAG = 0x800000;
/** `BootrLauncher.TICK_SPACING`. */
export const TICK_SPACING = 200;
/** `BootrLauncher.STARTING_TICK` / `POSITION_TICK_UPPER`, expressed as if the coin is currency0. */
export const STARTING_TICK = -230_400;
export const POSITION_TICK_UPPER = -120_000;
/** `PoolManager` storage slot of `mapping(PoolId => Pool.State) _pools` (StateLibrary.POOLS_SLOT). */
export const POOLS_SLOT = 6n;
/** Offset of `liquidity` inside `Pool.State` (slot0, feeGrowthGlobal0, feeGrowthGlobal1, liquidity). */
export const LIQUIDITY_OFFSET = 3n;

export type PoolKey = {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
};

/** Mirrors `BootrLauncher.poolKeyFor(token)`. */
export function poolKeyFor(token: Address, weth: Address, hook: Address): PoolKey {
  const coinIsToken0 = BigInt(token) < BigInt(weth);
  return {
    currency0: coinIsToken0 ? token : weth,
    currency1: coinIsToken0 ? weth : token,
    fee: DYNAMIC_FEE_FLAG,
    tickSpacing: TICK_SPACING,
    hooks: hook,
  };
}

/** `PoolIdLibrary.toId(key) = keccak256(abi.encode(key))`. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' },
        { type: 'address' },
        { type: 'uint24' },
        { type: 'int24' },
        { type: 'address' },
      ],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

export function isCoinToken0(token: Address, weth: Address): boolean {
  return BigInt(token) < BigInt(weth);
}

/** Tick range of the single Clanker LP position (flipped when the coin is currency1). */
export function positionTicks(coinIsToken0: boolean): { tickLower: number; tickUpper: number } {
  return coinIsToken0
    ? { tickLower: STARTING_TICK, tickUpper: POSITION_TICK_UPPER }
    : { tickLower: -POSITION_TICK_UPPER, tickUpper: -STARTING_TICK };
}

/** `StateLibrary._getPoolStateSlot(poolId) = keccak256(abi.encodePacked(poolId, POOLS_SLOT))`. */
export function poolStateSlot(poolId: Hex): Hex {
  return keccak256(`${poolId}${pad(toHex(POOLS_SLOT), { size: 32 }).slice(2)}` as Hex);
}

export function poolLiquiditySlot(poolId: Hex): Hex {
  return pad(toHex(hexToBigInt(poolStateSlot(poolId)) + LIQUIDITY_OFFSET), { size: 32 });
}

/** Decode packed slot0: sqrtPriceX96 (160) | tick (int24) | protocolFee (24) | lpFee (24). */
export function decodeSlot0(word: Hex): { sqrtPriceX96: bigint; tick: number; lpFee: number } {
  const v = hexToBigInt(word);
  const sqrtPriceX96 = v & ((1n << 160n) - 1n);
  let tick = Number((v >> 160n) & 0xffffffn);
  if (tick >= 0x800000) tick -= 0x1000000;
  const lpFee = Number((v >> 208n) & 0xffffffn);
  return { sqrtPriceX96, tick, lpFee };
}

export function decodeLiquidity(word: Hex): bigint {
  return hexToBigInt(word) & ((1n << 128n) - 1n);
}
