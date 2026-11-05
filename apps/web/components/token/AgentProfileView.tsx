'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { isAddress } from 'viem';
import { explorer } from '@/lib/chains';
import { env } from '@/lib/env';
import { shortAddr } from '@/lib/format';
import { useNow } from '@/lib/hooks';
import { useAgent, useToken } from '@/lib/indexer';
import { AgentPortrait } from '@/components/art/AgentPortrait';
import { Button } from '@/components/ui/Button';
import { CopyButton } from '@/components/ui/CopyButton';
import { Empty } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';
import { ActivityTape } from './ActivityTape';
import { AgentPanel } from './AgentPanel';
import { AgentStatusLine } from './AgentStatusLine';
import { XLinkedBadge } from './XLinkedBadge';

function Missing({ reason }: { reason: string }) {
  return <Empty action={<Link href="/" className="text-link hover:underline">Back to tokens</Link>}>{reason}</Empty>;
}

export function AgentProfileSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true">
      <Skeleton className="h-16 max-w-md" />
      <Skeleton className="h-72 rounded-md" />
    </div>
  );
}

/** One agent's public page: its coin, its X account and what it has done in public. No wallet needed. */
export function AgentProfileView({ kernel }: { kernel: string }) {
  const valid = isAddress(kernel, { strict: false });
  const agent = useAgent(valid ? kernel : undefined);
  const coin = useToken(agent.data?.token);
  const now = useNow();

  if (!valid) return <Missing reason="That is not an agent address." />;
  if (agent.isError || coin.isError) {
    return (
      <Empty
        action={
          <Button
            onClick={() => {
              void agent.refetch();
              void coin.refetch();
            }}
          >
            Retry
          </Button>
        }
      >
        The indexer did not respond.
      </Empty>
    );
  }
  if (agent.isPending || (agent.data && coin.isPending)) return <AgentProfileSkeleton />;
  const token = coin.data;
  if (!agent.data || !token) return <Missing reason="No Bootr agent has this address, or the indexer has not seen it yet." />;

  return (
    <div className="flex flex-col gap-6">
      <header className="flex min-w-0 items-center gap-4">
        <AgentPortrait address={token.kernel} status={agent.data.status} size={56} />
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-display-md font-semibold text-ink">{token.name} agent</h1>
            <XLinkedBadge agentId={token.agentId} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-caption text-mute">
            <span className="inline-flex items-center gap-1">
              <a href={explorer.address(token.kernel)} target="_blank" rel="noopener noreferrer" className="hover:text-link" title={token.kernel}>
                {shortAddr(token.kernel, 8, 6)}
              </a>
              <CopyButton value={token.kernel} label="Copy agent address" />
            </span>
            <Link href={`/token/${token.id}`} className="inline-flex items-center gap-1.5 hover:text-link">
              <TokenImage src={token.image} symbol={token.symbol} size={16} className="rounded-xs" />${token.symbol}
            </Link>
            <span>
              by{' '}
              <Link href={`/u/${token.creator}`} className="hover:text-link" title={token.creator}>
                {shortAddr(token.creator, 6, 4)}
              </Link>
            </span>
            {token.xHandle ? (
              <a href={`https://x.com/${token.xHandle}`} target="_blank" rel="noopener noreferrer nofollow" className="hover:text-link">
                @{token.xHandle}
              </a>
            ) : null}
            {env.useMock ? <span>· mock data</span> : null}
          </div>
          <AgentStatusLine token={token} agent={agent.data} now={now} className="mt-1.5" />
        </div>
      </header>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
        <ActivityTape token={token} now={now} />
        <AgentPanel token={token} now={now} />
      </div>
    </div>
  );
}

export function AgentProfileRoute() {
  const params = useParams<{ kernel: string }>();
  const kernel = decodeURIComponent(params?.kernel ?? '');
  return <AgentProfileView key={kernel.toLowerCase()} kernel={kernel} />;
}
