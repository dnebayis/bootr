export type AgentStatus = 'awake' | 'sleeping' | 'paused' | 'dormant' | 'claimed';

/** An agent counts as awake if it acted within this window. */
export const AWAKE_WINDOW_SEC = 6 * 3600;
/** Minimum USDC (6 decimals, kernel + spender float) to be considered funded: 1 USDC. */
export const MIN_FUNDED_USDC = 1_000_000n;

export type StatusInput = {
  now: number;
  lastActivityAt: number;
  dormancyPeriod: number;
  paused: boolean;
  claimed: boolean;
  /** Kernel (treasury) USDC. */
  treasuryUsdc: bigint;
  /** USDC float held by the agent's x402 spender EOA (counts as fuel, like the supervisor's sleep rule). */
  spenderUsdc?: bigint;
  /** Optional status reported by the supervisor (`awake` | `sleeping`). */
  supervisorHint?: string | null;
};

/**
 * Precedence: claimed > dormant > paused > sleeping (unfunded) > awake/sleeping by activity.
 * Dormancy outranks pause because the guardian's dormancy clock keeps running while paused and
 * the treasury becomes claimable regardless.
 */
export function deriveStatus(i: StatusInput): AgentStatus {
  if (i.claimed) return 'claimed';
  if (i.dormancyPeriod > 0 && i.now - i.lastActivityAt >= i.dormancyPeriod) return 'dormant';
  if (i.paused) return 'paused';
  if (i.treasuryUsdc + (i.spenderUsdc ?? 0n) < MIN_FUNDED_USDC) return 'sleeping';
  if (i.supervisorHint === 'sleeping') return 'sleeping';
  if (i.now - i.lastActivityAt < AWAKE_WINDOW_SEC) return 'awake';
  if (i.supervisorHint === 'awake') return 'awake';
  return 'sleeping';
}

/** `lastActivityAt + dormancyPeriod` once that moment has passed, else null. */
export function dormantSince(now: number, lastActivityAt: number, dormancyPeriod: number): number | null {
  const at = lastActivityAt + dormancyPeriod;
  return dormancyPeriod > 0 && now >= at ? at : null;
}
