import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, clankerTokenCreatedEvent } from '../src/abi.js';
import { agents, cursors, runtimes } from '../src/db/schema.js';
import { agentConfigOf, completeOnboarding, decodeDraftId, decodeLaunchLogs, draftIdFromContext, pollLaunches } from '../src/onboarding.js';
import { ADDR, agentConfig, CREATOR, KERNEL, LAUNCHER, makeWorld, TOKEN, type TestWorld } from './helpers.js';

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

const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
const LAUNCH_TX = toHex(7, { size: 32 });
const LAUNCH_TS = 1_792_000_000n;
const iso = (sec: bigint) => new Date(Number(sec) * 1000).toISOString();

function tokenCreatedLog(context: string, opts: { token?: Address; address?: Address } = {}): Log {
  const topics = encodeEventTopics({ abi: [clankerTokenCreatedEvent], eventName: 'TokenCreated', args: { tokenAddress: opts.token ?? TOKEN, tokenAdmin: KERNEL } });
  const zero = '0x0000000000000000000000000000000000000000' as const;
  const data = encodeAbiParameters(
    clankerTokenCreatedEvent.inputs.filter((i) => !('indexed' in i && i.indexed)),
    [LAUNCHER, 'ipfs://img', 'Test Coin', 'TEST', '{}', context, -230_400, zero, pad('0x02', { size: 32 }), ADDR.weth, zero, zero, 0n, []],
  );
  return { address: opts.address ?? ADDR.clanker, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

const bootrContext = (id: string) => JSON.stringify({ interface: 'Bootr', platform: 'bootr.fun', id });

const connected = (agentId: string, connectedAt: string) => ({ agentId, connected: true, revoked: false, handle: 'draft_handle', xUserId: '2000', connectedAt });

async function seedOnboarding(world: TestWorld, agentId: string, over: { draftId?: string | null; launchBlock?: number; kernel?: Address } = {}) {
  const now = world.ctx.now();
  await world.db.insert(agents).values({
    agentId,
    token: TOKEN,
    kernel: over.kernel ?? KERNEL,
    creator: CREATOR,
    config: agentConfig(now, { agentId, xHandle: null, xUserId: null }),
    permissionId: '0x11223344',
    sessionKeyInstalledAt: new Date(now),
    launchBlock: over.launchBlock ?? 42,
    launchTxHash: LAUNCH_TX,
    draftId: over.draftId === undefined ? DRAFT : over.draftId,
    status: 'onboarding',
  });
  await world.db.insert(runtimes).values({ agentId, state: {}, cycle: 0, nextAt: new Date(now), status: 'ready' });
}

describe('launch draft id -> X account rebind', () => {
  it('parses only Bootr uuid draft ids from the Clanker TokenCreated context', () => {
    expect(draftIdFromContext(bootrContext(DRAFT))).toBe(DRAFT);
    expect(draftIdFromContext(bootrContext('10388'))).toBeNull(); // never a numeric agent id
    expect(draftIdFromContext(bootrContext(DRAFT.toUpperCase()))).toBeNull();
    expect(draftIdFromContext('not json')).toBeNull();
    expect(draftIdFromContext('{"id":5}')).toBeNull();

    expect(decodeDraftId([tokenCreatedLog(bootrContext(DRAFT))], ADDR.clanker, TOKEN)).toBe(DRAFT);
    expect(decodeDraftId([tokenCreatedLog(bootrContext(DRAFT), { address: LAUNCHER })], ADDR.clanker, TOKEN)).toBe('');
    expect(decodeDraftId([tokenCreatedLog(bootrContext(DRAFT), { token: CREATOR })], ADDR.clanker, TOKEN)).toBe('');
    expect(decodeDraftId([tokenCreatedLog('')], ADDR.clanker, TOKEN)).toBe('');
  });

  it('registerAgent stores the draft id decoded from the launch receipt', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n, receipts: { [LAUNCH_TX]: [tokenCreatedLog(bootrContext(DRAFT)), fakeLaunchLog(7n)] } } });
    try {
      expect(await pollLaunches(world.ctx)).toBe(1);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.draftId).toBe(DRAFT);
    } finally {
      await world.close();
    }
  });

  it('adopts the account connected under the draft id before launch and activates the agent', async () => {
    const world = await makeWorld({ chain: { blockTimestamp: LAUNCH_TS } });
    try {
      world.sender.accounts = { [DRAFT]: connected(DRAFT, iso(LAUNCH_TS - 600n)) };
      await seedOnboarding(world, '7');
      await completeOnboarding(world.ctx);

      expect(world.sender.rebinds).toEqual([{ from: DRAFT, to: '7', connectedBefore: iso(LAUNCH_TS) }]);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.status).toBe('active');
      expect(agentConfigOf(agent!)).toMatchObject({ xHandle: 'draft_handle', xUserId: '2000' });
      const runtime = await world.db.query.runtimes.findFirst({ where: eq(runtimes.agentId, '7') });
      expect(runtime!.status).toBe('waiting');
    } finally {
      await world.close();
    }
  });

  it('does not look at the draft id when the agent id is already connected', async () => {
    const world = await makeWorld();
    try {
      world.sender.accounts = { '7': connected('7', iso(LAUNCH_TS)), [DRAFT]: connected(DRAFT, iso(LAUNCH_TS)) };
      await seedOnboarding(world, '7');
      await completeOnboarding(world.ctx);
      expect(world.sender.rebinds).toEqual([]);
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') }))!.status).toBe('active');
    } finally {
      await world.close();
    }
  });

  it('refuses an account bound to the draft id after the launch was public', async () => {
    const world = await makeWorld({ chain: { blockTimestamp: LAUNCH_TS } });
    try {
      world.sender.accounts = { [DRAFT]: connected(DRAFT, iso(LAUNCH_TS + 30n)) };
      await seedOnboarding(world, '7');
      await completeOnboarding(world.ctx);
      expect(world.sender.rebinds).toHaveLength(1);
      expect(world.sender.accounts[DRAFT]).toBeTruthy(); // not moved
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') }))!.status).toBe('onboarding');
    } finally {
      await world.close();
    }
  });

  it('lets only the earliest launch claim a draft id (a later launch copying the public context gets nothing)', async () => {
    const world = await makeWorld({ chain: { blockTimestamp: LAUNCH_TS } });
    try {
      world.sender.accounts = { [DRAFT]: connected(DRAFT, iso(LAUNCH_TS - 600n)) };
      await seedOnboarding(world, '7', { launchBlock: 42 });
      await seedOnboarding(world, '9', { launchBlock: 45, kernel: '0x2000000000000000000000000000000000000009' });
      // Process the copycat first: it must not adopt the account even though the original is still onboarding.
      await world.db.update(agents).set({ sessionKeyInstalledAt: null, permissionId: null }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx); // '7' has no session key (no admin signer): skipped; '9' is checked
      expect(world.sender.rebinds).toEqual([]);
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '9') }))!.status).toBe('onboarding');

      await world.db.update(agents).set({ sessionKeyInstalledAt: new Date(world.ctx.now()), permissionId: '0x11223344' }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx);
      expect(world.sender.rebinds.map((r) => r.to)).toEqual(['7']);
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') }))!.status).toBe('active');
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '9') }))!.status).toBe('onboarding');
    } finally {
      await world.close();
    }
  });

  it('backfills the draft id lazily for agents registered before the column existed', async () => {
    const world = await makeWorld({ chain: { blockTimestamp: LAUNCH_TS, receipts: { [LAUNCH_TX]: [tokenCreatedLog(bootrContext(DRAFT))] } } });
    try {
      world.sender.accounts = { [DRAFT]: connected(DRAFT, iso(LAUNCH_TS - 600n)) };
      await seedOnboarding(world, '7', { draftId: null });
      await completeOnboarding(world.ctx);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.draftId).toBe(DRAFT);
      expect(agent!.status).toBe('active');

      // Decoded once: '' (no Bootr context) is final and not re-read every tick.
      world.state.receipts[LAUNCH_TX] = [tokenCreatedLog('{}')];
      await seedOnboarding(world, '8', { draftId: null, kernel: '0x2000000000000000000000000000000000000008' });
      await completeOnboarding(world.ctx);
      await completeOnboarding(world.ctx);
      expect((await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!.draftId).toBe('');
      expect(world.state.calls.filter((c) => c.fn === 'getTransactionReceipt')).toHaveLength(2);
    } finally {
      await world.close();
    }
  });
});
