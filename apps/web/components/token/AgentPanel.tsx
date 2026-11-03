'use client';

import { useMemo } from 'react';
import type { Address } from 'viem';
import { useConnection } from 'wagmi';
import { useAgent } from '@/lib/indexer';
import type { Agent, Token } from '@/lib/types';
import { ago, shortHash, units, usd } from '@/lib/format';
import { env } from '@/lib/env';
import { explorer } from '@/lib/chains';
import { identityRegistry } from '@/lib/agent-card';
import { KV, Panel } from '@/components/ui/Panel';
import { AgentPortrait } from '@/components/art/AgentPortrait';
import { StatusDot } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { CopyButton } from '@/components/ui/CopyButton';
import { ExternalLink } from '@/components/ui/ExternalLink';
import { formatGas, gasStatus, gasTotal } from '@/lib/gas';
import { useKernelGas } from '@/lib/use-gas';
import { GasChip } from './GasForm';
import { shortAddr } from '@/lib/format';

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

export function AgentPanel({ token, now }: { token: Token & { agent?: Agent | null }; now: number }) {
  const q = useAgent(token.kernel);
  const agent: Agent | null = q.data ?? (token.agent && 'treasuryUsd' in token.agent ? token.agent : null);
  const kernels = useMemo(() => [token.kernel as Address], [token.kernel]);
  const gas = useKernelGas(kernels);
  const kernelGas = gas.of(token.kernel as Address);
  const gasWei = kernelGas ? gasTotal(kernelGas) : null;
  // Fuel, gas and the agent's settings are the creator's (CreatorConsole on the page); everyone sees the facts here.
  const { address } = useConnection();
  const isCreator = env.useMock || (!!address && !!token.creator && address.toLowerCase() === token.creator.toLowerCase());

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
    <Panel
      title={
        <span className="inline-flex items-center gap-2">
          <AgentPortrait address={token.kernel} status={agent?.status ?? token.agent?.status} size={32} />
          Agent
        </span>
      }
      action={<StatusDot status={agent?.status} withLabel />}
    >
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
        <KV label="Agent wallet">
          <span className="inline-flex items-center gap-1" data-testid="agent-wallet">
            <ExternalLink href={explorer.address(token.kernel)} icon={false}>
              {shortAddr(token.kernel)}
            </ExternalLink>
            <CopyButton value={token.kernel} label="Copy agent wallet address" />
          </span>
        </KV>
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
      {!isCreator ? <p className="mt-3 text-caption text-mute">Fuel and gas are added by the coin&rsquo;s creator. To buy the coin, use Trade.</p> : null}
    </Panel>
  );
}
