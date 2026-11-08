/**
 * Which open inbox notices carry the "connect X again" box (components/token/NotificationInbox.tsx). No imports: safe on
 * the client and the server.
 *
 * Two events ask the creator to reconnect the agent's X account and so must show the way to do it right there:
 *  - `x_revoked`: X dropped the connection (the sender's account row is revoked);
 *  - `x_forbidden`: X answered 403 "not permitted" to a publish; the notice says "connect it again from the creator
 *    console", and on 2026-11-08 a creator who read it found no button. The supervisor lifts the hold as soon as the
 *    sender's `connectedAt` moves past the hold (apps/supervisor/src/runtime.ts `liftForbiddenHoldOnReconnect`).
 * A resolved notice offers nothing: the connection is back, or the account posts again.
 */
export const X_RECONNECT_EVENTS: readonly string[] = ['x_revoked', 'x_forbidden'];

/** True when the inbox item should carry the "connect the same X account again" box. */
export function offersXReconnect(item: { event: string; state: 'active' | 'resolved' }): boolean {
  return item.state === 'active' && X_RECONNECT_EVENTS.includes(item.event);
}
