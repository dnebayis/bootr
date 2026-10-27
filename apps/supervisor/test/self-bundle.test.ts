import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import {
  concatHex,
  ContractFunctionExecutionError,
  ContractFunctionRevertedError,
  decodeAbiParameters,
  encodeErrorResult,
  encodeFunctionData,
  erc20Abi,
  pad,
  parseAbi,
  parseAbiParameters,
  slice,
  toHex,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { entryPoint07Abi, entryPoint07Address, toPackedUserOperation } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { createLocalAdminSigner } from '../src/admin-signer.js';
import { loadConfig } from '../src/config.js';
import { agents } from '../src/db/schema.js';
import { describeEntryPointError, describeRevertData, SELF_BUNDLE_GAS, SELF_BUNDLE_MAX_FEE_HEADROOM_BPS } from '../src/entrypoint.js';
import { createKernelClient, nonceMode } from '../src/kernel.js';
import { installSessionKey, rotateSessionKey, sessionPolicyFor } from '../src/onboarding.js';
import { buildValidatorData, encodeNonce, NONCE_MODE_ENABLE, serializeSessionPolicy } from '../src/session-key.js';
import { ADDR, ADMIN_PK, chainState, entryPointUserOpHash, GUARDIAN, HANDLE_OPS_TX, KERNEL, makeWorld, mockAdminSigner, mockChain, PAYTO, seedAgent, SESSION_PK, testConfig } from './helpers.js';

const sessionSigner = privateKeyToAccount(SESSION_PK);
const PID: Hex = '0x11223344';
const VALIDATOR_DATA: Hex = '0x1234';
const NOOP = { to: ADDR.usdc, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [PAYTO, 0n] }) };

async function selfBundlingClient(state = chainState({ sessionInstalled: false })) {
  const admin = mockAdminSigner();
  const chain = mockChain(state);
  const client = await createKernelClient({
    publicClient: chain.publicClient,
    chain: baseSepolia,
    kernel: KERNEL,
    guardian: GUARDIAN,
    permissionId: PID,
    validatorData: VALIDATOR_DATA,
    sessionSigner,
    bundlerUrl: 'http://127.0.0.1:9', // never reached by a self-bundled op
    selfBundle: admin.signer,
  });
  return { client, admin, state };
}

describe('config: ENABLE_MODE_SELF_BUNDLE', () => {
  it('defaults to false and requires ADMIN_PRIVATE_KEY when enabled', () => {
    expect(testConfig().ENABLE_MODE_SELF_BUNDLE).toBe(false);
    expect(testConfig({ ENABLE_MODE_SELF_BUNDLE: 'true' }).ENABLE_MODE_SELF_BUNDLE).toBe(true);
    expect(() => testConfig({ ENABLE_MODE_SELF_BUNDLE: 'true', ADMIN_PRIVATE_KEY: '' })).toThrow(/requires ADMIN_PRIVATE_KEY/);
    expect(() => loadConfig({ ...process.env, ENABLE_MODE_SELF_BUNDLE: 'maybe' })).toThrow();
  });
});

describe('self-bundled enable-mode userOp (kernel client)', () => {
  it('builds a packed EntryPoint v0.7 op with the fixed gas budget, signed in enable mode, hash equal to the EntryPoint formula', async () => {
    const { client, admin, state } = await selfBundlingClient(chainState({ sessionInstalled: false, nonceSeq: 3n, fees: { maxFeePerGas: 2_000_000n, maxPriorityFeePerGas: 50_000n } }));
    const prepared = await client.prepareUserOp([NOOP]);
    expect(prepared.enableMode).toBe(true);
    expect(prepared.selfBundled).toBe(true);
    expect(admin.handled).toHaveLength(0);

    const op = prepared.userOp;
    expect(op.sender).toBe(KERNEL);
    expect(op.nonce).toBe(encodeNonce(PID, NONCE_MODE_ENABLE, 3n));
    expect(nonceMode(op.nonce)).toBe(NONCE_MODE_ENABLE);
    expect(op.verificationGasLimit).toBe(SELF_BUNDLE_GAS.verificationGasLimit);
    expect(op.callGasLimit).toBe(SELF_BUNDLE_GAS.callGasLimit);
    expect(op.preVerificationGas).toBe(SELF_BUNDLE_GAS.preVerificationGas);
    expect(op.maxPriorityFeePerGas).toBe(50_000n);
    expect(op.maxFeePerGas).toBe((2_000_000n * (10_000n + SELF_BUNDLE_MAX_FEE_HEADROOM_BPS)) / 10_000n);
    expect(op.paymaster).toBeUndefined();
    expect(op.callData.startsWith('0x8dd7712f')).toBe(true);

    // packed exactly as EntryPoint v0.7 reads it
    const packed = toPackedUserOperation(op);
    expect(packed.accountGasLimits).toBe(concatHex([pad(toHex(op.verificationGasLimit), { size: 16 }), pad(toHex(op.callGasLimit), { size: 16 })]));
    expect(packed.gasFees).toBe(concatHex([pad(toHex(op.maxPriorityFeePerGas), { size: 16 }), pad(toHex(op.maxFeePerGas), { size: 16 })]));
    expect(packed.initCode).toBe('0x');
    expect(packed.paymasterAndData).toBe('0x');
    expect(prepared.hash).toBe(entryPointUserOpHash(packed));

    // enable-mode signature: guardian ‖ abi.encode(validatorData, 0x00, execute selector, "", timeSlot ‖ 0xff ‖ ecdsa(hash))
    expect(slice(op.signature, 0, 20).toLowerCase()).toBe(GUARDIAN.toLowerCase());
    const [validatorData, hookData, selectorData, enableSig, userOpSig] = decodeAbiParameters(parseAbiParameters('bytes, bytes, bytes, bytes, bytes'), slice(op.signature, 20));
    expect(validatorData).toBe(VALIDATOR_DATA);
    expect(hookData).toBe('0x00');
    expect(selectorData).toBe('0xe9ae5c53');
    expect(enableSig).toBe('0x');
    // [0 || uint64(32) || abi.encode(now)] || 0xff || ecdsa: BootrCallPolicy's time slot precedes the signer prefix
    expect(slice(userOpSig, 0, 9)).toBe('0x000000000000000020');
    expect(slice(userOpSig, 41, 42)).toBe('0xff');
    const { recoverAddress } = await import('viem');
    expect((await recoverAddress({ hash: prepared.hash, signature: slice(userOpSig, 42) })).toLowerCase()).toBe(sessionSigner.address.toLowerCase());
    expect(state.calls.filter((c) => c.fn === 'getNonce')).toHaveLength(1);
  });

  it('submits through adminSigner.handleOps once, serves the UserOperationEvent as the receipt and re-reads validationConfig', async () => {
    const { client, admin, state } = await selfBundlingClient();
    const prepared = await client.prepareUserOp([NOOP]);
    const readsBefore = state.calls.filter((c) => c.fn === 'validationConfig').length;

    expect(await client.submitUserOp(prepared)).toBe(prepared.hash);
    expect(admin.handled).toHaveLength(1);
    const { ops, beneficiary } = admin.handled[0]!;
    expect(beneficiary).toBe(admin.signer.address);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toEqual(toPackedUserOperation(prepared.userOp));

    const receipt = await client.waitForReceipt(prepared.hash, 1000);
    expect(receipt).not.toBeNull();
    expect(receipt!.success).toBe(true);
    expect(receipt!.userOpHash).toBe(prepared.hash);
    expect(receipt!.sender).toBe(KERNEL);
    expect(receipt!.nonce).toBe(prepared.userOp.nonce);
    expect(receipt!.entryPoint).toBe(entryPoint07Address);
    expect(receipt!.receipt.transactionHash).toBe(HANDLE_OPS_TX);
    expect(receipt!.reason).toBeUndefined();
    expect(await client.getReceipt(prepared.hash)).toBe(receipt);

    // the cached `installed` flag was reset: the next check re-reads the chain, which now reports the hook
    state.sessionInstalled = true;
    expect(await client.isSessionInstalled()).toBe(true);
    expect(state.calls.filter((c) => c.fn === 'validationConfig').length).toBe(readsBefore + 1);
    // and a later op is a regular one, handed to the bundler (unreachable here), never self-bundled
    await expect(client.prepareUserOp([NOOP])).rejects.toThrow();
    expect(admin.handled).toHaveLength(1);
  });

  it('reports success=false with the decoded UserOperationRevertReason', async () => {
    const { client, admin } = await selfBundlingClient();
    admin.outcome = 'reverted';
    admin.revertReason = encodeErrorResult({ abi: parseAbi(['error PolicyFailed(uint256 i)']), errorName: 'PolicyFailed', args: [0n] });
    const prepared = await client.prepareUserOp([NOOP]);
    await client.submitUserOp(prepared);
    const receipt = await client.waitForReceipt(prepared.hash, 1000);
    expect(receipt!.success).toBe(false);
    expect(receipt!.reason).toBe('PolicyFailed(0)');
    expect(describeRevertData(encodeErrorResult({ abi: parseAbi(['error Error(string)']), errorName: 'Error', args: ['boom'] }))).toBe('Error("boom")');
    expect(describeRevertData('0xdeadbeef')).toBe('0xdeadbeef');
  });

  it('surfaces a FailedOp from handleOps and caches no receipt', async () => {
    const { client, admin } = await selfBundlingClient();
    admin.outcome = new Error('EntryPoint.handleOps failed: FailedOp(0, "AA21 didn\'t pay prefund")');
    const prepared = await client.prepareUserOp([NOOP]);
    await expect(client.submitUserOp(prepared)).rejects.toThrow(/FailedOp\(0, "AA21 didn't pay prefund"\)/);
    expect(admin.handled).toHaveLength(1);
    expect(await client.getReceipt(prepared.hash)).toBeNull();
  });
});

describe('local admin signer: handleOps', () => {
  function revertingPublicClient(errorName: 'FailedOp' | 'FailedOpWithRevert', args: readonly unknown[]) {
    const calls: unknown[] = [];
    const publicClient = {
      chain: baseSepolia,
      // The sender's EntryPoint deposit already covers the prefund, so handleOps is simulated without a top-up.
      async readContract() {
        return 10n ** 18n;
      },
      async getBalance() {
        return 0n;
      },
      async simulateContract(req: { address: Address; functionName: string; args: unknown[]; account: { address: Address } }) {
        calls.push(req);
        const data = encodeErrorResult({ abi: entryPoint07Abi, errorName, args: args as never });
        const reverted = new ContractFunctionRevertedError({ abi: entryPoint07Abi, functionName: 'handleOps', data });
        throw new ContractFunctionExecutionError(reverted, { abi: entryPoint07Abi, functionName: 'handleOps', args: req.args, contractAddress: req.address, sender: req.account.address });
      },
    } as unknown as PublicClient<Transport, Chain>;
    return { publicClient, calls };
  }

  function signerWith(publicClient: PublicClient<Transport, Chain>) {
    return createLocalAdminSigner({ privateKey: ADMIN_PK, chain: baseSepolia, rpcUrl: 'http://127.0.0.1:9', guardian: GUARDIAN, publicClient });
  }

  const packed = toPackedUserOperation({ sender: KERNEL, nonce: 0n, callData: '0x', ...SELF_BUNDLE_GAS, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' });

  it('simulates handleOps from the admin EOA against the EntryPoint and decodes FailedOp before sending anything', async () => {
    const { publicClient, calls } = revertingPublicClient('FailedOp', [0n, 'AA23 reverted']);
    const signer = signerWith(publicClient);
    await expect(signer.handleOps([packed], signer.address)).rejects.toThrow('EntryPoint.handleOps failed: FailedOp(0, "AA23 reverted")');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ address: entryPoint07Address, functionName: 'handleOps', args: [[packed], signer.address], account: { address: privateKeyToAccount(ADMIN_PK).address } });
  });

  it('decodes the inner Kernel error of FailedOpWithRevert', async () => {
    const inner = encodeErrorResult({ abi: parseAbi(['error PolicyFailed(uint256 i)']), errorName: 'PolicyFailed', args: [0n] });
    const { publicClient } = revertingPublicClient('FailedOpWithRevert', [0n, 'AA23 reverted', inner]);
    await expect(signerWith(publicClient).handleOps([packed], KERNEL)).rejects.toThrow('FailedOpWithRevert(0, "AA23 reverted", PolicyFailed(0))');
    expect(describeEntryPointError(new Error('plain'))).toBeNull();
  });
});

describe('installSessionKey with ENABLE_MODE_SELF_BUNDLE', () => {
  it('approves, self-bundles the enable op via handleOps and records the install', async () => {
    const world = await makeWorld({ config: { ENABLE_MODE_SELF_BUNDLE: 'true' }, chain: { sessionInstalled: false } });
    const admin = mockAdminSigner();
    world.ctx.adminSigner = admin.signer;
    try {
      const agent = await seedAgent(world, { agent: { status: 'onboarding', permissionId: null, sessionKeyInstalledAt: null } });
      const result = await installSessionKey(world.ctx, agent);

      expect(admin.approved).toHaveLength(1);
      expect(admin.approved[0]).toMatchObject({ kernel: KERNEL, permissionId: result.permissionId, validatorData: result.validatorData });
      expect(admin.handled).toHaveLength(1);
      const { ops, beneficiary } = admin.handled[0]!;
      expect(beneficiary).toBe(admin.signer.address);
      expect(ops).toHaveLength(1);
      expect(ops[0]!.sender).toBe(KERNEL);
      expect(nonceMode(ops[0]!.nonce)).toBe(NONCE_MODE_ENABLE);
      expect(ops[0]!.nonce).toBe(encodeNonce(result.permissionId, NONCE_MODE_ENABLE, 0n));
      expect(ops[0]!.paymasterAndData).toBe('0x');
      expect(result.enableUserOpHash).toBe(entryPointUserOpHash(ops[0]!));
      expect(result.enableTxHash).toBe(HANDLE_OPS_TX);
      expect(slice(ops[0]!.signature, 0, 20).toLowerCase()).toBe(GUARDIAN.toLowerCase());

      const row = await world.db.query.agents.findFirst({ where: eq(agents.agentId, agent.agentId) });
      expect(row!.permissionId).toBe(result.permissionId);
      expect(row!.validatorData).toBe(result.validatorData);
      expect(row!.sessionKeyInstalledAt).not.toBeNull();
    } finally {
      await world.close();
    }
  });

  it('fails cleanly when the enable op reverts in handleOps simulation, leaving the install retryable', async () => {
    const world = await makeWorld({ config: { ENABLE_MODE_SELF_BUNDLE: 'true' }, chain: { sessionInstalled: false } });
    const admin = mockAdminSigner();
    admin.outcome = new Error('EntryPoint.handleOps failed: FailedOpWithRevert(0, "AA23 reverted", EnableNotApproved())');
    world.ctx.adminSigner = admin.signer;
    try {
      const agent = await seedAgent(world, { agent: { status: 'onboarding', permissionId: null, sessionKeyInstalledAt: null } });
      await expect(installSessionKey(world.ctx, agent)).rejects.toThrow(/EnableNotApproved/);
      const row = await world.db.query.agents.findFirst({ where: eq(agents.agentId, agent.agentId) });
      expect(row!.permissionId).toBe(admin.approved[0]!.permissionId); // persisted before the enable op, so a retry reuses it
      expect(row!.sessionKeyInstalledAt).toBeNull();
    } finally {
      await world.close();
    }
  });

  it('rotation keeps the order approve(new) -> handleOps(enable) -> revoke(old)', async () => {
    const world = await makeWorld({ config: { ENABLE_MODE_SELF_BUNDLE: 'true' }, chain: { sessionInstalled: false } });
    const admin = mockAdminSigner();
    const order: string[] = [];
    const inner = admin.signer;
    world.ctx.adminSigner = {
      ...inner,
      approveSessionKey: async (...a) => (order.push('approve'), inner.approveSessionKey(...a)),
      handleOps: async (...a) => (order.push('handleOps'), inner.handleOps(...a)),
      revokeSessionKey: async (...a) => (order.push('revoke'), inner.revokeSessionKey(...a)),
    };
    try {
      const seeded = await seedAgent(world, { agent: { permissionId: '0xdeadbeef' } });
      const oldPolicy = sessionPolicyFor(world.ctx, seeded, 1_900_000_000);
      await world.db
        .update(agents)
        .set({ validatorData: buildValidatorData(oldPolicy), sessionPolicy: serializeSessionPolicy(oldPolicy) as unknown as Record<string, unknown> })
        .where(eq(agents.agentId, seeded.agentId));
      const agent = (await world.db.query.agents.findFirst({ where: eq(agents.agentId, seeded.agentId) }))!;
      const result = await rotateSessionKey(world.ctx, agent);
      expect(order).toEqual(['approve', 'handleOps', 'revoke']);
      expect(result.permissionId).not.toBe('0xdeadbeef');
      expect(admin.revoked).toEqual(['0xdeadbeef']);
      expect(admin.handled[0]!.ops[0]!.nonce).toBe(encodeNonce(result.permissionId, NONCE_MODE_ENABLE, 0n));
    } finally {
      await world.close();
    }
  });
});
