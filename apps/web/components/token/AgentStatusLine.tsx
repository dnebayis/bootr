'use client';

import type { Agent, Token } from '@/lib/types';
import { ago } from '@/lib/format';
import { StatusDot } from '@/components/ui/Badge';

/** Treasury USDC the agent can spend (kernel + the x402 spender float), in whole USDC. */
function usdcTotal(a: Agent): number {
  try {
    return Number(BigInt(a.treasuryUsdc || '0') + BigInt(a.spenderUsdc || '0')) / 1e6;
  } catch {
    return 0;
  }
}

/** "6 h", "40 min", "3 d": how long the agent has been quiet. */
export function quietFor(sinceUnix: number | null | undefined, now: number): string {
  if (!sinceUnix) return 'a while';
  const s = Math.max(0, Math.floor(now / 1000 - sinceUnix));
  if (s < 3600) return `${Math.max(1, Math.floor(s / 60))} min`;
  if (s < 48 * 3600) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86400)} d`;
}

/**
 * The one-line reason behind the agent's status, from the data the coin page already has: the indexer's agent row
 * (status, balances, last post) and the token's X handle. The supervisor's own reason is not needed for these.
 */
export function agentStatusReason(token: Pick<Token, 'xHandle'>, agent: Agent | null | undefined, now: number): string {
  const status = agent?.status ?? 'sleeping';
  if (status === 'claimed') return 'claimed';
  if (status === 'dormant') return 'dormant';
  if (status === 'paused') return 'paused by creator';
  if (status === 'awake') return agent?.lastPostAt ? `awake · posted ${ago(agent.lastPostAt, now)}` : 'awake · no posts yet';
  if (!token.xHandle) return 'sleeping · waiting for an X account';
  if (agent && usdcTotal(agent) < 1) return 'sleeping · fuel below 1 USDC';
  return `sleeping · quiet for ${quietFor(agent?.lastActivityAt, now)}`;
}

export function AgentStatusLine({ token, agent, now, className }: { token: Pick<Token, 'xHandle'>; agent: Agent | null | undefined; now: number; className?: string }) {
  return (
    <p className={className} data-testid="agent-status">
      <StatusDot status={agent?.status} className="align-middle" />
      <span className="ml-1.5 align-middle text-caption text-body">{agentStatusReason(token, agent, now)}</span>
    </p>
  );
}
