/**
 * Treasury operations: on-chain reads, prepared/executed kernel userOps and the deterministic
 * fee-claim policy. Money rules:
 *  - every op is simulated and persisted (`sv_treasury_ops`, status `prepared`) before anything is sent;
 *  - the userOp hash is stored BEFORE the op is awaited; a timeout leaves it `unknown`;
 *  - an `unknown` op is only ever reconciled by its hash, never replaced.
 */
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { PolicyError, canonicalJson } from '@bootr/agent-core';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { concatHex, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, pad, parseAbiParameters, parseUnits, toHex, type Address, type Hex } from 'viem';
import { chainlinkAggregatorAbi, feeLockerAbi, universalRouterAbi } from './abi.js';
import type { AgentRow, SupervisorContext, TreasuryOpRow } from './context.js';
import { treasuryOps, type TreasuryOpKind } from './db/schema.js';
import type { KernelCall } from './kernel.js';

export interface SerializedCall {
  to: string;
  value: string;
  data: string;
}

export function serializeCalls(calls: readonly KernelCall[]): SerializedCall[] {
  return calls.map((c) => ({ to: getAddress(c.to), value: (c.value ?? 0n).toString(), data: c.data ?? '0x' }));
}

export function deserializeCalls(calls: readonly SerializedCall[]): KernelCall[] {
  return calls.map((c) => ({ to: c.to as Address, value: BigInt(c.value), data: c.data as Hex }));
}

/** `0x` + sha256 of the canonical JSON of the calls; the model echoes it as `expectedHash`. */
export function callsHash(calls: readonly SerializedCall[]): Hex {
  return `0x${createHash('sha256').update(canonicalJson(calls)).digest('hex')}`;
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export interface TreasurySnapshot {
  kernel: Address;
  observedAt: string;
  balances: { eth: string; weth: string; usdc: string; token: string };
  claimable: { weth: string; token: string };
  ethUsd: number | null;
  usd: { usdc: number; weth: number; claimableWeth: number };
}

export async function ethUsdPrice(ctx: SupervisorContext): Promise<number | null> {
  try {
    const [, answer] = await ctx.chain.publicClient.readContract({ address: ctx.chain.ethUsdFeed, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' });
    return answer > 0n ? Number(answer) / 1e8 : null;
  } catch {
    return null;
  }
}

export async function readTreasuryOnChain(ctx: SupervisorContext, agent: AgentRow): Promise<TreasurySnapshot> {
  const { publicClient, addresses } = ctx.chain;
  const kernel = agent.kernel as Address;
  const token = agent.token as Address;
  const bal = (asset: Address) => publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [kernel] });
  const fees = (asset: Address) => publicClient.readContract({ address: addresses.clankerFeeLocker, abi: feeLockerAbi, functionName: 'availableFees', args: [kernel, asset] }).catch(() => 0n);
  const [eth, weth, usdc, own, claimWeth, claimToken, price] = await Promise.all([
    publicClient.getBalance({ address: kernel }),
    bal(addresses.weth),
    bal(addresses.usdc),
    bal(token).catch(() => 0n),
    fees(addresses.weth),
    fees(token),
    ethUsdPrice(ctx),
  ]);
  const wethHuman = Number(formatUnits(weth, 18));
  return {
    kernel,
    observedAt: new Date(ctx.now()).toISOString(),
    balances: { eth: formatUnits(eth, 18), weth: formatUnits(weth, 18), usdc: formatUnits(usdc, 6), token: formatUnits(own, 18) },
    claimable: { weth: formatUnits(claimWeth, 18), token: formatUnits(claimToken, 18) },
    ethUsd: price,
    usd: {
      usdc: Number(formatUnits(usdc, 6)),
      weth: price ? wethHuman * price : 0,
      claimableWeth: price ? Number(formatUnits(claimWeth, 18)) * price : 0,
    },
  };
}

export async function openOps(ctx: SupervisorContext, agentId: string): Promise<TreasuryOpRow[]> {
  return ctx.db.select().from(treasuryOps).where(and(eq(treasuryOps.agentId, agentId), inArray(treasuryOps.status, ['sent', 'unknown'])));
}

export async function recentOps(ctx: SupervisorContext, agentId: string, limit = 10): Promise<TreasuryOpRow[]> {
  return ctx.db.select().from(treasuryOps).where(eq(treasuryOps.agentId, agentId)).orderBy(desc(treasuryOps.createdAt)).limit(limit);
}

export function opView(op: TreasuryOpRow) {
  return {
    opId: op.opId,
    kind: op.kind,
    description: op.description,
    status: op.status,
    callHash: op.callHash,
    userOpHash: op.userOpHash,
    txHash: op.txHash,
    error: op.error,
    createdAt: op.createdAt.toISOString(),
  };
}

// ---------------------------------------------------------------------------
// Call builders
// ---------------------------------------------------------------------------

export function encodeClaimCalls(feeLocker: Address, kernel: Address, assets: readonly Address[]): KernelCall[] {
  return assets.map((asset) => ({ to: feeLocker, value: 0n, data: encodeFunctionData({ abi: feeLockerAbi, functionName: 'claim', args: [kernel, asset] }) }));
}

export type SwapRoute = { kind: 'v3'; fee: number } | { kind: 'v4'; fee: number; tickSpacing: number; hooks: Address };

export function parseSwapRoute(value: string): SwapRoute {
  const parts = value.split(':');
  if (parts[0] === 'v3' && parts.length === 2) return { kind: 'v3', fee: Number(parts[1]) };
  if (parts[0] === 'v4' && parts.length === 4) return { kind: 'v4', fee: Number(parts[1]), tickSpacing: Number(parts[2]), hooks: getAddress(parts[3] as string) };
  throw new Error(`invalid SWAP_ROUTE: ${value}`);
}

const CMD_V3_SWAP_EXACT_IN = '0x00';
const CMD_V4_SWAP = '0x10';
const V4_SWAP_EXACT_IN_SINGLE = '0x06';
const V4_SETTLE = '0x0b';
const V4_TAKE_ALL = '0x0f';

/**
 * WETH -> USDC through the Universal Router. The kernel first transfers WETH to the router
 * (allow-listed `WETH.transfer(router, *)`), then the router swaps with `payerIsUser = false`
 * and pays USDC out to the kernel. Both calls are in one batched userOp.
 */
export function encodeSwapCalls(args: { route: SwapRoute; weth: Address; usdc: Address; universalRouter: Address; kernel: Address; amountIn: bigint; minOut: bigint; deadline: bigint }): KernelCall[] {
  const { route, weth, usdc, universalRouter, kernel, amountIn, minOut, deadline } = args;
  let commands: Hex;
  let input: Hex;
  if (route.kind === 'v3') {
    commands = CMD_V3_SWAP_EXACT_IN;
    const path = concatHex([weth, pad(toHex(route.fee), { size: 3 }), usdc]);
    input = encodeAbiParameters(parseAbiParameters('address, uint256, uint256, bytes, bool'), [kernel, amountIn, minOut, path, false]);
  } else {
    commands = CMD_V4_SWAP;
    const zeroForOne = BigInt(weth) < BigInt(usdc);
    const [currency0, currency1] = zeroForOne ? [weth, usdc] : [usdc, weth];
    const actions = concatHex([V4_SWAP_EXACT_IN_SINGLE, V4_SETTLE, V4_TAKE_ALL]);
    const swapParams = encodeAbiParameters(
      parseAbiParameters('((address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks) poolKey, bool zeroForOne, uint128 amountIn, uint128 amountOutMinimum, bytes hookData)'),
      [{ poolKey: { currency0, currency1, fee: route.fee, tickSpacing: route.tickSpacing, hooks: route.hooks }, zeroForOne, amountIn, amountOutMinimum: minOut, hookData: '0x' }],
    );
    const settle = encodeAbiParameters(parseAbiParameters('address, uint256, bool'), [weth, amountIn, false]);
    const take = encodeAbiParameters(parseAbiParameters('address, uint256'), [usdc, minOut]);
    input = encodeAbiParameters(parseAbiParameters('bytes, bytes[]'), [actions, [swapParams, settle, take]]);
  }
  return [
    { to: weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [universalRouter, amountIn] }) },
    { to: universalRouter, value: 0n, data: encodeFunctionData({ abi: universalRouterAbi, functionName: 'execute', args: [commands, [input], deadline] }) },
  ];
}

/** Human WETH amount needed to reach `targetUsdc` from `haveUsdc` at `ethUsd`, with a 2% buffer; capped at the balance. */
export function wethNeededFor(targetUsdc: number, haveUsdc: number, ethUsd: number, wethBalance: bigint): bigint {
  const missing = Math.max(0, targetUsdc - haveUsdc);
  if (missing <= 0 || ethUsd <= 0) return 0n;
  const wei = parseUnits(((missing / ethUsd) * 1.02).toFixed(18), 18);
  return wei < wethBalance ? wei : wethBalance;
}

export function minUsdcOut(amountInWei: bigint, ethUsd: number, slippageBps: number): bigint {
  const usd = (Number(formatUnits(amountInWei, 18)) * ethUsd * (10_000 - slippageBps)) / 10_000;
  return parseUnits(usd.toFixed(6), 6);
}

// ---------------------------------------------------------------------------
// Prepare / execute / reconcile
// ---------------------------------------------------------------------------

export interface PrepareArgs {
  kind: TreasuryOpKind;
  calls: KernelCall[];
  description: string;
  origin: 'policy' | 'model';
}

/** Simulates every call as the kernel (`eth_call` from the kernel address) and stores the op as `prepared`. */
export async function prepareOp(ctx: SupervisorContext, agent: AgentRow, args: PrepareArgs): Promise<TreasuryOpRow> {
  const kernel = agent.kernel as Address;
  for (const call of args.calls) {
    try {
      await ctx.chain.publicClient.call({ account: kernel, to: call.to, data: call.data ?? '0x', value: call.value ?? 0n });
    } catch (err) {
      throw new PolicyError('treasury_simulation_failed', { message: `treasury_simulation_failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}` });
    }
  }
  const calls = serializeCalls(args.calls);
  const opId = `op_${randomUUID()}`;
  const now = new Date(ctx.now());
  const [row] = await ctx.db
    .insert(treasuryOps)
    .values({ opId, agentId: agent.agentId, kind: args.kind, calls, callHash: callsHash(calls), description: args.description, origin: args.origin, status: 'prepared', createdAt: now, updatedAt: now })
    .returning();
  ctx.log.info({ agentId: agent.agentId, opId, kind: args.kind, callHash: row!.callHash }, 'treasury op prepared');
  return row!;
}

export type ExecuteResult =
  | { status: 'confirmed'; opId: string; userOpHash: Hex; txHash: Hex; success: boolean }
  | { status: 'unknown'; opId: string; userOpHash: Hex }
  | { status: 'failed'; opId: string; error: string };

/**
 * Re-simulates, sends the userOp and records the hash before awaiting inclusion. A receipt
 * timeout leaves the op `unknown` for `reconcileOps`; it is never resent.
 */
export async function executeOp(ctx: SupervisorContext, agent: AgentRow, opId: string, expectedHash?: Hex): Promise<ExecuteResult> {
  const op = await ctx.db.query.treasuryOps.findFirst({ where: and(eq(treasuryOps.opId, opId), eq(treasuryOps.agentId, agent.agentId)) });
  if (!op) throw new PolicyError('treasury_op_not_found');
  if (expectedHash && expectedHash.toLowerCase() !== op.callHash.toLowerCase()) throw new PolicyError('treasury_hash_mismatch');
  if (op.status !== 'prepared') throw new PolicyError('treasury_op_not_prepared', { message: `treasury_op_not_prepared: status ${op.status}` });
  const open = await openOps(ctx, agent.agentId);
  if (open.length) throw new PolicyError('treasury_op_in_flight', { message: `treasury_op_in_flight: ${open.map((o) => o.opId).join(',')}` });

  const calls = deserializeCalls(op.calls);
  const kernel = agent.kernel as Address;
  for (const call of calls) {
    try {
      await ctx.chain.publicClient.call({ account: kernel, to: call.to, data: call.data ?? '0x', value: call.value ?? 0n });
    } catch (err) {
      const error = `simulation_failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
      await ctx.db.update(treasuryOps).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
      return { status: 'failed', opId, error };
    }
  }

  const client = await ctx.kernelFor(agent);
  let prepared;
  try {
    prepared = await client.prepareUserOp(calls);
  } catch (err) {
    const error = `prepare_failed: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    await ctx.db.update(treasuryOps).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
    return { status: 'failed', opId, error };
  }
  // The hash is persisted before the op leaves the process: a crash from here on is reconcilable.
  await ctx.db.update(treasuryOps).set({ status: 'sent', userOpHash: prepared.hash, sentAt: new Date(ctx.now()), updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
  ctx.log.info({ agentId: agent.agentId, opId, userOpHash: prepared.hash, kind: op.kind }, 'treasury op sending');
  try {
    const sent = await client.submitUserOp(prepared);
    if (sent.toLowerCase() !== prepared.hash.toLowerCase()) ctx.log.warn({ opId, expected: prepared.hash, got: sent }, 'bundler returned a different userOp hash');
  } catch (err) {
    // Submission errored: the bundler may or may not have accepted the op. Unknown, reconcile by hash.
    const error = `submit_error: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`;
    await ctx.db.update(treasuryOps).set({ status: 'unknown', error, updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
    ctx.log.warn({ agentId: agent.agentId, opId, userOpHash: prepared.hash, error }, 'treasury op outcome unknown');
    return { status: 'unknown', opId, userOpHash: prepared.hash };
  }
  const receipt = await client.waitForReceipt(prepared.hash, ctx.config.USER_OP_RECEIPT_TIMEOUT_MS);
  if (!receipt) {
    await ctx.db.update(treasuryOps).set({ status: 'unknown', error: 'receipt_timeout', updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
    ctx.log.warn({ agentId: agent.agentId, opId, userOpHash: prepared.hash }, 'treasury op receipt timeout; marked unknown');
    return { status: 'unknown', opId, userOpHash: prepared.hash };
  }
  return settleReceipt(ctx, op, prepared.hash, receipt);
}

async function settleReceipt(ctx: SupervisorContext, op: TreasuryOpRow, userOpHash: Hex, receipt: { success: boolean; receipt: { transactionHash: Hex }; reason?: string | undefined }): Promise<ExecuteResult> {
  const txHash = receipt.receipt.transactionHash;
  const now = new Date(ctx.now());
  if (receipt.success) {
    await ctx.db.update(treasuryOps).set({ status: 'confirmed', txHash, confirmedAt: now, updatedAt: now, error: null }).where(eq(treasuryOps.opId, op.opId));
    ctx.log.info({ agentId: op.agentId, opId: op.opId, userOpHash, txHash, kind: op.kind }, 'treasury op confirmed');
    return { status: 'confirmed', opId: op.opId, userOpHash, txHash, success: true };
  }
  const error = `reverted_onchain${receipt.reason ? `: ${receipt.reason}` : ''}`;
  await ctx.db.update(treasuryOps).set({ status: 'failed', txHash, error, updatedAt: now }).where(eq(treasuryOps.opId, op.opId));
  ctx.log.warn({ agentId: op.agentId, opId: op.opId, userOpHash, txHash }, 'treasury op reverted');
  return { status: 'failed', opId: op.opId, error };
}

/** Resolves `sent`/`unknown` ops by their userOp hash. Returns the ops whose status changed. */
export async function reconcileOps(ctx: SupervisorContext, agent: AgentRow): Promise<{ op: TreasuryOpRow; result: ExecuteResult }[]> {
  const open = await openOps(ctx, agent.agentId);
  if (!open.length) return [];
  const client = await ctx.kernelFor(agent);
  const changed: { op: TreasuryOpRow; result: ExecuteResult }[] = [];
  for (const op of open) {
    if (!op.userOpHash) continue;
    const receipt = await client.getReceipt(op.userOpHash as Hex);
    if (receipt) {
      changed.push({ op, result: await settleReceipt(ctx, op, op.userOpHash as Hex, receipt) });
      continue;
    }
    // A `sent` op older than 10 minutes without a receipt is downgraded to unknown (still reconcilable).
    if (op.status === 'sent' && op.sentAt && ctx.now() - op.sentAt.getTime() > 10 * 60_000) {
      await ctx.db.update(treasuryOps).set({ status: 'unknown', error: 'no_receipt_after_10m', updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, op.opId));
    }
  }
  return changed;
}

// ---------------------------------------------------------------------------
// Fee claim policy (no model involved)
// ---------------------------------------------------------------------------

export interface FeePolicyOutcome {
  skipped?: string;
  claim?: ExecuteResult;
  swap?: ExecuteResult;
}

/** Price of the agent's own token in USD from the indexer, 0 when unknown. */
async function tokenPriceUsd(ctx: SupervisorContext, agent: AgentRow): Promise<number> {
  const market = await ctx.indexer.market(agent.token);
  const price = market && typeof market.priceUsd === 'number' ? market.priceUsd : 0;
  return price;
}

export async function runFeePolicy(ctx: SupervisorContext, agent: AgentRow, snapshot?: TreasurySnapshot): Promise<FeePolicyOutcome> {
  const { config, chain } = ctx;
  const open = await openOps(ctx, agent.agentId);
  if (open.length) return { skipped: 'op_in_flight' };
  const recent = await recentOps(ctx, agent.agentId, 3);
  const lastFailed = recent.find((o) => o.status === 'failed' && o.origin === 'policy');
  if (lastFailed && ctx.now() - lastFailed.updatedAt.getTime() < 60 * 60_000) return { skipped: 'recent_failure_backoff' };

  const snap = snapshot ?? (await readTreasuryOnChain(ctx, agent));
  const out: FeePolicyOutcome = {};
  const claimableToken = Number(snap.claimable.token) * (await tokenPriceUsd(ctx, agent));
  const claimableUsd = snap.usd.claimableWeth + claimableToken;
  if (claimableUsd >= config.CLAIM_THRESHOLD_USD) {
    const assets: Address[] = [];
    if (Number(snap.claimable.weth) > 0) assets.push(chain.addresses.weth);
    if (Number(snap.claimable.token) > 0) assets.push(agent.token as Address);
    const op = await prepareOp(ctx, agent, {
      kind: 'claim_fees',
      calls: encodeClaimCalls(chain.addresses.clankerFeeLocker, agent.kernel as Address, assets),
      description: `claim LP fees (~$${claimableUsd.toFixed(2)}) for ${assets.length} asset(s)`,
      origin: 'policy',
    });
    out.claim = await executeOp(ctx, agent, op.opId);
    if (out.claim.status !== 'confirmed') return out;
  }

  const after = out.claim ? await readTreasuryOnChain(ctx, agent) : snap;
  const wethBalance = parseUnits(after.balances.weth, 18);
  if (after.usd.usdc < config.FUEL_TARGET_USDC && wethBalance > 0n && after.ethUsd) {
    const amountIn = wethNeededFor(config.FUEL_TARGET_USDC, after.usd.usdc, after.ethUsd, wethBalance);
    if (amountIn > 0n) {
      const minOut = minUsdcOut(amountIn, after.ethUsd, config.SWAP_SLIPPAGE_BPS);
      if (minOut >= 10_000n) {
        const op = await prepareOp(ctx, agent, {
          kind: 'swap',
          calls: encodeSwapCalls({
            route: parseSwapRoute(config.SWAP_ROUTE),
            weth: chain.addresses.weth,
            usdc: chain.addresses.usdc,
            universalRouter: chain.addresses.uniswap.universalRouter,
            kernel: agent.kernel as Address,
            amountIn,
            minOut,
            deadline: BigInt(Math.floor(ctx.now() / 1000) + 20 * 60),
          }),
          description: `swap ${formatUnits(amountIn, 18)} WETH -> >= ${formatUnits(minOut, 6)} USDC (refuel to ${config.FUEL_TARGET_USDC})`,
          origin: 'policy',
        });
        out.swap = await executeOp(ctx, agent, op.opId);
      }
    }
  }
  return out;
}
