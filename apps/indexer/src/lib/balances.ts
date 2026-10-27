/**
 * Layout of the per-agent balance reads in the snapshot multicall: four kernel reads (USDC, WETH,
 * ETH via Multicall3 `getEthBalance`, own coin), then the spender's USDC `balanceOf` when the agent
 * has a known x402 spender.
 */
export type AgentBalances = {
  usdc: bigint;
  weth: bigint;
  eth: bigint;
  own: bigint;
  /** 0n when the agent has no known spender, undefined when its read failed (keep the last value). */
  spenderUsdc: bigint | undefined;
};

type CallResult = { status: string; result?: unknown } | undefined;

/** Number of multicall slots an agent occupies. */
export const agentReadCount = (spender: string | null | undefined) => (spender ? 5 : 4);

/**
 * Decode the agent slots of a multicall result starting at `start` (the slots after the pool reads).
 * An agent whose kernel reads did not all succeed is left out (its row keeps the last values).
 */
export function decodeAgentBalances(
  results: readonly CallResult[],
  start: number,
  agents: readonly { id: string }[],
  spenders: ReadonlyMap<string, string | null>,
): Map<string, AgentBalances> {
  const out = new Map<string, AgentBalances>();
  let at = start;
  for (const a of agents) {
    const spender = spenders.get(a.id);
    const base = at;
    at += agentReadCount(spender);
    const get = (k: number) => {
      const r = results[base + k];
      return r?.status === 'success' && typeof r.result === 'bigint' ? r.result : undefined;
    };
    const [usdc, weth, eth, own] = [get(0), get(1), get(2), get(3)];
    if (usdc === undefined || weth === undefined || eth === undefined || own === undefined) continue;
    out.set(a.id, { usdc, weth, eth, own, spenderUsdc: spender ? get(4) : 0n });
  }
  return out;
}
