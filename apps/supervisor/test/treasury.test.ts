import { describe, expect, it } from 'vitest';
import { decodeFunctionData, erc20Abi, parseUnits } from 'viem';
import { universalRouterAbi } from '../src/abi.js';
import { treasuryOps } from '../src/db/schema.js';
import { encodeSwapCalls, minUsdcOut, parseSwapRoute, readTreasuryOnChain, runFeePolicy, wethNeededFor } from '../src/treasury.js';
import { ADDR, KERNEL, makeWorld, seedAgent, TOKEN } from './helpers.js';

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
      const transfer = decodeFunctionData({ abi: erc20Abi, data: swap.calls[0]!.data as `0x${string}` });
      expect(transfer.functionName).toBe('transfer');
      expect(transfer.args[0]).toBe(ADDR.uniswap.universalRouter);
      // needs (20 - 5) USD -> 0.005 ETH * 1.02 = 0.0051 WETH (< 0.1 balance)
      expect(transfer.args[1]).toBe(parseUnits('0.0051', 18));
      const exec = decodeFunctionData({ abi: universalRouterAbi, data: swap.calls[1]!.data as `0x${string}` });
      expect(exec.args[0]).toBe('0x00'); // V3_SWAP_EXACT_IN
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

  it('encodes v3 and v4 routes behind WETH.transfer(router)', () => {
    const base = { weth: ADDR.weth, usdc: ADDR.usdc, universalRouter: ADDR.uniswap.universalRouter, kernel: KERNEL, amountIn: 10n ** 16n, minOut: 29_000_000n, deadline: 1_800_000_000n };
    const v3 = encodeSwapCalls({ ...base, route: parseSwapRoute('v3:500') });
    const v4 = encodeSwapCalls({ ...base, route: parseSwapRoute('v4:3000:60:0x0000000000000000000000000000000000000000') });
    for (const calls of [v3, v4]) {
      expect(calls[0]!.to).toBe(ADDR.weth);
      expect(calls[1]!.to).toBe(ADDR.uniswap.universalRouter);
    }
    expect(decodeFunctionData({ abi: universalRouterAbi, data: v3[1]!.data! }).args[0]).toBe('0x00');
    expect(decodeFunctionData({ abi: universalRouterAbi, data: v4[1]!.data! }).args[0]).toBe('0x10');
    expect(() => parseSwapRoute('v2:1')).toThrow();
  });
});
