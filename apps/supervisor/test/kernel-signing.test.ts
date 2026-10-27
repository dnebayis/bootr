import { describe, expect, it } from 'vitest';
import { decodeAbiParameters, parseAbiParameters, recoverAddress, slice, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { getUserOperationHash, type UserOperation } from 'viem/account-abstraction';
import { baseSepolia } from 'viem/chains';
import { createKernelClient, KernelSigningRefusedError } from '../src/kernel.js';
import { chainState, GUARDIAN, KERNEL, mockChain, SESSION_PK } from './helpers.js';

const sessionSigner = privateKeyToAccount(SESSION_PK);
const PID: Hex = '0x11223344';

async function client(nowMs = 1_800_000_000_000) {
  const chain = mockChain(chainState());
  return createKernelClient({ publicClient: chain.publicClient, chain: baseSepolia, kernel: KERNEL, guardian: GUARDIAN, permissionId: PID, sessionSigner, bundlerUrl: 'http://127.0.0.1:9', now: () => nowMs });
}

describe('kernel client signing', () => {
  it('refuses every ERC-1271 signature: the session permission has no signature path (C-01)', async () => {
    const k = await client();
    const td = { domain: { name: 'USDC', version: '2', chainId: 84532, verifyingContract: KERNEL }, types: { Probe: [{ name: 'x', type: 'uint256' }] }, primaryType: 'Probe', message: { x: 1n } } as const;
    await expect(k.signTypedData(td)).rejects.toBeInstanceOf(KernelSigningRefusedError);
    await expect(k.signMessage('hello')).rejects.toBeInstanceOf(KernelSigningRefusedError);
    await expect(k.signMessage({ raw: '0x1234' })).rejects.toThrow(/no messages/);
    await expect(k.account.signMessage({ message: 'hello' })).rejects.toBeInstanceOf(KernelSigningRefusedError);
  });

  it('every userOp signature carries the BootrCallPolicy time slot: [0 || 32 || abi.encode(now)] || 0xff || ecdsa(userOpHash)', async () => {
    const k = await client(1_800_000_000_500);
    const op: UserOperation<'0.7'> = { sender: KERNEL, nonce: 0n, callData: '0x', callGasLimit: 1n, verificationGasLimit: 1n, preVerificationGas: 1n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, signature: '0x' };
    const sig = await k.account.signUserOperation({ ...op, chainId: 84532 });
    expect(slice(sig, 0, 1)).toBe('0x00');
    expect(slice(sig, 1, 9)).toBe('0x0000000000000020');
    expect(decodeAbiParameters(parseAbiParameters('uint256'), slice(sig, 9, 41))).toEqual([1_800_000_000n]); // floor(ms / 1000)
    expect(slice(sig, 41, 42)).toBe('0xff');
    const ecdsa = slice(sig, 42);
    expect((ecdsa.length - 2) / 2).toBe(65);
    const hash = getUserOperationHash({ chainId: 84532, entryPointAddress: '0x0000000071727De22E5E9d8BAf0edAc6f37da032', entryPointVersion: '0.7', userOperation: op });
    expect(await recoverAddress({ hash, signature: ecdsa })).toBe(sessionSigner.address);
    // the stub signature for estimation has the same shape
    const stub = await k.account.getStubSignature({ nonce: 0n } as never);
    expect(slice(stub, 0, 9)).toBe('0x000000000000000020');
  });
});
