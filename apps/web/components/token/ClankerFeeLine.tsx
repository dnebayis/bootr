'use client';

import Link from 'next/link';
import { units } from '@/lib/format';
import { clankerVersionOf } from '@/lib/launch-source';
import type { Token } from '@/lib/types';
import { CLANKER_FEE_SOURCES, useClankerFees } from '@/lib/use-clanker-fees';
import { Button } from '@/components/ui/Button';

/**
 * One line for the creator of a Clanker coin: the fees waiting for them (one balance across all their coins of that
 * Clanker version) and the claim, so they need not open their profile for it. v4 coins pay WETH from Clanker's fee
 * locker, v5 coins native ETH from Clanker's fee escrow. The parent decides who the creator is; the claim pays the
 * creator wallet whoever sends the call.
 */
export function ClankerFeeLine({ token }: { token: Token }) {
  const version = clankerVersionOf(token.source);
  const fees = useClankerFees({ owner: token.creator, enabled: version !== null, label: `Claim $${token.symbol} fees`, version: version ?? 4 });
  if (version === null) return null;
  const { asset, from } = CLANKER_FEE_SOURCES[version];
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-hairline px-4 py-2.5"
      data-testid="clanker-fee-line"
      data-claim-via={version === 5 ? 'fee-escrow' : 'fee-locker'}
      data-claim-target={fees.target ?? undefined}
    >
      <p className="text-caption text-mute">
        Your claimable fees:{' '}
        <span className="font-mono text-sm text-ink tabular" data-testid="clanker-fee-amount">
          {fees.reading ? '…' : fees.amount == null ? '—' : `${units(fees.amount, 18, 6)} ${asset}`}
        </span>
        <span className="hidden sm:inline">
          {' '}
          · all your Clanker {version === 5 ? 'v5 ' : ''}coins, from {from}.{' '}
          <Link href="/profile" className="text-link hover:underline">
            Profile
          </Link>
        </span>
      </p>
      <Button size="sm" variant="secondary" onClick={() => void fees.claim()} disabled={!fees.amount} loading={fees.pending}>
        Claim
      </Button>
    </div>
  );
}
