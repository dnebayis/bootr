import { describe, expect, it } from 'vitest';
import { getAddress, keccak256, encodePacked, toHex } from 'viem';
import { deriveSpenderKey, SECP256K1_N, spenderAccount, spenderAddress } from '../src/spender.js';
import { SPENDER_MASTER, SESSION_PK, testConfig } from './helpers.js';

describe('per-agent x402 spender', () => {
  it('derives a deterministic, distinct, valid key per agent id: (keccak256(master || agentId) mod (n - 1)) + 1', () => {
    const k7 = deriveSpenderKey(SPENDER_MASTER, '7');
    expect(deriveSpenderKey(SPENDER_MASTER, '7')).toBe(k7);
    expect(deriveSpenderKey(SPENDER_MASTER, '8')).not.toBe(k7);
    expect(deriveSpenderKey(`0x${'ab'.repeat(32)}`, '7')).not.toBe(k7);
    const h = BigInt(keccak256(encodePacked(['bytes32', 'string'], [SPENDER_MASTER, '7'])));
    expect(k7).toBe(toHex((h % (SECP256K1_N - 1n)) + 1n, { size: 32 }));
    expect(BigInt(k7)).toBeGreaterThan(0n);
    expect(BigInt(k7)).toBeLessThan(SECP256K1_N);
    expect(spenderAccount(SPENDER_MASTER, '7').address).toBe(spenderAddress(SPENDER_MASTER, '7'));
    expect(getAddress(spenderAddress(SPENDER_MASTER, '7'))).not.toBe(getAddress(spenderAddress(SPENDER_MASTER, '70')));
    expect(() => deriveSpenderKey('0x1234', '7')).toThrow(/32-byte/);
    expect(() => deriveSpenderKey(SPENDER_MASTER, '')).toThrow(/agentId/);
  });

  it('the master key must differ from the session signer and the admin key; float bounds are sane', () => {
    expect(testConfig().SPENDER_MASTER_KEY).toBe(SPENDER_MASTER);
    expect(() => testConfig({ SPENDER_MASTER_KEY: SESSION_PK })).toThrow(/SPENDER_MASTER_KEY must differ/);
    expect(() => testConfig({ SPENDER_MASTER_KEY: '' })).toThrow(/SPENDER_MASTER_KEY/);
    expect(() => testConfig({ SPENDER_MIN_USDC: '30', SPENDER_TARGET_USDC: '20' })).toThrow(/SPENDER_TARGET_USDC/);
    expect(testConfig().SPENDER_MIN_USDC).toBe(5);
    expect(testConfig().SPENDER_TARGET_USDC).toBe(20);
    expect(testConfig().SESSION_USDC_WINDOW_SECONDS).toBe(86_400);
  });
});
