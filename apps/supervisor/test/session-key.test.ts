import { describe, expect, it } from 'vitest';
import { concatHex, decodeAbiParameters, encodeAbiParameters, encodeFunctionData, erc20Abi, getAddress, keccak256, pad, parseAbiParameters, slice, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { PolicyFlags } from '@zerodev/permissions';
import { ADDR, GUARDIAN, KERNEL, PAYTO, SESSION_PK, TOKEN } from './helpers.js';
import {
  buildDeinitData,
  buildValidatorData,
  callPolicyRules,
  CallPolicyOp,
  decodeCallPolicyData,
  encodeCallPolicyData,
  encodeEnableSignature,
  encodeErc1271Signature,
  encodeSessionSignature,
  encodeValidatorData,
  enableDigest,
  enableDigestManual,
  nonceKey,
  policyEntries,
  sdkValidatorData,
  validationId,
  zerodevEntries,
  type SessionPolicyParams,
} from '../src/session-key.js';
import { EXEC_MODE_BATCH, EXEC_MODE_SINGLE, encodeKernelCalls, nonceMode } from '../src/kernel.js';
import { KERNEL_EXECUTE_SELECTOR, KERNEL_EXECUTE_USER_OP_SELECTOR } from '../src/abi.js';

const signer = privateKeyToAccount(SESSION_PK);
const PID: Hex = '0xdeadbeef';
/** BootrCallPolicy is not deployed yet (`addresses.bootr.callPolicy` is null); any address will do for encoding. */
const CALL_POLICY = (ADDR.bootr.callPolicy ?? '0x6000000000000000000000000000000000000006') as Address;

function params(over: Partial<SessionPolicyParams> = {}): SessionPolicyParams {
  const z = ADDR.zerodev;
  return {
    kernel: KERNEL,
    token: TOKEN,
    feeLocker: ADDR.clankerFeeLocker,
    universalRouter: ADDR.uniswap.universalRouter,
    usdc: ADDR.usdc,
    weth: ADDR.weth,
    inferencePayTo: PAYTO,
    usdcTransferCap: 50_000_000n,
    gasAllowanceWei: 10n ** 17n,
    ratePerHour: 60,
    validUntil: 1_800_000_000,
    signatureCallers: [ADDR.usdc],
    sessionSigner: signer.address,
    policyAddresses: { callPolicy: ADDR.bootr.callPolicy ?? CALL_POLICY, gasPolicy: z.gasPolicy!, rateLimitPolicy: z.rateLimitPolicy!, timestampPolicy: z.timestampPolicy!, signaturePolicy: z.signaturePolicy!, ecdsaSigner: z.ecdsaSigner! },
    ...over,
  };
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

  it('production policy set: every entry is flags||address||initData, signer last, flags as designed', () => {
    const p = params();
    const data = buildValidatorData(p);
    const [entries] = decodeAbiParameters(parseAbiParameters('bytes[]'), data);
    expect(entries).toHaveLength(6); // call, gas, rate, timestamp, signature-caller, signer
    const parsed = entries.map((e) => ({ flags: slice(e, 0, 2), module: getAddress(slice(e, 2, 22)), data: e.length > 46 ? slice(e, 22) : ('0x' as Hex) }));
    expect(parsed.map((e) => e.module)).toEqual([p.policyAddresses.callPolicy, p.policyAddresses.gasPolicy, p.policyAddresses.rateLimitPolicy, p.policyAddresses.timestampPolicy, p.policyAddresses.signaturePolicy, p.policyAddresses.ecdsaSigner]);
    expect(parsed.map((e) => e.flags)).toEqual([PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.NOT_FOR_VALIDATE_SIG, PolicyFlags.FOR_ALL_VALIDATION, PolicyFlags.NOT_FOR_VALIDATE_USEROP, PolicyFlags.FOR_ALL_VALIDATION]);
    // signer init data is the 20-byte session key
    expect(parsed[5]!.data.toLowerCase()).toBe(signer.address.toLowerCase());
    // timestamp policy init data = abi.encode(uint48 validAfter, uint48 validUntil)
    expect(parsed[3]!.data).toBe(encodeAbiParameters(parseAbiParameters('uint48, uint48'), [0, 1_800_000_000]));
    // rate limit: interval(6) || count(6) || startAt(6)
    expect(parsed[2]!.data).toBe(`0x${(3600).toString(16).padStart(12, '0')}${(60).toString(16).padStart(12, '0')}${'0'.repeat(12)}`);
    // call policy init data = abi.encode(Rule[]) with the four allow-list rules (checked in detail below)
    expect(parsed[0]!.data).toBe(encodeCallPolicyData(callPolicyRules(p)));
    expect(parsed[0]!.module).toBe(CALL_POLICY);
  });

  it('BootrCallPolicy rules: exactly FeeLocker.claim(kernel,*), Router.execute, USDC.transfer(payTo,<=cap), WETH.transfer(router,*)', () => {
    const p = params();
    const rules = callPolicyRules(p);
    expect(rules).toEqual([
      { target: ADDR.clankerFeeLocker, selector: '0x21c0b342', args: [{ index: 0, op: CallPolicyOp.EQUAL, value: pad(KERNEL, { size: 32 }) }] }, // claim(address,address)
      { target: ADDR.uniswap.universalRouter, selector: '0x3593564c', args: [] }, // execute(bytes,bytes[],uint256)
      {
        target: ADDR.usdc,
        selector: '0xa9059cbb', // transfer(address,uint256)
        args: [
          { index: 0, op: CallPolicyOp.EQUAL, value: pad(PAYTO, { size: 32 }) },
          { index: 1, op: CallPolicyOp.LESS_THAN_OR_EQUAL, value: toHex(50_000_000n, { size: 32 }) },
        ],
      },
      { target: ADDR.weth, selector: '0xa9059cbb', args: [{ index: 0, op: CallPolicyOp.EQUAL, value: pad(ADDR.uniswap.universalRouter, { size: 32 }).toLowerCase() }] },
    ]);
    // round-trips through the contract's `abi.encode(Rule[])` layout: (address, bytes4, (uint8, uint8, bytes32)[])[]
    const data = encodeCallPolicyData(rules);
    const decoded = decodeCallPolicyData(data);
    expect(decoded.map((r) => ({ ...r, args: r.args.map((a) => ({ ...a, value: a.value.toLowerCase() })) }))).toEqual(rules.map((r) => ({ ...r, args: r.args.map((a) => ({ ...a, value: a.value.toLowerCase() })) })));
    // same bytes as a hand-written abi.encode with the Solidity tuple layout
    const manual = encodeAbiParameters(parseAbiParameters('(address, bytes4, (uint8, uint8, bytes32)[])[]'), [rules.map((r) => [r.target, r.selector, r.args.map((a) => [a.index, a.op, a.value] as const)] as const)]);
    expect(data).toBe(manual.toLowerCase());
    // the Kernel prepends bytes32(permissionId) to the module init data; our data must start right after
    expect(slice(concatHex([pad(PID, { size: 32, dir: 'right' }), data]), 32)).toBe(data);
  });

  it('the ZeroDev entries equal the SDK encoding (toPermissionValidator.getEnableData); the call policy is ours', async () => {
    const p = params();
    const sdk = (await sdkValidatorData(p, signer, '0x0000000071727De22E5E9d8BAf0edAc6f37da032', 84532)).toLowerCase();
    expect(encodeValidatorData(zerodevEntries(p))).toBe(sdk);
    // full validatorData = call policy entry + the SDK entries, in that order
    const [all] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildValidatorData(p));
    const [sdkEntries] = decodeAbiParameters(parseAbiParameters('bytes[]'), sdk as Hex);
    expect(all.slice(1)).toEqual(sdkEntries);
    expect(slice(all[0]!, 2, 22).toLowerCase()).toBe(CALL_POLICY.toLowerCase());
  });

  it('omits the signature-caller policy when callers are unrestricted', () => {
    expect(policyEntries(params({ signatureCallers: null }))).toHaveLength(5);
    const [entries] = decodeAbiParameters(parseAbiParameters('bytes[]'), buildDeinitData(params()));
    expect(entries).toHaveLength(6);
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
