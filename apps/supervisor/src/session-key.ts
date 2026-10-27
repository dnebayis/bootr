/**
 * Session key construction for a Bootr agent Kernel (ZeroDev Kernel v3.1, permission validator).
 *
 * The install goes through the guardian's enable-mode path, so this module produces exactly the
 * artefacts `packages/contracts/src/README.md` specifies:
 *   - `validatorData = abi.encode(bytes[] permissionEnableData)` (policies first, signer last)
 *   - `ValidationId = 0x02 ‖ permissionId ‖ 16 zero bytes`
 *   - the enable digest (EIP-712 `Enable` over the Kernel domain) that `guardian.approveSessionKey` pre-approves
 *   - the nonce key `mode ‖ 0x02 ‖ permissionId ‖ 16 zero bytes ‖ 2-byte key`
 *   - the enable-mode userOp signature `guardian ‖ abi.encode(validatorData, 0x00, 0xe9ae5c53, enableSig, userOpSig)`
 *
 * The call allow-list is Bootr's own module, `BootrCallPolicy` (`packages/contracts/src/BootrCallPolicy.sol`),
 * installed first with `abi.encode(Rule[])` init data (see `callPolicyRules` / `encodeCallPolicyData`).
 * ZeroDev's CallPolicy is not used: hooked permissions require `executeUserOp`-wrapped callData, which
 * that module cannot parse. ZeroDev SDK functions used: `toGasPolicy`, `toRateLimitPolicy`,
 * `toTimestampPolicy`, `toSignatureCallerPolicy` (policy init data), `toECDSASigner` and
 * `toPermissionValidator.getEnableData` (cross-checked against the local encoder in tests). The SDK's
 * own enable-mode wrapper (`getEncodedPluginsData`) cannot be used: it appends an action address and
 * init data to `selectorData`, while the guardian fixes `selectorData` to the bare 4-byte `execute` selector.
 */
import { randomBytes } from 'node:crypto';
import { toECDSASigner } from '@zerodev/permissions/signers';
import { toGasPolicy, toRateLimitPolicy, toSignatureCallerPolicy, toTimestampPolicy } from '@zerodev/permissions/policies';
import { PolicyFlags } from '@zerodev/permissions';
import {
  concatHex,
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  hashTypedData,
  keccak256,
  pad,
  parseAbiParameters,
  toFunctionSelector,
  toHex,
  type Address,
  type Hex,
  type LocalAccount,
} from 'viem';
import { KERNEL_EXECUTE_SELECTOR, UNIVERSAL_ROUTER_EXECUTE_SELECTOR } from './abi.js';

export const KERNEL_VERSION = '0.3.1';
export const SESSION_HOOK_DATA: Hex = '0x00';
export const SESSION_SELECTOR_DATA: Hex = KERNEL_EXECUTE_SELECTOR;
export const VALIDATION_TYPE_PERMISSION: Hex = '0x02';
export const NONCE_MODE_DEFAULT: Hex = '0x00';
export const NONCE_MODE_ENABLE: Hex = '0x01';
/** `0xff` prefix = "no policy signatures follow, here is the signer signature". */
export const SIGNER_PREFIX: Hex = '0xff';
export const DUMMY_ECDSA_SIG: Hex =
  '0xfffffffffffffffffffffffffffffff0000000000000000000000000000000007aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1c';

export interface SessionPolicyParams {
  kernel: Address;
  token: Address;
  feeLocker: Address;
  universalRouter: Address;
  usdc: Address;
  weth: Address;
  inferencePayTo: Address;
  /** Max per-transfer USDC amount (6 dp units) to the inference payTo. */
  usdcTransferCap: bigint;
  /** GasPolicy cumulative allowance in wei. */
  gasAllowanceWei: bigint;
  ratePerHour: number;
  /** Unix seconds. */
  validUntil: number;
  validAfter?: number;
  /** ERC-1271 callers for SignatureCallerPolicy; `null` = no caller policy. */
  signatureCallers: Address[] | null;
  /** Session signer EOA address. */
  sessionSigner: Address;
  policyAddresses: {
    /** BootrCallPolicy (`addresses.bootr.callPolicy`), not ZeroDev's CallPolicy. */
    callPolicy: Address;
    gasPolicy: Address;
    rateLimitPolicy: Address;
    timestampPolicy: Address;
    signaturePolicy: Address;
    ecdsaSigner: Address;
  };
}

/** JSON-safe form stored in `sv_agents.session_policy`. */
export type SerializedSessionPolicy = Omit<SessionPolicyParams, 'usdcTransferCap' | 'gasAllowanceWei'> & {
  usdcTransferCap: string;
  gasAllowanceWei: string;
};

export function serializeSessionPolicy(p: SessionPolicyParams): SerializedSessionPolicy {
  return { ...p, usdcTransferCap: p.usdcTransferCap.toString(), gasAllowanceWei: p.gasAllowanceWei.toString() };
}

export function deserializeSessionPolicy(p: SerializedSessionPolicy): SessionPolicyParams {
  return { ...p, usdcTransferCap: BigInt(p.usdcTransferCap), gasAllowanceWei: BigInt(p.gasAllowanceWei) };
}

export interface PolicyEntry {
  flags: Hex;
  module: Address;
  data: Hex;
}

// ---------------------------------------------------------------------------
// BootrCallPolicy rules (packages/contracts/src/BootrCallPolicy.sol)
// ---------------------------------------------------------------------------

/** `ArgRule.op`: EQUAL compares the 32-byte word, LESS_THAN_OR_EQUAL compares it as uint256. */
export const CallPolicyOp = { EQUAL: 1, LESS_THAN_OR_EQUAL: 2 } as const;

export interface CallPolicyArgRule {
  /** Static argument index: the word at `4 + 32 * index` of the call data. */
  index: number;
  op: (typeof CallPolicyOp)[keyof typeof CallPolicyOp];
  value: Hex; // bytes32
}

export interface CallPolicyRule {
  target: Address;
  selector: Hex;
  args: CallPolicyArgRule[];
}

/** `abi.encode(Rule[])` as `BootrCallPolicy.onInstall` decodes it (after the 32-byte permission id). */
export const CALL_POLICY_RULES_ABI = parseAbiParameters('(address target, bytes4 selector, (uint8 index, uint8 op, bytes32 value)[] args)[]');

export const FEE_LOCKER_CLAIM_SELECTOR: Hex = toFunctionSelector('claim(address,address)');
export const ERC20_TRANSFER_SELECTOR: Hex = toFunctionSelector('transfer(address,uint256)');

// Lower-case bytes32 values so rule data compares byte-for-byte with the lower-cased `validatorData`.
const eqAddress = (index: number, value: Address): CallPolicyArgRule => ({ index, op: CallPolicyOp.EQUAL, value: pad(value, { size: 32 }).toLowerCase() as Hex });
const lteUint = (index: number, value: bigint): CallPolicyArgRule => ({ index, op: CallPolicyOp.LESS_THAN_OR_EQUAL, value: toHex(value, { size: 32 }) });

/** The four calls a session key may make, in this order. Every call must carry zero ETH value. */
export function callPolicyRules(p: SessionPolicyParams): CallPolicyRule[] {
  return [
    // FeeLocker.claim(kernel, *): anyone may trigger, funds always go to the kernel.
    { target: p.feeLocker, selector: FEE_LOCKER_CLAIM_SELECTOR, args: [eqAddress(0, p.kernel)] },
    // UniversalRouter.execute(bytes,bytes[],uint256): route encoding is validated off-chain by treasury.ts.
    { target: p.universalRouter, selector: UNIVERSAL_ROUTER_EXECUTE_SELECTOR, args: [] },
    // USDC.transfer(inferencePayTo, <= cap): direct model funding.
    { target: p.usdc, selector: ERC20_TRANSFER_SELECTOR, args: [eqAddress(0, p.inferencePayTo), lteUint(1, p.usdcTransferCap)] },
    // WETH.transfer(universalRouter, *): pays the router before a swap (payerIsUser = false).
    { target: p.weth, selector: ERC20_TRANSFER_SELECTOR, args: [eqAddress(0, p.universalRouter)] },
  ];
}

export function encodeCallPolicyData(rules: readonly CallPolicyRule[]): Hex {
  return encodeAbiParameters(CALL_POLICY_RULES_ABI, [rules.map((r) => ({ target: r.target, selector: r.selector, args: r.args.map((a) => ({ index: a.index, op: a.op, value: a.value })) }))]).toLowerCase() as Hex;
}

export function decodeCallPolicyData(data: Hex): CallPolicyRule[] {
  const [rules] = decodeAbiParameters(CALL_POLICY_RULES_ABI, data);
  return rules.map((r) => ({ target: getAddress(r.target), selector: r.selector, args: r.args.map((a) => ({ index: a.index, op: a.op as CallPolicyArgRule['op'], value: a.value })) }));
}

/** The BootrCallPolicy entry: installed first, userOp-only (`NOT_FOR_VALIDATE_SIG`). */
export function callPolicyEntry(p: SessionPolicyParams): PolicyEntry {
  return { flags: PolicyFlags.NOT_FOR_VALIDATE_SIG, module: p.policyAddresses.callPolicy, data: encodeCallPolicyData(callPolicyRules(p)) };
}

/**
 * ZeroDev policies in install order (after the call policy). Gas and rate-limit policies are flagged
 * `NOT_FOR_VALIDATE_SIG` so ERC-1271 (x402 payments) only passes the timestamp policy and, optionally,
 * the signature-caller policy, which in turn is flagged `NOT_FOR_VALIDATE_USEROP`.
 */
export function buildPolicies(p: SessionPolicyParams) {
  const gasPolicy = toGasPolicy({ policyAddress: p.policyAddresses.gasPolicy, policyFlag: PolicyFlags.NOT_FOR_VALIDATE_SIG, allowed: p.gasAllowanceWei });
  const rateLimitPolicy = toRateLimitPolicy({
    policyAddress: p.policyAddresses.rateLimitPolicy,
    policyFlag: PolicyFlags.NOT_FOR_VALIDATE_SIG,
    count: p.ratePerHour,
    interval: 3600,
  });
  const timestampPolicy = toTimestampPolicy({
    policyAddress: p.policyAddresses.timestampPolicy,
    policyFlag: PolicyFlags.FOR_ALL_VALIDATION,
    validAfter: p.validAfter ?? 0,
    validUntil: p.validUntil,
  });
  const policies = [gasPolicy, rateLimitPolicy, timestampPolicy];
  if (p.signatureCallers && p.signatureCallers.length) {
    policies.push(
      toSignatureCallerPolicy({
        policyAddress: p.policyAddresses.signaturePolicy,
        policyFlag: PolicyFlags.NOT_FOR_VALIDATE_USEROP,
        allowedCallers: p.signatureCallers,
      }),
    );
  }
  return policies;
}

/** `bytes2 flags ‖ address module ‖ initData` per entry, then `abi.encode(bytes[])`. */
export function encodeValidatorData(entries: readonly PolicyEntry[]): Hex {
  const packed = entries.map((e) => concatHex([e.flags, e.module, e.data]));
  // Lower-case so the stored hex compares byte-for-byte with decoded values (checksummed inputs otherwise leak casing).
  return encodeAbiParameters(parseAbiParameters('bytes[]'), [packed]).toLowerCase() as Hex;
}

/** Entries built from the ZeroDev SDK policies, then the ECDSA signer (everything except the call policy). */
export function zerodevEntries(p: SessionPolicyParams): PolicyEntry[] {
  const entries: PolicyEntry[] = buildPolicies(p).map((policy) => {
    const info = policy.getPolicyInfoInBytes();
    return { flags: `0x${info.slice(2, 6)}` as Hex, module: getAddress(`0x${info.slice(6, 46)}`), data: policy.getPolicyData() };
  });
  entries.push({ flags: PolicyFlags.FOR_ALL_VALIDATION, module: p.policyAddresses.ecdsaSigner, data: p.sessionSigner });
  return entries;
}

/** All entries in install order: BootrCallPolicy, gas, rate-limit, timestamp, [signature-caller], signer. */
export function policyEntries(p: SessionPolicyParams): PolicyEntry[] {
  return [callPolicyEntry(p), ...zerodevEntries(p)];
}

/** The complete `validatorData` for `guardian.approveSessionKey` and the enable userOp. */
export function buildValidatorData(p: SessionPolicyParams): Hex {
  return encodeValidatorData(policyEntries(p));
}

/**
 * Cross-check: the SDK's own `toPermissionValidator(...).getEnableData()` for the ZeroDev policies and
 * the signer only (the SDK does not know BootrCallPolicy). Compare against `encodeValidatorData(zerodevEntries(p))`.
 */
export async function sdkValidatorData(p: SessionPolicyParams, signer: LocalAccount, entryPoint: Address, chainId: number): Promise<Hex> {
  const { toPermissionValidator } = await import('@zerodev/permissions');
  const ecdsa = await toECDSASigner({ signer, signerContractAddress: p.policyAddresses.ecdsaSigner });
  const client = { chain: { id: chainId } } as unknown as Parameters<typeof toPermissionValidator>[0];
  const validator = await toPermissionValidator(client, {
    signer: ecdsa,
    policies: buildPolicies(p),
    entryPoint: { address: entryPoint, version: '0.7' },
    kernelVersion: KERNEL_VERSION,
  });
  return validator.getEnableData(p.kernel);
}

export function randomPermissionId(): Hex {
  return toHex(randomBytes(4));
}

/** `ValidationId = 0x02 ‖ permissionId ‖ 16 zero bytes` (bytes21). */
export function validationId(permissionId: Hex): Hex {
  return concatHex([VALIDATION_TYPE_PERMISSION, pad(permissionId, { size: 20, dir: 'right' })]);
}

/** EntryPoint nonce key: `mode(1) ‖ 0x02(1) ‖ permissionId(4) ‖ 16 zero bytes ‖ 2-byte key` as uint192. */
export function nonceKey(permissionId: Hex, mode: Hex = NONCE_MODE_DEFAULT, key = 0): bigint {
  return BigInt(concatHex([mode, validationId(permissionId), pad(toHex(key), { size: 2 })]));
}

/** Full 256-bit nonce: `key(192) ‖ seq(64)`. */
export function encodeNonce(permissionId: Hex, mode: Hex, seq: bigint): bigint {
  return (nonceKey(permissionId, mode) << 64n) | seq;
}

export const ENABLE_TYPES = {
  Enable: [
    { name: 'validationId', type: 'bytes21' },
    { name: 'nonce', type: 'uint32' },
    { name: 'hook', type: 'address' },
    { name: 'validatorData', type: 'bytes' },
    { name: 'hookData', type: 'bytes' },
    { name: 'selectorData', type: 'bytes' },
  ],
} as const;

/** The digest `guardian.approveSessionKey` approves (EIP-712 `Enable` over the Kernel domain). */
export function enableDigest(args: { kernel: Address; chainId: number; guardian: Address; permissionId: Hex; nonce: number; validatorData: Hex }): Hex {
  return hashTypedData({
    domain: { name: 'Kernel', version: KERNEL_VERSION, chainId: args.chainId, verifyingContract: args.kernel },
    types: ENABLE_TYPES,
    primaryType: 'Enable',
    message: {
      validationId: validationId(args.permissionId),
      nonce: args.nonce,
      hook: args.guardian,
      validatorData: args.validatorData,
      hookData: SESSION_HOOK_DATA,
      selectorData: SESSION_SELECTOR_DATA,
    },
  });
}

/** Same digest computed byte-for-byte like `AgentGuardian._enableDigest` (used by tests as an independent reference). */
export function enableDigestManual(args: { kernel: Address; chainId: number; guardian: Address; permissionId: Hex; nonce: number; validatorData: Hex }): Hex {
  const ENABLE_TYPE_HASH = keccak256(toHex('Enable(bytes21 validationId,uint32 nonce,address hook,bytes validatorData,bytes hookData,bytes selectorData)'));
  const DOMAIN_TYPEHASH = keccak256(toHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const structHash = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes21, uint32, address, bytes32, bytes32, bytes32'), [
      ENABLE_TYPE_HASH,
      validationId(args.permissionId),
      args.nonce,
      args.guardian,
      keccak256(args.validatorData),
      keccak256(SESSION_HOOK_DATA),
      keccak256(SESSION_SELECTOR_DATA),
    ]),
  );
  const domainSeparator = keccak256(
    encodeAbiParameters(parseAbiParameters('bytes32, bytes32, bytes32, uint256, address'), [
      DOMAIN_TYPEHASH,
      keccak256(toHex('Kernel')),
      keccak256(toHex(KERNEL_VERSION)),
      BigInt(args.chainId),
      args.kernel,
    ]),
  );
  return keccak256(concatHex(['0x1901', domainSeparator, structHash]));
}

/** `guardian ‖ abi.encode(validatorData, hookData, selectorData, enableSig, userOpSig)`; the guardian ignores enableSig. */
export function encodeEnableSignature(guardian: Address, validatorData: Hex, userOpSig: Hex, enableSig: Hex = '0x'): Hex {
  return concatHex([
    guardian,
    encodeAbiParameters(parseAbiParameters('bytes, bytes, bytes, bytes, bytes'), [validatorData, SESSION_HOOK_DATA, SESSION_SELECTOR_DATA, enableSig, userOpSig]),
  ]);
}

/** Session signature for a regular userOp: `policySigs (none) ‖ 0xff ‖ signerSig`. */
export function encodeSessionSignature(signerSig: Hex): Hex {
  return concatHex([SIGNER_PREFIX, signerSig]);
}

/**
 * ERC-1271 signature as Kernel decodes it (`ValidatorLib.decodeSignature`, case 2):
 * `0x02 ‖ permissionId(4) ‖ policySigs (none) ‖ 0xff ‖ signerSig`. Only the 5-byte prefix is consumed for
 * permissions (unlike the 21-byte validator layout); the 16 zero bytes of the full ValidationId would be
 * parsed as policy-signature indexes and make Kernel revert `PolicySignatureOrderError`.
 */
export function encodeErc1271Signature(permissionId: Hex, signerSig: Hex): Hex {
  return concatHex([VALIDATION_TYPE_PERMISSION, permissionId, SIGNER_PREFIX, signerSig]);
}

/** `abi.encode(bytes[] permissionDisableData)` for `guardian.revokeSessionKey` (policies.length + 1 entries). */
export function buildDeinitData(p: SessionPolicyParams): Hex {
  const entries = policyEntries(p).map((e) => e.module as Hex);
  return encodeAbiParameters(parseAbiParameters('bytes[]'), [entries]);
}
