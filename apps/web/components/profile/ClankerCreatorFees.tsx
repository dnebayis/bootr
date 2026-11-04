'use client';

import Link from 'next/link';
import type { Address } from 'viem';
import { feeModelOf, pctLabel, swapFeePct } from '@/lib/fee-split';
import { dayLabel, units } from '@/lib/format';
import type { Token } from '@/lib/types';
import { useClankerFees } from '@/lib/use-clanker-fees';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';

const th = 'px-5 py-2 text-left text-caption font-normal text-mute';
const td = 'px-5 py-2.5';

/**
 * The creator share of the connected wallet's Clanker coins. Clanker's LP locker turns every coin's fees into WETH
 * and keeps the creator's part in Clanker's fee locker under the creator wallet, one balance for all their Clanker
 * coins; one claim sends it all to that wallet. Renders nothing when the wallet has no Clanker coin.
 */
export function ClankerCreatorFees({ owner, tokens }: { owner: Address; tokens: Token[] }) {
  const fees = useClankerFees({ owner, enabled: tokens.length > 0, label: 'Claim Clanker fees' });
  if (tokens.length === 0) return null;

  return (
    <Panel title="Creator fees, Clanker coins" bodyClassName="p-0" action={<span className="text-caption text-mute">Paid in WETH from Clanker&rsquo;s fee locker.</span>}>
      <div data-testid="clanker-creator-fees">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
          <div>
            <div className="text-caption text-mute">Claimable WETH, all your Clanker coins</div>
            <div className="font-mono text-base text-ink tabular" data-testid="clanker-creator-weth">
              {fees.reading ? <Skeleton className="h-5 w-24" /> : fees.amount == null ? '—' : `${units(fees.amount, 18, 6)} WETH`}
            </div>
          </div>
          <Button size="sm" variant="secondary" onClick={() => void fees.claim()} disabled={!fees.amount} loading={fees.pending}>
            Claim
          </Button>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] border-collapse">
            <thead className="bg-canvas-soft">
              <tr>
                <th scope="col" className={th}>Coin</th>
                <th scope="col" className={th}>Launched</th>
                <th scope="col" className={`${th} text-right`}>Fee</th>
              </tr>
            </thead>
            <tbody>
              {tokens.map((t) => (
                <tr key={t.id} className="border-t border-hairline">
                  <td className={td}>
                    <Link href={`/token/${t.id}`} className="flex items-center gap-2.5 hover:text-link">
                      <TokenImage src={t.image} symbol={t.symbol} size={28} className="rounded-xs" />
                      <span className="text-sm text-ink">{t.name}</span>
                      <span className="font-mono text-caption text-mute">${t.symbol}</span>
                    </Link>
                  </td>
                  <td className={`${td} font-mono text-caption text-mute`}>{dayLabel(t.launchedAt)}</td>
                  <td className={`${td} text-right font-mono text-caption text-body`}>{pctLabel(swapFeePct(feeModelOf(t)))} fee, plus 20% on top for Clanker</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-hairline px-5 py-2.5 text-caption text-mute">
          Your share of the trading fees of your Clanker coins arrives as WETH in Clanker&rsquo;s fee locker. Claim sends it to your wallet.
        </p>
      </div>
    </Panel>
  );
}
