'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { isAddress } from 'viem';
import { useConnection } from 'wagmi';
import { env } from '@/lib/env';
import { useNow } from '@/lib/hooks';
import { useAgentConfig, useToken } from '@/lib/indexer';
import { parseSection, type ConsoleSection } from '@/lib/console-sections';
import { Panel } from '@/components/ui/Panel';
import { Skeleton } from '@/components/ui/Skeleton';
import { TokenImage } from '@/components/ui/TokenImage';
import { ConnectButton } from '@/components/shell/ConnectButton';
import { AgentPortrait } from '@/components/art/AgentPortrait';
import { AgentStatusLine } from './AgentStatusLine';
import { CreatorConsole, editedLabel } from './CreatorConsole';

export function ConsoleSkeleton() {
  return (
    <div className="flex flex-col gap-6" aria-busy="true" aria-label="Loading console">
      <div className="flex items-center gap-4">
        <Skeleton className="size-12" />
        <div className="flex flex-col gap-2">
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-64" />
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[11.25rem_minmax(0,1fr)]">
        <Skeleton className="h-9 lg:h-56" />
        <Skeleton className="h-96 w-full" />
      </div>
    </div>
  );
}

/** The section the URL asks for, kept in the URL as the creator moves (replaceState: no navigation, no scroll). */
function useSection(): [ConsoleSection, (s: ConsoleSection) => void] {
  const params = useSearchParams();
  const [section, setSection] = useState<ConsoleSection>(() => parseSection(params.get('section')) ?? 'mind');
  const change = (s: ConsoleSection) => {
    setSection(s);
    const url = new URL(window.location.href);
    url.searchParams.set('section', s);
    window.history.replaceState(window.history.state, '', url);
  };
  return [section, change];
}

/**
 * `/token/:address/console`: the creator's console on its own page, with the whole content width (CreatorConsole.tsx).
 * Header: the agent's portrait, the coin's name and symbol, its status line, the way back to the coin page and the
 * config revision. Creator only: anyone else, or no wallet, sees the connect state in place of the console. In mock
 * mode everyone is the creator, as on the coin page.
 */
export function ConsolePage({ address }: { address: string }) {
  const valid = isAddress(address, { strict: false });
  const { data: token, isPending, isError } = useToken(valid ? address : undefined);
  const now = useNow();
  const { address: wallet } = useConnection();
  const isCreator = env.useMock || (!!wallet && !!token?.creator && wallet.toLowerCase() === token.creator.toLowerCase());
  const [section, setSection] = useSection();
  // The revision for the header; the console itself reads the same query.
  const config = useAgentConfig(token?.kernel, !!token && isCreator);
  // Marks the page for the shell: the mascot (bottom right, Mascot.css) stays off the save bar. Client-only, so the
  // static shell needs no route data.
  useEffect(() => {
    document.body.dataset.page = 'console';
    return () => {
      delete document.body.dataset.page;
    };
  }, []);

  if (!valid || (!isPending && !isError && !token)) {
    return (
      <div className="flex flex-col items-start gap-3 py-16">
        <h1 className="text-display-md font-semibold text-ink">Token not found.</h1>
        <p className="text-sm text-mute">{valid ? 'It may not be a Bootr coin, or the indexer has not seen it yet.' : 'That is not a valid token address.'}</p>
        <Link href="/" className="text-link hover:underline">
          Back to tokens
        </Link>
      </div>
    );
  }
  if (isPending) return <ConsoleSkeleton />;
  if (isError || !token)
    return (
      <div className="flex flex-col items-start gap-3 py-16">
        <h1 className="text-display-md font-semibold text-ink">The indexer did not respond.</h1>
        <Link href={`/token/${address}`} className="text-link hover:underline">
          Back to coin
        </Link>
      </div>
    );

  const coinHref = `/token/${token.id}`;
  return (
    <section aria-labelledby="console-title" className="flex flex-col gap-6" data-testid="creator-console-page">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex shrink-0 items-center gap-1.5" title="The coin and its agent">
            <TokenImage src={token.image} symbol={token.symbol} size={56} className="rounded-sm" />
            <AgentPortrait address={token.kernel} status={token.agent?.status} size={56} />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h1 id="console-title" className="text-display-sm font-semibold text-ink">
                Creator console
              </h1>
              <span className="truncate text-sm text-body">
                {token.name} <span className="font-mono text-mute">${token.symbol}</span>
              </span>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1">
              <AgentStatusLine token={token} agent={token.agent} now={now} />
              {config.data ? (
                <span className="font-mono text-micro text-mute" data-testid="config-revision">
                  {editedLabel(config.data.revision)}
                </span>
              ) : null}
            </div>
          </div>
        </div>
        <Link href={coinHref} className="text-sm text-link hover:underline" data-testid="back-to-coin">
          ← Back to coin
        </Link>
      </header>
      {isCreator ? (
        <CreatorConsole token={token} agent={token.agent ?? null} section={section} onSectionChange={setSection} />
      ) : (
        <Panel title="Creator console" className="max-w-xl">
          <div className="flex flex-col gap-3">
            <p className="text-sm text-body" data-testid="console-unavailable">
              This console belongs to the wallet that launched ${token.symbol}. Connect it to edit the agent; everyone else can follow the agent on the coin page.
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <ConnectButton />
              <Link href={coinHref} className="text-sm text-link hover:underline">
                Back to coin
              </Link>
            </div>
          </div>
        </Panel>
      )}
    </section>
  );
}
