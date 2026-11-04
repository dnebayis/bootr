import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, pad, toHex, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, clankerLaunchedEvent, launchContextEvent } from '../src/abi.js';
import { launcherEntries, launchSourceOf } from '../src/chain.js';
import { agents, cursors, runtimes } from '../src/db/schema.js';
import { pino } from 'pino';
import { DEFAULT_WORKER_TEMPLATE, LEGACY_WORKER_HASHES, customWorker, normalizeWorkerPreset, workerTemplateById } from '@bootr/shared/workers';
import { clankerDetailsOf, clankerLockersFor } from '../src/launch-source.js';
import { agentConfigOf, buildLaunchConfig, completeOnboarding, decodeClankerLaunch, decodeDraftId, decodeLaunchLogs, defaultIdentity, draftIdFromContext, pollLaunches, sessionPolicyFor, withCreatorIdentity, type LaunchEvent } from '../src/onboarding.js';
import { agentConfig, CLANKER_FEE_LOCKER, CLANKER_LAUNCHER, CLANKER_LP_LOCKER, CLANKER_POOL_ID, CREATOR, KERNEL, LAUNCHER, makeWorld, RWAGMI_LP_LOCKER, testConfig, TOKEN, type TestWorld, mockAdminSigner } from './helpers.js';

const CARD_URI = 'https://bootr.fun/agents/7.json';

function fakeLaunchLog(agentId: bigint, opts: { agentURI?: string; creator?: Address; workerHash?: Hex; launcher?: Address; token?: Address; kernel?: Address } = {}): Log {
  const creator = opts.creator ?? CREATOR;
  const topics = encodeEventTopics({ abi: [agentLaunchedEvent], eventName: 'AgentLaunched', args: { token: opts.token ?? TOKEN, kernel: opts.kernel ?? KERNEL, creator } });
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
    ['0x0000000000000000000000000000000000000000', agentId, [10_000, 5000, 3000, 0, 2000, creator, 20_000_000n, 90 * 86_400], opts.workerHash ?? pad('0x01', { size: 32 }), 'openai/gpt-4.1-mini', opts.agentURI ?? CARD_URI, '0x0000000000000000000000000000000000000000'],
  );
  return { address: opts.launcher ?? LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: toHex(7, { size: 32 }), logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

const CLANKER_HOOK: Address = '0x00000000000000000000000000000000000000B4';
const CLANKER_MEV: Address = '0x00000000000000000000000000000000000000E5';

/** `BootrClankerLauncher.ClankerLaunched(token, poolId, hook, locker, mevModule, startingTick, lpFeeBps)` as emitted next to `AgentLaunched`. */
function clankerLaunchedLog(opts: { token?: Address; address?: Address; locker?: Address } = {}): Log {
  const topics = encodeEventTopics({ abi: [clankerLaunchedEvent], eventName: 'ClankerLaunched', args: { token: opts.token ?? TOKEN } });
  const data = encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'int24' }, { type: 'uint24' }], [CLANKER_POOL_ID, CLANKER_HOOK, opts.locker ?? CLANKER_LP_LOCKER, CLANKER_MEV, -230400, 10_000]);
  return { address: opts.address ?? CLANKER_LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: toHex(7, { size: 32 }), logIndex: 2, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

const TEMPLATE_LINES = workerTemplateById(DEFAULT_WORKER_TEMPLATE)!.preset.identity;
const LEGACY_HASH_RESEARCHER = Object.entries(LEGACY_WORKER_HASHES).find(([, id]) => id === 'researcher')![0] as Hex;

describe('worker templates', () => {
  it('applies the preset the on-chain worker hash commits to, and falls back to the default template for unknown hashes', async () => {
    const world = await makeWorld({ chain: { logs: [], blockNumber: 50n } });
    try {
      const trader = workerTemplateById('trader')!;
      const launch = decodeLaunchLogs([fakeLaunchLog(7n, { workerHash: trader.hash })])[0]!;
      expect(launch.workerHash).toBe(trader.hash);
      const cfg = buildLaunchConfig(world.ctx, launch, { name: 'Quiet Engine', symbol: 'QENG' }) as Record<string, unknown>;
      expect(cfg.workerTemplate).toBe('trader');
      expect(cfg.capabilities).toEqual(trader.preset.capabilities);
      expect(cfg.postIntervalMs).toBe(trader.preset.postIntervalMs);
      expect(String(cfg.identityText)).toContain(trader.preset.identity[0]);
      // version-0 placeholder hashes (the first launches) still resolve
      const legacy = decodeLaunchLogs([fakeLaunchLog(8n, { workerHash: LEGACY_HASH_RESEARCHER })])[0]!;
      expect((buildLaunchConfig(world.ctx, legacy, { name: 'A', symbol: 'A' }) as Record<string, unknown>).workerTemplate).toBe('researcher');
      // unknown hash: the default template
      const unknown = decodeLaunchLogs([fakeLaunchLog(9n)])[0]!;
      const u = buildLaunchConfig(world.ctx, unknown, { name: 'A', symbol: 'A' }) as Record<string, unknown>;
      expect(u.workerTemplate).toBe(DEFAULT_WORKER_TEMPLATE);
      expect(u.capabilities).toEqual(workerTemplateById(DEFAULT_WORKER_TEMPLATE)!.preset.capabilities);
    } finally {
      await world.close();
    }
  });
});

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
      expect(agent!.config).toMatchObject({ creatorIdentity: '', identityText: defaultIdentity('Test Coin', 'TEST', CARD_URI, false, TEMPLATE_LINES) });
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
      expect(agent!.config.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, TEMPLATE_LINES)}`);
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

  it('takes the coin picture from the card as the image style reference, at registration or on the retry', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n } });
    try {
      serveCard(world, () => cardJson({ type: 'registration', image: 'https://cdn.bootr.fun/coins/7.png', bootr: { identity: IDENTITY } }));
      expect(await pollLaunches(world.ctx)).toBe(1);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.imageStyle).toEqual({ reference: 'https://cdn.bootr.fun/coins/7.png', notes: '' });
    } finally {
      await world.close();
    }
    const later = await makeWorld({ chain: { logs: [fakeLaunchLog(7n)], blockNumber: 50n } });
    try {
      let status = 503;
      serveCard(later, () => (status === 200 ? cardJson({ image: 'ipfs://bafy-not-https', bootr: { identity: IDENTITY } }) : cardJson({ error: 'down' }, status)));
      expect(await pollLaunches(later.ctx)).toBe(1);
      let agent = await later.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.imageStyle).toEqual({ reference: null, notes: '' });
      status = 200;
      await completeOnboarding(later.ctx);
      agent = await later.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config.creatorIdentity).toBe(IDENTITY);
      // an ipfs:// image is no reference the image model can fetch: none is set
      expect(agent!.config.imageStyle).toEqual({ reference: null, notes: '' });
    } finally {
      await later.close();
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
      expect(agent!.config.identityText).toBe(defaultIdentity('Test Coin', 'TEST', CARD_URI, false, TEMPLATE_LINES));

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
      expect(agentConfigOf(agent!)!.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, TEMPLATE_LINES)}`);
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

/** A creator-defined worker as the launch form builds it (`customWorker`) and the card publishes it (`bootr.worker`). */
const CUSTOM_PRESET = normalizeWorkerPreset({ capabilities: { xRead: true, xReply: false, xPublish: true, research: true, images: true }, postIntervalMs: 8 * 3_600_000, jobLines: ['Your job is to watch Base DeFi and post one sourced finding per cycle.', 'Never reply to anyone; you only publish.'] })!;
const CUSTOM = customWorker(CUSTOM_PRESET);
const cardWithWorker = (worker: { id: string; version: number; preset: unknown }, identity?: string) => cardJson({ type: 'registration', bootr: { ...(identity ? { identity } : {}), worker } });

/** Replaces the world's silent logger with one that collects worker-related warn+ lines (`ctx.log.child` descendants included). */
function collectWorkerWarnings(world: TestWorld): string[] {
  const lines: string[] = [];
  world.ctx.log = pino({ level: 'warn' }, { write: (line: string) => void (line.includes('worker') && lines.push(line)) });
  return lines;
}

describe('custom worker from the agent card', () => {
  it('applies the preset published as bootr.worker when its hash equals the on-chain worker hash', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n, { workerHash: CUSTOM.hash })], blockNumber: 50n } });
    try {
      const warnings = collectWorkerWarnings(world);
      serveCard(world, () => cardWithWorker({ id: 'custom', version: 1, preset: { ...CUSTOM_PRESET, jobLines: CUSTOM_PRESET.identity, identity: undefined } }, IDENTITY));
      expect(await pollLaunches(world.ctx)).toBe(1);
      const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config).toMatchObject({ workerTemplate: 'custom', workerHash: CUSTOM.hash, workerPreset: CUSTOM_PRESET, capabilities: CUSTOM_PRESET.capabilities, postIntervalMs: 8 * 3_600_000, creatorIdentity: IDENTITY });
      // job lines play the role of the preset lines, after the creator's instructions
      expect(agent!.config.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, CUSTOM_PRESET.identity)}`);
      expect(warnings).toEqual([]);
      // the parsed config the brain runs with carries the custom powers and cadence
      await world.db.update(agents).set({ sessionKeyInstalledAt: new Date(), permissionId: '0x11223344' }).where(eq(agents.agentId, '7'));
      await completeOnboarding(world.ctx);
      const active = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      const config = agentConfigOf(active!)!;
      expect(config.capabilities).toEqual(CUSTOM_PRESET.capabilities);
      expect(config.postIntervalMs).toBe(8 * 3_600_000);
    } finally {
      await world.close();
    }
  });

  it('falls back to the default template with a warning when the card worker does not hash to the on-chain hash, or the card has none', async () => {
    const fallback = workerTemplateById(DEFAULT_WORKER_TEMPLATE)!;
    const tampered = { ...CUSTOM_PRESET, postIntervalMs: 30 * 60_000 }; // the card says "every 30 min"; the chain committed to 8 h
    const cases: { card: (() => Response) | null; warning: string }[] = [
      { card: () => cardWithWorker({ id: 'custom', version: 1, preset: tampered }, IDENTITY), warning: 'does not hash to the on-chain worker hash' },
      { card: () => cardJson({ type: 'registration', bootr: { identity: IDENTITY } }), warning: 'no usable bootr.worker' },
      { card: null, warning: 'no usable bootr.worker' }, // the world's default fetch answers `{}`
    ];
    for (const { card, warning } of cases) {
      const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n, { workerHash: CUSTOM.hash })], blockNumber: 50n } });
      try {
        const warnings = collectWorkerWarnings(world);
        if (card) serveCard(world, card);
        expect(await pollLaunches(world.ctx)).toBe(1);
        const agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
        expect(agent!.config).toMatchObject({ workerTemplate: DEFAULT_WORKER_TEMPLATE, workerHash: CUSTOM.hash, capabilities: fallback.preset.capabilities, postIntervalMs: fallback.preset.postIntervalMs });
        expect(agent!.config.workerPreset).toBeUndefined();
        // the creator text still applies (the identity and the worker are independent)
        if (card) expect(agent!.config.creatorIdentity).toBe(IDENTITY);
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain(warning);
        // final: nothing to retry on later ticks
        await completeOnboarding(world.ctx);
        expect(warnings).toHaveLength(1);
      } finally {
        await world.close();
      }
    }
  });

  it('runs the default template while the card is unreachable and applies the custom worker on a later tick', async () => {
    const world = await makeWorld({ chain: { logs: [fakeLaunchLog(7n, { workerHash: CUSTOM.hash })], blockNumber: 50n } });
    try {
      let status = 503;
      const calls = serveCard(world, () => (status === 200 ? cardWithWorker({ id: 'custom', version: 1, preset: CUSTOM_PRESET }, IDENTITY) : cardJson({ error: 'down' }, status)));
      expect(await pollLaunches(world.ctx)).toBe(1);
      let agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(agent!.config).toMatchObject({ workerTemplate: DEFAULT_WORKER_TEMPLATE, creatorIdentity: null });
      expect(agent!.config.workerPreset).toBeUndefined();

      status = 200;
      await completeOnboarding(world.ctx);
      agent = await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') });
      expect(calls).toHaveLength(2);
      expect(agent!.config).toMatchObject({ workerTemplate: 'custom', workerPreset: CUSTOM_PRESET, capabilities: CUSTOM_PRESET.capabilities, postIntervalMs: 8 * 3_600_000, creatorIdentity: IDENTITY });
      expect(agent!.config.identityText).toBe(`${IDENTITY}\n\n${defaultIdentity('Test Coin', 'TEST', CARD_URI, false, CUSTOM_PRESET.identity)}`);
    } finally {
      await world.close();
    }
  });
});

describe('launch source: Bootr and Clanker launchers (docs/design/clanker-launch.md)', () => {
  const CLANKER_TX = toHex(7, { size: 32 });
  const expectedDetails = { poolId: CLANKER_POOL_ID, hook: CLANKER_HOOK, locker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER, mevModule: CLANKER_MEV, startingTick: -230400, lpFeeBps: 10_000 };

  it('config: the Clanker launcher is optional, must differ from the Bootr one, and the two make the launcher list', () => {
    expect(testConfig().BOOTR_CLANKER_LAUNCHER_ADDRESS).toBeUndefined();
    expect(launcherEntries(testConfig())).toEqual([{ address: LAUNCHER, source: 'bootr' }]);
    const both = testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER });
    expect(launcherEntries(both)).toEqual([
      { address: LAUNCHER, source: 'bootr' },
      { address: CLANKER_LAUNCHER, source: 'clanker' },
    ]);
    expect(launchSourceOf(launcherEntries(both), CLANKER_LAUNCHER.toLowerCase() as Address)).toBe('clanker');
    expect(launchSourceOf(launcherEntries(both), LAUNCHER)).toBe('bootr');
    expect(launchSourceOf(launcherEntries(both), TOKEN)).toBeNull();
    expect(() => testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: LAUNCHER.toLowerCase() })).toThrow(/must differ/);
    // the lockers default to the verified Base mainnet addresses
    const defaults = testConfig({ CLANKER_LOCKER_ADDRESS: '', CLANKER_FEE_LOCKER_ADDRESS: '' });
    expect(defaults.CLANKER_LOCKER_ADDRESS).toBe('0xffA37784D619F228D8B379d287a4D7282e500762');
    expect(defaults.CLANKER_FEE_LOCKER_ADDRESS).toBe('0xF3622742b1E446D92e45E22923Ef11C2fcD55D68');
  });

  it('decodes the source from the emitting launcher (unknown emitters count as bootr) and ClankerLaunched only from our launcher', () => {
    const launchers = launcherEntries(testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER }));
    const [bootr, clanker] = decodeLaunchLogs([fakeLaunchLog(7n), fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER })], launchers);
    expect(bootr).toMatchObject({ agentId: 7n, launcher: LAUNCHER, source: 'bootr' });
    expect(clanker).toMatchObject({ agentId: 8n, launcher: CLANKER_LAUNCHER, source: 'clanker' });
    expect(decodeLaunchLogs([fakeLaunchLog(9n, { launcher: CLANKER_LAUNCHER })])[0]!.source).toBe('bootr'); // no list: everything is Bootr
    expect(decodeClankerLaunch([fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER }), clankerLaunchedLog()], CLANKER_LAUNCHER, TOKEN, CLANKER_FEE_LOCKER)).toEqual(expectedDetails);
    // another contract's log, another token's log, or no log at all: nothing
    expect(decodeClankerLaunch([clankerLaunchedLog({ address: TOKEN })], CLANKER_LAUNCHER, TOKEN, CLANKER_FEE_LOCKER)).toBeNull();
    expect(decodeClankerLaunch([clankerLaunchedLog({ token: CREATOR })], CLANKER_LAUNCHER, TOKEN, CLANKER_FEE_LOCKER)).toBeNull();
    expect(decodeClankerLaunch([fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER })], CLANKER_LAUNCHER, TOKEN, CLANKER_FEE_LOCKER)).toBeNull();
    expect(clankerDetailsOf({ clanker: expectedDetails })).toEqual(expectedDetails);
    expect(clankerDetailsOf({})).toBeNull();
    expect(clankerDetailsOf({ clanker: { ...expectedDetails, locker: 'nope' } })).toBeNull();
  });

  it('pollLaunches follows both launchers with one cursor and registers each agent under its source, with the Clanker details from the receipt', async () => {
    const KERNEL_8: Address = '0x2000000000000000000000000000000000000008';
    const TOKEN_8: Address = '0x3000000000000000000000000000000000000008';
    const world = await makeWorld({
      config: { BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER },
      chain: {
        logs: [fakeLaunchLog(7n), fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER, token: TOKEN_8, kernel: KERNEL_8 })],
        blockNumber: 50n,
        receipts: { [CLANKER_TX]: [fakeLaunchLog(7n), launchContextLog(bootrContext(DRAFT)), fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER, token: TOKEN_8, kernel: KERNEL_8 }), launchContextLog(bootrContext(DRAFT), { token: TOKEN_8, address: CLANKER_LAUNCHER }), clankerLaunchedLog({ token: TOKEN_8 })] },
      },
    });
    try {
      expect(world.ctx.chain.launchers.map((l) => l.source)).toEqual(['bootr', 'clanker']);
      expect(await pollLaunches(world.ctx)).toBe(2);
      const bootr = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') }))!;
      const clanker = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!;
      expect(bootr).toMatchObject({ source: 'bootr', token: TOKEN, kernel: KERNEL, draftId: DRAFT });
      expect(bootr.config).toMatchObject({ source: 'bootr' });
      expect(bootr.config.clanker).toBeUndefined();
      expect(clanker).toMatchObject({ source: 'clanker', token: TOKEN_8, kernel: KERNEL_8, draftId: DRAFT });
      expect(clanker.config).toMatchObject({ source: 'clanker', clanker: expectedDetails });
      expect((await world.db.query.cursors.findFirst({ where: eq(cursors.name, 'launcher_block') }))!.value).toBe('50');

      // the session-key policy follows the source: RWAGMI locker for the Bootr agent, the Clanker lockers for the other
      const bootrPolicy = sessionPolicyFor(world.ctx, bootr, 1_900_000_000);
      expect(bootrPolicy).toMatchObject({ source: 'bootr', feeLocker: RWAGMI_LP_LOCKER, rulesVersion: 4 });
      expect(bootrPolicy.lpLocker).toBeUndefined();
      const clankerPolicy = sessionPolicyFor(world.ctx, clanker, 1_900_000_000);
      expect(clankerPolicy).toMatchObject({ source: 'clanker', feeLocker: CLANKER_FEE_LOCKER, lpLocker: CLANKER_LP_LOCKER, token: TOKEN_8, kernel: KERNEL_8, rulesVersion: 4 });
      expect(clankerLockersFor(world.ctx, clanker)).toMatchObject({ lpLocker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER });
    } finally {
      await world.close();
    }
  });

  it('a Clanker agent whose launch receipt was unreadable gets its details on a later tick; the configured lockers serve meanwhile', async () => {
    const world = await makeWorld({ config: { BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER }, chain: { logs: [fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER })], blockNumber: 50n } });
    try {
      // no receipt in the mock: getTransactionReceipt throws, registration still succeeds
      expect(await pollLaunches(world.ctx)).toBe(1);
      let agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!;
      expect(agent.source).toBe('clanker');
      expect(agent.draftId).toBeNull();
      expect(clankerDetailsOf(agent.config)).toBeNull();
      expect(clankerLockersFor(world.ctx, agent)).toMatchObject({ lpLocker: CLANKER_LP_LOCKER, feeLocker: CLANKER_FEE_LOCKER, details: null });
      // a launch that named another locker: once the receipt is readable, that locker is stored and used
      const OTHER_LOCKER: Address = '0x00000000000000000000000000000000000000D1';
      world.state.receipts[CLANKER_TX] = [fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER }), launchContextLog(bootrContext(DRAFT), { address: CLANKER_LAUNCHER }), clankerLaunchedLog({ locker: OTHER_LOCKER })];
      await completeOnboarding(world.ctx);
      agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!;
      expect(agent.draftId).toBe(DRAFT);
      expect(clankerDetailsOf(agent.config)).toEqual({ ...expectedDetails, locker: OTHER_LOCKER });
      expect(clankerLockersFor(world.ctx, agent)).toMatchObject({ lpLocker: OTHER_LOCKER, feeLocker: CLANKER_FEE_LOCKER });
      expect(sessionPolicyFor(world.ctx, agent, 1_900_000_000)).toMatchObject({ source: 'clanker', lpLocker: OTHER_LOCKER, feeLocker: CLANKER_FEE_LOCKER });
      // decoded once; later ticks do not re-read the receipt
      const reads = world.state.calls.filter((c) => c.fn === 'getTransactionReceipt').length;
      await completeOnboarding(world.ctx);
      expect(world.state.calls.filter((c) => c.fn === 'getTransactionReceipt')).toHaveLength(reads);
    } finally {
      await world.close();
    }
  });

  it('buildLaunchConfig stores the source and, for a Clanker launch, the details', async () => {
    const world = await makeWorld();
    try {
      const launch = { ...decodeLaunchLogs([fakeLaunchLog(8n, { launcher: CLANKER_LAUNCHER })])[0]!, source: 'clanker' as const };
      const config = buildLaunchConfig(world.ctx, launch, { name: 'C', symbol: 'C' }, '', undefined, expectedDetails);
      expect(config).toMatchObject({ source: 'clanker', clanker: expectedDetails });
      const bootr = buildLaunchConfig(world.ctx, { ...launch, source: 'bootr' }, { name: 'C', symbol: 'C' }, '', undefined, expectedDetails);
      expect(bootr).toMatchObject({ source: 'bootr' });
      expect(bootr.clanker).toBeUndefined();
    } finally {
      await world.close();
    }
  });
});
