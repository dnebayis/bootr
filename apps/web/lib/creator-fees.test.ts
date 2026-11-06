import { describe, expect, it } from 'vitest';

import { creatorFeeNotes, otherSharesInBalance } from './creator-fees';
import type { CreatorCoin, CreatorProfile } from './types';

const E18 = 10n ** 18n;
const coin = (over: Partial<CreatorCoin['creatorFees']>, symbol = 'BOOTR') =>
  ({ symbol, creatorFees: { earnedUsd: 0, claimedUsd: 0, ...over } }) as CreatorCoin;
const profile = (coins: CreatorCoin[], totals: Partial<CreatorProfile['totals']>): CreatorProfile =>
  ({ address: '0x1', readAt: 0, indexedAt: 0, totals: { coins: coins.length, agents: 0, earnedUsd: 0, claimedUsd: 0, ...totals }, coins }) as CreatorProfile;

describe('creatorFeeNotes', () => {
  it('says nothing for a normal creator', () => {
    expect(creatorFeeNotes(profile([coin({ earnedUsd: 100, claimedUsd: 80, otherShares: [] })], { earnedUsd: 100, claimedUsd: 80 }))).toEqual([]);
  });

  it('copes with an older indexer that has no share or WETH fields', () => {
    expect(creatorFeeNotes(profile([coin({ earnedUsd: 100, claimedUsd: 120 })], { earnedUsd: 100, claimedUsd: 120 }))).toEqual([]);
  });

  it('names the other share of a wallet holding two slots, with its own figures', () => {
    const [note] = creatorFeeNotes(
      profile([coin({ earnedUsd: 7650.81, claimedUsd: 7651, otherShares: [{ kind: 'platform', earnedUsd: 5597.85, claimedUsd: 5670.5 }] })], { earnedUsd: 7650.81, claimedUsd: 7651 }),
    );
    expect(note).toContain('also holds the platform share of $BOOTR');
    expect(note).toContain('count the creator share only');
    expect(note).toContain('$5,597.85 earned, $5,670.50 claimed');
  });

  it('says when the shares could not be told apart, with no figure for them', () => {
    const [note] = creatorFeeNotes(
      profile([coin({ earnedUsd: 10, claimedUsd: null, otherShares: [{ kind: 'platform', earnedUsd: 7, claimedUsd: null }] })], { earnedUsd: 10, claimedUsd: null }),
    );
    expect(note).toContain('could not be told apart');
    expect(note?.replace('$BOOTR', '')).not.toContain('$');
  });

  it('explains claimed above earned with the WETH, for any creator', () => {
    const notes = creatorFeeNotes(
      profile([coin({ earnedUsd: 100, claimedUsd: 101, otherShares: [] })], {
        earnedUsd: 100,
        claimedUsd: 101,
        earnedWeth: String(325n * E18 / 100n),
        claimedWeth: String(3249n * E18 / 1000n),
      }),
    );
    expect(notes).toEqual(['Fees claimed reads above Fees earned because each is in dollars at the ETH price of its own moment. In WETH: 3.25 earned, 3.249 claimed.']);
  });

  it('does not blame the price when more WETH really was claimed', () => {
    expect(
      creatorFeeNotes(profile([coin({ otherShares: [] })], { earnedUsd: 100, claimedUsd: 200, earnedWeth: String(E18), claimedWeth: String(2n * E18) })),
    ).toEqual([]);
  });
});

describe('otherSharesInBalance', () => {
  const OWNER = '0xAAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa';
  const t = (over: { platformRecipient?: string; kernel?: string; burner?: string | null }) =>
    ({ symbol: 'BOOTR', kernel: '0xk', burner: null, ...over }) as Parameters<typeof otherSharesInBalance>[1][number];

  it('is silent when the wallet holds the creator share alone', () => {
    expect(otherSharesInBalance(OWNER, [t({ platformRecipient: '0xother' }), t({})])).toBeNull();
  });

  it('names the other shares, ignoring case', () => {
    expect(otherSharesInBalance(OWNER, [t({ platformRecipient: OWNER.toLowerCase() })])).toBe('This balance also holds the platform share of $BOOTR. One claim pays all of it.');
  });
});
