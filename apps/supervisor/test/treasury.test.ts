import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseUnits } from 'viem';
import { swapHelperAbi } from '../src/abi.js';
import { treasuryOps } from '../src/db/schema.js';
import { clampSlippageBps, encodeSwapCalls, ethUsdPrice, fundingBudget, minUsdcOut, readTreasuryOnChain, runFeePolicy, spenderTopUp, wethNeededFor } from '../src/treasury.js';
import { ADDR, KERNEL, makeWorld, seedAgent, SPENDER, TOKEN } from './helpers.js';

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
      expect(claim.calls).toHaveLength(1);
      expect(claim.calls[0]!.to).toBe(ADDR.clankerFeeLocker);
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

  it('claims the agent token fees too and leaves USDC alone when already fuelled', async () => {
    const w = await makeWorld({ chain: { claimableWeth: parseUnits('0.01', 18), claimableToken: parseUnits('1000', 18), usdc: 50_000_000n, weth: parseUnits('1', 18) } });
    try {
      const agent = await seedAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.swap).toBeUndefined();
      const [claim] = await w.db.select().from(treasuryOps);
      expect(claim!.calls).toHaveLength(2);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.kernel).toBe(KERNEL);
      expect(snap.balances.token).toBe('0');
      expect(claim!.calls.map((c) => decodeFunctionData({ abi: [{ type: 'function', name: 'claim', inputs: [{ type: 'address' }, { type: 'address' }], outputs: [], stateMutability: 'nonpayable' }], data: c.data as `0x${string}` }).args[1])).toEqual([ADDR.weth, TOKEN]);
    } finally {
      await w.close();
    }
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
