/**
 * The coin page's words for an own agent (docs/design/byo-agent.md section 5.2): who runs it, and what its creator's
 * AI client last did. The rule (no client, no turn yet, active, away) is `@bootr/shared/own-presence`, the same one
 * the status row of the coin's tape is written from (apps/supervisor `activity.ts`), so the two always agree.
 */
import { ownPresenceOf, utcMinuteLabel } from '@bootr/shared/own-presence';
import type { Agent, AgentConfig, Token } from '@/lib/types';

/** Who runs an own agent, in the words the coin page uses. */
export const OWN_RUNNER_LINE = 'Runs in its creator’s own AI client';
export const HOSTED_RUNNER_LINE = 'Run by Bootr';

function agoWords(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  return `${Math.floor(hours / 24)} days ago`;
}

/**
 * When an own agent was last at work, from its last finished turn. It is "active" while that turn is no older than two
 * of its posting intervals (an hour at least); after that it is "away since" that moment. With no client connected it
 * is waiting for one, whatever its last turn says. An own agent is never "sleeping": it does not wait for fuel, it
 * waits for its creator's machine. `clients` left out means the count is not known, and then nothing is said about it.
 */
export function ownPresence(lastTurnAt: string | null | undefined, postIntervalMs: number | null | undefined, now: number, clients?: number | null): { active: boolean; text: string } {
  const presence = ownPresenceOf({ lastTurnAt, clients }, postIntervalMs, now);
  switch (presence.state) {
    case 'no_client':
      return { active: false, text: `no client connected${presence.lastTurnAt === null ? '' : ` · away since ${utcMinuteLabel(presence.lastTurnAt)}`}` };
    case 'no_turn':
      return { active: false, text: 'no turn yet' };
    case 'active':
      return { active: true, text: `last active ${agoWords(Math.max(0, now - presence.lastTurnAt))}` };
    case 'away':
      return { active: false, text: `away since ${utcMinuteLabel(presence.lastTurnAt)}` };
  }
}

/** The status line of an own agent: who runs it, then what the coin's own state, its clients or its last turn say. */
export function ownStatusLine(token: Pick<Token, 'xHandle'>, agent: Agent | null | undefined, config: Pick<AgentConfig, 'own' | 'worker'> | null | undefined, now: number): { active: boolean; text: string } {
  const status = agent?.status;
  if (status === 'claimed' || status === 'dormant') return { active: false, text: `${OWN_RUNNER_LINE} · ${status}` };
  if (status === 'paused') return { active: false, text: `${OWN_RUNNER_LINE} · paused by creator` };
  if (!token.xHandle) return { active: false, text: `${OWN_RUNNER_LINE} · waiting for an X account` };
  if (!config) return { active: false, text: OWN_RUNNER_LINE };
  const presence = ownPresence(config.own?.lastTurnAt, config.worker.postIntervalMs, now, config.own?.clients);
  return { active: presence.active, text: `${OWN_RUNNER_LINE} · ${presence.text}` };
}
