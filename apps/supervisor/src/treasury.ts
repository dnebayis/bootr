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
import { encodeFunctionData, erc20Abi, formatUnits, getAddress, isHex, pad, parseUnits, size, type Address, type Hex } from 'viem';
import { callPolicyAbi, chainlinkAggregatorAbi, rwagmiLauncherV3Abi, rwagmiLpLockerV3Abi, swapHelperAbi, SWAP_MAX_SLIPPAGE_BPS } from './abi.js';
import { deserializeSessionPolicy, FUNDING_AMOUNT_ARG_INDEX, fundingRuleIndex, type SerializedSessionPolicy } from './session-key.js';
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
  /** The agent's x402 spender EOA (pays the relay; funded from the kernel under the windowed cap). */
  spender: Address;
  observedAt: string;
  balances: { eth: string; weth: string; usdc: string; token: string; spenderUsdc: string };
  /**
   * Swap fees the kernel can claim from `RwagmiLpLockerV3`, WETH only (the hook charges fees in the paired asset):
   * `weth` = `pending` (credited to the pool, not settled to the kernel yet: `pendingQuote(poolId, kernel)`) +
   * `settled` (`claimableQuote(kernel, WETH)`). `poolId` is the coin's primary RWAGMI pool, or null when the coin
   * was not launched through the RWAGMI launcher (nothing pending can be settled then).
   */
  claimable: { weth: string; pending: string; settled: string; poolId: Hex | null };
  ethUsd: number | null;
  usd: { usdc: number; spenderUsdc: number; weth: number; claimableWeth: number };
}

/**
 * Chainlink ETH/USD, or `null` when the feed is unavailable, non-positive, stale (`updatedAt` older than
 * `CHAINLINK_MAX_AGE_SECONDS`) or answered in an older round (L-01). A `null` price disables swaps and the
 * USD figures shown to the model; BootrSwapHelper applies the same staleness rule on-chain.
 */
export async function ethUsdPrice(ctx: SupervisorContext): Promise<number | null> {
  try {
    const [roundId, answer, , updatedAt, answeredInRound] = await ctx.chain.publicClient.readContract({ address: ctx.chain.ethUsdFeed, abi: chainlinkAggregatorAbi, functionName: 'latestRoundData' });
    if (answer <= 0n) return null;
    const nowSec = BigInt(Math.floor(ctx.now() / 1000));
    const maxAge = BigInt(ctx.config.CHAINLINK_MAX_AGE_SECONDS);
    if (updatedAt === 0n || updatedAt + maxAge < nowSec || answeredInRound < roundId) {
      ctx.log.warn({ roundId: roundId.toString(), updatedAt: updatedAt.toString(), answeredInRound: answeredInRound.toString() }, 'chainlink ETH/USD stale; price unavailable');
      return null;
    }
    return Number(answer) / 1e8;
  } catch {
    return null;
  }
}

const ZERO_BYTES32: Hex = `0x${'0'.repeat(64)}`;

const isPoolId = (v: unknown): v is Hex => typeof v === 'string' && isHex(v) && size(v) === 32 && v !== ZERO_BYTES32;

/**
 * The coin's primary RWAGMI v3 pool id: `RwagmiB20LauncherV3.deploymentInfo(token).primaryPoolId`, falling back to
 * the indexer's `/market/:token` `poolId` only when the chain read fails. Null when the coin is not an RWAGMI launch
 * (the launcher answers zeros; a Clanker-era coin keeps nothing to settle on this locker).
 */
export async function poolIdFor(ctx: SupervisorContext, agent: Pick<AgentRow, 'token'>): Promise<Hex | null> {
  try {
    const info = await ctx.chain.publicClient.readContract({ address: ctx.chain.rwagmi.launcher, abi: rwagmiLauncherV3Abi, functionName: 'deploymentInfo', args: [agent.token as Address] });
    return isPoolId(info.primaryPoolId) ? info.primaryPoolId : null;
  } catch (err) {
    ctx.log.warn({ token: agent.token, err }, 'deploymentInfo read failed; using the indexer pool id');
    const market = await ctx.indexer.market(agent.token);
    return isPoolId(market?.poolId) ? market.poolId : null;
  }
}

export async function readTreasuryOnChain(ctx: SupervisorContext, agent: AgentRow): Promise<TreasurySnapshot> {
  const { publicClient, addresses, rwagmi } = ctx.chain;
  const kernel = agent.kernel as Address;
  const token = agent.token as Address;
  const spender = ctx.spenderFor(agent).address;
  const bal = (asset: Address, holder: Address = kernel) => publicClient.readContract({ address: asset, abi: erc20Abi, functionName: 'balanceOf', args: [holder] });
  const poolId = await poolIdFor(ctx, agent);
  // Unsettled fees sit on the pool (`pendingQuote`); settled ones on the kernel's per-currency balance (`claimableQuote`).
  const pending = poolId ? publicClient.readContract({ address: rwagmi.lpLocker, abi: rwagmiLpLockerV3Abi, functionName: 'pendingQuote', args: [poolId, kernel] }).catch(() => 0n) : Promise.resolve(0n);
  const settled = publicClient.readContract({ address: rwagmi.lpLocker, abi: rwagmiLpLockerV3Abi, functionName: 'claimableQuote', args: [kernel, addresses.weth] }).catch(() => 0n);
  const [eth, weth, usdc, spenderUsdc, own, pendingWeth, settledWeth, price] = await Promise.all([
    publicClient.getBalance({ address: kernel }),
    bal(addresses.weth),
    bal(addresses.usdc),
    bal(addresses.usdc, spender),
    bal(token).catch(() => 0n),
    pending,
    settled,
    ethUsdPrice(ctx),
  ]);
  const claimWeth = pendingWeth + settledWeth;
  const wethHuman = Number(formatUnits(weth, 18));
  return {
    kernel,
    spender,
    observedAt: new Date(ctx.now()).toISOString(),
    balances: { eth: formatUnits(eth, 18), weth: formatUnits(weth, 18), usdc: formatUnits(usdc, 6), token: formatUnits(own, 18), spenderUsdc: formatUnits(spenderUsdc, 6) },
    claimable: { weth: formatUnits(claimWeth, 18), pending: formatUnits(pendingWeth, 18), settled: formatUnits(settledWeth, 18), poolId },
    ethUsd: price,
    usd: {
      usdc: Number(formatUnits(usdc, 6)),
      spenderUsdc: Number(formatUnits(spenderUsdc, 6)),
      weth: price ? wethHuman * price : 0,
      claimableWeth: price ? Number(formatUnits(claimWeth, 18)) * price : 0,
    },
  };
}

export interface FundingBudget {
  /** `SESSION_USDC_TRANSFER_CAP` as installed (6 dp units). */
  cap: bigint;
  /** What the current window still allows (6 dp units). */
  remaining: bigint;
  /** End of the window the on-chain state refers to (unix seconds). */
  windowEnd: number;
  windowSeconds: number;
}

/**
 * Remaining USDC the session key may still move to the spender in the current window, from
 * `BootrCallPolicy.windowOf` (a window that already ended counts as fresh). Null when no session is installed.
 * The funding rule's index comes from the stored policy's rule layout (`fundingRuleIndex`): a key installed with the
 * Clanker-era layout keeps its rule at index 3 until it is rotated.
 */
export async function fundingBudget(ctx: SupervisorContext, agent: AgentRow): Promise<FundingBudget | null> {
  if (!agent.permissionId || !ctx.chain.addresses.bootr.callPolicy) return null;
  const id = pad(agent.permissionId as Hex, { size: 32, dir: 'right' });
  const ruleIndex = fundingRuleIndex(agent.sessionPolicy ? deserializeSessionPolicy(agent.sessionPolicy as unknown as SerializedSessionPolicy) : undefined);
  try {
    const [windowEnd, spent, windowSeconds, cap] = await ctx.chain.publicClient.readContract({
      address: ctx.chain.addresses.bootr.callPolicy,
      abi: callPolicyAbi,
      functionName: 'windowOf',
      args: [id, agent.kernel as Address, BigInt(ruleIndex), BigInt(FUNDING_AMOUNT_ARG_INDEX)],
    });
    if (cap === 0n) return null; // legacy rule set without a windowed argument
    const nowSec = BigInt(Math.floor(ctx.now() / 1000));
    const remaining = nowSec >= windowEnd ? cap : cap > spent ? cap - spent : 0n;
    return { cap, remaining, windowEnd: Number(windowEnd), windowSeconds };
  } catch {
    return null;
  }
}

/** `USDC.transfer(spender, amount)`: the only USDC outflow the session key may make. */
export function encodeFundSpenderCall(usdc: Address, spender: Address, amount: bigint): KernelCall {
  return { to: usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [spender, amount] }) };
}

/**
 * How much to move to the spender now: nothing while its balance is at or above `SPENDER_MIN_USDC`; otherwise
 * up to `SPENDER_TARGET_USDC`, bounded by the kernel's USDC and the remaining window budget.
 */
export function spenderTopUp(args: { spenderUsdc: bigint; kernelUsdc: bigint; minUsdc: number; targetUsdc: number; remaining: bigint }): bigint {
  const min = parseUnits(args.minUsdc.toFixed(6), 6);
  const target = parseUnits(args.targetUsdc.toFixed(6), 6);
  if (args.spenderUsdc >= min) return 0n;
  const want = target > args.spenderUsdc ? target - args.spenderUsdc : 0n;
  const amount = [want, args.kernelUsdc, args.remaining].reduce((a, b) => (a < b ? a : b));
  return amount > 0n ? amount : 0n;
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

/**
 * The fee claim on `RwagmiLpLockerV3`, sent by the kernel itself (the locker pays `msg.sender`'s balance to `to`,
 * and BootrCallPolicy only allows `to == kernel`): `settleAndClaim([poolId], WETH, kernel)` settles the pool's pending
 * fees into the kernel's balance and pays it out in one call; without a pool id only the already settled balance can
 * be paid (`claimQuote(WETH, kernel)`).
 */
export function encodeClaimCall(args: { lpLocker: Address; kernel: Address; weth: Address; poolId: Hex | null }): KernelCall {
  const { lpLocker, kernel, weth, poolId } = args;
  const data = poolId
    ? encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'settleAndClaim', args: [[poolId], weth, kernel] })
    : encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [weth, kernel] });
  return { to: lpLocker, value: 0n, data };
}

/** Clamps a requested slippage to what BootrSwapHelper accepts (`MAX_SLIPPAGE_BPS`). */
export function clampSlippageBps(bps: number): number {
  if (!Number.isFinite(bps) || bps < 0) return 0;
  return Math.min(Math.floor(bps), SWAP_MAX_SLIPPAGE_BPS);
}

/**
 * WETH -> USDC through BootrSwapHelper: `WETH.approve(helper, amountIn)` then
 * `helper.swapWethToUsdc(amountIn, maxSlippageBps)` in one batched userOp. The helper pulls the WETH from the
 * kernel, swaps through SwapRouter02 with a floor derived on-chain from Chainlink (`price * (1 - bps)`, bps
 * capped at 300) and pays all output USDC to the kernel. These are the only two swap-related calls the
 * session key's BootrCallPolicy allow-lists (C-02).
 */
export function encodeSwapCalls(args: { weth: Address; swapHelper: Address; amountIn: bigint; maxSlippageBps: number }): KernelCall[] {
  const { weth, swapHelper, amountIn } = args;
  const maxSlippageBps = clampSlippageBps(args.maxSlippageBps);
  if (amountIn <= 0n) throw new Error('swap amount must be positive');
  return [
    { to: weth, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [swapHelper, amountIn] }) },
    { to: swapHelper, value: 0n, data: encodeFunctionData({ abi: swapHelperAbi, functionName: 'swapWethToUsdc', args: [amountIn, BigInt(maxSlippageBps)] }) },
  ];
}

/** `addresses.bootr.swapHelper` or an error naming the missing deployment. */
export function swapHelperAddress(ctx: SupervisorContext): Address {
  const helper = ctx.chain.addresses.bootr.swapHelper;
  if (!helper) throw new Error(`bootr.swapHelper address is not configured for chain ${ctx.chain.chainId}`);
  return helper;
}

/** Human WETH amount needed to reach `targetUsdc` from `haveUsdc` at `ethUsd`, with a 2% buffer; capped at the balance. */
export function wethNeededFor(targetUsdc: number, haveUsdc: number, ethUsd: number, wethBalance: bigint): bigint {
  const missing = Math.max(0, targetUsdc - haveUsdc);
  if (missing <= 0 || ethUsd <= 0) return 0n;
  const wei = parseUnits(((missing / ethUsd) * 1.02).toFixed(18), 18);
  return wei < wethBalance ? wei : wethBalance;
}

/** Off-chain estimate of the helper's floor (for descriptions); the binding floor is computed on-chain. */
export function minUsdcOut(amountInWei: bigint, ethUsd: number, slippageBps: number): bigint {
  const usd = (Number(formatUnits(amountInWei, 18)) * ethUsd * (10_000 - clampSlippageBps(slippageBps))) / 10_000;
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
      throw new PolicyError('treasury_simulation_failed', { message: `treasury_simulation_failed: ${rpcErrorText(err)}` });
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
/**
 * One line that keeps the RPC's own reason: viem wraps bundler and paymaster rejections in `BaseError`s whose
 * `message` starts with a generic "RPC Request failed." while the server's text sits in `details` / the cause chain.
 */
export function rpcErrorText(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const parts: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur instanceof Error && depth < 6; depth++) {
    const e = cur as Error & { shortMessage?: string; details?: string; cause?: unknown };
    for (const text of [e.shortMessage ?? e.message.split('\n')[0], e.details]) {
      const t = (text ?? '').trim();
      if (t && !parts.includes(t)) parts.push(t);
    }
    cur = e.cause;
  }
  return parts.join(' | ').slice(0, 600);
}

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
      const error = `simulation_failed: ${rpcErrorText(err)}`;
      await ctx.db.update(treasuryOps).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
      ctx.log.warn({ agentId: agent.agentId, opId, kind: op.kind, error }, 'treasury op failed');
      return { status: 'failed', opId, error };
    }
  }

  const client = await ctx.kernelFor(agent);
  let prepared;
  try {
    prepared = await client.prepareUserOp(calls);
  } catch (err) {
    const error = `prepare_failed: ${rpcErrorText(err)}`;
    await ctx.db.update(treasuryOps).set({ status: 'failed', error, updatedAt: new Date(ctx.now()) }).where(eq(treasuryOps.opId, opId));
    ctx.log.warn({ agentId: agent.agentId, opId, kind: op.kind, error }, 'treasury op failed');
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
    const error = `submit_error: ${rpcErrorText(err)}`;
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
  /** Top-up of the spender from the kernel's USDC (`fund_model`). */
  fund?: ExecuteResult;
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
  // 1. Claim: fees are WETH only (RWAGMI hook), valued at Chainlink ETH/USD; pending fees need the pool id to settle.
  const claimableUsd = snap.usd.claimableWeth;
  if (claimableUsd >= config.CLAIM_THRESHOLD_USD && (snap.claimable.poolId || Number(snap.claimable.settled) > 0)) {
    const poolId = snap.claimable.poolId;
    const op = await prepareOp(ctx, agent, {
      kind: 'claim_fees',
      calls: [encodeClaimCall({ lpLocker: chain.rwagmi.lpLocker, kernel: agent.kernel as Address, weth: chain.addresses.weth, poolId })],
      description: poolId ? `claim ${snap.claimable.weth} WETH of swap fees (~$${claimableUsd.toFixed(2)}; ${snap.claimable.pending} pending + ${snap.claimable.settled} settled) via settleAndClaim` : `claim ${snap.claimable.settled} WETH of settled swap fees (~$${claimableUsd.toFixed(2)}) via claimQuote`,
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
      const slippage = clampSlippageBps(config.SWAP_SLIPPAGE_BPS);
      const minOut = minUsdcOut(amountIn, after.ethUsd, slippage);
      if (minOut >= 10_000n) {
        const op = await prepareOp(ctx, agent, {
          kind: 'swap',
          calls: encodeSwapCalls({ weth: chain.addresses.weth, swapHelper: swapHelperAddress(ctx), amountIn, maxSlippageBps: slippage }),
          description: `swap ${formatUnits(amountIn, 18)} WETH -> ~>= ${formatUnits(minOut, 6)} USDC via the swap helper (refuel to ${config.FUEL_TARGET_USDC})`,
          origin: 'policy',
        });
        out.swap = await executeOp(ctx, agent, op.opId);
        if (out.swap.status !== 'confirmed') return out;
      }
    }
  }

  // 3. Spender float: keep the x402 spender between SPENDER_MIN_USDC and SPENDER_TARGET_USDC, within the window cap.
  const latest = out.swap ? await readTreasuryOnChain(ctx, agent) : after;
  const spenderUsdc = parseUnits(latest.balances.spenderUsdc, 6);
  const kernelUsdc = parseUnits(latest.balances.usdc, 6);
  if (spenderUsdc < parseUnits(config.SPENDER_MIN_USDC.toFixed(6), 6) && kernelUsdc > 0n) {
    const budget = await fundingBudget(ctx, agent);
    if (!budget) return { ...out, skipped: out.skipped ?? 'no_funding_budget' };
    const amount = spenderTopUp({ spenderUsdc, kernelUsdc, minUsdc: config.SPENDER_MIN_USDC, targetUsdc: config.SPENDER_TARGET_USDC, remaining: budget.remaining });
    if (amount >= 10_000n) {
      const op = await prepareOp(ctx, agent, {
        kind: 'fund_model',
        calls: [encodeFundSpenderCall(chain.addresses.usdc, latest.spender, amount)],
        description: `fund the spender ${latest.spender} with ${formatUnits(amount, 6)} USDC (float ${latest.balances.spenderUsdc} -> target ${config.SPENDER_TARGET_USDC}; ${formatUnits(budget.remaining - amount, 6)} USDC left in this window)`,
        origin: 'policy',
      });
      out.fund = await executeOp(ctx, agent, op.opId);
    } else if (budget.remaining < 10_000n) {
      out.skipped = 'funding_window_exhausted';
    }
  }
  return out;
}
