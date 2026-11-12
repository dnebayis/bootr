/**
 * When an own agent (docs/design/byo-agent.md) was last at work, for the two places that say it in public: the coin
 * page's status line (apps/web `lib/own-presence.ts`) and the status row of the coin's tape (apps/supervisor
 * `activity.ts`). Both read the rule from here, so they cannot say different things about the same coin. No imports.
 *
 * An own agent is never "sleeping" or "awake": it does not wait for fuel, it waits for its creator's AI client. With
 * no client connected it can do nothing, whatever its last turn says; with one, it is "active" while its last finished
 * turn is no older than two of its posting intervals (an hour at least) and "away since" that moment after.
 */

const HOUR_MS = 3_600_000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

export type OwnPresence =
  /** No client is connected: nothing can start a turn. `lastTurnAt` is its last finished turn, if it ever had one. */
  | { state: 'no_client'; lastTurnAt: number | null }
  /** A client is connected and has not finished a turn yet. */
  | { state: 'no_turn'; lastTurnAt: null }
  /** A client is connected and its last turn is recent. */
  | { state: 'active'; lastTurnAt: number }
  /** A client is connected and its last turn is older than two posting intervals. */
  | { state: 'away'; lastTurnAt: number };

/** "9 Nov, 14:20 UTC": one clock for every reader. */
export function utcMinuteLabel(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC`;
}

/**
 * `clients` is the number of clients connected now. A count that is not known (`null`, `undefined`) is read as "some",
 * so an unknown count never claims that nothing is connected.
 */
export function ownPresenceOf(
  own: { lastTurnAt: string | number | null | undefined; clients?: number | null | undefined },
  postIntervalMs: number | null | undefined,
  now: number,
): OwnPresence {
  const raw = own.lastTurnAt;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' && raw ? Date.parse(raw) : NaN;
  const at = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  if (own.clients === 0) return { state: 'no_client', lastTurnAt: at };
  if (at === null) return { state: 'no_turn', lastTurnAt: null };
  const awayAfter = Math.max(HOUR_MS, 2 * (postIntervalMs && postIntervalMs > 0 ? postIntervalMs : 2 * HOUR_MS));
  return Math.max(0, now - at) <= awayAfter ? { state: 'active', lastTurnAt: at } : { state: 'away', lastTurnAt: at };
}

/**
 * The status row of an own coin's tape, one plain line. A stored row cannot count minutes, so it names the moment
 * ("9 Nov, 14:20 UTC") where the coin page, which redraws, says "14 minutes ago".
 */
export function ownTapeStatus(presence: OwnPresence): string {
  switch (presence.state) {
    case 'no_client':
      return `Waiting for its creator’s AI client: none is connected${presence.lastTurnAt === null ? '' : ` · away since ${utcMinuteLabel(presence.lastTurnAt)}`}`;
    case 'no_turn':
      return 'AI client connected · no turn yet';
    case 'active':
      return `Last active ${utcMinuteLabel(presence.lastTurnAt)}`;
    case 'away':
      return `Away since ${utcMinuteLabel(presence.lastTurnAt)}`;
  }
}
