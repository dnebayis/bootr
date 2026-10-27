'use client';

import type { Address } from 'viem';
import { useAgent, useAgentPosts } from '@/lib/indexer';
import type { Agent, Token } from '@/lib/types';
import { ago, shortHash, units, usd } from '@/lib/format';
import { env } from '@/lib/env';
import { explorer } from '@/lib/chains';
import { identityRegistry } from '@/lib/agent-card';
import { KV, Panel } from '@/components/ui/Panel';
import { StatusDot } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopyButton } from '@/components/ui/CopyButton';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { XLogoIcon } from '@/components/ui/Icons';
import { FuelForm } from './FuelForm';

function dormancyDays(a: Agent | null) {
  return Math.round((a?.dormancyPeriod ?? 90 * 86400) / 86400);
}

function Posts({ kernel, handle, now }: { kernel: string; handle: string | null; now: number }) {
  const posts = useAgentPosts(kernel);
  if (!handle) return <p className="text-caption text-mute">The agent has not connected an X account yet.</p>;
  const profile = `https://x.com/${handle}`;
  return (
    <div className="flex flex-col gap-3">
      <a href={profile} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 text-sm text-ink hover:text-link">
        <XLogoIcon /> <span className="font-mono">@{handle}</span>
      </a>
      {posts.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-10" />
          <Skeleton className="h-10" />
        </div>
      ) : posts.data && posts.data.length > 0 ? (
        <ul className="flex flex-col divide-y divide-hairline rounded-sm border border-hairline">
          {posts.data.map((p) => (
            <li key={p.id} className="px-3 py-2.5">
              <p className="text-sm text-body">{p.text}</p>
              <span className="mt-1 block font-mono text-micro text-mute">
                {p.url ? (
                  <a href={p.url} target="_blank" rel="noopener noreferrer" className="hover:text-link">
                    {ago(p.createdAt, now)}
                  </a>
                ) : (
                  ago(p.createdAt, now)
                )}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function AgentPanel({ token, now }: { token: Token & { agent?: Agent | null }; now: number }) {
  const q = useAgent(token.kernel);
  const agent: Agent | null = q.data ?? (token.agent && 'treasuryUsd' in token.agent ? token.agent : null);

  if (q.isPending && !agent) {
    return (
      <Panel title="Agent">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 7 }, (_, i) => (
            <Skeleton key={i} className="h-5" />
          ))}
        </div>
      </Panel>
    );
  }

  const days = dormancyDays(agent);
  const workerHref = env.workerSourceBase ? `${env.workerSourceBase}${token.workerHash}` : null;
  const registry = identityRegistry(token.chainId);
  const cardHref = /^https?:\/\//i.test(token.agentUri) ? token.agentUri : null;
  const inactive = agent?.status === 'paused' || agent?.status === 'dormant' || agent?.status === 'claimed';

  return (
    <Panel title="Agent" action={<StatusDot status={agent?.status} withLabel />}>
      <dl className="divide-y divide-hairline">
        <KV label="Model">{token.model || '—'}</KV>
        <KV label="Worker">
          <span className="inline-flex items-center gap-1">
            {workerHref ? <ExternalLink href={workerHref} icon={false}>{shortHash(token.workerHash)}</ExternalLink> : shortHash(token.workerHash)}
            <CopyButton value={token.workerHash} label="Copy worker hash" />
          </span>
        </KV>
        <KV label="Agent ID">
          {!token.agentId ? (
            '—'
          ) : registry ? (
            <ExternalLink href={explorer.nft(registry, token.agentId, token.chainId)} icon={false}>
              #{token.agentId}
            </ExternalLink>
          ) : (
            `#${token.agentId}`
          )}
        </KV>
        {cardHref ? (
          <KV label="Agent card" mono={false}>
            <ExternalLink href={cardHref}>ERC-8004 JSON</ExternalLink>
          </KV>
        ) : null}
        <KV label="Treasury">
          <a href={explorer.address(token.kernel)} target="_blank" rel="noopener noreferrer" className="hover:text-link">
            {usd(agent?.treasuryUsd, { compact: false })}
          </a>
        </KV>
        <div className="grid grid-cols-3 gap-2 py-2">
          {[
            ['USDC', units(agent?.treasuryUsdc, 6, 2)],
            ['WETH', units(agent?.treasuryWeth, 18, 4)],
            [`$${token.symbol}`, units(agent?.treasuryOwnToken, 18, 0)],
          ].map(([k, v]) => (
            <div key={k} className="rounded-xs bg-canvas-soft px-2 py-1.5">
              <div className="truncate text-micro text-mute">{k}</div>
              <div className="truncate font-mono text-caption text-ink tabular">{v}</div>
            </div>
          ))}
        </div>
        <KV label="Fees claimed">{usd(agent?.feesClaimedUsd, { compact: false })}</KV>
        <KV label="Reputation">
          {agent?.reputationScore != null ? (
            <>
              {agent.reputationScore.toFixed(1)} <span className="text-mute">· {agent.reputationCount} reviews</span>
            </>
          ) : (
            <span className="text-mute">No feedback yet</span>
          )}
        </KV>
        <KV label="Last activity">{ago(agent?.lastActivityAt, now)}</KV>
      </dl>
      <p className="mt-3 rounded-xs bg-canvas-soft px-3 py-2 text-caption text-body">
        Inactive for {days} days → treasury goes to the platform; own tokens burned.
      </p>
      <div className="mt-4">
        <FuelForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} />
        {inactive ? <p className="mt-2 text-caption text-mute">This agent is {agent?.status}. Fuel is held until it resumes.</p> : null}
      </div>
      <div className="mt-5 border-t border-hairline pt-4">
        <Posts kernel={token.kernel} handle={token.xHandle} now={now} />
      </div>
    </Panel>
  );
}
