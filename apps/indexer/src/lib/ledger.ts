/**
 * Fee ledger, shared by the `RwagmiHookV3.PoolFeeTakenV3` handler and by the launch handler (which
 * replays the dev buy's fee from the launch receipt, because that log precedes `AgentLaunched` and
 * therefore the token and slot rows).
 */
import { and, eq } from 'ponder';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { collectionRows, pickV5Slot } from './clanker';
import { splitFee, type RecipientKind } from './fees';
import { usd } from './price';
import { assetUsd, bumpDaily, bumpPlatform, bumpSource, feeKindDelta, getEthUsd, getPlatformConfig, lc, sourceOf, type Ctx, type TokenRow } from './store';

export type FeeMeta = { txHash: Hex; logIndex: number; blockNumber: bigint; timestamp: number };

/** One Bootr slot's accrual (`feeAccrual` + `feeBalance` + the per-kind rollups); `settled` also credits it. */
async function bookAccrual(
  context: Ctx,
  t: TokenRow,
  s: { id: string; recipient: Address; recipientKind: RecipientKind; asset: Address; amount: bigint; settled: boolean },
  m: FeeMeta,
  ethUsd: number,
  bootToken: string | null,
) {
  const amountUsd = assetUsd(s.asset, s.amount, t, ethUsd);
  await context.db.insert(schema.feeAccrual).values({
    id: s.id,
    token: t.id,
    recipient: s.recipient,
    recipientKind: s.recipientKind,
    asset: s.asset,
    amount: s.amount,
    amountUsd,
    timestamp: m.timestamp,
    txHash: m.txHash,
  });
  const settled = s.settled ? s.amount : 0n;
  await context.db
    .insert(schema.feeBalance)
    .values({
      id: `${s.recipient}-${s.asset}-${t.id}`,
      recipient: s.recipient,
      asset: s.asset,
      token: t.id,
      recipientKind: s.recipientKind,
      accrued: s.amount,
      settled,
      claimed: 0n,
      outstanding: s.amount,
      accruedUsd: amountUsd,
      claimedUsd: 0,
    })
    .onConflictDoUpdate((r) => ({
      accrued: r.accrued + s.amount,
      settled: r.settled + settled,
      outstanding: r.outstanding + s.amount,
      accruedUsd: usd(r.accruedUsd + amountUsd),
    }));
  const delta = feeKindDelta(s.recipientKind, amountUsd);
  await bumpDaily(context, m.timestamp, delta);
  await bumpSource(context, sourceOf(t), m.timestamp, delta);
  if (s.recipientKind === 'burn' && bootToken === t.id) {
    await bumpPlatform(context, m.timestamp, { bootFeesToBurnUsd: amountUsd });
  }
  return amountUsd;
}

/** The gross fee traders paid on a coin: token / daily / platform / per-source totals. */
export async function bookGrossFee(context: Ctx, t: TokenRow, grossUsd: number, ts: number) {
  if (grossUsd === 0) return;
  await context.db.update(schema.token, { id: t.id }).set((r) => ({ feesTotalUsd: usd(r.feesTotalUsd + grossUsd) }));
  await bumpDaily(context, ts, { feesUsd: grossUsd });
  await bumpPlatform(context, ts, { feesTotalUsd: grossUsd });
  await bumpSource(context, sourceOf(t), ts, { feesTotalUsd: grossUsd });
}

/**
 * Bootr path. Book one swap fee taken by the RWAGMI hook: the gross amount on the token / daily / platform
 * totals, and each Bootr reward slot's share (gross × bps / 10_000) as a `feeAccrual` plus its `feeBalance`.
 * RWAGMI's protocol slot is part of the gross figure only.
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
    await bookAccrual(
      context,
      t,
      { id: `${m.txHash}-${m.logIndex}-${s.slot}`, recipient: s.recipient, recipientKind: s.recipientKind as RecipientKind, asset: lc(asset), amount: share, settled: false },
      m,
      ethUsd,
      cfg.bootToken,
    );
  }
  await bookGrossFee(context, t, grossUsd, m.timestamp);
}

/**
 * Clanker path. Book one locker collection (`ClaimedRewards`): the exact amount each reward slot received, after
 * fee-preference conversion (WETH for the `Paired` slots, the coin for the burn slot), as a `feeAccrual`, a
 * `feeCredit` and its `feeBalance` (accrued and settled at once: the fee locker holds it, claimable now). The
 * gross fee is booked per trade from the swap (see `applySwap`), not here.
 */
export async function applyClankerCollection(
  context: Ctx,
  t: TokenRow,
  pool: { id: Hex; currency0: Address; currency1: Address },
  args: { rewards0: readonly bigint[]; rewards1: readonly bigint[] },
  m: FeeMeta,
) {
  const slots = await context.db.sql.select().from(schema.feeSlot).where(eq(schema.feeSlot.token, t.id));
  const rows = collectionRows(args, slots as { slot: number; recipient: Address; recipientKind: string }[], pool);
  if (rows.length === 0) return;
  const ethUsd = await getEthUsd(context, m.blockNumber);
  const cfg = await getPlatformConfig(context);
  for (const r of rows) {
    const id = `${m.txHash}-${m.logIndex}-${r.slot}-${r.side}`;
    const amountUsd = await bookAccrual(context, t, { id, ...r, settled: true }, m, ethUsd, cfg.bootToken);
    await context.db.insert(schema.feeCredit).values({
      id,
      token: t.id,
      poolId: pool.id,
      slot: r.slot,
      recipient: r.recipient,
      recipientKind: r.recipientKind,
      asset: r.asset,
      amount: r.amount,
      amountUsd,
      timestamp: m.timestamp,
      blockNumber: m.blockNumber,
      logIndex: m.logIndex,
      txHash: m.txHash,
    });
  }
}

/**
 * Clanker v5 path. Book one credit of the `TaxLaunchHook` for a coin of ours: `CreatorTaxCredited` (a paid slot's
 * exact share of a swap's tax, in the quote; native ETH is `0x0`) or `BurnTaxCredited` (the burn share, in the coin,
 * for the dead address). The amount is a `feeAccrual`, a `feeCredit` and its `feeBalance`, accrued and settled at
 * once (the escrow holds it, claimable now). The slot is the coin's burn slot, or the paid slot of that recipient
 * (`pickV5Slot`: the n-th credit to one wallet in a transaction is its n-th slot when it holds several). Credits to
 * a recipient that holds no slot of the coin are dropped. The gross fee is booked per trade from the swap
 * (`applySwap`), not here.
 */
export async function applyClankerV5TaxCredit(
  context: Ctx,
  t: TokenRow,
  poolId: Hex,
  c: { burn: boolean; recipient: Address; asset: Address; amount: bigint },
  m: FeeMeta,
) {
  if (c.amount === 0n) return;
  const recipient = lc(c.recipient);
  const slots = await context.db.sql.select().from(schema.feeSlot).where(eq(schema.feeSlot.token, t.id));
  let slot: (typeof slots)[number] | null;
  if (c.burn) {
    slot = slots.find((s) => s.recipientKind === 'burn' && s.recipient === recipient) ?? null;
  } else {
    const several = slots.filter((s) => s.recipient === recipient && s.recipientKind !== 'burn').length > 1;
    const prior = several
      ? (
          await context.db.sql
            .select({ id: schema.feeCredit.id })
            .from(schema.feeCredit)
            .where(and(eq(schema.feeCredit.token, t.id), eq(schema.feeCredit.txHash, m.txHash), eq(schema.feeCredit.recipient, recipient)))
        ).length
      : 0;
    slot = pickV5Slot(slots, recipient, prior);
  }
  if (!slot) return;
  const ethUsd = await getEthUsd(context, m.blockNumber);
  const cfg = await getPlatformConfig(context);
  const id = `${m.txHash}-${m.logIndex}`;
  const kind = slot.recipientKind as RecipientKind;
  const asset = lc(c.asset);
  const amountUsd = await bookAccrual(context, t, { id, recipient, recipientKind: kind, asset, amount: c.amount, settled: true }, m, ethUsd, cfg.bootToken);
  await context.db.insert(schema.feeCredit).values({
    id,
    token: t.id,
    poolId,
    slot: slot.slot,
    recipient,
    recipientKind: kind,
    asset,
    amount: c.amount,
    amountUsd,
    timestamp: m.timestamp,
    blockNumber: m.blockNumber,
    logIndex: m.logIndex,
    txHash: m.txHash,
  });
}
