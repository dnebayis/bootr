/**
 * Fee ledger, shared by the `RwagmiHookV3.PoolFeeTakenV3` handler and by the launch handler (which
 * replays the dev buy's fee from the launch receipt, because that log precedes `AgentLaunched` and
 * therefore the token and slot rows).
 */
import { eq } from 'ponder';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { splitFee, type RecipientKind } from './fees';
import { usd } from './price';
import { assetUsd, bumpDaily, bumpPlatform, feeKindDelta, getEthUsd, getPlatformConfig, lc, type Ctx, type TokenRow } from './store';

export type FeeMeta = { txHash: Hex; logIndex: number; blockNumber: bigint; timestamp: number };

/**
 * Book one swap fee taken by the hook: the gross amount on the token / daily / platform totals, and each
 * Bootr reward slot's share (gross × bps / 10_000) as a `feeAccrual` plus its `feeBalance`. RWAGMI's
 * protocol slot is part of the gross figure only.
 */
export async function applyFeeTaken(context: Ctx, t: TokenRow, asset: Address, amount: bigint, m: FeeMeta) {
  if (amount === 0n) return;
  const ethUsd = await getEthUsd(context, m.blockNumber);
  const grossUsd = assetUsd(asset, amount, t, ethUsd);
  const slots = (await context.db.sql.select().from(schema.feeSlot).where(eq(schema.feeSlot.token, t.id))).sort(
    (a, b) => a.slot - b.slot,
  );
  const shares = splitFee(
    amount,
    slots.map((s) => s.bps),
  );
  const cfg = await getPlatformConfig(context);

  for (let i = 0; i < slots.length; i++) {
    const s = slots[i]!;
    const share = shares[i]!;
    if (s.recipientKind === 'protocol' || share === 0n) continue;
    const kind = s.recipientKind as RecipientKind;
    const amountUsd = assetUsd(asset, share, t, ethUsd);
    await context.db.insert(schema.feeAccrual).values({
      id: `${m.txHash}-${m.logIndex}-${s.slot}`,
      token: t.id,
      recipient: s.recipient,
      recipientKind: kind,
      asset: lc(asset),
      amount: share,
      amountUsd,
      timestamp: m.timestamp,
      txHash: m.txHash,
    });
    await context.db
      .insert(schema.feeBalance)
      .values({
        id: `${s.recipient}-${lc(asset)}-${t.id}`,
        recipient: s.recipient,
        asset: lc(asset),
        token: t.id,
        recipientKind: kind,
        accrued: share,
        settled: 0n,
        claimed: 0n,
        outstanding: share,
        accruedUsd: amountUsd,
        claimedUsd: 0,
      })
      .onConflictDoUpdate((r) => ({
        accrued: r.accrued + share,
        outstanding: r.outstanding + share,
        accruedUsd: usd(r.accruedUsd + amountUsd),
      }));
    await bumpDaily(context, m.timestamp, feeKindDelta(kind, amountUsd));
    if (kind === 'burn' && cfg.bootToken === t.id) {
      await bumpPlatform(context, m.timestamp, { bootFeesToBurnUsd: amountUsd });
    }
  }

  await context.db.update(schema.token, { id: t.id }).set((r) => ({ feesTotalUsd: usd(r.feesTotalUsd + grossUsd) }));
  await bumpDaily(context, m.timestamp, { feesUsd: grossUsd });
  await bumpPlatform(context, m.timestamp, { feesTotalUsd: grossUsd });
}
