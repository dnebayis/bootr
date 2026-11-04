import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseUnits, type Hex } from 'viem';
import { clankerFeeLockerAbi, clankerLpLockerAbi, rwagmiLpLockerV3Abi, swapHelperAbi } from '../src/abi.js';
import { treasuryOps } from '../src/db/schema.js';
import { encodeUnwrapCall, gasStatusOf, gasTopUp, wethAbi } from '../src/gas.js';
import { CALL_POLICY_RULES_VERSION } from '../src/session-key.js';
import { CLANKER_PENDING_NOTE, claimOpFor, clampSlippageBps, encodeClaimCall, encodeClankerClaimCalls, encodeSwapCalls, ethUsdPrice, fundingBudget, minUsdcOut, poolIdFor, readTreasuryOnChain, runFeePolicy, spenderTopUp, wethNeededFor } from '../src/treasury.js';
import { ADDR, CLANKER_FEE_LOCKER, CLANKER_LP_LOCKER, CLANKER_POOL_ID, KERNEL, makeWorld, POOL_ID, RWAGMI_LP_LOCKER, seedAgent, SPENDER, TOKEN } from './helpers.js';

/** Clanker's mainnet FeeLocker: the claim target of session keys installed before the RWAGMI v3 cutover. */
const LEGACY_CLANKER_FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68' as const;

const claimOf = (data: string) => decodeFunctionData({ abi: rwagmiLpLockerV3Abi, data: data as Hex });

describe('fee claim policy', () => {
  it('claims above the USD threshold, then swaps WETH to refuel USDC up to the target', async () => {
    // 0.01 WETH claimable at $3000 = $30 >= $5 ; USDC 5 < 20 target ; WETH balance 0.1
    const w = await makeWorld({ chain: { claimableWeth: parseUnits('0.01', 18), usdc: 5_000_000n, weth: parseUnits('0.1', 18) } });
    try {
      const agent = await seedAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      const ops = await w.db.select().from(treasuryOps);
      expect(ops.map((o) => o.kind).sort()).toEqual(['claim_fees', 'swap']);
      expect(ops.every((o) => o.origin === 'policy' && o.status === 'confirmed' && o.userOpHash && o.txHash)).toBe(true);
      const claim = ops.find((o) => o.kind === 'claim_fees')!;
      // one call, by the kernel, on the RWAGMI locker: settle the coin's pool and pay the kernel's WETH to the kernel
      expect(claim.calls).toHaveLength(1);
      expect(claim.calls[0]!.to).toBe(RWAGMI_LP_LOCKER);
      expect(claim.calls[0]!.value).toBe('0');
      expect(claimOf(claim.calls[0]!.data)).toEqual({ functionName: 'settleAndClaim', args: [[POOL_ID], ADDR.weth, KERNEL] });
      expect(claim.description).toContain('settleAndClaim');
      const swap = ops.find((o) => o.kind === 'swap')!;
      expect(swap.calls.map((c) => c.to)).toEqual([ADDR.weth, ADDR.bootr.swapHelper]);
      const approve = decodeFunctionData({ abi: erc20Abi, data: swap.calls[0]!.data as `0x${string}` });
      expect(approve.functionName).toBe('approve');
      expect(approve.args[0]).toBe(ADDR.bootr.swapHelper);
      // needs (20 - 5) USD -> 0.005 ETH * 1.02 = 0.0051 WETH (< 0.1 balance)
      expect(approve.args[1]).toBe(parseUnits('0.0051', 18));
      const exec = decodeFunctionData({ abi: swapHelperAbi, data: swap.calls[1]!.data as `0x${string}` });
      expect(exec.functionName).toBe('swapWethToUsdc');
      expect(exec.args).toEqual([parseUnits('0.0051', 18), 100n]); // SWAP_SLIPPAGE_BPS default
      expect(swap.description).toContain('swap helper');
      expect(w.kernel.submitted).toHaveLength(2);
    } finally {
      await w.close();
    }
  });

  it('does nothing below the threshold and skips while an op is in flight', async () => {
    const w = await makeWorld({ chain: { claimableWeth: parseUnits('0.001', 18), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim).toBeUndefined();
      expect(out.swap).toBeUndefined();
      expect(await w.db.select().from(treasuryOps)).toHaveLength(0);
      await w.db.insert(treasuryOps).values({ opId: 'op_x', agentId: agent.agentId, kind: 'swap', calls: [], callHash: '0x00', description: 'd', origin: 'policy', status: 'unknown', userOpHash: '0x01' });
      w.state.claimableWeth = parseUnits('1', 18);
      expect((await runFeePolicy(w.ctx, agent)).skipped).toBe('op_in_flight');
    } finally {
      await w.close();
    }
  });

  it('counts pending (unsettled) plus settled WETH, settles through the pool, and leaves USDC alone when already fuelled', async () => {
    // 0.006 WETH still on the pool + 0.004 WETH settled = 0.01 WETH = $30; fees are WETH only (no token leg)
    const w = await makeWorld({ chain: { pendingWeth: parseUnits('0.006', 18), claimableWeth: parseUnits('0.004', 18), usdc: 50_000_000n, weth: parseUnits('1', 18) } });
    try {
      const agent = await seedAgent(w);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.kernel).toBe(KERNEL);
      expect(snap.balances.token).toBe('0');
      expect(snap.claimable).toEqual({ weth: '0.01', pending: '0.006', settled: '0.004', poolId: POOL_ID });
      expect(snap.usd.claimableWeth).toBeCloseTo(30, 6);
      expect(await poolIdFor(w.ctx, agent)).toBe(POOL_ID);
      const out = await runFeePolicy(w.ctx, agent, snap);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap).toBeUndefined();
      const [claim] = await w.db.select().from(treasuryOps);
      expect(claim!.calls).toHaveLength(1);
      expect(claimOf(claim!.calls[0]!.data)).toEqual({ functionName: 'settleAndClaim', args: [[POOL_ID], ADDR.weth, KERNEL] });
      expect(claim!.description).toContain('0.006 pending + 0.004 settled');
    } finally {
      await w.close();
    }
  });

  it('a coin without an RWAGMI pool (not launched through the launcher) only pays its settled balance with claimQuote', async () => {
    // deploymentInfo answers zeros: nothing pending can be settled, whatever the pool mock would report
    const w = await makeWorld({ chain: { poolId: null, pendingWeth: parseUnits('5', 18), claimableWeth: parseUnits('0.01', 18), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.claimable).toEqual({ weth: '0.01', pending: '0', settled: '0.01', poolId: null });
      const out = await runFeePolicy(w.ctx, agent, snap);
      expect(out.claim?.status).toBe('confirmed');
      const [claim] = await w.db.select().from(treasuryOps);
      expect(claim!.calls[0]!.to).toBe(RWAGMI_LP_LOCKER);
      expect(claimOf(claim!.calls[0]!.data)).toEqual({ functionName: 'claimQuote', args: [ADDR.weth, KERNEL] });
      expect(claim!.description).toContain('claimQuote');
      // nothing settled and no pool: nothing to claim, even above the threshold
      w.state.claimableWeth = 0n;
      expect((await runFeePolicy(w.ctx, agent)).claim).toBeUndefined();
      expect(await w.db.select().from(treasuryOps)).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('falls back to the indexer pool id when deploymentInfo cannot be read', async () => {
    const w = await makeWorld({ chain: { pendingWeth: parseUnits('0.01', 18) } });
    try {
      const agent = await seedAgent(w);
      const pc = w.ctx.chain.publicClient as unknown as { readContract: (a: { functionName: string }) => Promise<unknown> };
      const inner = pc.readContract.bind(pc);
      pc.readContract = async (a) => {
        if (a.functionName === 'deploymentInfo') throw new Error('rpc down');
        return inner(a);
      };
      (w.indexer.client as unknown as { market: () => Promise<unknown> }).market = async () => ({ poolId: POOL_ID, priceUsd: 0.01 });
      expect(await poolIdFor(w.ctx, agent)).toBe(POOL_ID);
      expect((await readTreasuryOnChain(w.ctx, agent)).claimable).toEqual({ weth: '0.01', pending: '0.01', settled: '0', poolId: POOL_ID });
      // an indexer without a pool id (or a malformed one) means no pool
      (w.indexer.client as unknown as { market: () => Promise<unknown> }).market = async () => ({ poolId: '0x1234' });
      expect(await poolIdFor(w.ctx, agent)).toBeNull();
      (w.indexer.client as unknown as { market: () => Promise<unknown> }).market = async () => null;
      expect(await poolIdFor(w.ctx, agent)).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('encodeClaimCall: settleAndClaim([poolId], WETH, kernel) with a pool, claimQuote(WETH, kernel) without', () => {
    const withPool = encodeClaimCall({ lpLocker: RWAGMI_LP_LOCKER, kernel: KERNEL, weth: ADDR.weth, poolId: POOL_ID });
    expect([withPool.to, withPool.value]).toEqual([RWAGMI_LP_LOCKER, 0n]);
    expect(claimOf(withPool.data!)).toEqual({ functionName: 'settleAndClaim', args: [[POOL_ID], ADDR.weth, KERNEL] });
    const settledOnly = encodeClaimCall({ lpLocker: RWAGMI_LP_LOCKER, kernel: KERNEL, weth: ADDR.weth, poolId: null });
    expect(claimOf(settledOnly.data!)).toEqual({ functionName: 'claimQuote', args: [ADDR.weth, KERNEL] });
  });

  it('a Bootr agent reports source bootr and no pending-fee note', async () => {
    const w = await makeWorld({ chain: { claimableWeth: parseUnits('0.004', 18) } });
    try {
      const snap = await readTreasuryOnChain(w.ctx, await seedAgent(w));
      expect(snap.source).toBe('bootr');
      expect(snap.claimable.note).toBeUndefined();
      expect(w.state.calls.some((c) => c.fn === 'availableFees')).toBe(false);
    } finally {
      await w.close();
    }
  });
});

describe('fee claims of a coin launched through Clanker (docs/design/clanker-launch.md section 3)', () => {
  /** The `config.clanker` block `registerAgent` stores from `ClankerLaunched`. */
  const clankerDetails = { poolId: CLANKER_POOL_ID, hook: '0x00000000000000000000000000000000000000B4', locker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER, mevModule: '0x00000000000000000000000000000000000000E5', startingTick: -230400, lpFeeBps: 10_000 };

  it('reads settled WETH from ClankerFeeLocker.availableFees(kernel, WETH), no pending, the Clanker pool id and the under-reporting note; the RWAGMI locker is never asked', async () => {
    const w = await makeWorld({ chain: { clankerAvailableWeth: parseUnits('0.004', 18), claimableWeth: parseUnits('9', 18), pendingWeth: parseUnits('9', 18) } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker' }, config: { source: 'clanker', clanker: clankerDetails } });
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.source).toBe('clanker');
      expect(snap.claimable).toEqual({ weth: '0.004', pending: '0', settled: '0.004', poolId: CLANKER_POOL_ID, note: CLANKER_PENDING_NOTE });
      expect(snap.claimable.note).toMatch(/under-reported/);
      expect(snap.usd.claimableWeth).toBeCloseTo(12, 6);
      const fns = w.state.calls.map((c) => c.fn);
      expect(fns).toContain('availableFees');
      expect(fns).not.toContain('pendingQuote');
      expect(fns).not.toContain('claimableQuote');
      expect(fns).not.toContain('deploymentInfo');
      // the fee locker read is for the kernel's WETH on the locker the launch named
      expect(w.state.calls.find((c) => c.fn === 'availableFees')!.args).toEqual([KERNEL, ADDR.weth]);
    } finally {
      await w.close();
    }
  });

  it('without the stored ClankerLaunched details (receipt unread) the configured lockers are used and the pool id is null', async () => {
    const w = await makeWorld({ chain: { clankerAvailableWeth: parseUnits('0.001', 18) } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker' }, config: { source: 'clanker' } });
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.claimable).toEqual({ weth: '0.001', pending: '0', settled: '0.001', poolId: null, note: CLANKER_PENDING_NOTE });
      const op = claimOpFor(w.ctx, agent, snap)!;
      expect(op.calls.map((c) => c.to)).toEqual([CLANKER_LP_LOCKER, CLANKER_FEE_LOCKER]);
    } finally {
      await w.close();
    }
  });

  it('claims above the threshold with one batched userOp: lpLocker.collectRewards(token) then feeLocker.claim(kernel, WETH); the rest of the policy is unchanged', async () => {
    // 0.004 WETH at $3000 = $12 >= $5 ; USDC 5 < 20 target ; WETH balance 0.1 -> claim, then the usual swap
    const w = await makeWorld({ chain: { clankerAvailableWeth: parseUnits('0.004', 18), usdc: 5_000_000n, weth: parseUnits('0.1', 18) } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker' }, config: { source: 'clanker', clanker: clankerDetails } });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      const ops = await w.db.select().from(treasuryOps);
      expect(ops.map((o) => o.kind).sort()).toEqual(['claim_fees', 'swap']);
      const claim = ops.find((o) => o.kind === 'claim_fees')!;
      expect(claim.origin).toBe('policy');
      expect(claim.calls).toHaveLength(2);
      expect(claim.calls.map((c) => [c.to, c.value])).toEqual([
        [CLANKER_LP_LOCKER, '0'],
        [CLANKER_FEE_LOCKER, '0'],
      ]);
      expect(decodeFunctionData({ abi: clankerLpLockerAbi, data: claim.calls[0]!.data as Hex })).toEqual({ functionName: 'collectRewards', args: [TOKEN] });
      expect(decodeFunctionData({ abi: clankerFeeLockerAbi, data: claim.calls[1]!.data as Hex })).toEqual({ functionName: 'claim', args: [KERNEL, ADDR.weth] });
      expect(claim.description).toContain('collectRewards + claim');
      expect(claim.description).toContain('Clanker');
      // one userOp for the claim (both calls batched), one for the swap
      expect(w.kernel.submitted).toHaveLength(2);
      const swap = ops.find((o) => o.kind === 'swap')!;
      expect(swap.calls.map((c) => c.to)).toEqual([ADDR.weth, ADDR.bootr.swapHelper]);
    } finally {
      await w.close();
    }
  });

  it('does nothing below the threshold, and never claims an empty fee locker (claim would revert NoFeesToClaim)', async () => {
    const w = await makeWorld({ chain: { clankerAvailableWeth: parseUnits('0.001', 18), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker' }, config: { source: 'clanker', clanker: clankerDetails } });
      expect(await runFeePolicy(w.ctx, agent)).toEqual({});
      expect(await w.db.select().from(treasuryOps)).toHaveLength(0);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(claimOpFor(w.ctx, agent, { ...snap, claimable: { ...snap.claimable, settled: '0', weth: '0' } })).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('encodeClankerClaimCalls: [lpLocker.collectRewards(token), feeLocker.claim(kernel, WETH)], both without value', () => {
    const calls = encodeClankerClaimCalls({ lpLocker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER, token: TOKEN, kernel: KERNEL, weth: ADDR.weth });
    expect(calls.map((c) => [c.to, c.value])).toEqual([
      [CLANKER_LP_LOCKER, 0n],
      [CLANKER_FEE_LOCKER, 0n],
    ]);
    expect(decodeFunctionData({ abi: clankerLpLockerAbi, data: calls[0]!.data! })).toEqual({ functionName: 'collectRewards', args: [TOKEN] });
    expect(decodeFunctionData({ abi: clankerFeeLockerAbi, data: calls[1]!.data! })).toEqual({ functionName: 'claim', args: [KERNEL, ADDR.weth] });
  });
});

describe('swap math and routes', () => {
  it('computes WETH needed and min out with slippage', () => {
    expect(wethNeededFor(20, 5, 3000, parseUnits('1', 18))).toBe(parseUnits('0.0051', 18));
    expect(wethNeededFor(20, 5, 3000, parseUnits('0.001', 18))).toBe(parseUnits('0.001', 18));
    expect(wethNeededFor(20, 25, 3000, parseUnits('1', 18))).toBe(0n);
    expect(minUsdcOut(parseUnits('0.01', 18), 3000, 100)).toBe(parseUnits('29.7', 6));
  });

  it('encodes WETH.approve(helper, amountIn) + helper.swapWethToUsdc(amountIn, bps) with the slippage clamped to the contract cap', () => {
    const calls = encodeSwapCalls({ weth: ADDR.weth, swapHelper: ADDR.bootr.swapHelper!, amountIn: 10n ** 16n, maxSlippageBps: 250 });
    expect(calls.map((c) => [c.to, c.value])).toEqual([
      [ADDR.weth, 0n],
      [ADDR.bootr.swapHelper, 0n],
    ]);
    expect(decodeFunctionData({ abi: erc20Abi, data: calls[0]!.data! })).toEqual({ functionName: 'approve', args: [ADDR.bootr.swapHelper, 10n ** 16n] });
    expect(decodeFunctionData({ abi: swapHelperAbi, data: calls[1]!.data! })).toEqual({ functionName: 'swapWethToUsdc', args: [10n ** 16n, 250n] });
    // the model may ask for more, the helper's MAX_SLIPPAGE_BPS (300) is the ceiling
    expect(clampSlippageBps(500)).toBe(300);
    expect(clampSlippageBps(-5)).toBe(0);
    expect(clampSlippageBps(Number.NaN)).toBe(0);
    expect(decodeFunctionData({ abi: swapHelperAbi, data: encodeSwapCalls({ weth: ADDR.weth, swapHelper: ADDR.bootr.swapHelper!, amountIn: 1n, maxSlippageBps: 10_000 })[1]!.data! }).args).toEqual([1n, 300n]);
    expect(() => encodeSwapCalls({ weth: ADDR.weth, swapHelper: ADDR.bootr.swapHelper!, amountIn: 0n, maxSlippageBps: 100 })).toThrow(/positive/);
  });
});

describe('spender float (x402 payer funding)', () => {
  it('tops the spender up from the kernel when it drops below SPENDER_MIN_USDC, bounded by the window budget', async () => {
    // spender 2 USDC (< 5), kernel 50 USDC, 10 USDC already spent in the window -> top-up min(18, 50, 40) = 18
    const w = await makeWorld({ chain: { spenderUsdc: 2_000_000n, usdc: 50_000_000n, fundingWindow: { windowEnd: 1_792_843_200n + 3600n, spent: 10_000_000n, windowSeconds: 86_400, cap: 50_000_000n } } });
    try {
      const agent = await seedAgent(w);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.spender).toBe(SPENDER);
      expect(snap.balances.spenderUsdc).toBe('2');
      expect(snap.usd.spenderUsdc).toBe(2);
      expect(await fundingBudget(w.ctx, agent)).toEqual({ cap: 50_000_000n, remaining: 40_000_000n, windowEnd: 1_792_843_200 + 3600, windowSeconds: 86_400 });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.fund?.status).toBe('confirmed');
      const [op] = await w.db.select().from(treasuryOps);
      expect(op!.kind).toBe('fund_model');
      expect(op!.origin).toBe('policy');
      expect(op!.calls).toHaveLength(1);
      expect(decodeFunctionData({ abi: erc20Abi, data: op!.calls[0]!.data as `0x${string}` })).toEqual({ functionName: 'transfer', args: [SPENDER, 18_000_000n] });
      expect(op!.description).toContain('22 USDC left in this window');
    } finally {
      await w.close();
    }
  });

  it('does nothing while the spender is funded, and reports an exhausted window', async () => {
    const w = await makeWorld({ chain: { spenderUsdc: 5_000_000n } });
    try {
      const agent = await seedAgent(w);
      expect((await runFeePolicy(w.ctx, agent)).fund).toBeUndefined();
      w.state.spenderUsdc = 0n;
      w.state.fundingWindow.spent = 50_000_000n;
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.fund).toBeUndefined();
      expect(out.skipped).toBe('funding_window_exhausted');
      // a window that already ended counts as fresh
      w.state.fundingWindow.windowEnd = 1_792_843_200n - 1n;
      expect((await fundingBudget(w.ctx, agent))?.remaining).toBe(50_000_000n);
      expect((await runFeePolicy(w.ctx, agent)).fund?.status).toBe('confirmed');
    } finally {
      await w.close();
    }
  });

  it('reads the funding window from the rule index of the installed layout (legacy keys keep index 3 until rotated)', async () => {
    const w = await makeWorld();
    try {
      const windowRule = () => w.state.calls.filter((c) => c.fn === 'windowOf').map((c) => c.args[2]);
      const legacyPolicy = { kernel: KERNEL, feeLocker: LEGACY_CLANKER_FEE_LOCKER, usdcTransferCap: '50000000', gasAllowanceWei: '1' };
      const legacy = await seedAgent(w, { agent: { sessionPolicy: legacyPolicy } });
      expect((await fundingBudget(w.ctx, legacy))?.remaining).toBe(50_000_000n);
      expect(windowRule()).toEqual([3n]);
      await w.db.update((await import('../src/db/schema.js')).agents).set({ sessionPolicy: { ...legacyPolicy, feeLocker: RWAGMI_LP_LOCKER, rulesVersion: CALL_POLICY_RULES_VERSION } });
      const current = { ...legacy, sessionPolicy: { ...legacyPolicy, feeLocker: RWAGMI_LP_LOCKER, rulesVersion: CALL_POLICY_RULES_VERSION } } as typeof legacy;
      expect((await fundingBudget(w.ctx, current))?.remaining).toBe(50_000_000n);
      // no stored policy at all: the current layout
      expect((await fundingBudget(w.ctx, { ...legacy, sessionPolicy: null } as typeof legacy))?.remaining).toBe(50_000_000n);
      expect(windowRule()).toEqual([3n, 4n, 4n]);
    } finally {
      await w.close();
    }
  });

  it('spenderTopUp math', () => {
    expect(spenderTopUp({ spenderUsdc: 5_000_000n, kernelUsdc: 100_000_000n, minUsdc: 5, targetUsdc: 20, remaining: 50_000_000n })).toBe(0n);
    expect(spenderTopUp({ spenderUsdc: 4_999_999n, kernelUsdc: 100_000_000n, minUsdc: 5, targetUsdc: 20, remaining: 50_000_000n })).toBe(15_000_001n);
    expect(spenderTopUp({ spenderUsdc: 0n, kernelUsdc: 7_000_000n, minUsdc: 5, targetUsdc: 20, remaining: 50_000_000n })).toBe(7_000_000n);
    expect(spenderTopUp({ spenderUsdc: 0n, kernelUsdc: 100_000_000n, minUsdc: 5, targetUsdc: 20, remaining: 3_000_000n })).toBe(3_000_000n);
    expect(spenderTopUp({ spenderUsdc: 0n, kernelUsdc: 0n, minUsdc: 5, targetUsdc: 20, remaining: 50_000_000n })).toBe(0n);
  });
});

describe('Chainlink staleness (L-01)', () => {
  it('returns null for a stale, non-positive or out-of-round answer and the fee policy then refuses to swap', async () => {
    const w = await makeWorld({ chain: { claimableWeth: 0n, usdc: 5_000_000n, weth: parseUnits('0.1', 18) } });
    try {
      const agent = await seedAgent(w);
      expect(await ethUsdPrice(w.ctx)).toBe(3000);
      // 1 hour + 1 s old -> stale
      w.state.feedUpdatedAt = w.state.blockTimestamp - 3601n;
      expect(await ethUsdPrice(w.ctx)).toBeNull();
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.swap).toBeUndefined();
      expect(await w.db.select().from(treasuryOps)).toHaveLength(0);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.ethUsd).toBeNull();
      expect(snap.usd.weth).toBe(0);
      // exactly at the limit is fine
      w.state.feedUpdatedAt = w.state.blockTimestamp - 3600n;
      expect(await ethUsdPrice(w.ctx)).toBe(3000);
      // non-positive answer
      w.state.feedUpdatedAt = w.state.blockTimestamp;
      w.state.ethUsd = 0n;
      expect(await ethUsdPrice(w.ctx)).toBeNull();
    } finally {
      await w.close();
    }
  });
});

describe('self-funded gas (no paymaster)', () => {
  const ETH = (v: string) => parseUnits(v, 18);

  it('reports gas = EntryPoint deposit + kernel ETH, and its status against GAS_MIN_WEI', async () => {
    const w = await makeWorld({ chain: { deposit: ETH('0.00015'), eth: ETH('0.0001') } });
    try {
      const snap = await readTreasuryOnChain(w.ctx, await seedAgent(w));
      expect(snap.gas).toEqual({ eth: '0.00025', deposit: '0.00015', balance: '0.0001', status: 'ok' });
    } finally {
      await w.close();
    }
    expect(gasStatusOf(ETH('0.0002'), ETH('0.0002'), true)).toBe('ok');
    expect(gasStatusOf(ETH('0.0001'), ETH('0.0002'), true)).toBe('low');
    expect(gasStatusOf(ETH('0.00004'), ETH('0.0002'), true)).toBe('low');
    expect(gasStatusOf(ETH('0.000039'), ETH('0.0002'), true)).toBe('empty');
    expect(gasStatusOf(0n, ETH('0.0002'), false)).toBe('sponsored');
    // nothing while gas is fine; otherwise up to the target, never more WETH than the kernel holds
    expect(gasTopUp({ total: ETH('0.0002'), minWei: ETH('0.0002'), targetWei: ETH('0.001'), wethBalance: ETH('1') })).toBe(0n);
    expect(gasTopUp({ total: ETH('0.0001'), minWei: ETH('0.0002'), targetWei: ETH('0.001'), wethBalance: ETH('1') })).toBe(ETH('0.0009'));
    expect(gasTopUp({ total: ETH('0.0001'), minWei: ETH('0.0002'), targetWei: ETH('0.001'), wethBalance: ETH('0.0003') })).toBe(ETH('0.0003'));
    expect(gasTopUp({ total: ETH('0.0001'), minWei: ETH('0.0002'), targetWei: ETH('0.001'), wethBalance: 0n })).toBe(0n);
  });

  it('unwraps WETH into gas (fund_gas) before refuelling USDC, when gas is under GAS_MIN_WEI', async () => {
    // gas 0.0001 (< 0.0002 min), 0.1 WETH on the kernel, USDC 5 < 20 target
    const w = await makeWorld({ chain: { deposit: ETH('0.0001'), eth: 0n, weth: ETH('0.1'), usdc: 5_000_000n } });
    try {
      const agent = await seedAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim).toBeUndefined();
      expect(out.gas?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      const ops = await w.db.select().from(treasuryOps).orderBy(treasuryOps.createdAt);
      expect(ops.map((o) => o.kind)).toEqual(['fund_gas', 'swap']);
      const gas = ops[0]!;
      expect(gas.origin).toBe('policy');
      expect(gas.calls).toHaveLength(1);
      expect(gas.calls[0]!.to).toBe(ADDR.weth);
      expect(gas.calls[0]!.value).toBe('0');
      // WETH.withdraw(target 0.001 - gas 0.0001)
      expect(decodeFunctionData({ abi: wethAbi, data: gas.calls[0]!.data as Hex })).toEqual({ functionName: 'withdraw', args: [ETH('0.0009')] });
      expect(gas.description).toContain('unwrap 0.0009 WETH into gas');
      expect(encodeUnwrapCall(ADDR.weth, ETH('0.0009'))).toEqual({ to: ADDR.weth, value: 0n, data: gas.calls[0]!.data });
    } finally {
      await w.close();
    }
  });

  it('an empty kernel sends nothing at all (out_of_gas) until someone adds gas', async () => {
    const w = await makeWorld({ chain: { deposit: 0n, eth: 0n, weth: ETH('0.1'), claimableWeth: ETH('0.01'), usdc: 0n } });
    try {
      const agent = await seedAgent(w);
      expect(await runFeePolicy(w.ctx, agent)).toEqual({ skipped: 'out_of_gas' });
      expect(await w.db.select().from(treasuryOps)).toHaveLength(0);
      // "Add gas" from the web app: EntryPoint.depositTo(kernel) by anyone. 0.0001 ETH is enough to act again:
      // claim (above the USD threshold), then unwrap WETH up to the target, then refuel USDC from the rest.
      w.state.deposit = ETH('0.0001');
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.gas?.status).toBe('confirmed');
      expect(out.swap?.status).toBe('confirmed');
      expect((await w.db.select().from(treasuryOps).orderBy(treasuryOps.createdAt)).map((o) => o.kind)).toEqual(['claim_fees', 'fund_gas', 'swap']);
    } finally {
      await w.close();
    }
  });

  it('low gas with no WETH claims fees below the USD threshold too, then unwraps them', async () => {
    // 0.001 WETH claimable = $3 < $5 threshold; gas 0.0001; the fees are the agent's only gas source
    const w = await makeWorld({ chain: { deposit: ETH('0.0001'), eth: 0n, weth: 0n, claimableWeth: ETH('0.001'), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      // the claim landed 0.001 WETH on the kernel (mocked), all of it goes to gas (0.0009 wanted, 0.001 held)
      w.state.weth = ETH('0.001');
      const ops = await w.db.select().from(treasuryOps).orderBy(treasuryOps.createdAt);
      expect(ops.map((o) => o.kind)).toEqual(['claim_fees']);
      expect(out.skipped).toBe('no_weth_for_gas'); // the mock balance did not move inside this run
      const again = await runFeePolicy(w.ctx, agent);
      expect(again.gas?.status).toBe('confirmed');
      expect(decodeFunctionData({ abi: wethAbi, data: (await w.db.select().from(treasuryOps)).find((o) => o.kind === 'fund_gas')!.calls[0]!.data as Hex }).args).toEqual([ETH('0.0009')]);
    } finally {
      await w.close();
    }
  });

  it('a session key installed under rule layout 2 (no WETH.withdraw) is reported, not used', async () => {
    const w = await makeWorld({ chain: { deposit: ETH('0.0001'), eth: 0n, weth: ETH('0.1') } });
    try {
      const policy = { rulesVersion: 2, usdcTransferCap: '50000000', gasAllowanceWei: '1' };
      const agent = await seedAgent(w, { agent: { sessionPolicy: policy } });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.skipped).toBe('session_key_without_gas_rule');
      expect(out.gas).toBeUndefined();
      expect((await w.db.select().from(treasuryOps)).map((o) => o.kind)).toEqual([]);
    } finally {
      await w.close();
    }
  });

  it('with a paymaster, gas is sponsored: no unwrap, no out_of_gas, even on an empty kernel', async () => {
    const w = await makeWorld({ config: { PAYMASTER_URL: 'http://paymaster.test' }, chain: { deposit: 0n, eth: 0n, weth: ETH('0.1'), usdc: 5_000_000n } });
    try {
      const agent = await seedAgent(w);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.gas.status).toBe('sponsored');
      const out = await runFeePolicy(w.ctx, agent, snap);
      expect(out.gas).toBeUndefined();
      expect(out.skipped).toBeUndefined();
      expect(out.swap?.status).toBe('confirmed');
    } finally {
      await w.close();
    }
  });
});

describe('prepareOp simulation', () => {
  it('simulates a multi-call op as one batch execute from the EntryPoint, so approve-then-swap passes', async () => {
    const { makeWorld, seedAgent } = await import('./helpers.js');
    const { encodeSwapCalls, prepareOp } = await import('../src/treasury.js');
    const { entryPoint07Address } = await import('viem/account-abstraction');
    const world = await makeWorld();
    try {
      const agent = await seedAgent(world);
      const seen: { account?: string; to?: string; data?: string }[] = [];
      const swapHelper = '0x5723152f21ed7E305312fd90a2Bb94864BA9D80d' as const;
      (world.ctx.chain.publicClient as unknown as { call: (a: { account?: string; to?: string; data?: string }) => Promise<unknown> }).call = async (a) => {
        seen.push(a);
        // the swap helper alone (no allowance in that state) reverts; the kernel batch from the EntryPoint passes
        if (a.to?.toLowerCase() === swapHelper.toLowerCase()) throw new Error('execution reverted');
        return { data: '0x' };
      };
      const calls = encodeSwapCalls({ weth: world.ctx.chain.addresses.weth, swapHelper, amountIn: 1_000n, maxSlippageBps: 300 });
      const op = await prepareOp(world.ctx, agent, { kind: 'swap', calls, description: 'swap', origin: 'policy' });
      expect(op.status).toBe('prepared');
      expect(seen).toHaveLength(1);
      expect(seen[0]!.account?.toLowerCase()).toBe(entryPoint07Address.toLowerCase());
      expect(seen[0]!.to?.toLowerCase()).toBe(agent.kernel.toLowerCase());
      // executeOp simulates the same way before sending (one batch call, not one per call)
      const { executeOp } = await import('../src/treasury.js');
      seen.length = 0;
      await executeOp(world.ctx, agent, op.opId);
      expect(seen.filter((a) => a.to?.toLowerCase() === agent.kernel.toLowerCase() && a.account?.toLowerCase() === entryPoint07Address.toLowerCase())).toHaveLength(1);
      expect(seen.some((a) => a.to?.toLowerCase() === swapHelper.toLowerCase())).toBe(false);
      // a single call still simulates as the kernel itself
      seen.length = 0;
      await prepareOp(world.ctx, agent, { kind: 'fund_model', calls: [calls[0]!], description: 'one', origin: 'policy' });
      expect(seen).toHaveLength(1);
      expect(seen[0]!.account?.toLowerCase()).toBe(agent.kernel.toLowerCase());
    } finally {
      await world.close();
    }
  });
});
