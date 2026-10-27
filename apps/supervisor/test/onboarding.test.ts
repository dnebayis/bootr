import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Hex, type Log } from 'viem';
import { agentLaunchedEvent } from '../src/abi.js';
import { agents, cursors, runtimes } from '../src/db/schema.js';
import { agentConfigOf, completeOnboarding, decodeLaunchLogs, pollLaunches } from '../src/onboarding.js';
import { CREATOR, KERNEL, LAUNCHER, makeWorld, TOKEN } from './helpers.js';

function fakeLaunchLog(agentId: bigint): Log {
  const topics = encodeEventTopics({ abi: [agentLaunchedEvent], eventName: 'AgentLaunched', args: { token: TOKEN, kernel: KERNEL, creator: CREATOR } });
  const data = encodeAbiParameters(
    [
      { type: 'address' },
      { type: 'uint256' },
      { type: 'tuple', components: [{ type: 'uint24' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'uint16' }, { type: 'address' }, { type: 'uint256' }, { type: 'uint32' }] },
      { type: 'bytes32' },
      { type: 'string' },
      { type: 'string' },
      { type: 'address' },
    ],
    ['0x0000000000000000000000000000000000000000', agentId, [10_000, 5000, 3000, 0, 2000, CREATOR, 20_000_000n, 90 * 86_400], pad('0x01', { size: 32 }), 'openai/gpt-4.1-mini', 'https://bootr.fun/agents/7.json', '0x0000000000000000000000000000000000000000'],
  );
  return { address: LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: toHex(7, { size: 32 }), logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

describe('onboarding from AgentLaunched', () => {
  it('decodes the event, registers the agent and runtime with {phase: boot}, and advances the cursor', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n } });
    try {
      const [launch] = decodeLaunchLogs([fakeLaunchLog(7n)]);
      expect(launch).toMatchObject({ token: TOKEN, kernel: KERNEL, creator: CREATOR, agentId: 7n, dormancyPeriod: 90 * 86_400, model: 'openai/gpt-4.1-mini' });

      expect(await pollLaunches(world.ctx)).toBe(1);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent).toMatchObject({ token: TOKEN, kernel: KERNEL, creator: CREATOR, status: 'onboarding', launchBlock: 42 });
      expect(agent!.config).toMatchObject({ agentId: '7', token: { symbol: 'TEST', name: 'Test Coin', chainId: 84532 }, model: 'openai/gpt-4.1-mini', xHandle: null });
      expect(agentConfigOf(agent!)).toBeNull(); // X not connected yet
      const runtime = await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, '7') });
      expect(runtime!.state).toMatchObject({ phase: 'boot' });
      expect(runtime!.cycle).toBe(0);
      const cursor = await world.db.query.cursors.findFirst({ where: eq(cursors.name, 'launcher_block') });
      expect(cursor!.value).toBe('50');

      // second poll: nothing new, idempotent
      world.state.blockNumber = 60n;
      expect(await pollLaunches(world.ctx)).toBe(0);
      expect(await pollLaunches(world.ctx)).toBe(0);

      // X connected + session key installed (simulated) -> active with a complete config
      await world.db.update(agents).set({ sessionKeyInstalledAt: new Date(), permissionId: '0x11223344' }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx);
      const active = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(active!.status).toBe('active');
      const config = agentConfigOf(active!);
      expect(config?.xHandle).toBe('bootr_agent');
      expect(config?.xUserId).toBe('1000');
      expect(config?.socialStartedAt).toBeTruthy();
    } finally {
      await world.close();
    }
  });

  it('stays in onboarding without an admin signer when the session key is not installed', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(8n)], blockNumber: 50n } });
    try {
      await pollLaunches(world.ctx);
      await completeOnboarding(world.ctx);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') });
      expect(agent!.status).toBe('onboarding');
      expect(agent!.permissionId).toBeNull();
    } finally {
      await world.close();
    }
  });
});
