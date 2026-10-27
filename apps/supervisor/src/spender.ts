/**
 * Per-agent x402 spender: a plain EOA that pays the inference relay with EIP-3009 `transferWithAuthorization`
 * (settled by the facilitator, so it needs no ETH). The kernel never signs anything through ERC-1271 (its session
 * permission is installed with SKIP_SIGNATURE); the session key may only fund the spender with
 * `USDC.transfer(spender, …)` under BootrCallPolicy's windowed cap. A leaked session key therefore moves at most
 * `SESSION_USDC_TRANSFER_CAP` per window into an account it does not control; a leaked spender key exposes at most
 * that agent's float (`SPENDER_TARGET_USDC`).
 *
 * Derivation (deterministic, one master secret, one key per agent id):
 *   `k = (uint256(keccak256(abi.encodePacked(bytes32 master, string agentId))) mod (n - 1)) + 1`, `n` the secp256k1
 *   group order, so `k` is always a valid private key in `[1, n - 1]`. The master key must differ from the session
 *   signer and the admin key (checked in config.ts). Rotating the master rotates every spender: fund the new
 *   addresses and let the old ones drain (there is no on-chain registration of a spender).
 */
import { encodePacked, keccak256, toHex, type Address, type Hex } from 'viem';
import { privateKeyToAccount, type LocalAccount } from 'viem/accounts';

/** secp256k1 group order. */
export const SECP256K1_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;

export function deriveSpenderKey(master: Hex, agentId: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(master)) throw new Error('SPENDER_MASTER_KEY must be a 32-byte hex key');
  if (!agentId) throw new Error('agentId is required to derive a spender');
  const h = BigInt(keccak256(encodePacked(['bytes32', 'string'], [master, agentId])));
  return toHex((h % (SECP256K1_N - 1n)) + 1n, { size: 32 });
}

export function spenderAccount(master: Hex, agentId: string): LocalAccount {
  return privateKeyToAccount(deriveSpenderKey(master, agentId));
}

export function spenderAddress(master: Hex, agentId: string): Address {
  return spenderAccount(master, agentId).address;
}
