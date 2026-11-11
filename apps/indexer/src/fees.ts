import { and, eq, inArray } from 'ponder';
import { ponder } from 'ponder:registry';
import * as schema from 'ponder:schema';
import type { Address, Hex } from 'viem';

import { decodeV5HookCredit, decodeV5SlotUpdate, isBurnClaim, slotUpdatePatch } from './lib/clanker';
import { enabledSources } from './lib/env';
import { claimParts, parseLaunchSource, type LaunchSource } from './lib/fees';
import { applyClankerCollection, applyClankerV5HookCredit, applyFeeTaken } from './lib/ledger';
import { toUnits, usd } from './lib/price';
import { assetUsd, bumpDaily, bumpPlatform, bumpSource, getEthUsd, getPlatformConfig, lc, recipientKindOf, sourceOf, type Ctx, type TokenRow } from './lib/store';

/**
 * Bootr path: RWAGMI v3 fee flow (docs/rwagmi-migration.md), all in WETH:
 *   RwagmiHookV3.PoolFeeTakenV3          gross swap fee per swap -> feeAccrual per Bootr slot (bps share)
 *   RwagmiLpLockerV3.PoolFeesSettledV3   the locker credits a slot's recipient -> feeCredit, feeBalance.settled
 *   RwagmiLpLockerV3.QuoteRewardsClaimedV3  a recipient claims its settled balance -> feeClaim
 * Clanker path (docs/design/clanker-launch.md section 4):
 *   ClankerLpLockerFeeConversion.ClaimedRewards  the locker collects a coin's LP fees, converts each slot's share
 *                                                (WETH for agent / creator / platform, the coin for the burn slot)
 *                                                and stores it in the fee locker -> feeAccrual + feeCredit,
 *                                                feeBalance.accrued = settled
 *   ClankerFeeLocker.ClaimTokens(Permissioned)   a fee owner's stored balance of an asset is paid out -> feeClaim;
 *                                                the burn slot's coin claim (to 0x…dEaD) counts as a burn
 * Clanker v5 path (docs/design/clanker-v5-migration.md section 6):
 *   ClankerV5Hook.CreatorTaxCredited   a paid slot's exact share of a swap's tax, in the quote (native ETH = 0x0)
 *                                      -> feeAccrual + feeCredit, feeBalance.accrued = settled
 *   ClankerV5Hook.BurnTaxCredited      the burn share, in the coin, for 0x…dEaD -> the same, on the burn slot
 *   ClankerV5FeeEscrow.Claimed         a recipient's whole escrow balance of a currency is paid out -> feeClaim;
 *                                      the dead address claiming the coin counts as a burn
 * Events of pools and recipients that are not ours are dropped. A claim is split over the recipient's balances of
 * the claiming locker's own path only (`claimParts`, the 2026-11-08 cross-booking fix).
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
      blockNumber: event.block.number,
      logIndex: event.log.logIndex,
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
    await recordClaim(context, 'bootr', event.args.recipient, event.args.currency, event.args.amount, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });
}

if (enabledSources().ClankerLpLocker) {
  /**
   * `collectRewards(token)` (anyone; the hook also collects on swaps while the MEV module is off): the position's
   * fees are taken, converted per slot preference and stored in the fee locker; `rewards0[i]` / `rewards1[i]` are
   * slot `i`'s share in currency0 / currency1 after conversion. Only coins in the `token` table are ours.
   */
  ponder.on('ClankerLpLocker:ClaimedRewards', async ({ event, context }) => {
    const t = await context.db.find(schema.token, { id: lc(event.args.token) });
    if (!t || sourceOf(t) !== 'clanker') return;
    const p = await context.db.find(schema.pool, { id: t.poolId });
    if (!p) return;
    await applyClankerCollection(
      context,
      t,
      { id: p.id, currency0: p.currency0, currency1: p.currency1 },
      { rewards0: event.args.rewards0, rewards1: event.args.rewards1 },
      { txHash: event.transaction.hash, logIndex: event.log.logIndex, blockNumber: event.block.number, timestamp: Number(event.block.timestamp) },
    );
  });
}

if (enabledSources().ClankerFeeLocker) {
  /** `claim(feeOwner, asset)` (anyone; always pays `feeOwner`) pays the whole (feeOwner, asset) balance. */
  ponder.on('ClankerFeeLocker:ClaimTokens', async ({ event, context }) => {
    await recordClaim(context, 'clanker', event.args.feeOwner, event.args.token, event.args.amountClaimed, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });

  ponder.on('ClankerFeeLocker:ClaimTokensPermissioned', async ({ event, context }) => {
    await recordClaim(context, 'clanker', event.args.feeOwner, event.args.token, event.args.amountClaimed, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });
}

if (enabledSources().ClankerV5Hook) {
  /**
   * The hook credits every v5 pool per swap (each slot's share in the quote, the burn in the coin on buys and sells
   * alike, the holder dividends' share); only pools registered by a v5 `AgentLaunched` are ours. One decoder for all
   * four (`decodeV5HookCredit`), shared with the launch-tx replay.
   */
  const onCredit = async (
    eventName: string,
    { event, context }: { event: { args: Record<string, unknown>; transaction: { hash: Hex }; log: { logIndex: number }; block: { number: bigint; timestamp: bigint } }; context: Ctx },
  ) => {
    const credit = decodeV5HookCredit(eventName, event.args);
    if (!credit) return;
    const t = await v5Coin(context, credit.poolId, event.transaction.hash);
    if (!t) return;
    await applyClankerV5HookCredit(context, t, credit, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      blockNumber: event.block.number,
      timestamp: Number(event.block.timestamp),
    });
  };
  ponder.on('ClankerV5Hook:CreatorTaxCredited', (x) => onCredit('CreatorTaxCredited', x));
  ponder.on('ClankerV5Hook:BurnTaxCredited', (x) => onCredit('BurnTaxCredited', x));
  ponder.on('ClankerV5Hook:DividendTaxCredited', (x) => onCredit('DividendTaxCredited', x));
  ponder.on('ClankerV5Hook:DividendTaxRedirected', (x) => onCredit('DividendTaxRedirected', x));

  /**
   * A slot admin moved a slot's recipient or admin (the creator's row and the extra rows only; the agent and platform
   * slots have the launcher as admin, which never calls this). The `feeSlot` row follows, so the hook's later credits
   * to the new recipient land on the same slot (and its own `feeBalance`); the old recipient keeps what it was credited.
   */
  const onSlotUpdate = async (
    eventName: string,
    { event, context }: { event: { args: Record<string, unknown>; transaction: { hash: Hex }; block: { number: bigint; timestamp: bigint }; log: { logIndex: number } }; context: Ctx },
  ) => {
    const u = decodeV5SlotUpdate(eventName, event.args);
    if (!u) return;
    const p = await context.db.find(schema.pool, { id: u.poolId });
    if (!p) return;
    const t = await context.db.find(schema.token, { id: p.token });
    if (!t || sourceOf(t) !== 'clanker-v5') return;
    const row = await context.db.find(schema.feeSlot, { id: `${t.id}-${u.slot}` });
    if (!row) {
      console.warn(`[indexer] ${eventName} for ${t.id} slot ${u.slot}: no such fee slot; ignored`);
      return;
    }
    const { patch, stale } = slotUpdatePatch(row, u);
    if (stale) console.warn(`[indexer] ${eventName} for ${t.id} slot ${u.slot}: the row held another ${u.field} than ${u.from}; taking ${u.to}`);
    await context.db.update(schema.feeSlot, { id: row.id }).set(patch);
    if (u.field === 'recipient') await context.db.insert(schema.feeRecipient).values({ id: u.to, firstToken: t.id }).onConflictDoNothing();
    await context.db.insert(schema.feeSlotUpdate).values({
      id: `${event.transaction.hash}-${event.log.logIndex}`,
      token: t.id,
      slot: u.slot,
      field: u.field,
      from: u.from,
      to: u.to,
      timestamp: Number(event.block.timestamp),
      blockNumber: event.block.number,
      txHash: event.transaction.hash,
    });
  };
  ponder.on('ClankerV5Hook:FeeSlotRecipientUpdated', (x) => onSlotUpdate('FeeSlotRecipientUpdated', x));
  ponder.on('ClankerV5Hook:FeeSlotAdminUpdated', (x) => onSlotUpdate('FeeSlotAdminUpdated', x));
}

/** The v5 coin of a hook event's pool, or null (not ours, another path, or the launch tx the launch handler replays). */
async function v5Coin(context: Ctx, poolId: Hex, txHash: Hex): Promise<TokenRow | null> {
  const p = await context.db.find(schema.pool, { id: lc(poolId) });
  if (!p) return null;
  const t = await context.db.find(schema.token, { id: p.token });
  if (!t || sourceOf(t) !== 'clanker-v5' || t.launchTx === txHash) return null;
  return t;
}

if (enabledSources().ClankerV5FeeEscrow) {
  /**
   * `claimFor(recipient, currency)` (anyone) / `claimTo(currency, destination)` (the owner) pay the recipient's whole
   * balance of `currency` across every v5 pool. The dead address claiming a coin finalises that coin's burn.
   */
  ponder.on('ClankerV5FeeEscrow:Claimed', async ({ event, context }) => {
    await recordClaim(context, 'clanker-v5', event.args.recipient, event.args.currency, event.args.amount, {
      txHash: event.transaction.hash,
      logIndex: event.log.logIndex,
      ts: Number(event.block.timestamp),
      blockNumber: event.block.number,
    });
  });
}

/**
 * A locker pays a recipient's whole balance of `asset` (RWAGMI: settled WETH across its pools; Clanker v4: the fee
 * locker's stored balance across its coins; Clanker v5: the escrow's balance across every v5 pool). `source` is the
 * claiming locker's launch path: only the recipient's balances of coins from that path are split (`claimParts`, by
 * `settled - claimed`), one feeClaim per coin. A burn slot claiming its coin (the dead address) is also a burn.
 */
async function recordClaim(
  context: Ctx,
  source: LaunchSource,
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
  const coins = await context.db.sql
    .select({ id: schema.token.id, source: schema.token.source })
    .from(schema.token)
    .where(inArray(schema.token.id, [...new Set(rows.map((r) => r.token))]));
  const sourceOfCoin = new Map(coins.map((c) => [c.id as string, parseLaunchSource(c.source)]));
  const parts = claimParts(rows, (token) => sourceOfCoin.get(token) ?? null, source, amount);
  const ethUsd = await getEthUsd(context, meta.blockNumber);
  for (const { row, part } of parts) {
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
      blockNumber: meta.blockNumber,
      logIndex: meta.logIndex,
      txHash: meta.txHash,
    });
    await context.db.update(schema.feeBalance, { id: row.id }).set((r) => ({
      claimed: r.claimed + part,
      outstanding: r.outstanding - part,
      claimedUsd: usd(r.claimedUsd + amountUsd),
    }));
    await bumpSource(context, sourceOf(t), meta.ts, {
      feesClaimedUsd: amountUsd,
      ...(row.recipientKind === 'platform' ? { feesPlatformClaimedUsd: amountUsd } : {}),
    });
    if (row.recipientKind === 'agent') {
      const agent = await context.db.find(schema.agent, { id: row.recipient });
      if (agent) {
        await context.db
          .update(schema.agent, { id: agent.id })
          .set({ feesClaimedUsd: usd(agent.feesClaimedUsd + amountUsd) });
      }
    }
    if (isBurnClaim({ recipientKind: row.recipientKind, recipient: row.recipient, asset, token: row.token })) {
      await recordBurn(context, t, row.recipient, part, amountUsd, meta);
    }
  }
}

/** A coin leaving circulation: `burn` row, `token.burnedTotal`, and the BOOT burn stats when it is the platform coin. */
async function recordBurn(context: Ctx, t: TokenRow, burner: Address, amount: bigint, amountUsd: number, meta: { txHash: Hex; logIndex: number; ts: number }) {
  await context.db
    .insert(schema.burn)
    .values({
      id: `${meta.txHash}-${meta.logIndex}`,
      token: t.id,
      burner: lc(burner),
      amountToken: amount,
      amountWethSpent: 0n,
      amountUsd,
      timestamp: meta.ts,
      txHash: meta.txHash,
    })
    .onConflictDoNothing();
  await context.db.update(schema.token, { id: t.id }).set((r) => ({ burnedTotal: r.burnedTotal + amount }));
  const cfg = await getPlatformConfig(context);
  if (cfg.bootToken === t.id) {
    await bumpDaily(context, meta.ts, { bootBurnedToken: amount, bootBurnedUsd: amountUsd });
    await bumpPlatform(context, meta.ts, { bootBurnedTotal: amount });
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
