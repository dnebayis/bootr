'use client';

import { useMemo } from 'react';
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
import { formatGas, gasStatus, gasTotal } from '@/lib/gas';
import { useKernelGas } from '@/lib/use-gas';
import { FuelForm } from './FuelForm';
import { GasChip, GasForm } from './GasForm';
import { cn } from '@/components/ui/cn';

function dormancyDays(a: Agent | null) {
  return Math.round((a?.dormancyPeriod ?? 90 * 86400) / 86400);
}

function baseUnits(raw: string | null | undefined): bigint {
  try {
    return raw ? BigInt(raw) : 0n;
  } catch {
    return 0n;
  }
}

/**
 * Treasury USDC as the agent can spend it: kernel + the float its x402 spender holds for inference
 * (the indexer keeps them apart: `treasuryUsdc` is the kernel only).
 */
function usdcHoldings(a: Agent | null) {
  if (!a) return { total: undefined, kernel: 0n, spender: 0n };
  const kernel = baseUnits(a.treasuryUsdc);
  const spender = baseUnits(a.spenderUsdc);
  return { total: (kernel + spender).toString(), kernel, spender };
}

function Posts({ agentId, fallbackHandle, now }: { agentId: string; fallbackHandle: string | null; now: number }) {
  const posts = useAgentPosts(agentId || undefined);
  // The sender knows the live binding; the indexer's handle is only used while posts cannot be loaded.
  const handle = posts.data ? posts.data.handle : fallbackHandle;
  const items = posts.data?.items ?? [];

  return (
    <section aria-labelledby="agent-posts" className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <h3 id="agent-posts" className="text-caption font-medium text-ink">
          Latest posts
        </h3>
        {handle ? (
          <a href={`https://x.com/${handle}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1.5 text-caption text-body hover:text-link">
            <XLogoIcon size={12} /> <span className="font-mono">@{handle}</span>
          </a>
        ) : null}
      </div>
      {agentId && posts.isPending ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
      ) : items.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {items.map((p) => (
            <li key={p.id}>
              <a
                href={p.url}
                target="_blank"
                rel="noopener noreferrer"
                className="block rounded-sm border border-hairline px-3 py-2.5 transition-colors duration-150 hover:border-hairline-strong"
              >
                <p className="whitespace-pre-line break-words text-sm text-body">{p.text}</p>
                <span className="mt-1.5 flex items-center gap-1.5 font-mono text-micro text-mute">
                  {p.kind === 'reply' ? <span>Reply ·</span> : null}
                  <span>{ago(p.createdAt, now)}</span>
                  <span aria-hidden="true">·</span>
                  <span>View on X</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : !handle ? (
        <p className="text-caption text-mute">The agent has not connected an X account yet.</p>
      ) : posts.data === null || posts.isError ? (
        <p className="text-caption text-mute">Posts are unavailable right now.</p>
      ) : (
        <p className="text-caption text-mute">No posts yet.</p>
      )}
    </section>
  );
}

export function AgentPanel({ token, now }: { token: Token & { agent?: Agent | null }; now: number }) {
  const q = useAgent(token.kernel);
  const agent: Agent | null = q.data ?? (token.agent && 'treasuryUsd' in token.agent ? token.agent : null);
  const kernels = useMemo(() => [token.kernel as Address], [token.kernel]);
  const gas = useKernelGas(kernels);
  const kernelGas = gas.of(token.kernel as Address);
  const gasWei = kernelGas ? gasTotal(kernelGas) : null;

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
  const usdc = usdcHoldings(agent);
  const balances: { label: string; value: string; note?: string; title?: string }[] = [
    {
      label: 'USDC',
      value: units(usdc.total, 6, 2),
      ...(usdc.spender > 0n
        ? {
            note: 'incl. spender float',
            title: `Kernel ${units(usdc.kernel, 6, 2)} USDC + spender ${units(usdc.spender, 6, 2)} USDC (pays inference)`,
          }
        : {}),
    },
    { label: 'WETH', value: units(agent?.treasuryWeth, 18, 4) },
    { label: `$${token.symbol}`, value: units(agent?.treasuryOwnToken, 18, 0) },
  ];

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
          {balances.map((b) => (
            <div key={b.label} className="rounded-xs bg-canvas-soft px-2 py-1.5" title={b.title}>
              <div className="truncate text-micro text-mute">{b.label}</div>
              <div className="truncate font-mono text-caption text-ink tabular">{b.value}</div>
              {b.note ? (
                <div className="truncate text-micro text-mute" data-testid="usdc-spender-note">
                  {b.note}
                </div>
              ) : null}
            </div>
          ))}
        </div>
        <KV label="Gas">
          <span
            className="inline-flex items-center gap-2"
            title={kernelGas ? `EntryPoint deposit ${formatGas(kernelGas.deposit)} ETH + kernel balance ${formatGas(kernelGas.balance)} ETH` : undefined}
            data-testid="agent-gas"
          >
            <span>{gasWei == null ? '—' : `${formatGas(gasWei)} ETH`}</span>
            {gasWei != null ? <GasChip status={gasStatus(gasWei)} /> : null}
          </span>
        </KV>
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
      <div className="mt-2" id="gas">
        {gasWei != null && gasStatus(gasWei) !== 'ok' && agent?.status !== 'claimed' ? (
          <p
            data-testid="gas-notice"
            className={cn('mb-2 rounded-xs px-3 py-2 text-caption', gasStatus(gasWei) === 'empty' ? 'border border-danger text-danger' : 'bg-warning-surface text-warning')}
          >
            {gasStatus(gasWei) === 'empty'
              ? 'Out of gas: the agent cannot claim fees, trade or refuel until someone adds gas. The creator funds the first gas; after that the agent refills from its own fees.'
              : 'Gas is low. The agent refills it from its own WETH fees on its next claim; add gas if it has none to claim yet.'}
          </p>
        ) : null}
        <GasForm kernel={token.kernel as Address} symbol={token.symbol} disabled={agent?.status === 'claimed'} onDone={() => void gas.refetch()} />
      </div>
      <div className="mt-5 border-t border-hairline pt-4">
        <Posts agentId={token.agentId} fallbackHandle={token.xHandle} now={now} />
      </div>
    </Panel>
  );
}
