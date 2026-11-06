import { units, usd } from './format';
import type { CreatorProfile, Token } from './types';

const dollars = (v: number | null | undefined) => usd(v, { compact: false });
const weth = (raw: string) => units(BigInt(raw), 18, 4);

/**
 * The plain sentences a creator's public page owes its reader. A wallet holding another share of a coin (the platform's,
 * say) claims it together with the creator share, so the page says what its figures leave out; and when claimed reads
 * above earned only because of the ETH price, it says that and gives the WETH.
 */
export function creatorFeeNotes(p: CreatorProfile): string[] {
  const notes: string[] = [];
  for (const c of p.coins) {
    for (const s of c.creatorFees.otherShares ?? []) {
      const lead = `This wallet also holds the ${s.kind} share of $${c.symbol}, and one claim pays both shares at once.`;
      notes.push(
        s.claimedUsd === null || c.creatorFees.claimedUsd === null
          ? `${lead} For this coin they could not be told apart, so Fees claimed leaves it out.`
          : `${lead} The figures above count the creator share only. The ${s.kind} share on its own: ${dollars(s.earnedUsd)} earned, ${dollars(s.claimedUsd)} claimed.`,
      );
    }
  }
  const { claimedUsd, earnedUsd, claimedWeth, earnedWeth } = p.totals;
  if (claimedUsd != null && claimedUsd > earnedUsd && claimedWeth != null && earnedWeth != null && BigInt(claimedWeth) <= BigInt(earnedWeth)) {
    notes.push(`Fees claimed reads above Fees earned because each is in dollars at the ETH price of its own moment. In WETH: ${weth(earnedWeth)} earned, ${weth(claimedWeth)} claimed.`);
  }
  return notes;
}

const same = (a: string | null | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/**
 * For the wallet's claimable balance (one balance per wallet, whatever pays into it): the coins where it also holds a
 * share other than the creator's, so a panel titled for the creator can say that the balance holds more.
 */
export function otherSharesInBalance(owner: string, tokens: readonly Pick<Token, 'symbol' | 'kernel' | 'burner' | 'platformRecipient'>[]): string | null {
  const parts: string[] = [];
  for (const t of tokens) {
    if (same(t.platformRecipient, owner)) parts.push(`the platform share of $${t.symbol}`);
    if (same(t.kernel, owner)) parts.push(`the agent share of $${t.symbol}`);
    if (same(t.burner, owner)) parts.push(`the burn share of $${t.symbol}`);
  }
  if (parts.length === 0) return null;
  return `This balance also holds ${parts.join(', ')}. One claim pays all of it.`;
}
