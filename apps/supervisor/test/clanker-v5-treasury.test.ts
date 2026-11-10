/**
 * The treasury of a Clanker v5 agent (docs/design/clanker-v5-migration.md section 3), on the mocked chain:
 * `FeeEscrow.owed(kernel, 0x0)` is `settled` (native ETH), the claim op is one `claimFor(kernel, 0x0)` that the session
 * key's claim rule allows, `fund_gas` never runs (fee ETH is gas), and the funding window is read at rule index 3.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, parseUnits, slice, zeroAddress, type Hex } from 'viem';
import { clankerV5FeeEscrowAbi } from '../src/abi.js';
import { treasuryOps } from '../src/db/schema.js';
import { sessionPolicyFor } from '../src/onboarding.js';
import { type SerializedSessionPolicy } from '../src/session-key.js';
import { callPolicyRules } from '../src/session-rules.js';
import { CLANKER_V5_NOTE, claimOpFor, encodeClankerV5ClaimCall, fundingBudget, readTreasuryOnChain, runFeePolicy } from '../src/treasury.js';
import { CLANKER_V5_FEE_ESCROW, CLANKER_V5_HOOK, CLANKER_V5_LAUNCHER, CLANKER_V5_POOL_ID, KERNEL, makeWorld, seedAgent, SPENDER } from './helpers.js';

const layout4 = JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout4.json', import.meta.url), 'utf8')) as { bootr: { policy: SerializedSessionPolicy } };
const V5 = (JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout5-clanker-v5.json', import.meta.url), 'utf8')) as { 'clanker-v5': { policy: SerializedSessionPolicy } })['clanker-v5'];
const ETH = (v: string) => parseUnits(v, 18);

/** The `config.clankerV5` block `registerAgent` stores from `ClankerV5Launched`. */
const V5_DETAILS = { poolId: CLANKER_V5_POOL_ID, hook: CLANKER_V5_HOOK, feeEscrow: CLANKER_V5_FEE_ESCROW, quoteToken: zeroAddress, tickSpacing: 200, taxBps: 15_000, antiSnipe: true };

async function v5World(chain: Parameters<typeof makeWorld>[0] = {}) {
  return makeWorld({ ...chain, config: { BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER, ...chain.config } });
}

describe('treasury of a Clanker v5 agent (mocked chain)', () => {
  it('reads FeeEscrow.owed(kernel, 0x0) as settled native ETH, nothing pending, the v5 pool id and the note; no Clanker v4 or RWAGMI fee read', async () => {
    const w = await v5World({ chain: { clankerV5OwedEth: ETH('0.004'), clankerAvailableWeth: ETH('9'), claimableWeth: ETH('9'), pendingWeth: ETH('9') } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.source).toBe('clanker-v5');
      expect(snap.claimable).toEqual({ weth: '0.004', pending: '0', settled: '0.004', poolId: CLANKER_V5_POOL_ID, note: CLANKER_V5_NOTE, asset: 'ETH' });
      expect(snap.usd.claimableWeth).toBeCloseTo(12);
      expect(w.state.calls.filter((c) => c.fn === 'owed')).toEqual([{ fn: 'owed', args: [KERNEL, zeroAddress] }]);
      expect(w.state.calls.some((c) => ['availableFees', 'claimableQuote', 'pendingQuote', 'deploymentInfo'].includes(c.fn))).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('claims above the threshold with one call, FeeEscrow.claimFor(kernel, 0x0), no value; with no WETH there is no swap and no fund_gas', async () => {
    // 0.004 ETH at $3000 = $12 >= $5; USDC 5 < 20 target, but the kernel holds no WETH: the fee ETH is not swapped
    const w = await v5World({ chain: { clankerV5OwedEth: ETH('0.004'), usdc: 5_000_000n } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.gas).toBeUndefined();
      expect(out.swap).toBeUndefined();
      const ops = await w.db.select().from(treasuryOps);
      expect(ops.map((o) => o.kind)).toEqual(['claim_fees']);
      const claim = ops[0]!;
      expect(claim.calls).toEqual([{ to: CLANKER_V5_FEE_ESCROW, value: '0', data: encodeClankerV5ClaimCall({ feeEscrow: CLANKER_V5_FEE_ESCROW, kernel: KERNEL }).data }]);
      expect(decodeFunctionData({ abi: clankerV5FeeEscrowAbi, data: claim.calls[0]!.data as Hex })).toEqual({ functionName: 'claimFor', args: [KERNEL, zeroAddress] });
      expect(claim.description).toContain('claimFor');
      expect(claim.description).toContain('ETH');
      expect(w.kernel.submitted).toHaveLength(1);
      // the claim op is exactly what the session key's claim rule allows: target, selector and word 0 = kernel
      const rule = callPolicyRules(sessionPolicyFor(w.ctx, agent, 1_800_000_000))[0]!;
      expect(claim.calls[0]!.to).toBe(rule.target);
      expect(slice(claim.calls[0]!.data as Hex, 0, 4)).toBe(rule.selector);
      expect(slice(claim.calls[0]!.data as Hex, 4, 36).toLowerCase()).toBe(rule.args[0]!.value);
    } finally {
      await w.close();
    }
  });

  it('never claims an empty escrow (claimFor reverts NothingToClaim) and nothing below the threshold with healthy gas', async () => {
    const w = await v5World({ chain: { clankerV5OwedEth: ETH('0.001'), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      expect(await runFeePolicy(w.ctx, agent)).toEqual({});
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(claimOpFor(w.ctx, agent, { ...snap, claimable: { ...snap.claimable, settled: '0', weth: '0' } })).toBeNull();
      expect(claimOpFor(w.ctx, agent, snap)?.calls).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('fund_gas is a no-op for v5: low gas claims the fee ETH (gas by itself) even below the threshold and even with WETH on the kernel, and never unwraps', async () => {
    // gas 0.0001 < 0.0002 min; 0.001 ETH owed = $3 < $5; 0.1 WETH on the kernel that a Bootr agent would unwrap
    const w = await v5World({ chain: { deposit: ETH('0.0001'), eth: 0n, weth: ETH('0.1'), clankerV5OwedEth: ETH('0.001'), usdc: 50_000_000n } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.gas).toBeUndefined();
      expect(out.skipped).toBeUndefined();
      expect((await w.db.select().from(treasuryOps)).map((o) => o.kind)).toEqual(['claim_fees']);
      // still low and nothing owed: nothing to do, and still no WETH.withdraw
      w.state.clankerV5OwedEth = 0n;
      const again = await runFeePolicy(w.ctx, agent);
      expect(again.gas).toBeUndefined();
      expect((await w.db.select().from(treasuryOps)).map((o) => o.kind)).toEqual(['claim_fees']);
    } finally {
      await w.close();
    }
  });

  it('the spender float reads the funding window at rule index 3 for a v5 key (4 for a Bootr key)', async () => {
    const w = await v5World();
    try {
      const sessionPolicy = { ...V5.policy } as unknown as Record<string, unknown>;
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5', sessionPolicy }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      expect(await fundingBudget(w.ctx, agent)).toMatchObject({ cap: 50_000_000n });
      const windowOf = w.state.calls.filter((c) => c.fn === 'windowOf');
      expect(windowOf).toHaveLength(1);
      expect(windowOf[0]!.args[2]).toBe(3n);
      expect(windowOf[0]!.args[3]).toBe(1n);
      w.state.calls.length = 0;
      await fundingBudget(w.ctx, { ...agent, source: 'bootr', sessionPolicy: { ...layout4.bootr.policy } as unknown as Record<string, unknown> });
      expect(w.state.calls.find((c) => c.fn === 'windowOf')!.args[2]).toBe(4n);
      expect(SPENDER).toBe(V5.policy.spender);
    } finally {
      await w.close();
    }
  });
});
