import { describe, expect, it } from 'vitest';

import { agentReadCount, decodeAgentBalances } from './balances';

const ok = (v: bigint) => ({ status: 'success', result: v });
const fail = { status: 'failure' };

describe('decodeAgentBalances', () => {
  it('reads 4 kernel slots per agent plus one spender USDC slot when a spender is known', () => {
    const agents = [{ id: 'k1' }, { id: 'k2' }, { id: 'k3' }];
    const spenders = new Map<string, string | null>([
      ['k1', '0xs1'],
      ['k2', null],
      ['k3', '0xs3'],
    ]);
    const pool = ok(0n); // one pool slot before the agents
    const res = [
      pool,
      ok(1n), ok(2n), ok(3n), ok(4n), ok(5n), // k1 + spender
      ok(10n), ok(20n), ok(30n), ok(40n), // k2, no spender
      ok(100n), ok(200n), ok(300n), ok(400n), fail, // k3, spender read failed
    ];
    const out = decodeAgentBalances(res, 1, agents, spenders);
    expect(out.get('k1')).toEqual({ usdc: 1n, weth: 2n, eth: 3n, own: 4n, spenderUsdc: 5n });
    expect(out.get('k2')).toEqual({ usdc: 10n, weth: 20n, eth: 30n, own: 40n, spenderUsdc: 0n });
    expect(out.get('k3')).toEqual({ usdc: 100n, weth: 200n, eth: 300n, own: 400n, spenderUsdc: undefined });
    expect(agentReadCount('0xs1') + agentReadCount(null) + agentReadCount(undefined)).toBe(13);
  });

  it('skips an agent whose kernel reads failed without shifting the next one', () => {
    const agents = [{ id: 'k1' }, { id: 'k2' }];
    const spenders = new Map([['k1', '0xs1']]);
    const res = [ok(1n), fail, ok(3n), ok(4n), ok(5n), ok(6n), ok(7n), ok(8n), ok(9n)];
    const out = decodeAgentBalances(res, 0, agents, spenders);
    expect(out.has('k1')).toBe(false);
    expect(out.get('k2')).toEqual({ usdc: 6n, weth: 7n, eth: 8n, own: 9n, spenderUsdc: 0n });
  });
});
