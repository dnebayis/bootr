import { encodeAbiParameters, hexToBigInt, keccak256, pad, toHex, type Address, type Hex } from 'viem';

/**
 * RWAGMI v3 pools carry a native LP fee of 0 in their key: the hook charges the swap fee itself
 * (`PoolFeeTakenV3`), in the paired asset.
 */
export const RWAGMI_POOL_FEE = 0;
/** Launch tick spacing (`LaunchConfigV3.pools[0].tickSpacing`, docs/rwagmi-migration.md). */
export const TICK_SPACING = 200;
/** `tickIfToken0IsB20` / the single position's upper tick, expressed as if the coin is currency0. */
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

/** The pool key RWAGMI v3 builds for a coin and its paired token (`LaunchPoolCreatedV3.key`). */
export function poolKeyFor(token: Address, paired: Address, hook: Address): PoolKey {
  const coinIsToken0 = BigInt(token) < BigInt(paired);
  return {
    currency0: coinIsToken0 ? token : paired,
    currency1: coinIsToken0 ? paired : token,
    fee: RWAGMI_POOL_FEE,
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

/**
 * Tick range of the single launch LP position (flipped when the coin is currency1). B20 addresses
 * (0xB20...) sort above WETH, so Bootr coins are currency1 and the mirrored range applies. The launch
 * handler prefers the exact range from `LiquidityPlacedV3`.
 */
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
