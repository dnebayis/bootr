'use client';

import { useQuery } from '@tanstack/react-query';
import { OWN_AGENT_MODEL_ID } from '@bootr/shared/own-agent';
import type { Agent, AgentConfig, Token } from '@/lib/types';
import { ago } from '@/lib/format';
import { useAgentConfig } from '@/lib/indexer';
import { fetchPlatformFlags } from '@/lib/launch';
import { StatusDot } from '@/components/ui/Badge';
import { cn } from '@/components/ui/cn';

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

/** Who runs an own agent, in the words the coin page uses (docs/design/byo-agent.md section 5.2). */
export const OWN_RUNNER_LINE = 'Runs in its creator’s own AI client';
export const HOSTED_RUNNER_LINE = 'Run by Bootr';

const HOUR_MS = 3_600_000;

function agoWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/** "9 Nov, 14:20 UTC": one clock for every reader. */
function sinceLabel(ms: number): string {
  const d = new Date(ms);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()];
  return `${d.getUTCDate()} ${month}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * When an own agent was last at work, from its last finished turn. It is "active" while that turn is no older than two
 * of its posting intervals (an hour at least); after that it is "away since" that moment. An own agent is never
 * "sleeping": it does not wait for fuel, it waits for its creator's machine.
 */
export function ownPresence(lastTurnAt: string | null | undefined, postIntervalMs: number | null | undefined, now: number): { active: boolean; text: string } {
  const at = lastTurnAt ? Date.parse(lastTurnAt) : NaN;
  if (!Number.isFinite(at)) return { active: false, text: 'no turn yet' };
  const quiet = Math.max(0, now - at);
  const awayAfter = Math.max(HOUR_MS, 2 * (postIntervalMs && postIntervalMs > 0 ? postIntervalMs : 2 * HOUR_MS));
  return quiet <= awayAfter ? { active: true, text: `last active ${agoWords(quiet)}` } : { active: false, text: `away since ${sinceLabel(at)}` };
}

/** The status line of an own agent: who runs it, then what the coin's own state or its last turn says. */
export function ownStatusLine(token: Pick<Token, 'xHandle'>, agent: Agent | null | undefined, config: Pick<AgentConfig, 'own' | 'worker'> | null | undefined, now: number): { active: boolean; text: string } {
  const status = agent?.status;
  if (status === 'claimed' || status === 'dormant') return { active: false, text: `${OWN_RUNNER_LINE} · ${status}` };
  if (status === 'paused') return { active: false, text: `${OWN_RUNNER_LINE} · paused by creator` };
  if (!token.xHandle) return { active: false, text: `${OWN_RUNNER_LINE} · waiting for an X account` };
  if (!config) return { active: false, text: OWN_RUNNER_LINE };
  const presence = ownPresence(config.own?.lastTurnAt, config.worker.postIntervalMs, now);
  return { active: presence.active, text: `${OWN_RUNNER_LINE} · ${presence.text}` };
}

/**
 * Who runs this coin's agent, for the coin page. An own agent is known from the agent's stored configuration
 * (`/api/agent/:kernel/config`), so it holds whether own agents are switched on or off; that read is made only for a
 * coin that may be own (its model line says `own-agent`) or where own agents are offered, so a Bootr-agent coin on a
 * deployment without own agents costs nothing new. Until the configuration answers, the coin's model line decides.
 */
export function useAgentRunner(token: Partial<Pick<Token, 'kernel' | 'model'>>) {
  const flags = useQuery({ queryKey: ['platform'], queryFn: fetchPlatformFlags, staleTime: 30_000 });
  const ownOffered = flags.data?.ownAgent === true;
  const maybeOwn = token.model === OWN_AGENT_MODEL_ID;
  const config = useAgentConfig(token.kernel, !!token.kernel && (maybeOwn || ownOffered));
  const own = config.data ? config.data.runner === 'own' : maybeOwn;
  return { own, ownOffered, config: config.data ?? null };
}

/**
 * The agent's status in one line. For the Bootr agent it is the line it always was; where own agents are offered it
 * also says "Run by Bootr". For an own agent it says so and when its client was last at work; never "sleeping".
 */
export function AgentStatusLine({ token, agent, now, className }: { token: Pick<Token, 'xHandle'> & Partial<Pick<Token, 'kernel' | 'model'>>; agent: Agent | null | undefined; now: number; className?: string }) {
  const { own, ownOffered, config } = useAgentRunner(token);

  if (own) {
    const line = ownStatusLine(token, agent, config, now);
    return (
      <p className={className} data-testid="agent-status" data-runner="own">
        <span className="inline-flex items-center gap-1.5 align-middle">
          <span className={cn('inline-block size-2 shrink-0 rounded-full', line.active ? 'bg-positive' : 'border border-hairline-strong bg-transparent')} aria-hidden="true" />
          <span className="sr-only">{line.active ? 'Agent active' : 'Agent away'}</span>
        </span>
        <span className="ml-1.5 align-middle text-caption text-body">{line.text}</span>
      </p>
    );
  }
  return (
    <p className={className} data-testid="agent-status">
      <StatusDot status={agent?.status} className="align-middle" />
      <span className="ml-1.5 align-middle text-caption text-body">
        {ownOffered ? `${HOSTED_RUNNER_LINE} · ` : ''}
        {agentStatusReason(token, agent, now)}
      </span>
    </p>
  );
}
