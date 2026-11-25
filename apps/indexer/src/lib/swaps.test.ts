import { describe, expect, it } from 'vitest';

import bootrPrepaidSell from '../../test/fixtures/bootr-prepaid-sell.json';
import cbbLateTransfer from '../../test/fixtures/cbb-v5-sell-late-transfer.json';
import owlOtherPool from '../../test/fixtures/owl-sell-other-pool.json';
import { dueSwaps, isFeeConversionSwap, poolManagerSwaps, syncCandidates, touchesPoolManager, type ReceiptLog } from './swaps';

const POOL_MANAGER = '0x498581fF718922c3f8e6A244956aF099B2652b2b';
const LOCKER = '0xffA37784D619F228D8B379d287a4D7282e500762';
const V5_HOOK = '0x5E320eA6278107968C119942E57d876c5F922AcC';
const BOOTR = '0xb1c3a6ac90e324c4072ad4b2a71c5d9382f9565c';
const CBB_POOL = '0xb86c708db7aad64b3543844a898525f3be432550659aa56134dd2d87f2dfcbc3';
const logsOf = (f: { logs: unknown[] }) => f.logs as ReceiptLog[];
const stack = { poolManager: POOL_MANAGER, clankerLocker: LOCKER, v5Hook: V5_HOOK };

describe('dueSwaps', () => {
  const swaps = [{ logIndex: 22 }, { logIndex: 35 }, { logIndex: 48 }];
  const points = [5, 11, 24, 37, 47];

  it('before a sync point: the pending swaps below it, in log order', () => {
    expect(dueSwaps(swaps, points, 5, -1, 'before')).toEqual([]);
    expect(dueSwaps(swaps, points, 24, -1, 'before')).toEqual([{ logIndex: 22 }]);
    expect(dueSwaps(swaps, points, 47, -1, 'before')).toEqual([{ logIndex: 22 }, { logIndex: 35 }]);
    expect(dueSwaps(swaps, points, 47, 22, 'before')).toEqual([{ logIndex: 35 }]);
    expect(dueSwaps(swaps, points, 47, 35, 'before')).toEqual([]);
  });

  it('after a sync point: nothing while a later one exists, the rest at the last one', () => {
    expect(dueSwaps(swaps, points, 37, 35, 'after')).toEqual([]);
    expect(dueSwaps(swaps, points, 47, 35, 'after')).toEqual([{ logIndex: 48 }]);
    expect(dueSwaps(swaps, points, 47, 48, 'after')).toEqual([]);
  });

  it('a transaction with one sync point gets every swap at it, before or after', () => {
    expect(dueSwaps(swaps, [30], 30, -1, 'before')).toEqual([{ logIndex: 22 }]);
    expect(dueSwaps(swaps, [30], 30, 22, 'after')).toEqual([{ logIndex: 35 }, { logIndex: 48 }]);
  });
});

describe('receipts from Base mainnet', () => {
  it('decodes every PoolManager swap of a receipt, Bootr’s pool or not', () => {
    const swaps = poolManagerSwaps(logsOf(owlOtherPool), POOL_MANAGER);
    expect(swaps).toHaveLength(2);
    expect(swaps[0]).toMatchObject({ logIndex: 48, poolId: '0x5255c461070845f7d09f0c4878fbdc8d575e15a2dbc2cca986fa741e237c31b2', fee: 0 });
    expect(swaps[0]!.amount1 < 0n).toBe(true); // the coin (currency1) is paid in: a sell
    expect(swaps[1]!.poolId).not.toBe(swaps[0]!.poolId);
    expect(poolManagerSwaps(logsOf(owlOtherPool), LOCKER)).toEqual([]);
  });

  it('finds the sync points of a Clanker v4 sell: the coin’s transfers at the PoolManager and the collection', () => {
    const c = syncCandidates(logsOf(bootrPrepaidSell), stack);
    expect(c.filter((x) => x.kind === 'transfer' && x.token === BOOTR).map((x) => x.logIndex)).toEqual([5, 11, 24, 37]);
    expect(c.filter((x) => x.kind === 'collection')).toEqual([{ logIndex: 47, kind: 'collection', token: BOOTR }]);
    // A transfer between two wallets is not one, whatever the token.
    expect(c.some((x) => x.logIndex === 26)).toBe(false);
  });

  it('finds the credits of a Clanker v5 swap, and none of either Clanker kind when that source is off', () => {
    const c = syncCandidates(logsOf(cbbLateTransfer), stack);
    const credits = c.filter((x) => x.kind === 'v5credit');
    expect(credits.length).toBeGreaterThan(0);
    expect(credits.every((x) => x.kind === 'v5credit' && x.poolId === CBB_POOL && x.logIndex > 17 && x.logIndex < 28)).toBe(true);
    expect(c.filter((x) => x.kind === 'transfer').map((x) => x.logIndex)).toEqual([28]);
    const off = { poolManager: POOL_MANAGER, clankerLocker: null, v5Hook: null };
    expect(syncCandidates(logsOf(cbbLateTransfer), off).map((x) => x.kind)).toEqual(['transfer']);
    expect(syncCandidates(logsOf(bootrPrepaidSell), off).every((x) => x.kind === 'transfer')).toBe(true);
  });
});

describe('small predicates', () => {
  it('a transfer touches the PoolManager on either side, in any case', () => {
    expect(touchesPoolManager(POOL_MANAGER.toLowerCase(), LOCKER, POOL_MANAGER)).toBe(true);
    expect(touchesPoolManager(LOCKER, POOL_MANAGER, POOL_MANAGER.toLowerCase())).toBe(true);
    expect(touchesPoolManager(LOCKER, V5_HOOK, POOL_MANAGER)).toBe(false);
  });

  it('the fee conversion locker is known by its address', () => {
    expect(isFeeConversionSwap(LOCKER.toLowerCase(), LOCKER)).toBe(true);
    expect(isFeeConversionSwap(V5_HOOK, LOCKER)).toBe(false);
    expect(isFeeConversionSwap(LOCKER, null)).toBe(false);
  });
});
