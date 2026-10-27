import { describe, expect, it } from 'vitest';
import { encodeAbiParameters, keccak256, pad, toHex } from 'viem';

import {
  decodeLiquidity,
  decodeSlot0,
  DYNAMIC_FEE_FLAG,
  isCoinToken0,
  poolIdOf,
  poolKeyFor,
  poolLiquiditySlot,
  poolStateSlot,
  positionTicks,
} from './pool';

const WETH = '0x4200000000000000000000000000000000000006';
const HOOK = '0x11b51DBC2f7F683b81CeDa83DC0078D57bA328cc';
const LOW = '0x0000000000000000000000000000000000000abc';
const HIGH = '0xfffffffffffffffffffffffffffffffffffffabc';

describe('poolKeyFor / poolIdOf', () => {
  it('orders currencies like BootrLauncher.poolKeyFor', () => {
    expect(poolKeyFor(LOW, WETH, HOOK)).toEqual({
      currency0: LOW,
      currency1: WETH,
      fee: DYNAMIC_FEE_FLAG,
      tickSpacing: 200,
      hooks: HOOK,
    });
    const k = poolKeyFor(HIGH, WETH, HOOK);
    expect(k.currency0).toBe(WETH);
    expect(k.currency1).toBe(HIGH);
    expect(isCoinToken0(LOW, WETH)).toBe(true);
    expect(isCoinToken0(HIGH, WETH)).toBe(false);
  });

  it('is keccak256(abi.encode(PoolKey))', () => {
    const key = poolKeyFor(LOW, WETH, HOOK);
    const manual = keccak256(
      encodeAbiParameters(
        [{ type: 'address' }, { type: 'address' }, { type: 'uint24' }, { type: 'int24' }, { type: 'address' }],
        [LOW, WETH, 0x800000, 200, HOOK],
      ),
    );
    expect(poolIdOf(key)).toBe(manual);
    // abi.encode of 5 static words = 160 bytes; a different hook gives a different id.
    expect(poolIdOf({ ...key, hooks: WETH })).not.toBe(manual);
  });
});

describe('PoolManager state slots', () => {
  it('derives slot0 / liquidity slots like StateLibrary', () => {
    const id = '0x' + '11'.repeat(32);
    const expected = keccak256(`0x${'11'.repeat(32)}${'0'.repeat(63)}6`);
    expect(poolStateSlot(id as `0x${string}`)).toBe(expected);
    expect(BigInt(poolLiquiditySlot(id as `0x${string}`))).toBe(BigInt(expected) + 3n);
  });

  it('decodes packed slot0 with a negative tick', () => {
    const sqrt = 79228162514264337593543950336n; // 2^96
    const tick = -230400;
    const word = (BigInt(1000) << 208n) | ((BigInt(tick) & 0xffffffn) << 160n) | sqrt;
    const d = decodeSlot0(pad(toHex(word), { size: 32 }));
    expect(d.sqrtPriceX96).toBe(sqrt);
    expect(d.tick).toBe(tick);
    expect(d.lpFee).toBe(1000);
    expect(decodeLiquidity(pad(toHex((1n << 200n) | 12345n), { size: 32 }))).toBe(12345n);
  });

  it('flips the position range when the coin is currency1', () => {
    expect(positionTicks(true)).toEqual({ tickLower: -230400, tickUpper: -120000 });
    expect(positionTicks(false)).toEqual({ tickLower: 120000, tickUpper: 230400 });
  });
});
