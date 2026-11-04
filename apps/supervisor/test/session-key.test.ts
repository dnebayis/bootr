import { describe, expect, it } from 'vitest';
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, pad, parseAbiParameters, slice, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PolicyFlags } from '@zerodev/permissions';
import { ADDR, CLANKER_FEE_LOCKER, CLANKER_LP_LOCKER, GUARDIAN, KERNEL, PAYTO, POOL_ID, RWAGMI_LP_LOCKER, SESSION_PK, SPENDER, TOKEN } from './helpers.js';
import {
  buildDeinitData,
  buildValidatorData,
  CALL_POLICY_RULES_VERSION,
  callPolicyRules,
  policySource,
  SOURCE_RULES_VERSION,
  CallPolicyOp,
  decodeCallPolicyData,
  encodeCallPolicyData,
  encodeEnableSignature,
  encodeErc1271Signature,
  encodeSessionSignature,
  encodePolicySigs,
  encodeTimeSlot,
  encodeValidatorData,
  enableDigest,
  enableDigestManual,
  FUNDING_AMOUNT_ARG_INDEX,
  FUNDING_RULE_INDEX,
  hasGasRule,
  fundingRuleIndex,
  LEGACY_FUNDING_RULE_INDEX,
  nonceKey,
  policyEntries,
  policyModules,
  sdkValidatorData,
  SIGNER_FLAGS,
  validationId,
  zerodevEntries,
  type SessionPolicyParams,
} from '../src/session-key.js';
import { EXEC_MODE_BATCH, EXEC_MODE_SINGLE, encodeKernelCalls, nonceMode } from '../src/kernel.js';
import { CLANKER_FEE_LOCKER_CLAIM_SELECTOR, CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR, clankerFeeLockerAbi, clankerLpLockerAbi, ERC20_APPROVE_SELECTOR, KERNEL_EXECUTE_SELECTOR, KERNEL_EXECUTE_USER_OP_SELECTOR, LOCKER_CLAIM_QUOTE_SELECTOR, LOCKER_SETTLE_AND_CLAIM_SELECTOR, rwagmiLpLockerV3Abi, SWAP_HELPER_SWAP_SELECTOR, WETH_WITHDRAW_SELECTOR } from '../src/abi.js';

/** Clanker's mainnet FeeLocker: the claim target of session keys installed before the RWAGMI v3 cutover. */
const LEGACY_CLANKER_FEE_LOCKER = '0xF3622742b1E446D92e45E22923Ef11C2fcD55D68' as const;

const signer = privateKeyToAccount(SESSION_PK);
const PID: Hex = '0xdeadbeef';
const CALL_POLICY = ADDR.bootr.callPolicy as Address;
const SWAP_HELPER = ADDR.bootr.swapHelper as Address;

function params(over: Partial<SessionPolicyParams> = {}): SessionPolicyParams {
  const z = ADDR.zerodev;
  return {
    kernel: KERNEL,
    token: TOKEN,
    feeLocker: RWAGMI_LP_LOCKER,
    rulesVersion: CALL_POLICY_RULES_VERSION,
    swapHelper: SWAP_HELPER,
    usdc: ADDR.usdc,
    weth: ADDR.weth,
    spender: SPENDER,
    usdcTransferCap: 50_000_000n,
    usdcWindowSeconds: 86_400,
    gasAllowanceWei: 10n ** 17n,
    ratePerHour: 60,
    validUntil: 1_800_000_000,
    signatureCallers: null,
    sessionSigner: signer.address,
    policyAddresses: { callPolicy: CALL_POLICY, gasPolicy: z.gasPolicy!, rateLimitPolicy: z.rateLimitPolicy!, timestampPolicy: z.timestampPolicy!, ecdsaSigner: z.ecdsaSigner! },
    ...over,
  };
}

/** A policy as stored by a supervisor that predates the swap helper / spender layout (router rules, payTo, caller policy). */
function legacyParams(): SessionPolicyParams {
  const p = params();
  delete p.rulesVersion;
  return { ...p, feeLocker: LEGACY_CLANKER_FEE_LOCKER, swapHelper: undefined as unknown as Address, spender: undefined as unknown as Address, inferencePayTo: PAYTO, universalRouter: ADDR.uniswap.universalRouter, signatureCallers: [ADDR.usdc], policyAddresses: { ...p.policyAddresses, signaturePolicy: ADDR.zerodev.signaturePolicy! } };
}

/** A policy installed with the Clanker-era layout (one `FeeLocker.claim` rule in front, funding rule at index 3). */
function clankerEraParams(): SessionPolicyParams {
  const p = params();
  delete p.rulesVersion;
  return { ...p, feeLocker: LEGACY_CLANKER_FEE_LOCKER };
}

describe('validatorData layout (contracts/src/README.md)', () => {
  it('matches the fork-test fixture: bytes2(0)||SUDO ; bytes2(0)||ECDSA_SIGNER||sessionKey, abi.encode(bytes[])', () => {
    // packages/contracts/test/fork/BootrFork.t.sol `_permissionData()`
    const expected = encodeAbiParameters(parseAbiParameters('bytes[]'), [[concatHex(['0x0000', ADDR.zerodev.sudoPolicy!]), concatHex(['0x0000', ADDR.zerodev.ecdsaSigner!, signer.address])]]);
    const actual = encodeValidatorData([
      { flags: '0x0000', module: ADDR.zerodev.sudoPolicy!, data: '0x' },
      { flags: '0x0000', module: ADDR.zerodev.ecdsaSigner!, data: signer.address },
    ]);
    expect(actual).toBe(expected.toLowerCase());
  });

  it('production policy set: every entry is flags||address||initData, signer last with SKIP_SIGNATURE, flags as designed', () => {
    const p = params();
    const data = buildValidatorData(p);
    const [entries] = decodeAbiParameters(parseAbiParameters('bytes[]'), data);
    expect(entries).toHaveLength(5); // call, gas, rate, timestamp, signer
    const parsed = entries.map((e) => ({ flags: slice(e, 0, 2), module: getAddress(slice(e, 2, 22)), data: e.length > 46 ? slice(e, 22) : ('0x' as Hex) }));
    expect(parsed.map((e) => e.module)).toEqual([p.policyAddresses.callPolicy, p.policyAddresses.gasPolicy, p.policyAddresses.rateLimitPolicy, p.policyAddresses.timestampPolicy, p.policyAddresses.ecdsaSigner]);
    // the signer's flags become the permission's permissionFlag: SKIP_SIGNATURE closes ERC-1271 (C-01)
    expect(parsed.map((e) => e.flags)).toEqual([PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.FOR_ALL_VALIDATION, PolicyFlags.NOT_FOR_VALIDATE_SIG]);
    expect(SIGNER_FLAGS).toBe('0x0002');
    // signer init data is the 20-byte session key
    expect(parsed[4]!.data.toLowerCase()).toBe(signer.address.toLowerCase());
    // timestamp policy init data = abi.encode(uint48 validAfter, uint48 validUntil)
    expect(parsed[3]!.data).toBe(encodeAbiParameters(parseAbiParameters('uint48, uint48'), [0, 1_800_000_000]));
    // rate limit: interval(6) || count(6) || startAt(6)
    expect(parsed[2]!.data).toBe(`0x${(3600).toString(16).padStart(12, '0')}${(60).toString(16).padStart(12, '0')}${'0'.repeat(12)}`);
    // call policy init data = abi.encode(Rule[]) with the five allow-list rules (checked in detail below)
    expect(parsed[0]!.data).toBe(encodeCallPolicyData(callPolicyRules(p)));
    expect(parsed[0]!.module).toBe(CALL_POLICY);
    // the module list used for revocation is the same, in the same order
    expect(policyModules(p)).toEqual(policyEntries(p).map((e) => e.module));
  });

  it('BootrCallPolicy rules: exactly locker.settleAndClaim(*,*,kernel), locker.claimQuote(*,kernel), WETH.approve(helper,*), helper.swapWethToUsdc(*,*), USDC.transfer(spender, SUM_PER_WINDOW cap), WETH.withdraw(*)', () => {
    const p = params();
    const rules = callPolicyRules(p);
    expect(rules).toEqual([
      // settleAndClaim(bytes32[] ids, address currency, address to): word 0 is the offset of `ids`, `to` is word 2
      { target: RWAGMI_LP_LOCKER, selector: LOCKER_SETTLE_AND_CLAIM_SELECTOR, windowSeconds: 0, args: [{ index: 2, op: CallPolicyOp.EQUAL, value: pad(KERNEL, { size: 32 }) }] },
      // claimQuote(address currency, address to): `to` is word 1
      { target: RWAGMI_LP_LOCKER, selector: LOCKER_CLAIM_QUOTE_SELECTOR, windowSeconds: 0, args: [{ index: 1, op: CallPolicyOp.EQUAL, value: pad(KERNEL, { size: 32 }) }] },
      { target: ADDR.weth, selector: ERC20_APPROVE_SELECTOR, windowSeconds: 0, args: [{ index: 0, op: CallPolicyOp.EQUAL, value: pad(SWAP_HELPER, { size: 32 }).toLowerCase() }] },
      { target: SWAP_HELPER, selector: SWAP_HELPER_SWAP_SELECTOR, windowSeconds: 0, args: [] },
      {
        target: ADDR.usdc,
        selector: '0xa9059cbb', // transfer(address,uint256)
        windowSeconds: 86_400,
        args: [
          { index: 0, op: CallPolicyOp.EQUAL, value: pad(SPENDER, { size: 32 }).toLowerCase() },
          { index: 1, op: CallPolicyOp.SUM_PER_WINDOW, value: toHex(50_000_000n, { size: 32 }) },
        ],
      },
      // WETH.withdraw(wad): the kernel's gas. WETH9 pays msg.sender, so the ETH lands on the kernel and can only leave as prefund.
      { target: ADDR.weth, selector: WETH_WITHDRAW_SELECTOR, windowSeconds: 0, args: [] },
    ]);
    expect(rules).toHaveLength(6);
    expect(WETH_WITHDRAW_SELECTOR).toBe('0x2e1a7d4d');
    expect(hasGasRule(p)).toBe(true);
    // the RWAGMI layout before self-funded gas (version 2) is the same list without the withdraw rule; the funding
    // rule keeps its index in both, so `windowOf` reads the right window for keys installed under either
    const v2 = callPolicyRules({ ...p, rulesVersion: 2 });
    expect(v2).toEqual(rules.slice(0, 5));
    expect(hasGasRule({ rulesVersion: 2 })).toBe(false);
    expect(fundingRuleIndex({ rulesVersion: 2 })).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex(p)).toBe(FUNDING_RULE_INDEX);
    expect(FUNDING_RULE_INDEX).toBe(4);
    expect(rules[FUNDING_RULE_INDEX]!.args[FUNDING_AMOUNT_ARG_INDEX]!.op).toBe(CallPolicyOp.SUM_PER_WINDOW);
    expect(LOCKER_SETTLE_AND_CLAIM_SELECTOR).toBe(keccak256(toHex('settleAndClaim(bytes32[],address,address)')).slice(0, 10));
    expect(LOCKER_CLAIM_QUOTE_SELECTOR).toBe(keccak256(toHex('claimQuote(address,address)')).slice(0, 10));
    // the pinned argument word is where `to` really sits in the ABI encoding of each claim call (word = 4 + 32 * index)
    const word = (data: Hex, index: number) => slice(data, 4 + 32 * index, 4 + 32 * (index + 1));
    const settle = encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'settleAndClaim', args: [[POOL_ID], ADDR.weth, KERNEL] });
    expect(slice(settle, 0, 4)).toBe(LOCKER_SETTLE_AND_CLAIM_SELECTOR);
    expect(word(settle, 2).toLowerCase()).toBe(pad(KERNEL, { size: 32 }).toLowerCase());
    expect(word(settle, 2).toLowerCase()).not.toBe(word(settle, 1).toLowerCase()); // word 1 is the currency
    const claim = encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [ADDR.weth, KERNEL] });
    expect(slice(claim, 0, 4)).toBe(LOCKER_CLAIM_QUOTE_SELECTOR);
    expect(word(claim, 1).toLowerCase()).toBe(pad(KERNEL, { size: 32 }).toLowerCase());
    // a claim with any other `to` fails the EQUAL rule
    expect(word(encodeFunctionData({ abi: rwagmiLpLockerV3Abi, functionName: 'claimQuote', args: [ADDR.weth, SPENDER] }), 1).toLowerCase()).not.toBe(pad(KERNEL, { size: 32 }).toLowerCase());
    // the locker rules never pin the currency or the pool: fees are WETH today, the kernel is the only payout address
    expect(rules.filter((r) => r.target === RWAGMI_LP_LOCKER).every((r) => r.args.length === 1 && r.args[0]!.value.toLowerCase() === pad(KERNEL, { size: 32 }).toLowerCase())).toBe(true);
    expect(rules.some((r) => r.target === LEGACY_CLANKER_FEE_LOCKER)).toBe(false);
    // the payTo is never a recipient any more; the spender is the only USDC sink
    expect(rules.some((r) => r.args.some((a) => a.value.toLowerCase() === pad(PAYTO, { size: 32 }).toLowerCase()))).toBe(false);
    expect(() => callPolicyRules(params({ usdcWindowSeconds: 0 }))).toThrow(/usdcWindowSeconds/);
    expect(() => callPolicyRules(params({ usdcTransferCap: 2n ** 128n }))).toThrow(/uint128/);
    expect(ERC20_APPROVE_SELECTOR).toBe('0x095ea7b3');
    expect(SWAP_HELPER_SWAP_SELECTOR).toBe(keccak256(toHex('swapWethToUsdc(uint256,uint256)')).slice(0, 10));
    // nothing may ever reach the Universal Router or move WETH anywhere but the helper's allowance
    expect(rules.some((r) => r.target === ADDR.uniswap.universalRouter)).toBe(false);
    expect(rules.filter((r) => r.target === ADDR.weth).map((r) => r.selector)).toEqual([ERC20_APPROVE_SELECTOR, WETH_WITHDRAW_SELECTOR]);
    expect(() => callPolicyRules(legacyParams())).toThrow(/legacy rule layout/);
    expect(() => callPolicyRules(clankerEraParams())).toThrow(/legacy rule layout/);
    expect(() => callPolicyRules(params({ feeLocker: undefined as unknown as Address }))).toThrow(/feeLocker/);
    // round-trips through the contract's `abi.encode(Rule[])` layout: (address, bytes4, (uint8, uint8, bytes32)[])[]
    const data = encodeCallPolicyData(rules);
    const decoded = decodeCallPolicyData(data);
    expect(decoded.map((r) => ({ ...r, args: r.args.map((a) => ({ ...a, value: a.value.toLowerCase() })) }))).toEqual(rules.map((r) => ({ ...r, args: r.args.map((a) => ({ ...a, value: a.value.toLowerCase() })) })));
    // same bytes as a hand-written abi.encode with the Solidity tuple layout
    const manual = encodeAbiParameters(parseAbiParameters('(address, bytes4, uint32, (uint8, uint8, bytes32)[])[]'), [rules.map((r) => [r.target, r.selector, r.windowSeconds, r.args.map((a) => [a.index, a.op, a.value] as const)] as const)]);
    expect(data).toBe(manual.toLowerCase());
    // the Kernel prepends bytes32(permissionId) to the module init data; our data must start right after
    expect(slice(concatHex([pad(PID, { size: 32, dir: 'right' }), data]), 32)).toBe(data);
  });

  it('the ZeroDev entries equal the SDK encoding (toPermissionValidator.getEnableData with flag = SKIP_SIGNATURE); the call policy is ours', async () => {
    const p = params();
    const sdk = (await sdkValidatorData(p, signer, '0x0000000071727De22E5E9d8BAf0edAc6f37da032', 84532)).toLowerCase();
    expect(encodeValidatorData(zerodevEntries(p))).toBe(sdk);
    // full validatorData = call policy entry + the SDK entries, in that order
    const [all] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildValidatorData(p));
    const [sdkEntries] = decodeAbiParameters(parseAbiParameters('bytes[]'), sdk as Hex);
    expect(all.slice(1)).toEqual(sdkEntries);
    expect(slice(all[0]!, 2, 22).toLowerCase()).toBe(CALL_POLICY.toLowerCase());
  });

  it('deinit data: one entry per installed module, also for a legacy stored policy (no helper, no spender, signature-caller policy)', () => {
    const [entries] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildDeinitData(params()));
    expect(entries).toHaveLength(5);
    const legacy = legacyParams();
    expect(policyModules(legacy)).toEqual([CALL_POLICY, ADDR.zerodev.gasPolicy, ADDR.zerodev.rateLimitPolicy, ADDR.zerodev.timestampPolicy, ADDR.zerodev.signaturePolicy, ADDR.zerodev.ecdsaSigner]);
    const [legacyEntries] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildDeinitData(legacy));
    expect(legacyEntries).toHaveLength(6);
    expect(() => callPolicyRules(legacy)).toThrow(/legacy rule layout/);
    // a Clanker-era policy (five modules, four rules) still revokes and still reports its funding rule at index 3
    const [clankerEraEntries] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildDeinitData(clankerEraParams()));
    expect(clankerEraEntries).toHaveLength(5);
  });

  it('fundingRuleIndex: 4 for the RWAGMI layout (and when no policy is stored), 3 for keys installed with the Clanker-era layout', () => {
    expect(fundingRuleIndex(params())).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex(undefined)).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex(null)).toBe(FUNDING_RULE_INDEX);
    expect(fundingRuleIndex(clankerEraParams())).toBe(LEGACY_FUNDING_RULE_INDEX);
    expect(fundingRuleIndex(legacyParams())).toBe(LEGACY_FUNDING_RULE_INDEX);
    expect(fundingRuleIndex({ rulesVersion: 1 })).toBe(3);
    expect(fundingRuleIndex({ rulesVersion: 3 })).toBe(4);
  });
});

describe('claim rules by launch source (docs/design/clanker-launch.md section 3)', () => {
  /** A policy of an agent launched through Clanker: fee locker = ClankerFeeLocker, lpLocker = ClankerLpLockerFeeConversion. */
  const clankerParams = (over: Partial<SessionPolicyParams> = {}): SessionPolicyParams => params({ source: 'clanker', feeLocker: CLANKER_FEE_LOCKER, lpLocker: CLANKER_LP_LOCKER, ...over });

  it('a Bootr agent gets byte for byte the rules of layout 3: the version bump changes nothing for existing or new Bootr keys', () => {
    const v3 = params({ rulesVersion: 3 });
    delete (v3 as { source?: unknown }).source; // a policy stored before `source` existed
    const v4 = params({ rulesVersion: 4, source: 'bootr' });
    const v4Unset = params({ rulesVersion: 4 });
    expect(CALL_POLICY_RULES_VERSION).toBe(4);
    expect(SOURCE_RULES_VERSION).toBe(4);
    expect(policySource(v3)).toBe('bootr');
    expect(policySource(v4Unset)).toBe('bootr');
    expect(callPolicyRules(v4)).toEqual(callPolicyRules(v3));
    expect(callPolicyRules(v4Unset)).toEqual(callPolicyRules(v3));
    expect(encodeCallPolicyData(callPolicyRules(v4))).toBe(encodeCallPolicyData(callPolicyRules(v3)));
    // the whole validatorData is identical too (same modules, same init data), so a stored v3 key and a fresh v4 key
    // of the same agent carry the same enable digest
    expect(buildValidatorData(v4)).toBe(buildValidatorData(v3));
    expect(buildValidatorData(v4Unset)).toBe(buildValidatorData(v3));
    expect(hasGasRule(v4)).toBe(true);
    expect(fundingRuleIndex(v4)).toBe(FUNDING_RULE_INDEX);
    // the pinned bytes of the first Bootr rules are unchanged (RWAGMI locker, `to == kernel`)
    expect(callPolicyRules(v4).slice(0, 2).map((r) => [r.target, r.selector])).toEqual([
      [RWAGMI_LP_LOCKER, LOCKER_SETTLE_AND_CLAIM_SELECTOR],
      [RWAGMI_LP_LOCKER, LOCKER_CLAIM_QUOTE_SELECTOR],
    ]);
  });

  it('a Clanker agent: lpLocker.collectRewards(token == own coin), feeLocker.claim(feeOwner == kernel, *), then the same four shared rules', () => {
    const p = clankerParams();
    const rules = callPolicyRules(p);
    const shared = callPolicyRules(params()).slice(2);
    expect(rules).toHaveLength(6);
    expect(rules.slice(0, 2)).toEqual([
      { target: CLANKER_LP_LOCKER, selector: CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR, windowSeconds: 0, args: [{ index: 0, op: CallPolicyOp.EQUAL, value: pad(TOKEN, { size: 32 }).toLowerCase() }] },
      { target: CLANKER_FEE_LOCKER, selector: CLANKER_FEE_LOCKER_CLAIM_SELECTOR, windowSeconds: 0, args: [{ index: 0, op: CallPolicyOp.EQUAL, value: pad(KERNEL, { size: 32 }).toLowerCase() }] },
    ]);
    // the swap pair, the windowed spender funding and the gas rule are the same bytes as for a Bootr agent
    expect(rules.slice(2)).toEqual(shared);
    expect(fundingRuleIndex(p)).toBe(FUNDING_RULE_INDEX);
    expect(rules[FUNDING_RULE_INDEX]!.args[FUNDING_AMOUNT_ARG_INDEX]!.op).toBe(CallPolicyOp.SUM_PER_WINDOW);
    expect(hasGasRule(p)).toBe(true);
    expect(policySource(p)).toBe('clanker');
    expect(CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR).toBe(keccak256(toHex('collectRewards(address)')).slice(0, 10));
    expect(CLANKER_FEE_LOCKER_CLAIM_SELECTOR).toBe(keccak256(toHex('claim(address,address)')).slice(0, 10));
    // the pinned words sit where the ABI encoding of the real calls puts them
    const word = (data: Hex, index: number) => slice(data, 4 + 32 * index, 4 + 32 * (index + 1)).toLowerCase();
    const collect = encodeFunctionData({ abi: clankerLpLockerAbi, functionName: 'collectRewards', args: [TOKEN] });
    expect(slice(collect, 0, 4)).toBe(CLANKER_LOCKER_COLLECT_REWARDS_SELECTOR);
    expect(word(collect, 0)).toBe(pad(TOKEN, { size: 32 }).toLowerCase());
    const claim = encodeFunctionData({ abi: clankerFeeLockerAbi, functionName: 'claim', args: [KERNEL, ADDR.weth] });
    expect(slice(claim, 0, 4)).toBe(CLANKER_FEE_LOCKER_CLAIM_SELECTOR);
    expect(word(claim, 0)).toBe(pad(KERNEL, { size: 32 }).toLowerCase());
    // a claim for anyone else, or a collection of another coin, fails the EQUAL rules
    expect(word(encodeFunctionData({ abi: clankerFeeLockerAbi, functionName: 'claim', args: [SPENDER, ADDR.weth] }), 0)).not.toBe(pad(KERNEL, { size: 32 }).toLowerCase());
    expect(word(encodeFunctionData({ abi: clankerLpLockerAbi, functionName: 'collectRewards', args: [ADDR.weth] }), 0)).not.toBe(pad(TOKEN, { size: 32 }).toLowerCase());
    // the token argument of `claim` is free (the payee is fixed); nothing points at the RWAGMI locker any more
    expect(rules[1]!.args).toHaveLength(1);
    expect(rules.some((r) => r.target === RWAGMI_LP_LOCKER)).toBe(false);
    // round-trips through the contract layout and differs from the Bootr encoding only in the first two rules
    expect(decodeCallPolicyData(encodeCallPolicyData(rules)).map((r) => [r.target, r.selector])).toEqual(rules.map((r) => [r.target, r.selector]));
    expect(encodeCallPolicyData(rules)).not.toBe(encodeCallPolicyData(callPolicyRules(params())));
    expect(policyModules(p)).toEqual(policyModules(params()));
    expect(buildValidatorData(p)).not.toBe(buildValidatorData(params()));
  });

  it('a Clanker policy needs the lockers and the source-aware layout', () => {
    expect(() => callPolicyRules(clankerParams({ lpLocker: undefined }))).toThrow(/lpLocker/);
    expect(() => callPolicyRules(clankerParams({ feeLocker: undefined as unknown as Address }))).toThrow(/feeLocker/);
    expect(() => callPolicyRules(clankerParams({ rulesVersion: 3 }))).toThrow(/rule layout 4/);
    // the legacy guard still comes first
    expect(() => callPolicyRules(clankerParams({ rulesVersion: 1 }))).toThrow(/legacy rule layout/);
  });
});

describe('userOp signature: BootrCallPolicy time slot', () => {
  it('encodeSessionSignature = [0 || uint64(32) || abi.encode(now)] || 0xff || sig; without a time it is 0xff || sig', () => {
    expect(encodeSessionSignature('0x1234')).toBe('0xff1234');
    const at = encodeSessionSignature('0x1234', 1_800_000_000);
    expect(at).toBe(concatHex(['0x00', '0x0000000000000020', toHex(1_800_000_000n, { size: 32 }), '0xff', '0x1234']));
    expect(encodeTimeSlot(5n)).toEqual({ index: 0, data: toHex(5n, { size: 32 }) });
    expect(() => encodeTimeSlot(2n ** 48n)).toThrow(/uint48/);
    expect(() => encodeTimeSlot(-1)).toThrow(/uint48/);
  });

  it('policy slots are sorted by index; duplicates and out-of-range indexes are refused (Kernel: PolicySignatureOrderError)', () => {
    expect(encodePolicySigs([{ index: 2, data: '0x01' }, { index: 1, data: '0x0203' }])).toBe(concatHex(['0x01', '0x0000000000000002', '0x0203', '0x02', '0x0000000000000001', '0x01']));
    expect(() => encodePolicySigs([{ index: 1, data: '0x' }, { index: 1, data: '0x' }])).toThrow(/duplicate/);
    expect(() => encodePolicySigs([{ index: 255, data: '0x' }])).toThrow(/out of range/);
    expect(encodePolicySigs([])).toBe('0x');
  });
});

describe('enable digest and identifiers', () => {
  it('EIP-712 digest equals the manual keccak layout of AgentGuardian._enableDigest', () => {
    const validatorData = buildValidatorData(params());
    const args = { kernel: KERNEL, chainId: 84532, guardian: GUARDIAN, permissionId: PID, nonce: 1, validatorData };
    expect(enableDigest(args)).toBe(enableDigestManual(args));
    expect(enableDigest({ ...args, nonce: 2 })).not.toBe(enableDigest(args));
  });

  it('validationId = 0x02 || permissionId || 16 zero bytes; nonce key matches the fork test formula', () => {
    expect(validationId(PID)).toBe('0x02deadbeef00000000000000000000000000000000');
    // uint192 key = (mode << 184) | (0x02 << 176) | (uint160(bytes20(pid || bytes16(0))) << 16)
    const ref = (mode: bigint) => (mode << 184n) | (2n << 176n) | (BigInt(pad(PID, { size: 20, dir: 'right' })) << 16n);
    expect(nonceKey(PID, '0x01')).toBe(ref(1n));
    expect(nonceKey(PID, '0x00')).toBe(ref(0n));
    expect(nonceMode(nonceKey(PID, '0x01') << 64n)).toBe('0x01');
    expect(nonceMode((nonceKey(PID, '0x00') << 64n) | 5n)).toBe('0x00');
  });

  it('enable signature = guardian || abi.encode(validatorData, 0x00, 0xe9ae5c53, enableSig, userOpSig)', () => {
    const validatorData = buildValidatorData(params());
    const userOpSig = encodeSessionSignature('0x1234');
    expect(userOpSig).toBe('0xff1234');
    const sig = encodeEnableSignature(GUARDIAN, validatorData, userOpSig);
    expect(slice(sig, 0, 20).toLowerCase()).toBe(GUARDIAN.toLowerCase());
    const [vd, hookData, selectorData, enableSig, uos] = decodeAbiParameters(parseAbiParameters('bytes, bytes, bytes, bytes, bytes'), slice(sig, 20));
    expect(vd).toBe(validatorData);
    expect(hookData).toBe('0x00');
    expect(selectorData).toBe(KERNEL_EXECUTE_SELECTOR);
    expect(enableSig).toBe('0x');
    expect(uos).toBe('0xff1234');
  });

  it('ERC-1271 signature = 0x02 || permissionId(4) || 0xff || signerSig (Kernel decodeSignature case 2 consumes 5 bytes)', () => {
    expect(encodeErc1271Signature(PID, '0xabcd')).toBe(`0x02${PID.slice(2)}ffabcd`);
    expect((encodeErc1271Signature(PID, `0x${'11'.repeat(65)}`).length - 2) / 2).toBe(5 + 1 + 65);
  });
});

describe('kernel call data', () => {
  it('wraps execute(mode, calldata) in executeUserOp for single and batch calls', () => {
    const transfer = encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [PAYTO, 0n] });
    const single = encodeKernelCalls([{ to: ADDR.usdc, data: transfer }]);
    expect(single.startsWith(KERNEL_EXECUTE_USER_OP_SELECTOR)).toBe(true);
    expect(slice(single, 4, 8)).toBe(KERNEL_EXECUTE_SELECTOR);
    const [mode, execCalldata] = decodeAbiParameters(parseAbiParameters('bytes32, bytes'), slice(single, 8));
    expect(mode).toBe(EXEC_MODE_SINGLE);
    expect(execCalldata.toLowerCase()).toBe(concatHex([ADDR.usdc, pad(toHex(0n), { size: 32 }), transfer]).toLowerCase());
    const batch = encodeKernelCalls([{ to: ADDR.usdc, data: transfer }, { to: ADDR.weth, data: transfer, value: 1n }]);
    const [bmode, bdata] = decodeAbiParameters(parseAbiParameters('bytes32, bytes'), slice(batch, 8));
    expect(bmode).toBe(EXEC_MODE_BATCH);
    const [execs] = decodeAbiParameters(parseAbiParameters('(address target, uint256 value, bytes callData)[]'), bdata);
    expect(execs).toHaveLength(2);
    expect(execs[1]!.value).toBe(1n);
    expect(keccak256(batch)).not.toBe(keccak256(single));
  });
});
