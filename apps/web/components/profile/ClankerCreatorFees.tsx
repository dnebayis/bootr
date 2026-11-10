'use client';

import Link from 'next/link';
import type { Address } from 'viem';
import { otherSharesInBalance } from '@/lib/creator-fees';
import { feeModelOf, pctLabel, swapFeePct } from '@/lib/fee-split';
import { dayLabel, units } from '@/lib/format';
import type { Token } from '@/lib/types';
import { CLANKER_FEE_SOURCES, useClankerFees } from '@/lib/use-clanker-fees';
import { Button } from '@/components/ui/Button';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';

const th = 'px-5 py-2 text-left text-caption font-normal text-mute';
const td = 'px-5 py-2.5';

/** The fee column: what a trader pays and who adds what, in plain words. */
function feeCell(t: Token, version: 4 | 5): string {
  const fee = pctLabel(swapFeePct(feeModelOf(t)));
  return version === 5 ? `${fee} tax, Clanker’s share inside it` : `${fee} fee, plus 20% on top for Clanker`;
}

/**
 * The creator share of the connected wallet's Clanker coins of one version, with one claim for all of them. v4 (the
 * default): Clanker's LP locker turns every coin's fees into WETH and keeps the creator's part in Clanker's fee locker.
 * v5: the coin's tax credits the creator's part to Clanker's fee escrow on every trade, in ETH. Either way it is one
 * balance under the creator wallet, and one claim sends it all to that wallet. Renders nothing without such a coin.
 */
export function ClankerCreatorFees({ owner, tokens, version = 4 }: { owner: Address; tokens: Token[]; version?: 4 | 5 }) {
  const fees = useClankerFees({ owner, enabled: tokens.length > 0, label: version === 5 ? 'Claim Clanker v5 fees' : 'Claim Clanker fees', version });
  if (tokens.length === 0) return null;
  const alsoHolds = otherSharesInBalance(owner, tokens);
  const { asset, from } = CLANKER_FEE_SOURCES[version];
  const coins = version === 5 ? 'Clanker v5 coins' : 'Clanker coins';
  const testId = version === 5 ? 'clanker-v5-creator-fees' : 'clanker-creator-fees';

  return (
    <Panel title={`Creator fees, ${coins}`} bodyClassName="p-0" action={<span className="text-caption text-mute">Paid in {asset} from {from}.</span>}>
      <div data-testid={testId} data-claim-via={version === 5 ? 'fee-escrow' : 'fee-locker'} data-claim-target={fees.target ?? undefined}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-hairline px-5 py-3">
          <div>
            <div className="text-caption text-mute">Claimable {asset}, all your {coins}</div>
            <div className="font-mono text-base text-ink tabular" data-testid={version === 5 ? 'clanker-v5-creator-eth' : 'clanker-creator-weth'}>
              {fees.reading ? <Skeleton className="h-5 w-24" /> : fees.amount == null ? '—' : `${units(fees.amount, 18, 6)} ${asset}`}
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
                  <td className={`${td} text-right font-mono text-caption text-body`}>{feeCell(t, version)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="border-t border-hairline px-5 py-2.5 text-caption text-mute">
          {version === 5
            ? 'Your share of the trading tax of your Clanker v5 coins arrives as ETH in Clanker’s fee escrow on every trade. Claim sends it to your wallet.'
            : 'Your share of the trading fees of your Clanker coins arrives as WETH in Clanker’s fee locker. Claim sends it to your wallet.'}
          {alsoHolds ? ` ${alsoHolds}` : null}
        </p>
      </div>
    </Panel>
  );
}
