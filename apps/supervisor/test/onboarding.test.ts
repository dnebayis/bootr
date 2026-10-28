import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, launchContextEvent } from '../src/abi.js';
import { agents, cursors, runtimes } from '../src/db/schema.js';
import { agentConfigOf, buildLaunchConfig, completeOnboarding, decodeDraftId, decodeLaunchLogs, defaultIdentity, draftIdFromContext, pollLaunches, withCreatorIdentity, type LaunchEvent } from '../src/onboarding.js';
import { agentConfig, CREATOR, KERNEL, LAUNCHER, makeWorld, TOKEN, type TestWorld } from './helpers.js';

const CARD_URI = 'https://bootr.fun/agents/7.json';

function fakeLaunchLog(agentId: bigint, opts: { agentURI?: string; creator?: Address } = {}): Log {
  const creator = opts.creator ?? CREATOR;
  const topics = encodeEventTopics({ abi: [agentLaunchedEvent], eventName: 'AgentLaunched', args: { token: TOKEN, kernel: KERNEL, creator } });
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
    ['0x0000000000000000000000000000000000000000', agentId, [10_000, 5000, 3000, 0, 2000, creator, 20_000_000n, 90 * 86_400], pad('0x01', { size: 32 }), 'openai/gpt-4.1-mini', opts.agentURI ?? CARD_URI, '0x0000000000000000000000000000000000000000'],
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
      // The mock card has no bootr.identity: default persona, nothing left to retry.
      expect(agent!.config).toMatchObject({ creatorIdentity: '', identityText: defaultIdentity('Test Coin', 'TEST', CARD_URI) });
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

/** `BootrLauncher.LaunchContext(token, context)` as emitted in the launch tx (BootrLauncher v2, after `AgentLaunched`). */
function launchContextLog(context: string, opts: { token?: Address; address?: Address } = {}): Log {
  const topics = encodeEventTopics({ abi: [launchContextEvent], eventName: 'LaunchContext', args: { token: opts.token ?? TOKEN } });
  const data = encodeAbiParameters([{ type: 'string' }], [context]);
  return { address: opts.address ?? LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex: 1, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
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
  it('parses only Bootr uuid draft ids from the launcher LaunchContext event', () => {
    expect(draftIdFromContext(bootrContext(DRAFT))).toBe(DRAFT);
    expect(draftIdFromContext(bootrContext('10388'))).toBeNull(); // never a numeric agent id
    expect(draftIdFromContext(bootrContext(DRAFT.toUpperCase()))).toBeNull();
    expect(draftIdFromContext('not json')).toBeNull();
    expect(draftIdFromContext('{"id":5}')).toBeNull();

    expect(decodeDraftId([fakeLaunchLog(7n), launchContextLog(bootrContext(DRAFT))], LAUNCHER, TOKEN)).toBe(DRAFT);
    // only our launcher's event counts: the same event from another contract (the token itself, say) is ignored
    expect(decodeDraftId([launchContextLog(bootrContext(DRAFT), { address: TOKEN })], LAUNCHER, TOKEN)).toBe('');
    expect(decodeDraftId([launchContextLog(bootrContext(DRAFT), { token: CREATOR })], LAUNCHER, TOKEN)).toBe('');
    expect(decodeDraftId([launchContextLog('')], LAUNCHER, TOKEN)).toBe('');
    expect(decodeDraftId([fakeLaunchLog(7n)], LAUNCHER, TOKEN)).toBe('');
  });

  it('registerAgent stores the draft id decoded from the launch receipt', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n, receipts: { [LAUNCH_TX]: [fakeLaunchLog(7n), launchContextLog(bootrContext(DRAFT))] } } });
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
    const world = await makeWorld({ chain: { blockTimestamp: LAUNCH_TS, receipts: { [LAUNCH_TX]: [launchContextLog(bootrContext(DRAFT))] } } });
    try {
      world.sender.accounts = { [DRAFT]: connected(DRAFT, iso(LAUNCH_TS - 600n)) };
      await seedOnboarding(world, '7', { draftId: null });
      await completeOnboarding(world.ctx);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.draftId).toBe(DRAFT);
      expect(agent!.status).toBe('active');

      // Decoded once: '' (no Bootr context) is final and not re-read every tick.
      world.state.receipts[LAUNCH_TX] = [launchContextLog('{}')];
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

const IDENTITY = 'A patient onchain analyst for small Base coins.\nShort, plain, no hype, no emoji.';
const cardJson = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Serves the agent card at CARD_URI from `answer`; everything else goes to the world's default mock. */
function serveCard(world: TestWorld, answer: () => Response) {
  const calls: string[] = [];
  const inner = world.ctx.fetch;
  world.ctx.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url === CARD_URI) {
      calls.push(url);
      return answer();
    }
    return inner(input, init);
  }) as typeof fetch;
  return calls;
}

describe('creator identity from the agent card', () => {
  it('leads identityText with the creator text from bootr.identity, ahead of the default lines', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n } });
    try {
      const calls = serveCard(world, () => cardJson({ type: 'registration', description: 'x', bootr: { identity: `  ${IDENTITY}  ` } }));
      expect(await pollLaunches(world.ctx)).toBe(1);
      expect(calls).toEqual([CARD_URI]);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.creatorIdentity).toBe(IDENTITY);
      expect(agent!.config.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI)}`);
      // The persona reaches the parsed config the brain runs with, once X is connected.
      await world.db.update(agents).set({ sessionKeyInstalledAt: new Date(), permissionId: '0x11223344' }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx);
      const active = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agentConfigOf(active!)!.identityText.startsWith(IDENTITY)).toBe(true);
      expect(calls).toHaveLength(1); // nothing to retry
    } finally {
      await world.close();
    }
  });

  it('keeps the default identity while the card is unreachable and applies the text on a later tick', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n } });
    try {
      let status = 503;
      const calls = serveCard(world, () => (status === 200 ? cardJson({ bootr: { identity: IDENTITY } }) : cardJson({ error: 'down' }, status)));
      expect(await pollLaunches(world.ctx)).toBe(1);
      let agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.creatorIdentity).toBeNull();
      expect(agent!.config.identityText).toBe(defaultIdentity('Test Coin', 'TEST', CARD_URI));

      // still down: retried, still pending
      await completeOnboarding(world.ctx);
      agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.creatorIdentity).toBeNull();
      expect(calls).toHaveLength(2);

      // back: applied, and the agent goes active with it in the same tick
      status = 200;
      await world.db.update(agents).set({ sessionKeyInstalledAt: new Date(), permissionId: '0x11223344' }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx);
      agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.status).toBe('active');
      expect(agent!.config.creatorIdentity).toBe(IDENTITY);
      expect(agentConfigOf(agent!)!.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI)}`);
      expect(calls).toHaveLength(3);

      // active: no further card reads
      await completeOnboarding(world.ctx);
      expect(calls).toHaveLength(3);
    } finally {
      await world.close();
    }
  });

  it('keeps the launchpad identity for the platform launch and adds the creator text in front of it', async () => {
    const world = await makeWorld({ config: { PLATFORM_TREASURY_ADDRESS: CREATOR } });
    try {
      const [launch] = decodeLaunchLogs([fakeLaunchLog(9n)]) as [LaunchEvent];
      const plain = buildLaunchConfig(world.ctx, launch, { name: 'Boot', symbol: 'BOOT' });
      expect(plain.platform).toBe(true);
      expect(plain.creatorIdentity).toBeNull();
      expect(plain.identityText).toBe(defaultIdentity('Boot', 'BOOT', CARD_URI, true));
      expect(String(plain.identityText)).toContain('voice of Bootr');

      const withText = buildLaunchConfig(world.ctx, launch, { name: 'Boot', symbol: 'BOOT' }, IDENTITY);
      expect(withText.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Boot', 'BOOT', CARD_URI, true)}`);
      expect(withCreatorIdentity(plain, IDENTITY)).toEqual(withText);
      expect(withCreatorIdentity(plain, '')).toEqual({ ...plain, creatorIdentity: '' });
    } finally {
      await world.close();
    }
  });
});
