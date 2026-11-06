import { describe, expect, it } from 'vitest';
import type { Address } from 'viem';

import type { RecipientKind } from '../lib/fees';
import {
  chainOrder,
  claimThresholds,
  composeClaimedByKind,
  composeCreatorFees,
  distinctRecipients,
  logIndexOfId,
  splitWalletClaims,
  walletsHoldingSeveralKinds,
  type CreditWindow,
  type WalletClaim,
} from './wallet-slots';

const WETH = '0x4200000000000000000000000000000000000006' as Address;
const COIN = '0x00000000000000000000000000000000000000c0';
const WALLET = '0x00000000000000000000000000000000000000a1';
const OTHER = '0x00000000000000000000000000000000000000a2';
const E15 = 10n ** 15n;

const slotKinds = new Map<number, RecipientKind>([
  [1, 'creator'],
  [3, 'platform'],
]);
const claim = (timestamp: number, logIndex: number, amount: bigint, amountUsd: number): WalletClaim => ({ asset: WETH, timestamp, logIndex, amount, amountUsd });
const win = (window: number, slot: number, amount: bigint): CreditWindow => ({ asset: WETH, window, slot, amount });

describe('walletsHoldingSeveralKinds', () => {
  const base = { token: COIN };
  it('finds a wallet with creator and platform slots on one coin', () => {
    const found = walletsHoldingSeveralKinds([
      { ...base, recipient: '0xagent', slot: 0, recipientKind: 'agent' },
      { ...base, recipient: WALLET, slot: 1, recipientKind: 'creator' },
      { ...base, recipient: '0xdead', slot: 2, recipientKind: 'burn' },
      { ...base, recipient: WALLET, slot: 3, recipientKind: 'platform' },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]!.recipient).toBe(WALLET);
    expect([...found[0]!.slotKinds]).toEqual([
      [1, 'creator'],
      [3, 'platform'],
    ]);
  });

  it('leaves normal coins alone, also a wallet paid by one kind on two coins, two slots of one kind and the protocol slot', () => {
    expect(
      walletsHoldingSeveralKinds([
        { token: COIN, recipient: WALLET, slot: 1, recipientKind: 'creator' },
        { token: COIN, recipient: OTHER, slot: 3, recipientKind: 'platform' },
        { token: '0xother', recipient: OTHER, slot: 1, recipientKind: 'creator' },
        { token: '0xtwo', recipient: WALLET, slot: 1, recipientKind: 'creator' },
        { token: '0xtwo', recipient: WALLET, slot: 2, recipientKind: 'creator' },
        { token: '0xthree', recipient: WALLET, slot: 1, recipientKind: 'creator' },
        { token: '0xthree', recipient: WALLET, slot: 4, recipientKind: 'protocol' },
      ]),
    ).toEqual([]);
  });
});

describe('chain order', () => {
  it('orders by block, then by the log index inside the block', () => {
    expect(chainOrder(100, 5) < chainOrder(100, 6)).toBe(true);
    expect(chainOrder(100, 999) < chainOrder(101, 0)).toBe(true);
    expect(claimThresholds([claim(200, 1, 1n, 1), claim(100, 9, 1n, 1)])).toEqual([chainOrder(100, 9), chainOrder(200, 1)]);
  });

  it('reads the log index of both id shapes', () => {
    expect(logIndexOfId('0xabc-341-0xcoin')).toBe(341);
    expect(logIndexOfId('0xabc-52-3-0')).toBe(52);
  });
});

describe('splitWalletClaims', () => {
  it('tells two shares apart from the credits, each at the price of the claim that paid it', () => {
    // Two sweeps: 10 WETH at $2000, then 2 WETH at $3000. 1 WETH more came in after the last claim.
    const s = splitWalletClaims(
      slotKinds,
      [claim(100, 1, 10_000n * E15, 20_000), claim(200, 1, 2_000n * E15, 6000)],
      [win(0, 1, 6000n * E15), win(0, 3, 4000n * E15), win(1, 1, 1000n * E15), win(1, 3, 1000n * E15), win(2, 1, 500n * E15), win(2, 3, 500n * E15)],
    );
    expect(s.exact).toBe(true);
    expect(s.byKind.creator).toEqual({ amount: 7000n * E15, usd: 15_000 });
    expect(s.byKind.platform).toEqual({ amount: 5000n * E15, usd: 11_000 });
    expect(s.bookedUsd).toBe(26_000);
  });

  it('keeps wei exact: the shares add up to the claims, with no bps anywhere', () => {
    const s = splitWalletClaims(slotKinds, [claim(100, 1, 1234567n, 1)], [win(0, 1, 1000000n), win(0, 3, 234567n)]);
    expect(s.exact).toBe(true);
    expect(s.byKind.creator!.amount + s.byKind.platform!.amount).toBe(1234567n);
  });

  it('survives a claim the ledger placed on the wrong side of a sweep, as long as the running total lands on a credit', () => {
    // The real case on $BOOTR: a claim from the other locker booked a little to this coin, the next sweep evened it out.
    const s = splitWalletClaims(
      slotKinds,
      [claim(100, 1, 148n, 1), claim(200, 1, 426n, 3)],
      [win(0, 1, 259n), win(0, 3, 170n), win(1, 1, 83n), win(1, 3, 62n)],
    );
    expect(s.exact).toBe(true);
    expect(s.byKind.creator!.amount).toBe(342n);
    expect(s.byKind.platform!.amount).toBe(232n);
  });

  it('says so when the credits do not add up to the claims', () => {
    expect(splitWalletClaims(slotKinds, [claim(100, 1, 100n, 1)], [win(0, 1, 40n), win(0, 3, 40n)]).exact).toBe(false);
    expect(splitWalletClaims(slotKinds, [claim(100, 1, 100n, 1)], []).exact).toBe(false);
    expect(splitWalletClaims(slotKinds, [claim(100, 1, 100n, 1)], [win(0, 1, 70n), win(0, 3, 70n)]).exact).toBe(false);
  });

  it('says so when a credit went to a slot the wallet does not hold', () => {
    expect(splitWalletClaims(slotKinds, [claim(100, 1, 100n, 1)], [win(0, 1, 60n), win(0, 7, 40n)]).exact).toBe(false);
  });

  it('is exact with nothing claimed, and lists every kind held', () => {
    const s = splitWalletClaims(slotKinds, [], [win(0, 1, 60n), win(0, 3, 40n)]);
    expect(s.exact).toBe(true);
    expect(s.byKind).toEqual({ creator: { amount: 0n, usd: 0 }, platform: { amount: 0n, usd: 0 } });
  });

  it('checks each asset by itself', () => {
    const COINASSET = '0x00000000000000000000000000000000000000c0';
    const s = splitWalletClaims(
      slotKinds,
      [claim(100, 1, 100n, 10), { asset: COINASSET, timestamp: 100, logIndex: 2, amount: 50n, amountUsd: 5 }],
      [win(0, 1, 60n), win(0, 3, 40n), { asset: COINASSET, window: 0, slot: 3, amount: 50n }],
    );
    expect(s.exact).toBe(true);
    expect(s.byKind.creator).toEqual({ amount: 60n, usd: 6 });
    expect(s.byKind.platform).toEqual({ amount: 90n, usd: 9 });
  });
});

describe('composeCreatorFees', () => {
  const twoSlot = splitWalletClaims(slotKinds, [claim(100, 1, 10n * E15, 20)], [win(0, 1, 6n * E15), win(0, 3, 4n * E15)]);
  const input = {
    earned: new Map([
      ['0xnormal', { usd: 100, weth: 50n * E15 }],
      ['0xshared', { usd: 11, weth: 7n * E15 }],
    ]),
    claimed: new Map([
      ['0xnormal', { usd: 80, weth: 40n * E15 }],
      ['0xshared', { usd: 20, weth: 10n * E15 }],
    ]),
    earnedByKind: new Map([['0xshared', { creator: 11, platform: 9 }]]),
  };

  it('leaves a normal creator as booked', () => {
    const r = composeCreatorFees({ ...input, ids: ['0xnormal'], splits: new Map() });
    expect(r.coins.get('0xnormal')).toEqual({ earnedUsd: 100, claimedUsd: 80, earnedWeth: 50n * E15, claimedWeth: 40n * E15, otherShares: [] });
    expect(r.totals).toEqual({ earnedUsd: 100, claimedUsd: 80, earnedWeth: 50n * E15, claimedWeth: 40n * E15 });
  });

  it('counts only the creator share for a wallet holding two slots, never the $20 booked together', () => {
    const r = composeCreatorFees({ ...input, ids: ['0xshared'], splits: new Map([['0xshared', twoSlot]]) });
    expect(r.coins.get('0xshared')).toEqual({
      earnedUsd: 11,
      claimedUsd: 12,
      earnedWeth: 7n * E15,
      claimedWeth: 6n * E15,
      otherShares: [{ kind: 'platform', earnedUsd: 9, claimedUsd: 8 }],
    });
    expect(r.totals.claimedUsd).toBe(12);
  });

  it('leaves the figure out when the split is not exact, and adds up the coins it knows', () => {
    const open = splitWalletClaims(slotKinds, [claim(100, 1, 10n, 20)], [win(0, 1, 1n)]);
    const one = composeCreatorFees({ ...input, ids: ['0xshared'], splits: new Map([['0xshared', open]]) });
    expect(one.coins.get('0xshared')).toMatchObject({ claimedUsd: null, claimedWeth: null, otherShares: [{ kind: 'platform', claimedUsd: null }] });
    expect(one.totals.claimedUsd).toBeNull();
    expect(one.totals.claimedWeth).toBeNull();

    const both = composeCreatorFees({ ...input, ids: ['0xnormal', '0xshared'], splits: new Map([['0xshared', open]]) });
    expect(both.totals.claimedUsd).toBe(80);
    expect(both.totals.earnedUsd).toBe(111);
  });

  it('answers zeros for coins with no fee rows and no coins at all', () => {
    const r = composeCreatorFees({ ...input, ids: ['0xfresh'], splits: new Map() });
    expect(r.coins.get('0xfresh')).toMatchObject({ earnedUsd: 0, claimedUsd: 0 });
    expect(composeCreatorFees({ ...input, ids: [], splits: new Map() }).totals).toEqual({ earnedUsd: 0, claimedUsd: 0, earnedWeth: 0n, claimedWeth: 0n });
  });
});

describe('composeClaimedByKind', () => {
  const rows = [
    { kind: 'agent', recipient: '0xagent', usd: 5 },
    { kind: 'creator', recipient: WALLET, usd: 20 },
    { kind: 'burn', recipient: '0xdead', usd: 3 },
  ];

  it('is what the ledger booked on a normal coin', () => {
    const r = composeClaimedByKind([{ kind: 'creator', recipient: WALLET, usd: 20 }, { kind: 'platform', recipient: OTHER, usd: 7 }], []);
    expect(r.claimed).toEqual({ agent: 0, creator: 20, burn: 0, platform: 7 });
    expect(r.sharedWallets).toEqual([]);
  });

  it('moves the platform share out of the creator figure for a wallet holding both', () => {
    const split = splitWalletClaims(slotKinds, [claim(100, 1, 10n * E15, 20)], [win(0, 1, 6n * E15), win(0, 3, 4n * E15)]);
    const r = composeClaimedByKind(rows, [{ recipient: WALLET, split }]);
    expect(r.claimed).toEqual({ agent: 5, creator: 12, burn: 3, platform: 8 });
    expect(r.sharedWallets).toEqual([{ recipient: WALLET, kinds: ['creator', 'platform'], claimedUsd: 20, toldApart: true }]);
  });

  it('answers null for both kinds when they cannot be told apart, and keeps the sum it can state', () => {
    const split = splitWalletClaims(slotKinds, [claim(100, 1, 10n, 20)], [win(0, 1, 1n)]);
    const r = composeClaimedByKind(rows, [{ recipient: WALLET, split }]);
    expect(r.claimed).toEqual({ agent: 5, creator: null, burn: 3, platform: null });
    expect(r.sharedWallets[0]).toMatchObject({ claimedUsd: 20, toldApart: false });
  });
});

describe('distinctRecipients', () => {
  const r = (recipient: string, recipientKind: RecipientKind) => ({ recipient: recipient as Address, recipientKind });

  it('gives one wallet one row, however many slots it holds', () => {
    expect(distinctRecipients([r('0xA', 'agent'), r('0xB', 'creator'), r('0xD', 'burn'), r('0xb', 'platform')])).toEqual([
      r('0xA', 'agent'),
      { ...r('0xB', 'creator'), alsoKinds: ['platform'] },
      r('0xD', 'burn'),
    ]);
  });

  it('changes nothing when every slot has its own wallet', () => {
    const list = [r('0xA', 'agent'), r('0xB', 'creator'), r('0xC', 'platform')];
    expect(distinctRecipients(list)).toEqual(list);
  });
});
