'use client';

import Link from 'next/link';
import { units } from '@/lib/format';
import type { Token } from '@/lib/types';
import { useClankerFees } from '@/lib/use-clanker-fees';
import { Button } from '@/components/ui/Button';

/**
 * One line for the creator of a Clanker coin: the WETH waiting for them in Clanker's fee locker (one balance across
 * all their Clanker coins) and the claim, so they need not open their profile for it. The parent decides who the
 * creator is; the fee owner is the creator wallet and the claim pays it whoever sends the call.
 */
export function ClankerFeeLine({ token }: { token: Token }) {
  const fees = useClankerFees({ owner: token.creator, enabled: token.source === 'clanker', label: `Claim $${token.symbol} fees` });
  if (token.source !== 'clanker') return null;
  return (
    <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-md border border-hairline px-4 py-2.5" data-testid="clanker-fee-line">
      <p className="text-caption text-mute">
        Your claimable fees:{' '}
        <span className="font-mono text-sm text-ink tabular" data-testid="clanker-fee-amount">
          {fees.reading ? '…' : fees.amount == null ? '—' : `${units(fees.amount, 18, 6)} WETH`}
        </span>
        <span className="hidden sm:inline">
          {' '}
          · all your Clanker coins, from Clanker&rsquo;s fee locker.{' '}
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
