/**
 * The X troubles the coin page shows the creator (components/token/CreatorXBanner.tsx): the 403 hold and a lost connection.
 * No imports beyond types: safe on the client and the server.
 *
 * X answered "not permitted" to a publish, so the supervisor holds the agent's posts for hours (apps/supervisor/src/rhythm.ts
 * `forbiddenHold`) and says so in `AgentConfig.xHold` (`GET /api/agent/:kernel/config`). Until 2026-11-08 the only sign on
 * the page was an inbox item, and the "waiting for an X account" panel came up only when the creator revoked the app on X
 * first. A reconnect from the page lifts the hold on the next supervisor pass (runtime.ts `liftForbiddenHoldOnReconnect`).
 */
import type { AgentXConnection, AgentXHold } from '@/lib/types';

/**
 * Which panel the creator of an agent with an X account sees: `revoked` when X dropped the connection (the sender's row
 * says so; nothing, no hold included, can end before the account is connected again), else `hold` while a 403 hold lasts,
 * else nothing. An unknown connection (null: the sender did not answer) decides nothing by itself.
 */
export function xTrouble(xConnection: AgentXConnection | null | undefined, xHold: AgentXHold | null | undefined, nowMs: number): 'revoked' | 'hold' | null {
  if (xConnection === 'revoked') return 'revoked';
  return activeXHold(xHold, nowMs) ? 'hold' : null;
}

/** The lost-connection panel's words (the inbox's `x_revoked` notice, with the way out beside it). */
export function xRevokedCopy(handle: string | null | undefined): { title: string; body: string } {
  const who = handle ? `@${handle.replace(/^@/, '')}'s` : "the agent's";
  return {
    title: 'X connection lost',
    body: `X no longer accepts ${who} connection, so the agent cannot read or post. Connect the same X account again here; the agent resumes on the next pass.`,
  };
}

/** The hold if it is still in force at `nowMs`: null when there is none, its time has passed or its time is unreadable. */
export function activeXHold(xHold: AgentXHold | null | undefined, nowMs: number): AgentXHold | null {
  if (!xHold || xHold.reason !== 'forbidden') return null;
  const until = Date.parse(xHold.until);
  return Number.isFinite(until) && until > nowMs ? xHold : null;
}

/** The panel's words. `untilText` is the end of the hold as the page formats it (the viewer's clock). */
export function xHoldCopy(handle: string | null | undefined, untilText: string): { title: string; body: string } {
  const who = handle ? `@${handle.replace(/^@/, '')}` : 'the agent';
  return {
    title: "X is refusing this agent's posts",
    body: `X answered 'not permitted' when ${who} tried to post, so posts and replies are paused until ${untilText}. Log in to the X account and check for a lock, a restriction or a notice from X. If you reconnect the account here, the pause ends at once.`,
  };
}

/** The end of the hold on the viewer's clock: "Nov 9, 03:15" with the viewer's zone; same day drops the date. */
export function formatHoldEnd(until: string, nowMs: number, locale = 'en-US'): string {
  const d = new Date(until);
  if (!Number.isFinite(d.getTime())) return 'later today';
  const sameDay = d.toDateString() === new Date(nowMs).toDateString();
  const time = d.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString(locale, { month: 'short', day: 'numeric' })}, ${time}`;
}
