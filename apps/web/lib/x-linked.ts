/**
 * The "X linked" badge's one rule. No imports: safe on the client and the server.
 *
 * What the indexer calls `xHandle` is not proof and is not an input here: it is a label that can outlive a revoked account.
 * The proof is the sender's account row, read through `GET /api/agents/:agentId/posts` (`handle`, null when there is no
 * account or it was revoked). A row reaches a real agent id (a number, the ERC-8004 id) in only two ways, both gated on the
 * wallet that launched the coin:
 *  - after launch: the creator signs `Connect the X account of Bootr agent #<agentId> (<kernel>).`, checked against the
 *    indexer's creator (`POST /api/siwe/x-claim`, `POST /api/agent/x-connect`), then X's own consent screen runs;
 *  - in the launch form: X's consent runs under a draft uuid, and the supervisor moves the account to the agent id only
 *    when the creator's launch transaction names that draft and the account was connected before the launch block
 *    (`adoptDraftAccount` in apps/supervisor/src/onboarding.ts).
 * So a draft id is never enough, and neither is anything the indexer repeats. Anything short of this claims nothing.
 */

const AGENT_ID = /^[1-9][0-9]{0,19}$/;
const X_HANDLE = /^[A-Za-z0-9_]{1,15}$/;

/** The X handle proven connected to this agent, or null: no badge. */
export function provenXHandle(agentId: string | null | undefined, account: { handle: string | null } | null | undefined): string | null {
  if (!agentId || !AGENT_ID.test(agentId)) return null;
  const handle = account?.handle;
  return handle && X_HANDLE.test(handle) ? handle : null;
}
