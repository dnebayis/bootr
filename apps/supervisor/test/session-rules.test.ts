/**
 * Session rules per power (src/session-rules.ts; docs/design/agent-capabilities.md section 8 item 2).
 *
 * The fixture test/fixtures/session-policy-layout4.json was written by the code of commit 47f1a95 (one standard
 * policy for every agent, rule layout 4) for the test constants below: the rules, their `abi.encode(Rule[])` and the
 * whole validatorData. The first tests pin the new module to those bytes, for a Bootr and a Clanker agent, through
 * `callPolicyRules` on a stored policy and through `sessionPolicyFor` on a seeded row.
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { pino } from 'pino';
import { decodeAbiParameters, parseAbiParameters, slice, type Address, type Hex } from 'viem';
import { AGENT_ID, CLANKER_FEE_LOCKER, CLANKER_LP_LOCKER, KERNEL, makeWorld, mockAdminSigner, RWAGMI_LP_LOCKER, seedAgent, SPENDER, TOKEN, type TestWorld } from './helpers.js';
import { agents, cursors } from '../src/db/schema.js';
import { buildValidatorData, decodeCallPolicyData, deserializeSessionPolicy, encodeCallPolicyData, serializeSessionPolicy, type SerializedSessionPolicy, type SessionPolicyParams } from '../src/session-key.js';
import {
  ALWAYS_ON_SESSION_POWERS,
  CALL_POLICY_MAX_RULES,
  CALL_POLICY_RULES_VERSION,
  callPolicyRules,
  CallPolicyOp,
  diffRuleLabels,
  formatRuleDiff,
  FUNDING_RULE_INDEX,
  registerSessionRuleProvider,
  SESSION_POWER_ORDER,
  sessionKeyNeedsReinstall,
  sessionPowersOf,
  sessionRuleLabelsFor,
  sessionRuleProvider,
  sessionRulesFor,
  sessionRulesMeta,
  sessionRulesMetaOf,
  sessionRulesStatus,
  storedRuleLabels,
  type SessionRuleProvider,
} from '../src/session-rules.js';
import { installSessionKey, lastRulesRotationAt, rotateExpiringSessionKeys, rotateSessionKey, RULES_ROTATION_MIN_INTERVAL_MS, sessionPolicyFor } from '../src/onboarding.js';

interface FixtureEntry {
  policy: SerializedSessionPolicy;
  rules: { target: Address; selector: Hex; windowSeconds: number; args: { index: number; op: number; value: Hex }[] }[];
  callPolicyData: Hex;
  validatorData: Hex;
}
const fixture = JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout4.json', import.meta.url), 'utf8')) as { bootr: FixtureEntry; clanker: FixtureEntry };

const STANDARD_LABELS = ['claims.settleAndClaim', 'claims.claimQuote', 'swap.approveWeth', 'swap.swapWethToUsdc', 'treasury.fundSpender', 'treasury.withdrawWethForGas'];
const CLANKER_LABELS = ['claims.collectRewards', 'claims.claim', ...STANDARD_LABELS.slice(2)];

/** A placeholder `BootrTradeHelper` and the rules the Trade power would add: approve the coin to it, call its swap. */
const TRADE_HELPER: Address = '0xd000000000000000000000000000000000000000';
const TRADE_SWAP_SELECTOR: Hex = '0x12345678';
const fakeTrade: SessionRuleProvider = () => [
  { power: 'trade', label: 'trade.approveCoin', build: (p) => ({ target: p.token, selector: '0x095ea7b3', windowSeconds: 0, args: [{ index: 0, op: CallPolicyOp.EQUAL, value: `0x${'0'.repeat(24)}${TRADE_HELPER.slice(2)}` as Hex }] }) },
  { power: 'trade', label: 'trade.swap', build: () => ({ target: TRADE_HELPER, selector: TRADE_SWAP_SELECTOR, windowSeconds: 0, args: [] }) },
];

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});
const withFakeTrade = (provider: SessionRuleProvider = fakeTrade) => restores.push(registerSessionRuleProvider('trade', provider));

const strip = (rules: ReturnType<typeof sessionRulesFor>) => rules.map(({ target, selector, windowSeconds, args }) => ({ target, selector, windowSeconds, args }));

describe('identity with the standard policy of before (fixture of commit 47f1a95, rule layout 4)', () => {
  for (const [name, entry, labels] of [
    ['bootr', fixture.bootr, STANDARD_LABELS],
    ['clanker', fixture.clanker, CLANKER_LABELS],
  ] as const) {
    it(`${name}: a stored policy without rules metadata builds the same rules, the same abi.encode(Rule[]) and the same validatorData`, () => {
      const policy = deserializeSessionPolicy(entry.policy);
      expect(policy.rules).toBeUndefined();
      expect(callPolicyRules(policy)).toEqual(entry.rules);
      expect(encodeCallPolicyData(callPolicyRules(policy))).toBe(entry.callPolicyData);
      expect(buildValidatorData(policy)).toBe(entry.validatorData);
      // the always-on powers, labelled, are those same rules in the same order
      const rules = sessionRulesFor(ALWAYS_ON_SESSION_POWERS, policy);
      expect(strip(rules)).toEqual(entry.rules);
      expect(rules.map((r) => r.label)).toEqual(labels);
      expect(rules.map((r) => r.power)).toEqual(['claims', 'claims', 'swap', 'swap', 'treasury', 'treasury']);
      expect(rules[FUNDING_RULE_INDEX]!.label).toBe('treasury.fundSpender');
      // and a policy that carries the metadata (as every policy built from now on does) encodes the same bytes
      const withMeta: SessionPolicyParams = { ...policy, rules: sessionRulesMeta(ALWAYS_ON_SESSION_POWERS, rules) };
      expect(callPolicyRules(withMeta)).toEqual(entry.rules);
      expect(buildValidatorData(withMeta)).toBe(entry.validatorData);
      expect(storedRuleLabels(policy)).toEqual(labels);
      expect(storedRuleLabels(withMeta)).toEqual(labels);
    });
  }

  it('sessionPolicyFor on a seeded row: the same validatorData as before, now with rules metadata on the policy', async () => {
    const world = await makeWorld();
    try {
      const bootr = await seedAgent(world);
      const policy = sessionPolicyFor(world.ctx, bootr, 1_800_000_000);
      expect(buildValidatorData(policy)).toBe(fixture.bootr.validatorData);
      expect(policy.rules).toEqual({ version: 1, powers: ['claims', 'swap', 'treasury'], items: STANDARD_LABELS.map((label) => ({ label, power: label.split('.')[0] })) });
      // the stored form round-trips with the metadata and without the bigints
      const stored = serializeSessionPolicy(policy);
      expect(stored.rules).toEqual(policy.rules);
      expect(typeof stored.usdcTransferCap).toBe('string');
      expect(buildValidatorData(deserializeSessionPolicy(JSON.parse(JSON.stringify(stored)) as SerializedSessionPolicy))).toBe(fixture.bootr.validatorData);
      // a Clanker agent (no launch details stored: the configured lockers serve) matches its fixture too
      await world.db.update(agents).set({ source: 'clanker' }).where(eq(agents.agentId, AGENT_ID));
      const clanker = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const clankerPolicy = sessionPolicyFor(world.ctx, clanker, 1_800_000_000);
      expect(clankerPolicy).toMatchObject({ source: 'clanker', feeLocker: CLANKER_FEE_LOCKER, lpLocker: CLANKER_LP_LOCKER, token: TOKEN, kernel: KERNEL, spender: SPENDER});
      expect(buildValidatorData(clankerPolicy)).toBe(fixture.clanker.validatorData);
      expect(clankerPolicy.rules!.items.map((i) => i.label)).toEqual(CLANKER_LABELS);
      expect(clankerPolicy.feeLocker).not.toBe(RWAGMI_LP_LOCKER);
    } finally {
      await world.close();
    }
  });
});

describe('sessionRulesFor: powers to rules, as data', () => {
  const inputs = () => deserializeSessionPolicy(fixture.bootr.policy);

  it('a power with a provider adds its rules after the always-on set; indexes of the shared rules do not move', () => {
    withFakeTrade();
    const rules = sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], inputs());
    expect(rules).toHaveLength(8);
    expect(strip(rules).slice(0, 6)).toEqual(fixture.bootr.rules);
    expect(rules.slice(6).map((r) => r.label)).toEqual(['trade.approveCoin', 'trade.swap']);
    expect(rules[6]).toMatchObject({ power: 'trade', target: TOKEN, selector: '0x095ea7b3' });
    expect(rules[7]).toMatchObject({ power: 'trade', target: TRADE_HELPER, selector: TRADE_SWAP_SELECTOR });
    expect(rules[FUNDING_RULE_INDEX]!.label).toBe('treasury.fundSpender');
    // the order on chain is SESSION_POWER_ORDER, whatever order the powers are named in
    expect(strip(sessionRulesFor(['trade', 'treasury', 'claims', 'swap'], inputs()))).toEqual(strip(rules));
    // metadata records the powers in canonical order and one item per rule
    const meta = sessionRulesMeta(['trade', 'claims', 'swap', 'treasury'], rules);
    expect(meta).toEqual({ version: 1, powers: ['claims', 'swap', 'treasury', 'trade'], items: rules.map((r) => ({ label: r.label, power: r.power })) });
    expect(sessionRulesMetaOf(JSON.parse(JSON.stringify(meta)))).toEqual(meta);
    // a stored policy with that metadata rebuilds the eight rules (callPolicyRules follows rules.powers)
    expect(callPolicyRules({ ...inputs(), rules: meta })).toEqual(strip(rules));
    expect(decodeCallPolicyData(encodeCallPolicyData(callPolicyRules({ ...inputs(), rules: meta })))).toHaveLength(8);
    // labels alone need no addresses
    expect(sessionRuleLabelsFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], { source: 'bootr', rulesVersion: CALL_POLICY_RULES_VERSION })).toEqual([...STANDARD_LABELS, 'trade.approveCoin', 'trade.swap']);
    expect(sessionRuleLabelsFor(ALWAYS_ON_SESSION_POWERS, { source: 'clanker', rulesVersion: CALL_POLICY_RULES_VERSION })).toEqual(CLANKER_LABELS);
    // layout 2 had no gas rule
    expect(sessionRuleLabelsFor(ALWAYS_ON_SESSION_POWERS, { source: 'bootr', rulesVersion: 2 })).toEqual(STANDARD_LABELS.slice(0, 5));
  });

  it('refuses a rule set over BootrCallPolicy.MAX_RULES, a power without a provider, an unknown power and duplicate labels', () => {
    expect(CALL_POLICY_MAX_RULES).toBe(8);
    withFakeTrade(() => [...fakeTrade({ source: 'bootr', rulesVersion: 4 }), { power: 'trade', label: 'trade.third', build: () => ({ target: TRADE_HELPER, selector: '0xabcdef01', windowSeconds: 0, args: [] }) }]);
    expect(() => sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], inputs())).toThrow(/over the BootrCallPolicy limit: 9 rules .* at most 8 \(.*trade\.third\)/);
    // no provider is registered for bounties today (and none for trade outside this test)
    expect(sessionRuleProvider('bounties')).toBeUndefined();
    expect(() => sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'bounties'], inputs())).toThrow(/bounties power is on but has no session rule provider/);
    expect(() => sessionRulesFor(['claims', 'nope' as never], inputs())).toThrow(/unknown session power nope/);
    expect(() => registerSessionRuleProvider('nope' as never, fakeTrade)).toThrow(/unknown session power/);
    restores.pop()!();
    withFakeTrade(() => [{ power: 'trade', label: 'swap.approveWeth', build: () => ({ target: TRADE_HELPER, selector: '0xabcdef01', windowSeconds: 0, args: [] }) }]);
    expect(() => sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], inputs())).toThrow(/duplicate session rule label swap\.approveWeth/);
    restores.pop()!();
    withFakeTrade(() => [{ power: 'bounties', label: 'bounties.propose', build: () => ({ target: TRADE_HELPER, selector: '0xabcdef01', windowSeconds: 0, args: [] }) }]);
    expect(() => sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], inputs())).toThrow(/trade provider produced a rule of power bounties/);
    expect(SESSION_POWER_ORDER).toEqual(['claims', 'swap', 'treasury', 'trade', 'bounties']);
  });

  it('after a test restores the registry, trade has no provider again', () => {
    expect(sessionRuleProvider('trade')).toBeUndefined();
    expect(() => sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], inputs())).toThrow(/trade power is on but has no session rule provider/);
  });

  it('sessionPowersOf: the treasury loop whatever the config says; trade from the raw capabilities block; bounties only once its provider exists (stage A asks nothing of the key)', () => {
    expect(sessionPowersOf({})).toEqual(['claims', 'swap', 'treasury']);
    expect(sessionPowersOf({ capabilities: { treasury: false, xRead: true } })).toEqual(['claims', 'swap', 'treasury']);
    expect(sessionPowersOf({ capabilities: { trade: true } })).toEqual(['claims', 'swap', 'treasury', 'trade']);
    // the bounties power is a console switch since stage A, but nothing on chain: the key's rules do not change
    expect(sessionPowersOf({ capabilities: { trade: 'yes', bounties: true } })).toEqual(['claims', 'swap', 'treasury']);
    const restore = registerSessionRuleProvider('bounties', () => [{ power: 'bounties', label: 'bounties.open', build: () => ({ target: TRADE_HELPER, selector: '0xabcdef02', windowSeconds: 0, args: [] }) }]);
    try {
      expect(sessionPowersOf({ capabilities: { trade: 'yes', bounties: true } })).toEqual(['claims', 'swap', 'treasury', 'bounties']);
    } finally {
      restore();
    }
    expect(sessionPowersOf({ capabilities: [] })).toEqual(['claims', 'swap', 'treasury']);
  });
});

describe('deserializeSessionPolicy stays compatible with rows stored before the metadata', () => {
  it('a layout-4 row without `rules`, a layout-2 row and a legacy row all read back; labels follow what can be rebuilt', () => {
    const v4 = deserializeSessionPolicy(fixture.bootr.policy);
    expect(v4.usdcTransferCap).toBe(50_000_000n);
    expect(v4.gasAllowanceWei).toBe(10n ** 17n);
    expect(v4.rules).toBeUndefined();
    expect(storedRuleLabels(v4)).toEqual(STANDARD_LABELS);
    const v2 = deserializeSessionPolicy({ ...fixture.bootr.policy, rulesVersion: 2 });
    expect(storedRuleLabels(v2)).toEqual(STANDARD_LABELS.slice(0, 5));
    expect(callPolicyRules(v2)).toEqual(fixture.bootr.rules.slice(0, 5));
    const legacy = { ...fixture.bootr.policy } as Partial<SerializedSessionPolicy>;
    delete legacy.rulesVersion;
    expect(storedRuleLabels(deserializeSessionPolicy(legacy as SerializedSessionPolicy))).toBeNull();
    expect(() => callPolicyRules(deserializeSessionPolicy(legacy as SerializedSessionPolicy))).toThrow(/legacy rule layout/);
    // malformed metadata is ignored, not trusted
    expect(sessionRulesMetaOf(null)).toBeNull();
    expect(sessionRulesMetaOf({ version: 1, powers: ['claims', 'nope'], items: [] })).toBeNull();
    expect(sessionRulesMetaOf({ version: 1, powers: ['claims'], items: [{ label: 1, power: 'claims' }] })).toBeNull();
    expect(storedRuleLabels({ ...v4, rules: { version: 1, powers: ['claims', 'nope' as never], items: [] } })).toEqual(STANDARD_LABELS);
  });
});

describe('sessionRulesStatus / sessionKeyNeedsReinstall', () => {
  const stored = () => ({ permissionId: '0x11223344', sessionPolicy: fixture.bootr.policy as unknown as Record<string, unknown>, source: 'bootr' });

  it('no stored policy: nothing to reinstall, the wanted set is for the current layout and the agent source', () => {
    expect(sessionRulesStatus({ permissionId: null, sessionPolicy: null, source: 'bootr' }, {})).toEqual({ current: [], wanted: STANDARD_LABELS, reinstallNeeded: false });
    expect(sessionRulesStatus({ permissionId: null, sessionPolicy: null, source: 'clanker' }, {})).toEqual({ current: [], wanted: CLANKER_LABELS, reinstallNeeded: false });
    expect(sessionRulesStatus({ permissionId: '0x11223344', sessionPolicy: null, source: 'bootr' }, { capabilities: { trade: true } })).toMatchObject({ reinstallNeeded: false, error: expect.stringMatching(/no session rule provider/) });
  });

  it('a stored standard policy matches a config without new powers; a power switched on that adds rules asks for a reinstall', () => {
    expect(sessionRulesStatus(stored(), {})).toEqual({ current: STANDARD_LABELS, wanted: STANDARD_LABELS, reinstallNeeded: false });
    expect(sessionKeyNeedsReinstall(stored(), { capabilities: { xRead: true, services: true } })).toBe(false);
    // the power is on but no contract exists yet: reported, never rotated
    expect(sessionRulesStatus(stored(), { capabilities: { trade: true } })).toEqual({ current: STANDARD_LABELS, wanted: STANDARD_LABELS, reinstallNeeded: false, error: expect.stringMatching(/trade power is on but has no session rule provider/) });
    withFakeTrade();
    expect(sessionRulesStatus(stored(), { capabilities: { trade: true } })).toEqual({ current: STANDARD_LABELS, wanted: [...STANDARD_LABELS, 'trade.approveCoin', 'trade.swap'], reinstallNeeded: true });
    expect(sessionKeyNeedsReinstall(stored(), { capabilities: { trade: true } })).toBe(true);
    // the power switched off again on a key that has the rules: a reinstall too (the extra rules must go)
    const withTrade = { ...stored(), sessionPolicy: { ...fixture.bootr.policy, rules: sessionRulesMeta([...ALWAYS_ON_SESSION_POWERS, 'trade'], sessionRulesFor([...ALWAYS_ON_SESSION_POWERS, 'trade'], deserializeSessionPolicy(fixture.bootr.policy))) } as unknown as Record<string, unknown> };
    expect(sessionRulesStatus(withTrade, {})).toEqual({ current: [...STANDARD_LABELS, 'trade.approveCoin', 'trade.swap'], wanted: STANDARD_LABELS, reinstallNeeded: true });
    expect(sessionRulesStatus(withTrade, { capabilities: { trade: true } }).reinstallNeeded).toBe(false);
    // no permission installed yet (a half-done install): the install itself builds from the config
    expect(sessionRulesStatus({ ...stored(), permissionId: null }, { capabilities: { trade: true } }).reinstallNeeded).toBe(false);
  });

  it('a layout difference alone does not ask for a reinstall (layout bumps follow the expiry rotation, as before)', () => {
    const v2 = { ...stored(), sessionPolicy: { ...fixture.bootr.policy, rulesVersion: 2 } as unknown as Record<string, unknown> };
    expect(sessionRulesStatus(v2, {})).toEqual({ current: STANDARD_LABELS.slice(0, 5), wanted: STANDARD_LABELS.slice(0, 5), reinstallNeeded: false });
    const legacy = { ...fixture.bootr.policy } as Record<string, unknown>;
    delete legacy.rulesVersion;
    expect(sessionRulesStatus({ ...stored(), sessionPolicy: legacy }, {})).toEqual({ current: [], wanted: STANDARD_LABELS.slice(0, 5), reinstallNeeded: false });
  });

  it('diffRuleLabels / formatRuleDiff', () => {
    expect(diffRuleLabels(STANDARD_LABELS, [...STANDARD_LABELS, 'trade.swap'])).toEqual({ added: ['trade.swap'], removed: [] });
    expect(formatRuleDiff(diffRuleLabels(['a', 'b'], ['b', 'c']))).toBe('+c, -a');
    expect(formatRuleDiff(diffRuleLabels(['a'], ['a']))).toBe('');
  });
});

// ---------------------------------------------------------------------------
// Install, rotation and the tick's scan (self-bundled enable path, mocked admin signer and chain)
// ---------------------------------------------------------------------------

function captureLogs(world: TestWorld): string[] {
  const lines: string[] = [];
  world.ctx.log = pino({ level: 'info' }, { write: (line: string) => void lines.push(line) });
  return lines;
}

const parsed = (lines: string[]) => lines.map((l) => JSON.parse(l) as { msg: string; added?: string[]; removed?: string[]; rules?: string[]; powers?: string[]; change?: string });

/** A world whose agent has today's standard key installed and stored (`permissionId` 0xdeadbeef). */
async function worldWithStandardKey(configOver: Record<string, unknown> = {}) {
  const world = await makeWorld({ config: { ENABLE_MODE_SELF_BUNDLE: 'true' }, chain: { sessionInstalled: false } });
  const admin = mockAdminSigner();
  world.ctx.adminSigner = admin.signer;
  const seeded = await seedAgent(world, { config: configOver, agent: { permissionId: '0xdeadbeef', sessionValidUntil: new Date(world.ctx.now() + 20 * 86_400_000) } });
  const policy = sessionPolicyFor(world.ctx, seeded, Math.floor(world.ctx.now() / 1000) + 20 * 86_400);
  await world.db
    .update(agents)
    .set({ validatorData: buildValidatorData(policy), sessionPolicy: serializeSessionPolicy(policy) as unknown as Record<string, unknown> })
    .where(eq(agents.agentId, seeded.agentId));
  const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, seeded.agentId) }))!;
  return { world, admin, agent };
}

const row = (world: TestWorld) => world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }).then((r) => r!);
const ruleCount = (validatorData: string) => {
  const [entries] = decodeAbiParameters(parseAbiParameters('bytes[]'), validatorData as Hex);
  return decodeCallPolicyData(slice(entries[0]!, 22)).length;
};

describe('rotation re-applies the agent\'s own rule set and logs the change', () => {
  it('a power switched on since the install: rotation rebuilds from the current config (+trade rules) and says so', async () => {
    withFakeTrade();
    const { world, admin, agent } = await worldWithStandardKey();
    try {
      // the creator switches Trade on in the console (stored on the config like every other power)
      await world.db.update(agents).set({ config: { ...agent.config, capabilities: { ...(agent.config.capabilities as object), trade: true } } }).where(eq(agents.agentId, AGENT_ID));
      const lines = captureLogs(world);
      const result = await rotateSessionKey(world.ctx, await row(world));
      const change = parsed(lines).find((l) => l.msg.startsWith('rotation changes rules'));
      expect(change).toMatchObject({ msg: 'rotation changes rules: +trade.approveCoin, +trade.swap', added: ['trade.approveCoin', 'trade.swap'], removed: [], powers: ['claims', 'swap', 'treasury', 'trade'] });
      expect(change!.rules).toEqual([...STANDARD_LABELS, 'trade.approveCoin', 'trade.swap']);
      expect(admin.revoked).toEqual(['0xdeadbeef']);
      const after = await row(world);
      expect(after.permissionId).toBe(result.permissionId);
      expect((after.sessionPolicy as { rules: unknown }).rules).toEqual({ version: 1, powers: ['claims', 'swap', 'treasury', 'trade'], items: [...STANDARD_LABELS, 'trade.approveCoin', 'trade.swap'].map((label) => ({ label, power: label.split('.')[0] })) });
      expect(ruleCount(after.validatorData!)).toBe(8);
      expect(admin.approved[0]!.validatorData).toBe(after.validatorData);
      expect(sessionRulesStatus(after, after.config).reinstallNeeded).toBe(false);
      // the key the install reuses on a retry carries the eight rules too (deinit data of the rotated key is unchanged in shape)
      expect(callPolicyRules(deserializeSessionPolicy(after.sessionPolicy as unknown as SerializedSessionPolicy))).toHaveLength(8);
    } finally {
      await world.close();
    }
  });

  it('nothing changed: rotation keeps the rules, byte for byte, and logs that', async () => {
    const { world, agent } = await worldWithStandardKey();
    try {
      const lines = captureLogs(world);
      await rotateSessionKey(world.ctx, agent);
      const keep = parsed(lines).find((l) => l.msg === 'rotation keeps the rules');
      expect(keep).toMatchObject({ rules: STANDARD_LABELS, powers: ['claims', 'swap', 'treasury'] });
      expect(parsed(lines).some((l) => l.msg.startsWith('rotation changes rules'))).toBe(false);
      const after = await row(world);
      expect(ruleCount(after.validatorData!)).toBe(6);
      // same call-policy bytes as the key it replaced (only the timestamp policy differs)
      const callPolicyOf = (v: string) => slice(decodeAbiParameters(parseAbiParameters('bytes[]'), v as Hex)[0][0]!, 22);
      expect(callPolicyOf(after.validatorData!)).toBe(callPolicyOf(agent.validatorData!));
    } finally {
      await world.close();
    }
  });

  it('a first install (no policy stored) logs the rules it grants', async () => {
    const world = await makeWorld({ config: { ENABLE_MODE_SELF_BUNDLE: 'true' }, chain: { sessionInstalled: false } });
    world.ctx.adminSigner = mockAdminSigner().signer;
    try {
      const agent = await seedAgent(world, { agent: { status: 'onboarding', permissionId: null, sessionKeyInstalledAt: null } });
      const lines = captureLogs(world);
      await installSessionKey(world.ctx, agent);
      expect(parsed(lines).find((l) => l.msg === 'session rules')).toMatchObject({ rules: STANDARD_LABELS, powers: ['claims', 'swap', 'treasury'] });
      expect(((await row(world)).sessionPolicy as { rules: { items: unknown[] } }).rules.items).toHaveLength(6);
    } finally {
      await world.close();
    }
  });
});

describe('rotateExpiringSessionKeys also rotates keys whose rules are behind the config, once a day per agent', () => {
  it('rotates an active agent whose config gained a power with rules; a second scan finds nothing to do', async () => {
    withFakeTrade();
    const { world, admin, agent } = await worldWithStandardKey();
    try {
      // standard key, far from expiry, config unchanged: the scan leaves it alone
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(0);
      await world.db.update(agents).set({ config: { ...agent.config, capabilities: { ...(agent.config.capabilities as object), trade: true } } }).where(eq(agents.agentId, AGENT_ID));
      const lines = captureLogs(world);
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
      expect(admin.revoked).toEqual(['0xdeadbeef']);
      expect(parsed(lines).find((l) => l.msg === 'session rules behind the config; rotating the key')).toMatchObject({ change: '+trade.approveCoin, +trade.swap' });
      expect(ruleCount((await row(world)).validatorData!)).toBe(8);
      expect(await lastRulesRotationAt(world.ctx, AGENT_ID)).toBe(world.ctx.now());
      // the rules now match: no second rotation, even a day later
      world.setNow(world.ctx.now() + 2 * RULES_ROTATION_MIN_INTERVAL_MS);
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
    } finally {
      await world.close();
    }
  });

  it('a failing rotation is not retried before a day has passed, and is retried after it', async () => {
    withFakeTrade();
    const { world, admin, agent } = await worldWithStandardKey();
    try {
      await world.db.update(agents).set({ config: { ...agent.config, capabilities: { ...(agent.config.capabilities as object), trade: true } } }).where(eq(agents.agentId, AGENT_ID));
      // the admin transaction itself fails (nothing stored, the row keeps the old key and its outdated rules)
      let approveAttempts = 0;
      const inner = admin.signer;
      world.ctx.adminSigner = {
        ...inner,
        approveSessionKey: async () => {
          approveAttempts += 1;
          throw new Error('admin tx failed: insufficient funds for gas');
        },
      };
      const lines = captureLogs(world);
      await rotateExpiringSessionKeys(world.ctx);
      expect(approveAttempts).toBe(1);
      expect(parsed(lines).find((l) => l.msg === 'session key rotation failed')).toMatchObject({ reason: 'outdated_rules' });
      expect((await row(world)).permissionId).toBe('0xdeadbeef');
      expect(sessionRulesStatus(await row(world), (await row(world)).config).reinstallNeeded).toBe(true);
      const first = await lastRulesRotationAt(world.ctx, AGENT_ID);
      expect(first).toBe(world.ctx.now());
      // same tick again, and an hour later: still outdated, but no new attempt (the tick runs every minute)
      await rotateExpiringSessionKeys(world.ctx);
      world.setNow(world.ctx.now() + 3_600_000);
      await rotateExpiringSessionKeys(world.ctx);
      expect(approveAttempts).toBe(1);
      // a day later the scan tries once more; with the admin back it goes through
      world.ctx.adminSigner = inner;
      world.setNow(first! + RULES_ROTATION_MIN_INTERVAL_MS);
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
      expect(admin.revoked).toEqual(['0xdeadbeef']);
      expect(ruleCount((await row(world)).validatorData!)).toBe(8);
      expect(await lastRulesRotationAt(world.ctx, AGENT_ID)).toBe(world.ctx.now());
      expect((await world.db.query.cursors.findFirst({ where: eq(cursors.name, `session_rules_rotation:${AGENT_ID}`) }))!.value).toBe(String(world.ctx.now()));
    } finally {
      await world.close();
    }
  });

  it('an install that fails after the admin approval keeps the new policy on the row (as before): the rules path does not retry it, a retry reuses the stored permission', async () => {
    withFakeTrade();
    const { world, admin, agent } = await worldWithStandardKey();
    try {
      await world.db.update(agents).set({ config: { ...agent.config, capabilities: { ...(agent.config.capabilities as object), trade: true } } }).where(eq(agents.agentId, AGENT_ID));
      admin.outcome = new Error('EntryPoint.handleOps failed: FailedOpWithRevert(0, "AA23 reverted", EnableNotApproved())');
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
      const after = await row(world);
      expect(after.permissionId).toBe(admin.approved[0]!.permissionId);
      expect(ruleCount(after.validatorData!)).toBe(8);
      expect(sessionRulesStatus(after, after.config).reinstallNeeded).toBe(false);
      world.setNow(world.ctx.now() + 2 * RULES_ROTATION_MIN_INTERVAL_MS);
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
    } finally {
      await world.close();
    }
  });

  it('leaves alone: agents that are not active, powers without a provider, and the expiry path keeps its own rule', async () => {
    const { world, admin, agent } = await worldWithStandardKey();
    try {
      const traded = { ...agent.config, capabilities: { ...(agent.config.capabilities as object), trade: true } };
      // trade on, but no provider exists: the console shows the error, nothing is rotated
      await world.db.update(agents).set({ config: traded }).where(eq(agents.agentId, AGENT_ID));
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(0);
      expect(sessionRulesStatus(await row(world), traded).error).toMatch(/no session rule provider/);
      // provider present but the agent is paused by the operator (not active): untouched
      withFakeTrade();
      await world.db.update(agents).set({ status: 'paused' }).where(eq(agents.agentId, AGENT_ID));
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(0);
      expect(await lastRulesRotationAt(world.ctx, AGENT_ID)).toBeNull();
      // an expiring key rotates as before, without touching the daily counter of the rules path
      await world.db.update(agents).set({ status: 'active', config: agent.config, sessionValidUntil: new Date(world.ctx.now() + 86_400_000) }).where(eq(agents.agentId, AGENT_ID));
      await rotateExpiringSessionKeys(world.ctx);
      expect(admin.approved).toHaveLength(1);
      expect(await lastRulesRotationAt(world.ctx, AGENT_ID)).toBeNull();
      expect(ruleCount((await row(world)).validatorData!)).toBe(6);
    } finally {
      await world.close();
    }
  });
});
