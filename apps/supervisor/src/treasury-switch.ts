/**
 * Whether the treasury turn runs for an agent (roles.ts), in a module of its own with no imports: the chat (chat.ts)
 * reads it to know whether a creator request may go to the treasury turn, and the chat may not import the broker.
 */

/** The powers whose presence turns the treasury turn on (design sections 3.2 and 3.3); not in `CAPABILITY_KEYS` yet. */
export const TREASURY_TURN_POWERS: readonly string[] = ['trade', 'bounties'];

/**
 * Whether the treasury turn runs for an agent, from its stored config (`sv_agents.config`, the raw block, not the parsed
 * `AgentConfig`: the zod schema drops capability keys it does not know, and `trade` and `bounties` are not in it yet).
 */
export function treasuryTurnOn(raw: Record<string, unknown>): boolean {
  const caps = raw.capabilities && typeof raw.capabilities === 'object' && !Array.isArray(raw.capabilities) ? (raw.capabilities as Record<string, unknown>) : {};
  if (TREASURY_TURN_POWERS.some((power) => caps[power] === true)) return true;
  return raw.treasuryTurn === true;
}
