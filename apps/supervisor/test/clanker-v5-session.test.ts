/**
 * The supervisor side of the Clanker v5 migration (docs/design/clanker-v5-migration.md section 3).
 *
 * - session rules: a `clanker-v5` agent gets rule layout 5, one `FeeEscrow.claimFor(kernel, *)` rule in front of the
 *   shared swap / treasury rules (funding rule at index 3), pinned literally here and by
 *   test/fixtures/session-policy-layout5-clanker-v5.json; Bootr (RWAGMI) and Clanker v4 agents keep layout 4 and the
 *   bytes of test/fixtures/session-policy-layout4.json (commit 47f1a95), checked again here through `sessionPolicyFor`;
 * - onboarding: an `AgentLaunched` from `BootrClankerLauncherV5` registers a `clanker-v5` agent with the
 *   `ClankerV5Launched` details from the receipt;
 * The treasury side is in clanker-v5-treasury.test.ts, the fee split in clanker-v5-coin-fees.test.ts.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, pad, parseAbiParameters, slice, toHex, zeroAddress, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, clankerV5FeeEscrowAbi, clankerV5LaunchedEvent, CLANKER_V5_ESCROW_CLAIM_FOR_SELECTOR } from '../src/abi.js';
import { launcherEntries, launchSourceOf } from '../src/chain.js';
import { agents } from '../src/db/schema.js';
import { agentSource, clankerV5DetailsOf, clankerV5EscrowFor } from '../src/launch-source.js';
import { decodeClankerV5Launch, decodeLaunchLogs, pollLaunches, sessionPolicyFor } from '../src/onboarding.js';
import { buildValidatorData, encodeCallPolicyData, type SerializedSessionPolicy } from '../src/session-key.js';
import {
  ALWAYS_ON_SESSION_POWERS,
  CALL_POLICY_RULES_VERSION,
  callPolicyRules,
  CallPolicyOp,
  CLANKER_V5_FUNDING_RULE_INDEX,
  CLANKER_V5_RULES_VERSION,
  FUNDING_RULE_INDEX,
  fundingRuleIndex,
  rulesVersionFor,
  sessionRuleLabelsFor,
  sessionRulesFor,
  sessionRulesStatus,
} from '../src/session-rules.js';
import {
  AGENT_ID,
  CLANKER_FEE_LOCKER,
  CLANKER_LAUNCHER,
  CLANKER_LP_LOCKER,
  CLANKER_V5_FEE_ESCROW,
  CLANKER_V5_HOOK,
  CLANKER_V5_LAUNCHER,
  CLANKER_V5_POOL_ID,
  CREATOR,
  KERNEL,
  LAUNCHER,
  makeWorld,
  RWAGMI_LP_LOCKER,
  seedAgent,
  testConfig,
  TOKEN,
} from './helpers.js';

interface FixtureEntry {
  policy: SerializedSessionPolicy;
  rules: { target: Address; selector: Hex; windowSeconds: number; args: { index: number; op: number; value: Hex }[] }[];
  callPolicyData: Hex;
  validatorData: Hex;
}
const layout4 = JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout4.json', import.meta.url), 'utf8')) as { bootr: FixtureEntry; clanker: FixtureEntry };
const layout5 = JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout5-clanker-v5.json', import.meta.url), 'utf8')) as { 'clanker-v5': FixtureEntry };
const V5 = layout5['clanker-v5'];

const V5_LABELS = ['claims.claimFor', 'swap.approveWeth', 'swap.swapWethToUsdc', 'treasury.fundSpender', 'treasury.withdrawWethForGas'];

/** The `config.clankerV5` block `registerAgent` stores from `ClankerV5Launched`. */
const V5_DETAILS = { poolId: CLANKER_V5_POOL_ID, hook: CLANKER_V5_HOOK, feeEscrow: CLANKER_V5_FEE_ESCROW, quoteToken: zeroAddress, tickSpacing: 200, taxBps: 15_000, antiSnipe: true };

async function v5World(chain: Parameters<typeof makeWorld>[0] = {}) {
  return makeWorld({ ...chain, config: { BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER, ...chain.config } });
}

describe('session rules of a Clanker v5 agent (rule layout 5)', () => {
  it('one claim rule: FeeEscrow 0x5dd237d1…FA61, claimFor(address,address) = 0xb4ba9e11, window 0, word 0 EQUAL the kernel; then the shared rules', async () => {
    const world = await v5World();
    try {
      const agent = await seedAgent(world, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: V5_DETAILS } });
      const policy = sessionPolicyFor(world.ctx, agent, 1_800_000_000);
      expect(policy).toMatchObject({ source: 'clanker-v5', feeLocker: CLANKER_V5_FEE_ESCROW, rulesVersion: 5 });
      expect(policy.lpLocker).toBeUndefined();
      const rules = callPolicyRules(policy);
      // the claim rule, written out by hand
      expect(rules[0]).toEqual({
        target: '0x5dd237d1f716C65426CCd2FAe82B95109825FA61',
        selector: '0xb4ba9e11',
        windowSeconds: 0,
        args: [{ index: 0, op: CallPolicyOp.EQUAL, value: '0x0000000000000000000000002000000000000000000000000000000000000002' }],
      });
      expect(CLANKER_V5_ESCROW_CLAIM_FOR_SELECTOR).toBe('0xb4ba9e11');
      // word 0 of the real call data is the recipient, and it is the kernel
      const data = encodeFunctionData({ abi: clankerV5FeeEscrowAbi, functionName: 'claimFor', args: [KERNEL, zeroAddress] });
      expect(slice(data, 0, 4)).toBe('0xb4ba9e11');
      expect(slice(data, 4, 36).toLowerCase()).toBe(pad(KERNEL, { size: 32 }).toLowerCase());
      expect(slice(data, 36, 68)).toBe(pad(zeroAddress, { size: 32 }));
      // the four shared rules follow, exactly as on the Bootr layout (same targets and arguments, one place earlier)
      expect(rules.slice(1)).toEqual(layout4.bootr.rules.slice(2));
      expect(rules).toEqual(V5.rules);
      expect(sessionRulesFor(ALWAYS_ON_SESSION_POWERS, policy).map((r) => r.label)).toEqual(V5_LABELS);
      expect(policy.rules!.items.map((i) => i.label)).toEqual(V5_LABELS);
      // the funding rule is at index 3, and that is the index the window is read from
      expect(rules[CLANKER_V5_FUNDING_RULE_INDEX]).toMatchObject({ selector: '0xa9059cbb', windowSeconds: 86_400 });
      expect(fundingRuleIndex(policy)).toBe(3);
      // abi.encode(Rule[]) and the whole validatorData match the fixture, and the claim rule's encoding is what an
      // independent encoder makes of the literal values
      expect(encodeCallPolicyData(rules)).toBe(V5.callPolicyData);
      expect(buildValidatorData(policy)).toBe(V5.validatorData);
      const claimOnly = encodeAbiParameters(parseAbiParameters('(address target, bytes4 selector, uint32 windowSeconds, (uint8 index, uint8 op, bytes32 value)[] args)[]'), [
        [{ target: '0x5dd237d1f716C65426CCd2FAe82B95109825FA61', selector: '0xb4ba9e11', windowSeconds: 0, args: [{ index: 0, op: 1, value: pad(KERNEL, { size: 32 }) }] }],
      ]);
      expect(encodeCallPolicyData(rules.slice(0, 1))).toBe(claimOnly.toLowerCase());
      // the stored policy reads back to the same bytes
      const fixturePolicy = { ...V5.policy, usdcTransferCap: BigInt(V5.policy.usdcTransferCap), gasAllowanceWei: BigInt(V5.policy.gasAllowanceWei) };
      expect(callPolicyRules(fixturePolicy)).toEqual(V5.rules);
      expect(buildValidatorData(fixturePolicy)).toBe(V5.validatorData);
    } finally {
      await world.close();
    }
  });

  it('without the stored ClankerV5Launched details the address book escrow serves; a chain without v5 refuses to build the rule', async () => {
    const world = await v5World();
    try {
      const agent = await seedAgent(world, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5' } });
      expect(clankerV5EscrowFor(world.ctx, agent)).toEqual({ feeEscrow: CLANKER_V5_FEE_ESCROW, details: null });
      expect(buildValidatorData(sessionPolicyFor(world.ctx, agent, 1_800_000_000))).toBe(V5.validatorData);
      (world.ctx.chain as { clankerV5: { feeEscrow: Address | null } }).clankerV5 = { feeEscrow: null };
      expect(() => sessionPolicyFor(world.ctx, agent, 1_800_000_000)).toThrow(/clankerV5.feeEscrow address is not configured/);
    } finally {
      await world.close();
    }
  });

  it('layout versions per source: 5 for clanker-v5 only; a v5 policy under an older layout is refused; labels and funding index follow the layout', () => {
    expect(CALL_POLICY_RULES_VERSION).toBe(5);
    expect(CLANKER_V5_RULES_VERSION).toBe(5);
    expect(rulesVersionFor('clanker-v5')).toBe(5);
    expect(rulesVersionFor('bootr')).toBe(4);
    expect(rulesVersionFor('clanker')).toBe(4);
    expect(sessionRuleLabelsFor(ALWAYS_ON_SESSION_POWERS, { source: 'clanker-v5', rulesVersion: 5 })).toEqual(V5_LABELS);
    expect(() => sessionRuleLabelsFor(ALWAYS_ON_SESSION_POWERS, { source: 'clanker-v5', rulesVersion: 4 })).toThrow(/clanker-v5 session policy needs rule layout 5/);
    expect(fundingRuleIndex({ source: 'clanker-v5', rulesVersion: 5 })).toBe(3);
    expect(fundingRuleIndex({ source: 'bootr', rulesVersion: 4 })).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex({ source: 'clanker', rulesVersion: 4 })).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex({ source: 'bootr', rulesVersion: 2 })).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex({ rulesVersion: undefined })).toBe(3); // the Clanker-era legacy layout
    // the console's view of a v5 agent with no key yet: the v5 rule set, nothing to reinstall
    expect(sessionRulesStatus({ permissionId: null, sessionPolicy: null, source: 'clanker-v5' }, {})).toEqual({ current: [], wanted: V5_LABELS, reinstallNeeded: false });
    // a stored v5 policy matches its own config: no reinstall
    const stored = { ...V5.policy, rules: { version: 1, powers: ['claims', 'swap', 'treasury'], items: V5_LABELS.map((label) => ({ label, power: label.split('.')[0] })) } };
    expect(sessionRulesStatus({ permissionId: '0x11223344', sessionPolicy: stored as unknown as Record<string, unknown>, source: 'clanker-v5' }, {})).toMatchObject({ current: V5_LABELS, wanted: V5_LABELS, reinstallNeeded: false });
  });

  it('Bootr (RWAGMI) and Clanker v4 agents are untouched: layout 4 and byte for byte the validatorData of the commit-47f1a95 fixture', async () => {
    const world = await v5World();
    try {
      const bootr = await seedAgent(world);
      const bootrPolicy = sessionPolicyFor(world.ctx, bootr, 1_800_000_000);
      expect(bootrPolicy).toMatchObject({ source: 'bootr', feeLocker: RWAGMI_LP_LOCKER, rulesVersion: 4 });
      expect(callPolicyRules(bootrPolicy)).toEqual(layout4.bootr.rules);
      expect(encodeCallPolicyData(callPolicyRules(bootrPolicy))).toBe(layout4.bootr.callPolicyData);
      expect(buildValidatorData(bootrPolicy)).toBe(layout4.bootr.validatorData);
      expect(fundingRuleIndex(bootrPolicy)).toBe(4);
      await world.db.update(agents).set({ source: 'clanker' }).where(eq(agents.agentId, AGENT_ID));
      const clanker = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      const clankerPolicy = sessionPolicyFor(world.ctx, clanker, 1_800_000_000);
      expect(clankerPolicy).toMatchObject({ source: 'clanker', feeLocker: CLANKER_FEE_LOCKER, lpLocker: CLANKER_LP_LOCKER, rulesVersion: 4 });
      expect(callPolicyRules(clankerPolicy)).toEqual(layout4.clanker.rules);
      expect(encodeCallPolicyData(callPolicyRules(clankerPolicy))).toBe(layout4.clanker.callPolicyData);
      expect(buildValidatorData(clankerPolicy)).toBe(layout4.clanker.validatorData);
      expect(fundingRuleIndex(clankerPolicy)).toBe(4);
      // and the stored layout-4 fixtures keep reading back to their bytes
      for (const entry of [layout4.bootr, layout4.clanker]) {
        const p = { ...entry.policy, usdcTransferCap: BigInt(entry.policy.usdcTransferCap), gasAllowanceWei: BigInt(entry.policy.gasAllowanceWei) };
        expect(buildValidatorData(p)).toBe(entry.validatorData);
        expect(fundingRuleIndex(p)).toBe(4);
      }
    } finally {
      await world.close();
    }
  });
});

const LAUNCH_TX = toHex(7, { size: 32 });

function fakeLaunchLog(agentId: bigint, opts: { launcher?: Address; token?: Address; kernel?: Address } = {}): Log {
  const topics = encodeEventTopics({ abi: [agentLaunchedEvent], eventName: 'AgentLaunched', args: { token: opts.token ?? TOKEN, kernel: opts.kernel ?? KERNEL, creator: CREATOR } });
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
    [zeroAddress, agentId, [15_000, 500, 6500, 0, 3000, CREATOR, 20_000_000n, 90 * 86_400], pad('0x01', { size: 32 }), 'openai/gpt-4.1-mini', 'https://bootr.fun/agents/7.json', zeroAddress],
  );
  return { address: opts.launcher ?? LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

/** `BootrClankerLauncherV5.ClankerV5Launched(token, poolId, hook, feeEscrow, quoteToken, tickSpacing, taxBps, antiSnipe)`. */
function v5LaunchedLog(opts: { token?: Address; address?: Address; feeEscrow?: Address } = {}): Log {
  const topics = encodeEventTopics({ abi: [clankerV5LaunchedEvent], eventName: 'ClankerV5Launched', args: { token: opts.token ?? TOKEN } });
  const data = encodeAbiParameters(parseAbiParameters('bytes32, address, address, address, int24, uint24, bool'), [CLANKER_V5_POOL_ID, CLANKER_V5_HOOK, opts.feeEscrow ?? CLANKER_V5_FEE_ESCROW, zeroAddress, 200, 15_000, true]);
  return { address: opts.address ?? CLANKER_V5_LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex: 3, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

describe('onboarding from BootrClankerLauncherV5 (BOOTR_CLANKER_V5_LAUNCHER_ADDRESS)', () => {
  it('config: the v5 launcher is optional (unset = v5 off, the launcher list unchanged), must differ from the other two, and joins the list as clanker-v5', () => {
    expect(testConfig().BOOTR_CLANKER_V5_LAUNCHER_ADDRESS).toBeUndefined();
    expect(launcherEntries(testConfig())).toEqual([{ address: LAUNCHER, source: 'bootr' }]);
    expect(launcherEntries(testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER }))).toEqual([
      { address: LAUNCHER, source: 'bootr' },
      { address: CLANKER_LAUNCHER, source: 'clanker' },
    ]);
    const all = launcherEntries(testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER, BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER }));
    expect(all).toEqual([
      { address: LAUNCHER, source: 'bootr' },
      { address: CLANKER_LAUNCHER, source: 'clanker' },
      { address: CLANKER_V5_LAUNCHER, source: 'clanker-v5' },
    ]);
    expect(launchSourceOf(all, CLANKER_V5_LAUNCHER.toLowerCase() as Address)).toBe('clanker-v5');
    expect(() => testConfig({ BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: LAUNCHER.toLowerCase() })).toThrow(/BOOTR_CLANKER_V5_LAUNCHER_ADDRESS must differ/);
    expect(() => testConfig({ BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER, BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_LAUNCHER })).toThrow(/BOOTR_CLANKER_V5_LAUNCHER_ADDRESS must differ/);
    expect(agentSource({ source: 'clanker-v5' })).toBe('clanker-v5');
    expect(agentSource({ source: 'something-else' as never })).toBe('bootr');
  });

  it('decodes ClankerV5Launched only from our v5 launcher and only for the token', () => {
    const logs = [fakeLaunchLog(9n, { launcher: CLANKER_V5_LAUNCHER }), v5LaunchedLog()];
    expect(decodeLaunchLogs(logs, launcherEntries(testConfig({ BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER })))[0]).toMatchObject({ agentId: 9n, source: 'clanker-v5', launcher: CLANKER_V5_LAUNCHER });
    expect(decodeClankerV5Launch(logs, CLANKER_V5_LAUNCHER, TOKEN)).toEqual(V5_DETAILS);
    expect(decodeClankerV5Launch([v5LaunchedLog({ address: CLANKER_LAUNCHER })], CLANKER_V5_LAUNCHER, TOKEN)).toBeNull();
    expect(decodeClankerV5Launch([v5LaunchedLog({ token: CREATOR })], CLANKER_V5_LAUNCHER, TOKEN)).toBeNull();
    expect(decodeClankerV5Launch([fakeLaunchLog(9n, { launcher: CLANKER_V5_LAUNCHER })], CLANKER_V5_LAUNCHER, TOKEN)).toBeNull();
    expect(clankerV5DetailsOf({ clankerV5: V5_DETAILS })).toEqual(V5_DETAILS);
    expect(clankerV5DetailsOf({ clankerV5: { ...V5_DETAILS, feeEscrow: 'nope' } })).toBeNull();
    expect(clankerV5DetailsOf({})).toBeNull();
  });

  it('pollLaunches follows the third launcher on the same cursor: a mocked AgentLaunched on the v5 launcher registers a clanker-v5 agent with its details and the v5 session policy', async () => {
    const KERNEL_8: Address = '0x2000000000000000000000000000000000000008';
    const TOKEN_8: Address = '0x3000000000000000000000000000000000000008';
    const world = await makeWorld({
      config: { BOOTR_CLANKER_LAUNCHER_ADDRESS: CLANKER_LAUNCHER, BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER },
      chain: {
        logs: [fakeLaunchLog(7n), fakeLaunchLog(8n, { launcher: CLANKER_V5_LAUNCHER, token: TOKEN_8, kernel: KERNEL_8 })],
        blockNumber: 50n,
        receipts: { [LAUNCH_TX]: [fakeLaunchLog(7n), fakeLaunchLog(8n, { launcher: CLANKER_V5_LAUNCHER, token: TOKEN_8, kernel: KERNEL_8 }), v5LaunchedLog({ token: TOKEN_8 })] },
      },
    });
    try {
      expect(world.ctx.chain.launchers.map((l) => l.source)).toEqual(['bootr', 'clanker', 'clanker-v5']);
      expect(await pollLaunches(world.ctx)).toBe(2);
      const bootr = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '7') }))!;
      const v5 = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, '8') }))!;
      expect(bootr.source).toBe('bootr');
      expect(bootr.config.clankerV5).toBeUndefined();
      expect(v5).toMatchObject({ source: 'clanker-v5', token: TOKEN_8, kernel: KERNEL_8, status: 'onboarding' });
      expect(v5.config).toMatchObject({ source: 'clanker-v5', clankerV5: V5_DETAILS });
      expect(v5.config.clanker).toBeUndefined();
      const policy = sessionPolicyFor(world.ctx, v5, 1_900_000_000);
      expect(policy).toMatchObject({ source: 'clanker-v5', feeLocker: CLANKER_V5_FEE_ESCROW, rulesVersion: 5, kernel: KERNEL_8, token: TOKEN_8 });
      expect(callPolicyRules(policy)[0]).toEqual({ target: CLANKER_V5_FEE_ESCROW, selector: '0xb4ba9e11', windowSeconds: 0, args: [{ index: 0, op: 1, value: pad(KERNEL_8, { size: 32 }).toLowerCase() }] });
      expect(sessionPolicyFor(world.ctx, bootr, 1_900_000_000)).toMatchObject({ source: 'bootr', rulesVersion: 4 });
    } finally {
      await world.close();
    }
  });
});
