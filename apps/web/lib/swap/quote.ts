/**
 * Live quote from the Uniswap v4 quoter and the pool's own state. The quoter runs the real swap through the pool and its
 * hook and reverts with the result, so its figure is net of the pool's fee and of Clanker's launch fee.
 */
import type { PublicClient } from 'viem';
import { idealOut, impactPct, poolIdOf, shortfallPct, SWAP_CONTRACTS, V3_WETH_USDC, wethToPairedEstimate, zeroForOne, type LaunchWindow, type PoolKey, type SwapSide } from './core';
import { SwapFailure } from './errors';

/** Written as `view`: the quoter is not one on chain, but this only ever runs in `eth_call`. */
export const quoterAbi = [
  {
    type: 'function',
    name: 'quoteExactInputSingle',
    stateMutability: 'view',
    inputs: [
      {
        name: 'params',
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
          { name: 'exactAmount', type: 'uint128' },
          { name: 'hookData', type: 'bytes' },
        ],
      },
    ],
    outputs: [
      { name: 'amountOut', type: 'uint256' },
      { name: 'gasEstimate', type: 'uint256' },
    ],
  },
] as const;

export const stateViewAbi = [
  {
    type: 'function',
    name: 'getSlot0',
    stateMutability: 'view',
    inputs: [{ name: 'poolId', type: 'bytes32' }],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'protocolFee', type: 'uint24' },
      { name: 'lpFee', type: 'uint24' },
    ],
  },
] as const;

export const clankerHookAbi = [
  { type: 'function', name: 'mevModuleEnabled', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'poolCreationTimestamp', stateMutability: 'view', inputs: [{ name: 'poolId', type: 'bytes32' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'MAX_MEV_MODULE_DELAY', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
] as const;

export type SwapQuote = {
  side: SwapSide;
  amountIn: bigint;
  amountOut: bigint;
  /** What this swap pays as a fee, measured on the pool. Null if it could not be measured. */
  feePct: number | null;
  /** The fee in ETH, null along with `feePct`. */
  feeEth: bigint | null;
  impactPct: number | null;
  launchWindow: LaunchWindow | null;
};

/** A tenth of a percent of the amount reads the pool's rate without moving it. */
function referenceAmount(amountIn: bigint): bigint {
  const ref = amountIn / 1000n;
  return ref < 1_000_000_000n ? amountIn : ref;
}

type QuoteClient = Pick<PublicClient, 'multicall'>;

/** The Clanker hook's view of its launch fee; null for other pools or if the read fails (the quote still stands). */
async function readLaunchWindow(client: QuoteClient, key: PoolKey): Promise<LaunchWindow | null> {
  if (key.hooks.toLowerCase() !== SWAP_CONTRACTS.clankerHook.toLowerCase()) return null;
  const poolId = poolIdOf(key);
  const hook = { address: key.hooks, abi: clankerHookAbi } as const;
  const [armed, createdAt, maxDelay] = await client.multicall({
    allowFailure: true,
    contracts: [
      { ...hook, functionName: 'mevModuleEnabled', args: [poolId] },
      { ...hook, functionName: 'poolCreationTimestamp', args: [poolId] },
      { ...hook, functionName: 'MAX_MEV_MODULE_DELAY' },
    ],
  });
  if (armed.status !== 'success' || createdAt.status !== 'success' || maxDelay.status !== 'success') return null;
  return { armed: armed.result, startedAt: Number(createdAt.result), endsAt: Number(createdAt.result) + Number(maxDelay.result) };
}

export async function quoteSwap(
  client: QuoteClient,
  { key, side, amountIn, now }: { key: PoolKey; side: SwapSide; amountIn: bigint; now?: number },
): Promise<SwapQuote> {
  const direction = zeroForOne(key, side);
  const refIn = referenceAmount(amountIn);
  const quote = (exactAmount: bigint) =>
    ({
      address: SWAP_CONTRACTS.quoter,
      abi: quoterAbi,
      functionName: 'quoteExactInputSingle',
      args: [{ poolKey: key, zeroForOne: direction, exactAmount, hookData: '0x' as const }],
    }) as const;

  const [[main, ref, slot0], launchWindow] = await Promise.all([
    client.multicall({
      allowFailure: true,
      contracts: [
        quote(amountIn),
        quote(refIn),
        { address: SWAP_CONTRACTS.stateView, abi: stateViewAbi, functionName: 'getSlot0', args: [poolIdOf(key)] },
      ],
    }),
    readLaunchWindow(client, key),
  ]);

  const sqrtPriceX96 = slot0.status === 'success' ? slot0.result[0] : null;
  if (sqrtPriceX96 === 0n) throw new SwapFailure('no_pool');
  if (main.status !== 'success') throw SwapFailure.from(main.error, { launchWindow, ...(now !== undefined ? { now } : {}) });

  const amountOut = main.result[0];
  if (amountOut === 0n) throw new SwapFailure('no_liquidity');

  const refOut = ref.status === 'success' ? ref.result[0] : null;
  let feePct: number | null = null;
  let impact: number | null = null;
  if (refOut !== null && refOut > 0n) {
    impact = impactPct(amountIn, amountOut, refIn, refOut);
    if (sqrtPriceX96 !== null) feePct = shortfallPct(refOut, idealOut(refIn, sqrtPriceX96, direction));
  }
  return { side, amountIn, amountOut, feePct, feeEth: feeInEth(side, amountIn, amountOut, feePct), impactPct: impact, launchWindow };
}

/** The fee in ETH: a share of the ETH going in on a buy, of the ETH before the fee on a sell. */
function feeInEth(side: SwapSide, amountIn: bigint, amountOut: bigint, feePct: number | null): bigint | null {
  if (feePct === null) return null;
  const ppm = BigInt(Math.min(Math.round(feePct * 10_000), 999_999));
  return side === 'buy' ? (amountIn * ppm) / 1_000_000n : (amountOut * ppm) / (1_000_000n - ppm);
}

const v3Slot0Abi = [
  {
    type: 'function',
    name: 'slot0',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'sqrtPriceX96', type: 'uint160' },
      { name: 'tick', type: 'int24' },
      { name: 'observationIndex', type: 'uint16' },
      { name: 'observationCardinality', type: 'uint16' },
      { name: 'observationCardinalityNext', type: 'uint16' },
      { name: 'feeProtocol', type: 'uint8' },
      { name: 'unlocked', type: 'bool' },
    ],
  },
] as const;

/**
 * A buy of a USDC-paired coin with ETH (`buildEthViaPairedBuyTx`): the first hop's USDC estimated at the v3 WETH/USDC
 * pool's price less its fee, then the coin's pool quoted for that USDC. The answer's `amountIn` is the ETH; its fee
 * figures are the coin pool's, in USDC. `viaPaired` is the USDC the first hop is expected to give.
 */
export async function quoteEthViaPaired(client: QuoteClient & Pick<PublicClient, 'readContract'>, { key, amountIn }: { key: PoolKey; amountIn: bigint }): Promise<SwapQuote & { viaPaired: bigint }> {
  const [sqrtPriceX96] = await client.readContract({ address: V3_WETH_USDC.pool, abi: v3Slot0Abi, functionName: 'slot0' });
  const viaPaired = wethToPairedEstimate(amountIn, sqrtPriceX96);
  if (viaPaired === 0n) throw new SwapFailure('no_liquidity');
  const q = await quoteSwap(client, { key, side: 'buy', amountIn: viaPaired });
  return { ...q, amountIn, viaPaired };
}
