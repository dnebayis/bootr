'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { isAddress } from 'viem';
import { useConnection } from 'wagmi';
import { useCoinLinks } from '@/lib/coin-links';
import { creatorFeeNotes } from '@/lib/creator-fees';
import { explorer } from '@/lib/chains';
import { env } from '@/lib/env';
import { shortAddr, usd } from '@/lib/format';
import { useCreatorProfile } from '@/lib/indexer';
import { clockUtc } from '@/lib/leaderboards';
import type { CreatorCoin } from '@/lib/types';
import { Empty, Panel } from '@/components/ui/Panel';
import { StatusDot, Badge } from '@/components/ui/Badge';
import { CopyButton } from '@/components/ui/CopyButton';
import { StatRow, StatTile } from '@/components/ui/StatTile';
import { Button } from '@/components/ui/Button';
import { ArrowUpRightIcon } from '@/components/ui/Icons';
import { XLinkedBadge } from '@/components/token/XLinkedBadge';
import { CoinLabel, Rows } from './ProfileView';

function CoinLinks({ coin }: { coin: CreatorCoin }) {
  const links = useCoinLinks(coin.metadata);
  const list = [
    { label: 'Website', href: links.data?.website },
    { label: 'X', href: links.data?.x },
    { label: 'Telegram', href: links.data?.telegram },
    { label: 'Discord', href: links.data?.discord },
  ].filter((l): l is { label: string; href: string } => !!l.href);
  if (list.length === 0) return null;
  return (
    <>
      {list.map((l) => (
        <a key={l.label} href={l.href} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-0.5 text-caption text-mute hover:text-link">
          {l.label} <ArrowUpRightIcon size={12} />
        </a>
      ))}
    </>
  );
}

function CoinRow({ coin }: { coin: CreatorCoin }) {
  return (
    <li className="flex flex-col gap-2 px-5 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="flex min-w-0 flex-col gap-1.5">
        <Link href={`/token/${coin.id}`} className="hover:text-link">
          <CoinLabel token={coin} />
        </Link>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pl-[38px]">
          {coin.kernel && coin.agent ? (
            <Link href={`/agent/${coin.kernel}`} className="inline-flex items-center gap-1.5 text-caption text-body hover:text-link">
              <StatusDot status={coin.agent.status} />
              {coin.xHandle ? `@${coin.xHandle}` : 'Agent'}
            </Link>
          ) : (
            <span className="text-caption text-mute">No agent</span>
          )}
          <XLinkedBadge agentId={coin.agentId} />
          {coin.source === 'clanker' ? <Badge>Clanker</Badge> : null}
          <CoinLinks coin={coin} />
        </div>
      </div>
      <dl className="flex shrink-0 items-baseline gap-5 pl-[38px] font-mono tabular sm:pl-0 sm:text-right">
        <div>
          <dt className="text-micro text-mute">Market cap</dt>
          <dd className="text-sm text-ink">{usd(coin.marketCapUsd)}</dd>
        </div>
        <div>
          <dt className="text-micro text-mute">Fees earned</dt>
          <dd className="text-sm text-ink">{usd(coin.creatorFees.earnedUsd, { compact: false })}</dd>
        </div>
      </dl>
    </li>
  );
}

/** Anyone's public creator page, no wallet needed: figures from the indexer only, no chain read, nothing to sign. */
export function PublicProfileView({ address }: { address: string }) {
  const valid = isAddress(address, { strict: false });
  const q = useCreatorProfile(valid ? address : undefined);
  const { address: wallet } = useConnection();
  const own = !!wallet && wallet.toLowerCase() === address.toLowerCase();

  if (!valid) {
    return <Empty action={<Link href="/" className="text-link hover:underline">Back to tokens</Link>}>That is not a wallet address.</Empty>;
  }
  const p = q.data;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-display-lg font-semibold text-ink">Creator</h1>
        <div className="flex flex-wrap items-center gap-2 font-mono text-caption text-mute">
          <a href={explorer.address(address)} target="_blank" rel="noopener noreferrer" className="hover:text-link" title={address}>
            {shortAddr(address, 10, 8)}
          </a>
          <CopyButton value={address} label="Copy creator address" />
          {own ? <Link href="/profile" className="text-link hover:underline">Your profile</Link> : null}
          {env.useMock ? <span>· mock data</span> : null}
        </div>
      </div>

      {q.isError ? (
        <Empty action={<Button onClick={() => void q.refetch()}>Retry</Button>}>The indexer did not respond.</Empty>
      ) : (
        <>
          <StatRow className="grid-cols-2 lg:grid-cols-4">
            <StatTile label="Coins launched" value={p ? p.totals.coins : '—'} />
            <StatTile label="Agents" value={p ? p.totals.agents : '—'} />
            <StatTile label="Fees earned" value={p ? usd(p.totals.earnedUsd, { compact: false }) : '—'} />
            <StatTile label="Fees claimed" value={p ? usd(p.totals.claimedUsd, { compact: false }) : '—'} />
          </StatRow>

          <Panel title="Coins launched" bodyClassName="p-0">
            {q.isPending ? (
              <Rows />
            ) : !p?.coins.length ? (
              <Empty>No coin has been launched from this address.</Empty>
            ) : (
              <ul className="divide-y divide-hairline">
                {p.coins.map((c) => (
                  <CoinRow key={c.id} coin={c} />
                ))}
              </ul>
            )}
            {p ? (
              <p className="flex flex-wrap gap-x-3 gap-y-1 border-t border-hairline px-5 py-2.5 font-mono text-micro text-mute">
                <span>Read {clockUtc(p.readAt)}</span>
                <span>Fees are the creator’s share as booked in dollars; coins launched through Clanker count once their fees are collected.</span>
              </p>
            ) : null}
            {p && creatorFeeNotes(p).length > 0 ? (
              <ul className="flex flex-col gap-1 border-t border-hairline px-5 py-2.5 text-caption text-mute" data-testid="creator-fee-notes">
                {creatorFeeNotes(p).map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            ) : null}
          </Panel>
        </>
      )}
    </div>
  );
}

export function PublicProfileRoute() {
  const params = useParams<{ address: string }>();
  const address = decodeURIComponent(params?.address ?? '');
  return <PublicProfileView key={address.toLowerCase()} address={address} />;
}
