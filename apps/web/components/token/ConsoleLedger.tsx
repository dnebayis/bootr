'use client';

import Link from 'next/link';
import { useAgentLedger } from '@/lib/indexer';
import { ledgerHref } from '@/lib/ledger-view';
import type { AgentConfig, Token } from '@/lib/types';
import { Skeleton } from '@/components/ui/Skeleton';
import { LedgerDays } from './LedgerDays';

/**
 * The creator console's view of the public ledger (Fuel section): the same seven days of totals the coin's ledger page
 * shows, with today's use of the creator's daily caps beside them, and the way to every row. The caps come from the
 * agent's config the console already reads; nothing private is fetched for it.
 */
export function ConsoleLedger({ token, config }: { token: Token; config: Pick<AgentConfig, 'services' | 'bounties'> | null }) {
  const ledger = useAgentLedger(token.kernel);
  const first = ledger.data?.pages[0];
  return (
    <div className="rounded-md border border-hairline p-4" data-testid="console-ledger">
      <div className="mb-1.5 flex items-baseline justify-between gap-3">
        <h3 className="text-caption font-medium text-ink">Money, day by day</h3>
        <Link href={ledgerHref(token.id)} className="text-caption text-link underline-offset-4 hover:underline">
          Every movement
        </Link>
      </div>
      {ledger.isPending ? (
        <Skeleton className="h-24" />
      ) : first?.days ? (
        <LedgerDays days={first.days} complete={first.daysComplete !== false} {...(config ? { caps: { services: config.services, bounties: config.bounties } } : {})} />
      ) : (
        <p className="text-caption text-mute">The totals are unavailable right now.</p>
      )}
    </div>
  );
}
