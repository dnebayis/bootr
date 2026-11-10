/**
 * The treasury of a USDC-paired Clanker v5 agent (docs/design/clanker-v5-token-settings.md section 3, the owner's answers
 * 6 and 7 of 2026-11-10), on the mocked chain: `FeeEscrow.owed(kernel, USDC)` is `settled` (6 decimals, $1 each), the
 * claim is one `claimFor(kernel, USDC)`, the claimed USDC is fuel (it funds the spender like the creator's USDC), gas
 * comes only from the creator (no claim for gas, no fund_gas, `gas_from_creator`, the out-of-gas notice says so), and
 * the kernel's holder dividends are never claimed, which the snapshot says. ETH-paired v5 agents keep their behaviour
 * (clanker-v5-treasury.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { decodeFunctionData, zeroAddress, type Address, type Hex } from 'viem';
import { clankerV5FeeEscrowAbi } from '../src/abi.js';
import { treasuryOps } from '../src/db/schema.js';
import { notificationText } from '../src/notifications.js';
import { evaluateHealth } from '../src/notify-health.js';
import {
  CLANKER_V5_DIVIDENDS_NOTE,
  CLANKER_V5_NOTE,
  CLANKER_V5_OTHER_NOTE,
  CLANKER_V5_USDC_NOTE,
  claimOpFor,
  readTreasuryOnChain,
  runFeePolicy,
  USDC_FUEL_CLAIM_MIN,
} from '../src/treasury.js';
import { CLANKER_V5_FEE_ESCROW, CLANKER_V5_HOOK, CLANKER_V5_LAUNCHER, CLANKER_V5_POOL_ID, KERNEL, makeWorld, seedAgent, SPENDER, type TestWorld } from './helpers.js';

/** USDC on Base Sepolia (the mocked chain's address book). */
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const usdc = (v: number) => BigInt(Math.round(v * 1e6));

const SETTINGS = {
  buyTaxBps: 15_000,
  sellTaxBps: 15_000,
  burnBps: 0,
  dividendBps: 0,
  slots: [
    { role: 'agent', weightBps: 500 },
    { role: 'platform', weightBps: 3_000 },
    { role: 'creator', weightBps: 6_500 },
  ],
  protocolPolicy: { protocolTaxShare: 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000 },
  minDividendHolding: null,
  metadataEditable: true,
};
const details = (over: Record<string, unknown> = {}, settings: Record<string, unknown> = {}) => ({
  poolId: CLANKER_V5_POOL_ID,
  hook: CLANKER_V5_HOOK,
  feeEscrow: CLANKER_V5_FEE_ESCROW,
  quoteToken: USDC,
  tickSpacing: 200,
  taxBps: 15_000,
  antiSnipe: true,
  settings: { ...SETTINGS, ...settings },
  ...over,
});

async function usdcWorld(chain: NonNullable<Parameters<typeof makeWorld>[0]>['chain'] = {}) {
  return makeWorld({ chain, config: { BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER } });
}

const seedUsdcAgent = (w: TestWorld, d: Record<string, unknown> = details()) => seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: d } });

/** The mocked kernel moves the escrow's USDC onto the kernel when a userOp carries claimFor(kernel, USDC), and the float when it carries the spender transfer. */
function settleOnSubmit(w: TestWorld) {
  const submit = w.kernel.client.submitUserOp.bind(w.kernel.client);
  w.kernel.client.submitUserOp = (async (prepared: { hash: Hex; userOp: { calls: { to: Address; data: Hex }[] } }) => {
    for (const call of prepared.userOp.calls) {
      if (call.to === CLANKER_V5_FEE_ESCROW) {
        const { args } = decodeFunctionData({ abi: clankerV5FeeEscrowAbi, data: call.data });
        if (args[1] === USDC) {
          w.state.usdc += w.state.clankerV5OwedUsdc ?? 0n;
          w.state.clankerV5OwedUsdc = 0n;
        }
      }
    }
    return submit(prepared as never);
  }) as unknown as typeof w.kernel.client.submitUserOp;
}

describe('treasury of a USDC-paired Clanker v5 agent (mocked chain)', () => {
  it('reads FeeEscrow.owed(kernel, USDC) as settled USDC (6 decimals, valued at $1) with the USDC note; no ETH escrow read', async () => {
    const w = await usdcWorld({ clankerV5OwedUsdc: usdc(2.5), clankerV5OwedEth: 10n ** 18n });
    try {
      const agent = await seedUsdcAgent(w);
      const snap = await readTreasuryOnChain(w.ctx, agent);
      expect(snap.claimable).toEqual({ weth: '2.5', pending: '0', settled: '2.5', poolId: CLANKER_V5_POOL_ID, note: CLANKER_V5_USDC_NOTE, asset: 'USDC' });
      expect(snap.usd.claimableWeth).toBe(2.5);
      expect(w.state.calls.filter((c) => c.fn === 'owed')).toEqual([{ fn: 'owed', args: [KERNEL, USDC] }]);
      // the note says what the agent must know: fuel yes, gas only from the creator
      expect(CLANKER_V5_USDC_NOTE).toContain('which is fuel');
      expect(CLANKER_V5_USDC_NOTE).toContain('your gas comes only from your creator');
    } finally {
      await w.close();
    }
  });

  it('an ETH-paired coin is read as before, and an asset no agent coin may have is read but never valued or claimed', async () => {
    const w = await usdcWorld({ clankerV5OwedUsdc: usdc(9), clankerV5OwedEth: 4n * 10n ** 15n });
    try {
      const eth = await seedUsdcAgent(w, details({ quoteToken: zeroAddress }));
      const snap = await readTreasuryOnChain(w.ctx, eth);
      expect(snap.claimable).toEqual({ weth: '0.004', pending: '0', settled: '0.004', poolId: CLANKER_V5_POOL_ID, note: CLANKER_V5_NOTE, asset: 'ETH' });
      expect(snap.usd.claimableWeth).toBeCloseTo(12);
      const other = { ...eth, config: { ...eth.config, clankerV5: details({ quoteToken: '0x1111111111111111111111111111111111111111' }) } };
      const odd = await readTreasuryOnChain(w.ctx, other);
      expect(odd.claimable).toMatchObject({ asset: 'other', note: CLANKER_V5_OTHER_NOTE });
      expect(odd.usd.claimableWeth).toBe(0);
      expect(claimOpFor(w.ctx, other, { ...odd, claimable: { ...odd.claimable, settled: '5' } })).toBeNull();
    } finally {
      await w.close();
    }
  });

  it('says that holder dividends are not claimed when the coin pays them, and nothing when it does not', async () => {
    const w = await usdcWorld({ clankerV5OwedUsdc: usdc(1) });
    try {
      const plain = await readTreasuryOnChain(w.ctx, await seedUsdcAgent(w));
      expect(plain.claimable.dividends).toBeUndefined();
      const agent = await w.db.query.agents.findFirst();
      const withDividends = { ...agent!, config: { ...agent!.config, clankerV5: details({}, { dividendBps: 1_500, minDividendHolding: (10n ** 22n).toString() }) } };
      const snap = await readTreasuryOnChain(w.ctx, withDividends);
      expect(snap.claimable.dividends).toBe(CLANKER_V5_DIVIDENDS_NOTE);
      expect(CLANKER_V5_DIVIDENDS_NOTE).toContain('no rule lets your wallet claim dividends');
      // no read of any dividend tracker either: only the escrow
      expect(new Set(w.state.calls.map((c) => c.fn)).has('withdrawableDividendOf')).toBe(false);
    } finally {
      await w.close();
    }
  });

  it('claims above the threshold with one claimFor(kernel, USDC), and the claimed USDC funds the spender in the same pass: fuel directly', async () => {
    // $6 owed >= $5; the spender float is low (2 < 5) and the kernel has no USDC of its own
    const w = await usdcWorld({ clankerV5OwedUsdc: usdc(6), usdc: 0n, spenderUsdc: usdc(2) });
    try {
      settleOnSubmit(w);
      const agent = await seedUsdcAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim?.status).toBe('confirmed');
      expect(out.fund?.status).toBe('confirmed');
      expect(out.gas).toBeUndefined();
      expect(out.swap).toBeUndefined();
      const ops = await w.db.select().from(treasuryOps);
      expect(ops.map((o) => o.kind)).toEqual(['claim_fees', 'fund_model']);
      const [claim, fund] = ops;
      expect(claim!.calls).toHaveLength(1);
      expect(decodeFunctionData({ abi: clankerV5FeeEscrowAbi, data: claim!.calls[0]!.data as Hex })).toEqual({ functionName: 'claimFor', args: [KERNEL, USDC] });
      expect(claim!.calls[0]).toMatchObject({ to: CLANKER_V5_FEE_ESCROW, value: '0' });
      expect(claim!.description).toBe('claim 6 USDC of trading tax (~$6.00) from the Clanker v5 fee escrow via claimFor; it lands on the kernel as fuel');
      // the transfer to the spender is paid from the USDC the claim brought in
      expect(fund!.description).toContain(`fund the spender ${SPENDER} with 6 USDC`);
    } finally {
      await w.close();
    }
  });

  it('below the threshold it claims for fuel only when fuel is under the target and at least USDC_FUEL_CLAIM_MIN is owed', async () => {
    expect(USDC_FUEL_CLAIM_MIN).toBe(1);
    // fuel 3 + 2 = 5 < 20 target, $1.5 owed: claimed
    const low = await usdcWorld({ clankerV5OwedUsdc: usdc(1.5), usdc: usdc(3), spenderUsdc: usdc(2) });
    try {
      const out = await runFeePolicy(low.ctx, await seedUsdcAgent(low));
      expect(out.claim?.status).toBe('confirmed');
    } finally {
      await low.close();
    }
    // fuel 50 + 20 >= 20 target: $1.5 waits for the $5 threshold
    const full = await usdcWorld({ clankerV5OwedUsdc: usdc(1.5) });
    try {
      expect(await runFeePolicy(full.ctx, await seedUsdcAgent(full))).toEqual({});
    } finally {
      await full.close();
    }
    // fuel low but only $0.5 owed: not worth a claim's gas
    const dust = await usdcWorld({ clankerV5OwedUsdc: usdc(0.5), usdc: usdc(3), spenderUsdc: usdc(6) });
    try {
      expect((await runFeePolicy(dust.ctx, await seedUsdcAgent(dust))).claim).toBeUndefined();
    } finally {
      await dust.close();
    }
  });

  it('gas comes only from the creator: low gas never claims for gas, never unwraps WETH, says gas_from_creator; empty gas waits for the creator', async () => {
    // gas 0.0001 < 0.0002 min; $2 owed (below threshold, fuel healthy); stray WETH that a Bootr agent would unwrap
    const w = await usdcWorld({ deposit: 10n ** 14n, eth: 0n, weth: 10n ** 17n, clankerV5OwedUsdc: usdc(2) });
    try {
      const agent = await seedUsdcAgent(w);
      const out = await runFeePolicy(w.ctx, agent);
      expect(out.claim).toBeUndefined();
      expect(out.gas).toBeUndefined();
      expect(out.skipped).toBe('gas_from_creator');
      expect((await w.db.select().from(treasuryOps)).filter((o) => o.kind === 'fund_gas')).toEqual([]);
      w.state.deposit = 0n;
      expect(await runFeePolicy(w.ctx, agent)).toEqual({ skipped: 'out_of_gas' });
    } finally {
      await w.close();
    }
  });

  it('the creator is told plainly that gas comes only from them, for USDC agents only', () => {
    const facts = {
      now: 0,
      agentStatus: 'onboarding' as const,
      runtime: null,
      reviews: { pending: 0, expiring: 0, soonestExpiry: null },
      fuel: null,
      gas: 'empty' as const,
      x: null,
      key: { validUntil: null, rotateBeforeMs: 0, outdated: false },
    };
    expect(evaluateHealth({ ...facts, gasFromCreatorOnly: true }).gas_out).toEqual({ creatorOnly: 1 });
    expect(evaluateHealth(facts).gas_out).toEqual({});
    expect(notificationText('gas_out', { creatorOnly: 1 }).body).toBe(
      'This coin’s fees arrive in USDC, which pays the agent’s thinking but never its gas: gas comes only from you. The agent cannot claim fees, trade or refuel until you add gas on the coin page.',
    );
    expect(notificationText('gas_out', {}).body).toBe('The agent cannot claim fees, trade or refuel until someone adds gas on the coin page.');
  });
});
