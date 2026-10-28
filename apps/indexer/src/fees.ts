import { and, eq } from 'ponder';
import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { enabledSources } from './lib/env';
import { allocateClaim } from './lib/fees';
import { applyFeeTaken } from './lib/ledger';
import { toUnits, usd } from './lib/price';
import { assetUsd, bumpDaily, bumpPlatform, getEthUsd, getPlatformConfig, lc, recipientKindOf, type Ctx } from './lib/store';

/**
 * RWAGMI v3 fee flow (docs/rwagmi-migration.md), all in WETH:
 *   RwagmiHookV3.PoolFeeTakenV3          gross swap fee per swap -> feeAccrual per Bootr slot (bps share)
 *   RwagmiLpLockerV3.PoolFeesSettledV3   the locker credits a slot's recipient -> feeCredit, feeBalance.settled
 *   RwagmiLpLockerV3.QuoteRewardsClaimedV3  a recipient claims its settled balance -> feeClaim
 * Events of non-Bootr pools and recipients are dropped.
 */
if (enabledSources().RwagmiHookV3) {
  ponder.on('RwagmiHookV3:PoolFeeTakenV3', async ({ event, context }) => {
    const p = await context.db.find(schema.pool, { id: lc(event.args.poolId) });
    if (!p) return;
    const t = await context.db.find(schema.token, { id: p.token });
    if (!t || t.launchTx === event.transaction.hash) return; // launch tx is replayed by AgentLaunched
    await applyFeeTaken(context, t, event.args.quote, event.args.amount, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      blockNumber: event.block.number,
      timestamp: Number(event.block.timestamp),
    });
  });
}

if (enabledSources().RwagmiLpLockerV3) {
  /** Settlement moves a pool's pending fees into each slot recipient's claimable balance. */
  ponder.on('RwagmiLpLockerV3:PoolFeesSettledV3', async ({ event, context }) => {
    const p = await context.db.find(schema.pool, { id: lc(event.args.poolId) });
    if (!p) return;
    const t = await context.db.find(schema.token, { id: p.token });
    if (!t) return;
    const amount = event.args.amount;
    if (amount === 0n) return;
    const slot = Number(event.args.slot);
    const recipient = lc(event.args.recipient);
    const row = await context.db.find(schema.feeSlot, { id: `${t.id}-${slot}` });
    const kind = row && row.recipient === recipient ? row.recipientKind : recipientKindOf(recipient, t);
    if (!kind || kind === 'protocol') return;
    const asset = lc(event.args.currency);
    const ethUsd = await getEthUsd(context, event.block.number);
    const amountUsd = assetUsd(asset, amount, t, ethUsd);
    await context.db.insert(schema.feeCredit).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      token: t.id,
      poolId: p.id,
      slot,
      recipient,
      recipientKind: kind,
      asset,
      amount,
      amountUsd,
      timestamp: Number(event.block.timestamp),
      txHash: event.transaction.hash,
    });
    await context.db
      .insert(schema.feeBalance)
      .values({
        id: `${recipient}-${asset}-${t.id}`,
        recipient,
        asset,
        token: t.id,
        recipientKind: kind,
        accrued: 0n,
        settled: amount,
        claimed: 0n,
        outstanding: 0n,
        accruedUsd: 0,
        claimedUsd: 0,
      })
      .onConflictDoUpdate((r) => ({ settled: r.settled + amount }));
  });

  /**
   * `claimQuote(currency, to)` / `settleAndClaim(ids, currency, to)` pay the recipient's whole settled
   * balance in `currency`, across every coin it receives fees from. Split it over the per-coin claimable
   * balances (`settled - claimed`, see `allocateClaim`) and record one feeClaim per coin.
   */
  ponder.on('RwagmiLpLockerV3:QuoteRewardsClaimedV3', async ({ event, context }) => {
    await recordClaim(context, event.args.recipient, event.args.currency, event.args.amount, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });
}

async function recordClaim(
  context: Ctx,
  recipient: Address,
  asset: Address,
  amount: bigint,
  meta: { txHash: Hex; logIndex: number; ts: number; blockNumber: bigint },
) {
  if (amount === 0n) return;
  if (!(await context.db.find(schema.feeRecipient, { id: lc(recipient) }))) return;
  const rows = await context.db.sql
    .select()
    .from(schema.feeBalance)
    .where(and(eq(schema.feeBalance.recipient, lc(recipient)), eq(schema.feeBalance.asset, lc(asset))));
  if (rows.length === 0) return;
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const parts = allocateClaim(
    rows.map((r) => r.settled - r.claimed),
    amount,
  );
  const ethUsd = await getEthUsd(context, meta.blockNumber);
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const part = parts[i]!;
    if (part === 0n) continue;
    const t = await context.db.find(schema.token, { id: row.token });
    if (!t) continue;
    const amountUsd = assetUsd(asset, part, t, ethUsd);
    await context.db.insert(schema.feeClaim).values({
      id: `${meta.txHash}-${meta.logIndex}-${row.token}`,
      token: row.token,
      recipient: row.recipient,
      recipientKind: row.recipientKind,
      asset: lc(asset),
      amount: part,
      amountUsd,
      timestamp: meta.ts,
      txHash: meta.txHash,
    });
    await context.db.update(schema.feeBalance, { id: row.id }).set((r) => ({
      claimed: r.claimed + part,
      outstanding: r.outstanding - part,
      claimedUsd: usd(r.claimedUsd + amountUsd),
    }));
    if (row.recipientKind === 'agent') {
      const agent = await context.db.find(schema.agent, { id: row.recipient });
      if (agent) {
        await context.db
          .update(schema.agent, { id: agent.id })
          .set({ feesClaimedUsd: usd(agent.feesClaimedUsd + amountUsd) });
      }
    }
  }
}

if (enabledSources().BuybackBurner) {
  ponder.on('BuybackBurner:Swapped', async ({ event, context }) => {
    const id = lc(event.log.address);
    if (!(await context.db.find(schema.burner, { id }))) return;
    await context.db
      .update(schema.burner, { id })
      .set({ lastSwapTx: event.transaction.hash, lastSwapWeth: event.args.wethIn });
  });

  ponder.on('BuybackBurner:Burned', async ({ event, context }) => {
    const id = lc(event.log.address);
    const b = await context.db.find(schema.burner, { id });
    if (!b) return;
    const t = await context.db.find(schema.token, { id: b.token });
    if (!t) return;
    const ts = Number(event.block.timestamp);
    const amount = event.args.amount;
    const amountUsd = usd(toUnits(amount, 18) * t.priceUsd);
    await context.db.insert(schema.burn).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      token: t.id,
      burner: id,
      amountToken: amount,
      amountWethSpent: b.lastSwapTx === event.transaction.hash ? b.lastSwapWeth : 0n,
      amountUsd,
      timestamp: ts,
      txHash: event.transaction.hash,
    });
    await context.db.update(schema.burner, { id }).set({ burnedTotal: b.burnedTotal + amount });
    await context.db.update(schema.token, { id: t.id }).set((r) => ({ burnedTotal: r.burnedTotal + amount }));
    const cfg = await getPlatformConfig(context);
    if (cfg.bootToken === t.id) {
      await bumpDaily(context, ts, { bootBurnedToken: amount, bootBurnedUsd: amountUsd });
      await bumpPlatform(context, ts, { bootBurnedTotal: amount });
    }
  });
}
