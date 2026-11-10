/**
 * The creator's token settings of a Clanker v5 coin as the supervisor reads them (docs/design/clanker-v5-token-settings.md
 * sections 2.2 and 3): one decoder (`decodeClankerV5Launch`) takes the v2 `ClankerV5Launched`, the hook's `FeeSlotCreated`
 * and the factory's `LaunchTaxConfigured` out of the launch receipt, registration stores them in `config.clankerV5`, and
 * the session policy does not depend on any of it: a USDC-paired agent gets the same rule layout 5 bytes as an ETH one,
 * pinned by test/fixtures/session-policy-layout5-clanker-v5.json, and its claim `claimFor(kernel, USDC)` passes the
 * one claim rule (recipient pinned, currency free).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { encodeAbiParameters, encodeEventTopics, encodeFunctionData, getAddress, pad, slice, toEventSelector, toHex, zeroAddress, type AbiEvent, type Address, type Hex, type Log } from 'viem';
import { agentLaunchedEvent, clankerV5FeeEscrowAbi, clankerV5FeeSlotCreatedEvent, clankerV5LaunchedEvent, clankerV5LaunchTaxConfiguredEvent } from '../src/abi.js';
import { agents } from '../src/db/schema.js';
import { CLANKER_V5_DEFAULT_POLICY, clankerV5DetailsOf, clankerV5QuoteOf, pairedAssetOf } from '../src/launch-source.js';
import { classifyClankerV5Slots, decodeClankerV5Launch, pollLaunches, sessionPolicyFor } from '../src/onboarding.js';
import { buildValidatorData, encodeCallPolicyData, type SerializedSessionPolicy } from '../src/session-key.js';
import { callPolicyRules, CallPolicyOp } from '../src/session-rules.js';
import { encodeClankerV5ClaimCall } from '../src/treasury.js';
import { AGENT_ID, CLANKER_V5_FEE_ESCROW, CLANKER_V5_HOOK, CLANKER_V5_LAUNCHER, CLANKER_V5_POOL_ID, CREATOR, KERNEL, makeWorld, seedAgent, TOKEN } from './helpers.js';

const V5 = (JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout5-clanker-v5.json', import.meta.url), 'utf8')) as { 'clanker-v5': { policy: SerializedSessionPolicy; callPolicyData: Hex; validatorData: Hex } })['clanker-v5'];
const layout4 = JSON.parse(readFileSync(new URL('./fixtures/session-policy-layout4.json', import.meta.url), 'utf8')) as Record<'bootr' | 'clanker', { validatorData: Hex }>;

/** USDC on Base Sepolia (the test chain's address book). */
const USDC: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PLATFORM: Address = '0x9000000000000000000000000000000000000009';
const OTHER_A: Address = '0xe00000000000000000000000000000000000000e';
const OTHER_B: Address = '0xf00000000000000000000000000000000000000f';
const FACTORY: Address = '0x572e88D3cD7f23E4241EB6ceDD96667271bF09A0';
const LAUNCH_TX = toHex(9, { size: 32 });

/** Any event log: topics from the indexed inputs, data from the rest, in declaration order. */
function eventLog(event: AbiEvent, args: Record<string, unknown>, address: Address, logIndex = 0): Log {
  const topics = encodeEventTopics({ abi: [event], eventName: event.name, args } as never) as [Hex, ...Hex[]];
  const plain = event.inputs.filter((i) => !i.indexed);
  const data = encodeAbiParameters(plain, plain.map((i) => args[i.name!]) as never);
  return { address, topics, data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

/** The settings launcher's `ClankerV5Launched`: a USDC pool, 1.5% buy, 2% sell, burn 10% and dividends 15% of the post-Clanker tax. */
function launchedV2(over: Record<string, unknown> = {}, address: Address = CLANKER_V5_LAUNCHER): Log {
  return eventLog(
    clankerV5LaunchedEvent,
    { token: TOKEN, poolId: CLANKER_V5_POOL_ID, hook: CLANKER_V5_HOOK, feeEscrow: CLANKER_V5_FEE_ESCROW, quoteToken: USDC, tickSpacing: 200, buyTaxBps: 15_000, sellTaxBps: 20_000, burnBps: 1_000, dividendBps: 1_500, antiSnipe: false, metadataEditable: true, ...over },
    address,
    3,
  );
}

/**
 * The hook's slots as the launcher builds them (section 2.2): agent 5% and platform 30% of the post-Clanker pool, the
 * creator's rows splitting the rest (creator funds 20% of the pool: the creator 60% of it, two other rows 25% and 15%).
 * Slot pool P = 10_000 - 1000 burn - 1500 dividends = 7500: agent ceil(500/0.75) = 667, platform floor(3000/0.75) = 4000,
 * the rows 5333 split 3200 / 1333 / 800.
 */
const SLOTS: { recipient: Address; admin: Address; weightBps: number }[] = [
  { recipient: KERNEL, admin: CLANKER_V5_LAUNCHER, weightBps: 667 },
  { recipient: PLATFORM, admin: CLANKER_V5_LAUNCHER, weightBps: 4_000 },
  { recipient: CREATOR, admin: CREATOR, weightBps: 3_200 },
  { recipient: OTHER_A, admin: OTHER_A, weightBps: 1_333 },
  { recipient: OTHER_B, admin: CREATOR, weightBps: 800 },
];

function slotLogs(poolId: Hex = CLANKER_V5_POOL_ID, hook: Address = CLANKER_V5_HOOK): Log[] {
  return SLOTS.map((s, i) => eventLog(clankerV5FeeSlotCreatedEvent, { poolId, slotIndex: BigInt(i), ...s, isCreator: false }, hook, 10 + i));
}

function taxConfigured(over: { token?: Address; address?: Address; minimumDividendHolding?: bigint; protocolTaxShare?: number } = {}): Log {
  return eventLog(
    clankerV5LaunchTaxConfiguredEvent,
    {
      poolId: CLANKER_V5_POOL_ID,
      token: over.token ?? TOKEN,
      configVersion: 1n,
      admittedPolicy: {
        taxFeeBounds: { minimumBuyTaxRate: 1_000_000, maximumBuyTaxRate: 10_000_000, minimumSellTaxRate: 1_000_000, maximumSellTaxRate: 10_000_000 },
        protocolFeeConfiguration: { protocolTaxShare: over.protocolTaxShare ?? 10_000_000, minimumProtocolFeeRate: 500_000, maximumProtocolFeeRate: 1_000_000, protocolFeeRecipient: '0x7a2e54e3f0000000000000000000000000003829' },
        antiSnipeConfiguration: { startTotalFeeRate: 99_000_000, windowSeconds: 20 },
        minimumDividendHoldingRequirement: 10n ** 22n,
      },
      taxConfiguration: { buyTaxRate: 1_500_000, sellTaxRate: 2_000_000, creatorAllocationShare: 75_000_000, burnAllocationShare: 10_000_000, dividendAllocationShare: 15_000_000, integratorAllocationShare: 0, minimumDividendHolding: over.minimumDividendHolding ?? 10n ** 22n },
      integratorFeeRecipient: zeroAddress,
      antiSnipeEnabled: false,
    },
    over.address ?? FACTORY,
    20,
  );
}

/** What registration stores for the USDC coin above. */
const USDC_DETAILS = {
  poolId: CLANKER_V5_POOL_ID,
  hook: CLANKER_V5_HOOK,
  feeEscrow: CLANKER_V5_FEE_ESCROW,
  quoteToken: USDC,
  tickSpacing: 200,
  taxBps: 15_000,
  antiSnipe: false,
  settings: {
    buyTaxBps: 15_000,
    sellTaxBps: 20_000,
    burnBps: 1_000,
    dividendBps: 1_500,
    slots: [
      { role: 'agent', weightBps: 667 },
      { role: 'platform', weightBps: 4_000 },
      { role: 'creator', weightBps: 3_200 },
      { role: 'other', weightBps: 1_333 },
      { role: 'other', weightBps: 800 },
    ],
    protocolPolicy: CLANKER_V5_DEFAULT_POLICY,
    minDividendHolding: (10n ** 22n).toString(),
    metadataEditable: true,
  },
};

describe('the v5 launch receipt, decoded in one function', () => {
  it('pins the topics: ClankerV5Launched v2 as the spec writes it, FeeSlotCreated and LaunchTaxConfigured as Clanker verified them', () => {
    expect(toEventSelector(clankerV5LaunchedEvent)).toBe(toEventSelector('ClankerV5Launched(address,bytes32,address,address,address,int24,uint24,uint24,uint16,uint16,bool,bool)'));
    expect(toEventSelector(clankerV5FeeSlotCreatedEvent)).toBe(toEventSelector('FeeSlotCreated(bytes32,uint256,address,address,uint16,bool)'));
    // the indexer's vendored JSON ABI (apps/indexer/abis/ClankerV5.ts) gives the same topic
    expect(toEventSelector(clankerV5LaunchTaxConfiguredEvent)).toBe('0xca38976cd82d14818c38913aecbfb2384a94f680214aba7ed4d051ecff7c7750');
  });

  it('reads the pool, the paired asset, both taxes, burn, dividends, the switches, the slots by role and Clanker policy', () => {
    const logs = [launchedV2(), ...slotLogs(), taxConfigured()];
    expect(decodeClankerV5Launch(logs, CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL, factory: FACTORY })).toEqual(USDC_DETAILS);
    // the factory unknown (a chain without the address): any emitter's LaunchTaxConfigured for the token
    expect(decodeClankerV5Launch(logs, CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL })).toEqual(USDC_DETAILS);
    // and the stored block reads back to the same thing
    expect(clankerV5DetailsOf({ clankerV5: JSON.parse(JSON.stringify(USDC_DETAILS)) })).toEqual(USDC_DETAILS);
  });

  it('ignores other emitters, other pools and other tokens; without LaunchTaxConfigured the live policy stands in', () => {
    const foreignSlots = [...slotLogs(toHex(5, { size: 32 })), ...slotLogs(CLANKER_V5_POOL_ID, OTHER_A)];
    const logs = [launchedV2(), ...foreignSlots, ...slotLogs(), taxConfigured({ address: OTHER_A, protocolTaxShare: 1 }), taxConfigured({ token: CREATOR, protocolTaxShare: 2 })];
    const d = decodeClankerV5Launch(logs, CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL, factory: FACTORY })!;
    expect(d.settings!.slots).toEqual(USDC_DETAILS.settings.slots);
    expect(d.settings!.protocolPolicy).toEqual(CLANKER_V5_DEFAULT_POLICY);
    expect(d.settings!.minDividendHolding).toBeNull();
    // only our launcher's event and only for the token
    expect(decodeClankerV5Launch([launchedV2({}, OTHER_A), ...slotLogs()], CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL })).toBeNull();
    expect(decodeClankerV5Launch([launchedV2({ token: CREATOR }), ...slotLogs()], CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL })).toBeNull();
  });

  it('no slots, or no agent slot, means no settings: the pool, escrow and quote stay, and no split can be stated', () => {
    const bare = decodeClankerV5Launch([launchedV2()], CLANKER_V5_LAUNCHER, TOKEN, { kernel: KERNEL })!;
    expect(bare).toEqual({ ...USDC_DETAILS, settings: undefined });
    expect(bare.settings).toBeUndefined();
    expect(classifyClankerV5Slots(SLOTS.slice(1), CLANKER_V5_LAUNCHER, KERNEL)).toBeNull();
    expect(classifyClankerV5Slots([], CLANKER_V5_LAUNCHER, KERNEL)).toBeNull();
    // the kernel not known: the first launcher-admin slot is the agent's (the launcher's order)
    expect(classifyClankerV5Slots(SLOTS, CLANKER_V5_LAUNCHER, null)).toEqual(USDC_DETAILS.settings.slots);
    // a coin with only the creator's own row (the default): agent, platform, creator
    expect(classifyClankerV5Slots(SLOTS.slice(0, 3), CLANKER_V5_LAUNCHER, KERNEL)!.map((s) => s.role)).toEqual(['agent', 'platform', 'creator']);
  });

  it('paired asset: 0x0 is ETH, the chain USDC is USDC, anything else is other', async () => {
    const w = await makeWorld();
    try {
      expect(pairedAssetOf(w.ctx, zeroAddress)).toBe('ETH');
      expect(pairedAssetOf(w.ctx, USDC)).toBe('USDC');
      expect(pairedAssetOf(w.ctx, getAddress(USDC.toLowerCase()))).toBe('USDC');
      expect(pairedAssetOf(w.ctx, OTHER_A)).toBe('other');
      expect(w.ctx.chain.addresses.usdc).toBe(USDC);
      expect(clankerV5QuoteOf({ config: { clankerV5: USDC_DETAILS } })).toBe(USDC);
      expect(clankerV5QuoteOf({ config: {} })).toBe(zeroAddress);
    } finally {
      await w.close();
    }
  });
});

function agentLaunchedLog(agentId: bigint): Log {
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
    [zeroAddress, agentId, [15_000, 500, 6000, 1000, 3000, CREATOR, 20_000_000n, 90 * 86_400], pad('0x01', { size: 32 }), 'openai/gpt-4.1-mini', 'https://bootr.fun/agents/9.json', zeroAddress],
  );
  return { address: CLANKER_V5_LAUNCHER, topics: topics as [Hex, ...Hex[]], data, blockNumber: 42n, transactionHash: LAUNCH_TX, logIndex: 0, blockHash: toHex(1, { size: 32 }), transactionIndex: 0, removed: false };
}

describe('a USDC-paired agent: registration and its session key', () => {
  it('registers with the settings, and gets byte for byte the layout-5 policy of an ETH agent; today’s layout-4 fixtures are untouched', async () => {
    const receipt = [agentLaunchedLog(7n), launchedV2(), ...slotLogs(), taxConfigured()];
    const w = await makeWorld({ config: { BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER }, chain: { logs: [agentLaunchedLog(7n)], blockNumber: 50n, receipts: { [LAUNCH_TX]: receipt } } });
    try {
      expect(await pollLaunches(w.ctx)).toBe(1);
      const agent = (await w.db.query.agents.findFirst({ where: eq(agents.agentId, AGENT_ID) }))!;
      expect(agent.config).toMatchObject({ source: 'clanker-v5', clankerV5: USDC_DETAILS });
      const policy = sessionPolicyFor(w.ctx, agent, 1_800_000_000);
      expect(policy).toMatchObject({ source: 'clanker-v5', feeLocker: CLANKER_V5_FEE_ESCROW, rulesVersion: 5 });
      // the same rules and validatorData as the ETH fixture: the currency is not in the policy
      expect(encodeCallPolicyData(callPolicyRules(policy))).toBe(V5.callPolicyData);
      expect(buildValidatorData(policy)).toBe(V5.validatorData);
      // an ETH v5 agent and a v1 row give the same bytes
      const eth = { ...agent, config: { ...agent.config, clankerV5: { ...USDC_DETAILS, quoteToken: zeroAddress } } };
      expect(buildValidatorData(sessionPolicyFor(w.ctx, eth, 1_800_000_000))).toBe(V5.validatorData);
      const v1 = { ...agent, config: { ...agent.config, clankerV5: { ...USDC_DETAILS, quoteToken: zeroAddress, settings: undefined } } };
      expect(buildValidatorData(sessionPolicyFor(w.ctx, v1, 1_800_000_000))).toBe(V5.validatorData);
      // RWAGMI and Clanker v4 stay on their commit-47f1a95 bytes
      const bootr = { ...agent, source: 'bootr' as const, config: { ...agent.config, source: 'bootr', clankerV5: undefined } };
      expect(buildValidatorData(sessionPolicyFor(w.ctx, bootr, 1_800_000_000))).toBe(layout4.bootr.validatorData);
    } finally {
      await w.close();
    }
  });

  it('the claim of a USDC agent, claimFor(kernel, USDC), passes the one claim rule: target, selector, word 0 = kernel; the currency word is free', async () => {
    const w = await makeWorld({ config: { BOOTR_CLANKER_V5_LAUNCHER_ADDRESS: CLANKER_V5_LAUNCHER } });
    try {
      const agent = await seedAgent(w, { agent: { source: 'clanker-v5' }, config: { source: 'clanker-v5', clankerV5: USDC_DETAILS } });
      const rule = callPolicyRules(sessionPolicyFor(w.ctx, agent, 1_800_000_000))[0]!;
      const call = encodeClankerV5ClaimCall({ feeEscrow: CLANKER_V5_FEE_ESCROW, kernel: KERNEL, currency: USDC });
      expect(call).toEqual({ to: CLANKER_V5_FEE_ESCROW, value: 0n, data: encodeFunctionData({ abi: clankerV5FeeEscrowAbi, functionName: 'claimFor', args: [KERNEL, USDC] }) });
      expect(call.to).toBe(rule.target);
      expect(slice(call.data!, 0, 4)).toBe(rule.selector);
      expect(rule.args).toEqual([{ index: 0, op: CallPolicyOp.EQUAL, value: pad(KERNEL, { size: 32 }).toLowerCase() }]);
      expect(slice(call.data!, 4, 36).toLowerCase()).toBe(rule.args[0]!.value);
      // word 1 is the currency, which no rule argument constrains
      expect(slice(call.data!, 36, 68).toLowerCase()).toBe(pad(USDC, { size: 32 }).toLowerCase());
      expect(rule.args.some((a) => a.index === 1)).toBe(false);
    } finally {
      await w.close();
    }
  });
});
