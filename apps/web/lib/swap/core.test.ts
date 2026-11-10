import { decodeAbiParameters, decodeFunctionData, erc20Abi, maxUint160, maxUint256, parseEther, slice, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import {
  approvalCalls,
  buildBuyTx,
  buildEthViaPairedBuyTx,
  buildSellTx,
  idealOut,
  impactPct,
  inputToken,
  isErc20Paired,
  isNativePool,
  pairedCurrency,
  launchBlocksSwaps,
  launchWindowActive,
  minReceived,
  permit2Abi,
  poolIdOf,
  poolKeyOf,
  shortfallPct,
  SWAP_CONTRACTS,
  universalRouterAbi,
  v5TradingOpensIn,
  V3_WETH_USDC,
  verifiedPoolKey,
  wethToPairedEstimate,
  zeroForOne,
} from './core';

const BOOTR: Address = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';
const OWL: Address = '0xb2000000000000000000004481c175669cbc8edb';
const SUFFIX: Hex = '0x07626f6f7472000b0080218021802180218021802180218021';
const key = poolKeyOf(BOOTR, 'clanker');
const swapParamsAbi = [
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
] as const;

function decodeExecute(data: Hex) {
  const { args } = decodeFunctionData({ abi: universalRouterAbi, data });
  return { commands: args[0], inputs: args[1], deadline: args[2] };
}
function decodeV4(input: Hex) {
  const [actions, params] = decodeAbiParameters([{ type: 'bytes' }, { type: 'bytes[]' }], input);
  return { actions, params };
}

describe('pool keys', () => {
  it('match what the launchers build on chain', () => {
    // BootrClankerLauncher.poolKeyFor($BOOTR) and BootrLauncher.poolKeyFor(OWL), read on Base.
    expect(poolKeyOf(BOOTR, 'clanker')).toEqual({
      currency0: '0x4200000000000000000000000000000000000006',
      currency1: BOOTR,
      fee: 8_388_608,
      tickSpacing: 200,
      hooks: '0xb429d62f8f3bFFb98CdB9569533eA23bF0Ba28CC',
    });
    expect(poolKeyOf(OWL, 'bootr')).toEqual({
      currency0: '0x4200000000000000000000000000000000000006',
      currency1: OWL,
      fee: 0,
      tickSpacing: 200,
      hooks: '0xB20B00367E37F826a0652c85a6DF375D784B20Ec',
    });
  });

  it('are used only when they hash to the coin\'s pool id', () => {
    const id = poolIdOf(key);
    expect(id.startsWith('0x8bc63477')).toBe(true); // $BOOTR's pool id at launch.
    expect(verifiedPoolKey(BOOTR, 'clanker', id)).toEqual(key);
    expect(verifiedPoolKey(BOOTR, 'clanker', id.toUpperCase().replace('0X', '0x'))).toEqual(key);
    expect(verifiedPoolKey(BOOTR, 'bootr', id)).toBeNull();
    expect(verifiedPoolKey(OWL, 'clanker', id)).toBeNull();
  });

  it('sort the coin against WETH', () => {
    const low: Address = '0x0000000000000000000000000000000000000abc';
    expect(poolKeyOf(low, 'bootr').currency0).toBe(low);
    expect(zeroForOne(poolKeyOf(low, 'bootr'), 'buy')).toBe(false);
    expect(zeroForOne(poolKeyOf(low, 'bootr'), 'sell')).toBe(true);
    expect(zeroForOne(key, 'buy')).toBe(true);
    expect(zeroForOne(key, 'sell')).toBe(false);
  });
});

describe('buildBuyTx', () => {
  const amountIn = parseEther('0.01');
  const tx = buildBuyTx({ key, coin: BOOTR, amountIn, minOut: 123n, deadline: 999n });

  it('wraps exactly the ETH sent, swaps, returns leftovers', () => {
    expect(tx.to).toBe(SWAP_CONTRACTS.universalRouter);
    expect(tx.value).toBe(amountIn);
    const { commands, inputs, deadline } = decodeExecute(tx.data);
    expect(commands).toBe('0x0b100c');
    expect(deadline).toBe(999n);
    const [wrapTo, wrapAmount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[0]!);
    expect(wrapTo).toBe('0x0000000000000000000000000000000000000002');
    expect(wrapAmount).toBe(amountIn);
    const [unwrapTo] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[2]!);
    expect(unwrapTo).toBe('0x0000000000000000000000000000000000000001');
  });

  it('puts the floor in the swap and pays the caller only', () => {
    const { actions, params } = decodeV4(decodeExecute(tx.data).inputs[1]!);
    expect(actions).toBe('0x060b0e');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.amountIn).toBe(amountIn);
    expect(swap.amountOutMinimum).toBe(123n);
    expect(swap.zeroForOne).toBe(true);
    const [currency, recipient] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(currency).toBe(BOOTR);
    expect(recipient).toBe('0x0000000000000000000000000000000000000001');
  });

  it('carries the builder code after the call', () => {
    const plain = buildBuyTx({ key, coin: BOOTR, amountIn, minOut: 123n, deadline: 999n });
    const coded = buildBuyTx({ key, coin: BOOTR, amountIn, minOut: 123n, deadline: 999n, dataSuffix: SUFFIX });
    expect(coded.data).toBe(`${plain.data}${SUFFIX.slice(2)}`);
    expect(decodeExecute(coded.data).commands).toBe('0x0b100c');
  });
});

describe('buildSellTx', () => {
  const amountIn = parseEther('1000');
  const tx = buildSellTx({ key, coin: BOOTR, amountIn, minOut: 77n, deadline: 999n, dataSuffix: SUFFIX });

  it('sends no ETH, pulls no more than the amount, enforces the floor twice', () => {
    expect(tx.value).toBe(0n);
    const { commands, inputs } = decodeExecute(tx.data);
    expect(commands).toBe('0x100c');
    const { actions, params } = decodeV4(inputs[0]!);
    expect(actions).toBe('0x060c0e');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.amountOutMinimum).toBe(77n);
    expect(swap.zeroForOne).toBe(false);
    const [settleCurrency, maxAmount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!);
    expect(settleCurrency).toBe(BOOTR);
    expect(maxAmount).toBe(amountIn);
    const [to, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[1]!);
    expect(to).toBe('0x0000000000000000000000000000000000000001');
    expect(min).toBe(77n);
    expect(slice(tx.data, -SUFFIX.length / 2 + 1)).toBe(SUFFIX);
  });
});

describe('Clanker v5 (native ETH pool)', () => {
  const COIN: Address = '0xabcdef0123456789abcdef0123456789abcdcccc';
  const v5 = poolKeyOf(COIN, 'clanker-v5')!;
  const NATIVE = '0x0000000000000000000000000000000000000000';

  it('builds BootrClankerLauncherV5.poolKeyFor: ETH first, fee 0, tick spacing 200, the v5 hook', () => {
    expect(v5).toEqual({ currency0: NATIVE, currency1: COIN, fee: 0, tickSpacing: 200, hooks: '0x5E320eA6278107968C119942E57d876c5F922AcC' });
    expect(isNativePool(v5)).toBe(true);
    expect(isNativePool(key)).toBe(false);
    expect(zeroForOne(v5, 'buy')).toBe(true);
    expect(zeroForOne(v5, 'sell')).toBe(false);
    expect(verifiedPoolKey(COIN, 'clanker-v5', poolIdOf(v5))).toEqual(v5);
    expect(verifiedPoolKey(COIN, 'clanker', poolIdOf(v5))).toBeNull();
  });

  it('buys with the ETH sent: no wrap, the router settles native ETH and sweeps what is left back', () => {
    const amountIn = parseEther('0.01');
    const tx = buildBuyTx({ key: v5, coin: COIN, amountIn, minOut: 5n, deadline: 999n });
    expect(tx.value).toBe(amountIn);
    const { commands, inputs } = decodeExecute(tx.data);
    expect(commands).toBe('0x1004');
    const { actions, params } = decodeV4(inputs[0]!);
    expect(actions).toBe('0x060b0e');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.zeroForOne).toBe(true);
    expect(swap.amountOutMinimum).toBe(5n);
    const [settleCurrency, , payerIsUser] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[1]!);
    expect(settleCurrency).toBe(NATIVE);
    expect(payerIsUser).toBe(false);
    const [takeCurrency, takeTo] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(takeCurrency.toLowerCase()).toBe(COIN);
    expect(takeTo).toBe('0x0000000000000000000000000000000000000001');
    const [sweepToken, sweepTo] = decodeAbiParameters([{ type: 'address' }, { type: 'address' }, { type: 'uint256' }], inputs[1]!);
    expect(sweepToken).toBe(NATIVE);
    expect(sweepTo).toBe('0x0000000000000000000000000000000000000001');
  });

  it('sells for native ETH paid straight to the caller, at least the minimum', () => {
    const amountIn = parseEther('1000');
    const tx = buildSellTx({ key: v5, coin: COIN, amountIn, minOut: 77n, deadline: 999n });
    expect(tx.value).toBe(0n);
    const { commands, inputs } = decodeExecute(tx.data);
    expect(commands).toBe('0x10');
    const { actions, params } = decodeV4(inputs[0]!);
    expect(actions).toBe('0x060c0f');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.zeroForOne).toBe(false);
    expect(swap.amountOutMinimum).toBe(77n);
    const [takeCurrency, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(takeCurrency).toBe(NATIVE);
    expect(min).toBe(77n);
  });

  it('keeps buys closed for the first 20 seconds after launch', () => {
    expect(v5TradingOpensIn(1000, 1000)).toBe(20);
    expect(v5TradingOpensIn(1000, 1012.4)).toBe(8);
    expect(v5TradingOpensIn(1000, 1020)).toBe(0);
    expect(v5TradingOpensIn(1000, 2000)).toBe(0);
  });
});

describe('Clanker v5 (USDC pool)', () => {
  const USDC = SWAP_CONTRACTS.usdc;
  // One coin sorting above USDC and one below: either can come out of the salt mining.
  const HIGH: Address = '0xfbcdef0123456789abcdef0123456789abcdcccc';
  const LOW: Address = '0x0bcdef0123456789abcdef0123456789abcdcccc';
  const hi = poolKeyOf(HIGH, 'clanker-v5', USDC)!;
  const lo = poolKeyOf(LOW, 'clanker-v5', USDC)!;

  it('sorts the coin and USDC like the launcher, with fee 0 and the v5 hook', () => {
    expect(hi).toMatchObject({ currency0: USDC, currency1: HIGH, fee: 0, tickSpacing: 200 });
    expect(lo).toMatchObject({ currency0: LOW, currency1: USDC });
    for (const k of [hi, lo]) {
      expect(isNativePool(k)).toBe(false);
      expect(isErc20Paired(k)).toBe(true);
      expect(pairedCurrency(k)).toBe(USDC);
    }
    expect(zeroForOne(hi, 'buy')).toBe(true);
    expect(zeroForOne(lo, 'buy')).toBe(false);
    expect(inputToken(hi, 'buy')).toBe(USDC);
    expect(inputToken(hi, 'sell')).toBe(HIGH);
    expect(inputToken(poolKeyOf(HIGH, 'clanker-v5')!, 'buy')).toBe('0x0000000000000000000000000000000000000000');
    // The pool id commits to the quote: a USDC coin's id does not verify as an ETH pool, nor the other way round.
    expect(verifiedPoolKey(HIGH, 'clanker-v5', poolIdOf(hi), USDC)).toEqual(hi);
    expect(verifiedPoolKey(HIGH, 'clanker-v5', poolIdOf(hi))).toBeNull();
    expect(verifiedPoolKey(HIGH, 'clanker-v5', poolIdOf(poolKeyOf(HIGH, 'clanker-v5')!), USDC)).toBeNull();
  });

  it('buys with USDC pulled through Permit2 and the coin taken to the caller; no ETH moves', () => {
    const tx = buildBuyTx({ key: lo, coin: LOW, amountIn: 25_000_000n, minOut: 9n, deadline: 999n });
    expect(tx.value).toBe(0n);
    const { commands, inputs } = decodeExecute(tx.data);
    expect(commands).toBe('0x10');
    const { actions, params } = decodeV4(inputs[0]!);
    expect(actions).toBe('0x060c0f');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.zeroForOne).toBe(false);
    expect(swap.amountIn).toBe(25_000_000n);
    const [settle, max] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!);
    expect(settle).toBe(USDC);
    expect(max).toBe(25_000_000n);
    const [take, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(take.toLowerCase()).toBe(LOW);
    expect(min).toBe(9n);
  });

  it('sells for USDC paid to the caller, at least the minimum', () => {
    const tx = buildSellTx({ key: hi, coin: HIGH, amountIn: parseEther('10'), minOut: 3_000_000n, deadline: 999n });
    expect(tx.value).toBe(0n);
    const { inputs } = decodeExecute(tx.data);
    const { actions, params } = decodeV4(inputs[0]!);
    expect(actions).toBe('0x060c0f');
    const [swap] = decodeAbiParameters(swapParamsAbi, params[0]!);
    expect(swap.zeroForOne).toBe(false);
    const [settle] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[1]!);
    expect(settle.toLowerCase()).toBe(HIGH);
    const [take, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(take).toBe(USDC);
    expect(min).toBe(3_000_000n);
  });
});

describe('Clanker v5 (USDC pool) bought with ETH: two hops in one transaction', () => {
  // Calldata only: this route is not fork-tested yet.
  const USDC = SWAP_CONTRACTS.usdc;
  const COIN: Address = '0xfbcdef0123456789abcdef0123456789abcdcccc';
  const key = poolKeyOf(COIN, 'clanker-v5', USDC)!;
  const amountIn = parseEther('0.02');
  const tx = buildEthViaPairedBuyTx({ key, coin: COIN, amountIn, minOut: 123n, deadline: 999n, dataSuffix: SUFFIX });

  it('wraps the ETH sent, swaps it for USDC on the v3 0.05% pool into the router, then the router’s USDC for the coin', () => {
    expect(tx.to).toBe(SWAP_CONTRACTS.universalRouter);
    expect(tx.value).toBe(amountIn);
    const { commands, inputs, deadline } = decodeExecute(tx.data);
    expect(commands).toBe('0x0b0010');
    expect(deadline).toBe(999n);
    const [wrapTo, wrapAmount] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], inputs[0]!);
    expect(wrapTo).toBe('0x0000000000000000000000000000000000000002');
    expect(wrapAmount).toBe(amountIn);
    const [recipient, v3In, v3Min, path, payerIsUser] = decodeAbiParameters(
      [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'bytes' }, { type: 'bool' }],
      inputs[1]!,
    );
    expect(recipient).toBe('0x0000000000000000000000000000000000000002');
    expect(v3In).toBe(amountIn);
    // The USDC hop has no floor of its own; the coin's floor below covers the whole route.
    expect(v3Min).toBe(0n);
    expect(payerIsUser).toBe(false);
    expect(path.toLowerCase()).toBe(`${SWAP_CONTRACTS.weth}0001f4${USDC.slice(2)}`.toLowerCase());
    expect(V3_WETH_USDC.pool).toBe('0xd0b53D9277642d899DF5C87A3966A349A798F224');
  });

  it('settles the router’s whole USDC balance, swaps all of that credit, and takes at least the minimum of the coin', () => {
    const { inputs } = decodeExecute(tx.data);
    const { actions, params } = decodeV4(inputs[2]!);
    expect(actions).toBe('0x0b060f');
    const [settleCurrency, settleAmount, payerIsUser] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], params[0]!);
    expect(settleCurrency).toBe(USDC);
    expect(settleAmount).toBe(1n << 255n); // ActionConstants.CONTRACT_BALANCE
    expect(payerIsUser).toBe(false);
    const [swap] = decodeAbiParameters(swapParamsAbi, params[1]!);
    expect(swap.zeroForOne).toBe(true); // USDC sorts before this coin
    expect(swap.amountIn).toBe(0n); // ActionConstants.OPEN_DELTA: the full credit
    expect(swap.amountOutMinimum).toBe(123n);
    const [take, min] = decodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], params[2]!);
    expect(take.toLowerCase()).toBe(COIN);
    expect(min).toBe(123n);
    expect(slice(tx.data, -SUFFIX.length / 2 + 1)).toBe(SUFFIX);
  });

  it('estimates the first hop at the pool price less 0.05%', () => {
    // sqrtPriceX96 for 2,000 USDC (6 decimals) per WETH (18): price = 2000e6 / 1e18.
    const sqrt = BigInt(Math.floor(Math.sqrt(2000e6 / 1e18) * 2 ** 96));
    const out = wethToPairedEstimate(parseEther('1'), sqrt);
    expect(Number(out)).toBeGreaterThan(1998.9e6);
    expect(Number(out)).toBeLessThan(1999.1e6);
  });
});

describe('approvalCalls', () => {
  const amount = parseEther('500');
  const none = { token: 0n, permit2Amount: 0n, permit2Expiration: 0 };
  const now = 1_000_000;

  it('asks for the exact amount from both, never unlimited', () => {
    const calls = approvalCalls({ coin: BOOTR, amount, allowances: none, now });
    expect(calls.map((c) => c.kind)).toEqual(['token', 'permit2']);
    const token = decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data });
    expect(calls[0]!.to).toBe(BOOTR);
    expect(token.functionName).toBe('approve');
    expect(token.args).toEqual([SWAP_CONTRACTS.permit2, amount]);
    const permit2 = decodeFunctionData({ abi: permit2Abi, data: calls[1]!.data });
    expect(calls[1]!.to).toBe(SWAP_CONTRACTS.permit2);
    expect(permit2.args).toEqual([BOOTR, SWAP_CONTRACTS.universalRouter, amount, now + 1800]);
    expect(token.args).not.toContain(maxUint256);
    expect(permit2.args).not.toContain(maxUint160);
  });

  it('skips what already covers the sell', () => {
    expect(approvalCalls({ coin: BOOTR, amount, allowances: { token: amount, permit2Amount: amount, permit2Expiration: now + 600 }, now })).toEqual([]);
    expect(approvalCalls({ coin: BOOTR, amount, allowances: { ...none, token: amount }, now }).map((c) => c.kind)).toEqual(['permit2']);
    expect(approvalCalls({ coin: BOOTR, amount, allowances: { token: 0n, permit2Amount: amount, permit2Expiration: now + 600 }, now }).map((c) => c.kind)).toEqual(['token']);
  });

  it('renews a Permit2 allowance about to expire', () => {
    expect(approvalCalls({ coin: BOOTR, amount, allowances: { token: amount, permit2Amount: amount, permit2Expiration: now + 60 }, now }).map((c) => c.kind)).toEqual(['permit2']);
  });

  it('carries the builder code', () => {
    for (const c of approvalCalls({ coin: BOOTR, amount, allowances: none, now, dataSuffix: SUFFIX })) expect(c.data.endsWith(SUFFIX.slice(2))).toBe(true);
  });
});

describe('figures', () => {
  it('minimum received rounds down', () => {
    expect(minReceived(1000n, 100)).toBe(990n);
    expect(minReceived(999n, 100)).toBe(989n);
    expect(minReceived(1000n, 0)).toBe(1000n);
  });

  it('ideal output follows the pool price both ways', () => {
    const q96 = 1n << 96n;
    expect(idealOut(1000n, q96, true)).toBe(1000n);
    expect(idealOut(1000n, q96 * 2n, true)).toBe(4000n);
    expect(idealOut(4000n, q96 * 2n, false)).toBe(1000n);
    expect(idealOut(1000n, 0n, true)).toBe(0n);
  });

  it('shortfall and price impact are percents, never below zero', () => {
    expect(shortfallPct(990n, 1000n)).toBe(1);
    expect(shortfallPct(1100n, 1000n)).toBe(0);
    expect(shortfallPct(1n, 0n)).toBe(0);
    expect(impactPct(1000n, 980n, 10n, 10n)).toBe(2);
    expect(impactPct(1000n, 1000n, 1000n, 1000n)).toBe(0);
  });

  it('the launch window runs only while armed and before its end', () => {
    expect(launchWindowActive({ armed: true, startedAt: 0, endsAt: 100 }, 99)).toBe(true);
    expect(launchWindowActive({ armed: true, startedAt: 0, endsAt: 100 }, 100)).toBe(false);
    expect(launchWindowActive({ armed: false, startedAt: 0, endsAt: 100 }, 99)).toBe(false);
    expect(launchWindowActive(null, 99)).toBe(false);
    expect(launchBlocksSwaps({ armed: true, startedAt: 10, endsAt: 130 }, 10)).toBe(true);
    expect(launchBlocksSwaps({ armed: true, startedAt: 10, endsAt: 130 }, 15)).toBe(false);
    expect(launchBlocksSwaps({ armed: false, startedAt: 10, endsAt: 130 }, 10)).toBe(false);
    expect(launchBlocksSwaps(null, 10)).toBe(false);
  });
});
