import { and, eq } from 'ponder';
import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { enabledSources } from './lib/env';
import { allocateClaim } from './lib/fees';
import { toUnits, usd } from './lib/price';
import {
  assetUsd,
  bumpDaily,
  bumpPlatform,
  feeKindDelta,
  getEthUsd,
  getPlatformConfig,
  lc,
  recipientKindOf,
  type Ctx,
} from './lib/store';

if (enabledSources().ClankerLpLocker) {
  /**
   * `ClankerLpLockerFeeConversion._collectRewards` stores every recipient's share in the
   * FeeLocker and then emits ClaimedRewards(token, amount0, amount1, rewards0[], rewards1[]) with
   * per-reward-index amounts *after* fee-preference conversion (the burner's WETH share arrives
   * as the coin). This is the only fee event that names the coin, so accruals come from here
   * rather than from `ClankerFeeLocker.StoreTokens` (which only names the fee asset).
   * Reward index order is fixed by BootrLauncher: [kernel, creator, (burner), platform].
   */
  ponder.on('ClankerLpLocker:ClaimedRewards', async ({ event, context }) => {
    const t = await context.db.find(schema.token, { id: lc(event.args.token) });
    if (!t) return;
    const ts = Number(event.block.timestamp);
    const ethUsd = await getEthUsd(context, event.block.number);
    const recipients: Address[] = t.burner
      ? [t.kernel, t.creator, t.burner, t.platformRecipient]
      : [t.kernel, t.creator, t.platformRecipient];
    const currency0 = t.coinIsToken0 ? t.id : t.pairedToken;
    const currency1 = t.coinIsToken0 ? t.pairedToken : t.id;
    const cfg = await getPlatformConfig(context);

    for (let i = 0; i < recipients.length; i++) {
      const recipient = recipients[i]!;
      const kind = recipientKindOf(recipient, t);
      if (!kind) continue;
      for (const [side, asset, amount] of [
        [0, currency0, event.args.rewards0[i] ?? 0n],
        [1, currency1, event.args.rewards1[i] ?? 0n],
      ] as const) {
        if (amount === 0n) continue;
        const amountUsd = assetUsd(asset, amount, t, ethUsd);
        await context.db.insert(schema.feeAccrual).values({
          id: `${event.transaction.hash}-${event.log.logIndex}-${i}-${side}`,
          token: t.id,
          recipient: lc(recipient),
          recipientKind: kind,
          asset: lc(asset),
          amount,
          amountUsd,
          timestamp: ts,
          txHash: event.transaction.hash,
        });
        await context.db
          .insert(schema.feeBalance)
          .values({
            id: `${lc(recipient)}-${lc(asset)}-${t.id}`,
            recipient: lc(recipient),
            asset: lc(asset),
            token: t.id,
            recipientKind: kind,
            accrued: amount,
            claimed: 0n,
            outstanding: amount,
            accruedUsd: amountUsd,
            claimedUsd: 0,
          })
          .onConflictDoUpdate((r) => ({
            accrued: r.accrued + amount,
            outstanding: r.outstanding + amount,
            accruedUsd: usd(r.accruedUsd + amountUsd),
          }));
        await context.db
          .update(schema.token, { id: t.id })
          .set((r) => ({ feesTotalUsd: usd(r.feesTotalUsd + amountUsd) }));
        await bumpDaily(context, ts, feeKindDelta(kind, amountUsd));
        await bumpPlatform(context, ts, {
          feesTotalUsd: amountUsd,
          ...(kind === 'burn' && cfg.bootToken === t.id ? { bootFeesToBurnUsd: amountUsd } : {}),
        });
      }
    }
  });
}

/**
 * `ClankerFeeLocker.claim(feeOwner, asset)` pays the full (feeOwner, asset) balance. Split it
 * over the per-coin outstanding balances (see `allocateClaim`) and record one feeClaim per coin.
 */
async function recordClaim(
  context: Ctx,
  feeOwner: Address,
  asset: Address,
  amount: bigint,
  meta: { txHash: Hex; logIndex: number; ts: number; blockNumber: bigint },
) {
  if (!(await context.db.find(schema.feeRecipient, { id: lc(feeOwner) }))) return;
  const rows = await context.db.sql
    .select()
    .from(schema.feeBalance)
    .where(and(eq(schema.feeBalance.recipient, lc(feeOwner)), eq(schema.feeBalance.asset, lc(asset))));
  if (rows.length === 0) return;
  rows.sort((a, b) => (a.id < b.id ? -1 : 1));
  const parts = allocateClaim(
    rows.map((r) => r.outstanding),
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

if (enabledSources().ClankerFeeLocker) {
  ponder.on('ClankerFeeLocker:ClaimTokens', async ({ event, context }) => {
    await recordClaim(context, event.args.feeOwner, event.args.token, event.args.amountClaimed, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });

  ponder.on('ClankerFeeLocker:ClaimTokensPermissioned', async ({ event, context }) => {
    await recordClaim(context, event.args.feeOwner, event.args.token, event.args.amountClaimed, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });
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
