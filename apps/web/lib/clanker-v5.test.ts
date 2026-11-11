import { encodeAbiParameters, getContractAddress, keccak256, toHex, type Address, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { mineV5Salt, openingCapEth, predictV5Token, SaltMiningError } from './clanker-v5';

const LAUNCHER: Address = '0x00000000000000000000000000000000000ba5e5';
const DEPLOYER: Address = '0xc25FfE6374EdcCb5bFCcA3b9684046a426AbCE6A';
const CREATOR: Address = '0x1111111111111111111111111111111111111111';
const INIT_HASH: Hex = keccak256(toHex('a v5 token init code'));

/** `BootrClankerLauncherV5.predictToken`, spelled out with viem's ABI encoder: the reference the miner must match. */
function reference(salt: Hex): Address {
  const inner = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [CREATOR, salt]));
  const scoped = keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'bytes32' }], [LAUNCHER, inner]));
  return getContractAddress({ opcode: 'CREATE2', from: DEPLOYER, salt: scoped, bytecodeHash: INIT_HASH });
}

const input = { launcher: LAUNCHER, tokenDeployer: DEPLOYER, creator: CREATOR, initCodeHash: INIT_HASH };

describe('Clanker v5 salt mining', () => {
  it('predicts the address the launcher predicts', () => {
    for (const salt of [keccak256(toHex('draft-1')), `0x${'00'.repeat(32)}` as Hex, `0x${'ff'.repeat(32)}` as Hex]) {
      expect(predictV5Token(input, salt)).toBe(reference(salt));
    }
  });

  it('finds a salt whose token address ends in cccc, and the same one for the same draft', async () => {
    const startSalt = keccak256(toHex('draft-2'));
    const mined = await mineV5Salt({ ...input, startSalt });
    expect(mined.token.toLowerCase().endsWith('cccc')).toBe(true);
    expect(reference(mined.salt)).toBe(mined.token);
    expect(BigInt(mined.salt) - BigInt(startSalt)).toBe(BigInt(mined.attempts - 1));
    expect(await mineV5Salt({ ...input, startSalt })).toMatchObject({ salt: mined.salt, token: mined.token });
    // Recorded for the report: tries and wall time of one mining run in Node.
    console.info(`[clanker-v5] mined in ${mined.attempts} tries, ${mined.ms} ms`);
  }, 120_000);

  it('carries the counter across bytes', async () => {
    const found = await mineV5Salt({ ...input, startSalt: keccak256(toHex('draft-2')) });
    // Start just below a byte boundary under the salt found above: counting up must carry into the next byte to reach it.
    const start = BigInt(found.salt) - (BigInt(found.salt) & 0xffn) - 1n;
    const mined = await mineV5Salt({ ...input, startSalt: toHex(start, { size: 32 }) });
    expect(BigInt(mined.salt) - start).toBe(BigInt(mined.attempts - 1));
    expect(BigInt(mined.salt) <= BigInt(found.salt)).toBe(true);
    expect(reference(mined.salt)).toBe(mined.token);
  }, 120_000);

  it('gives up with a plain error past the bound', async () => {
    await expect(mineV5Salt({ ...input, startSalt: keccak256(toHex('draft-3')) }, { maxAttempts: 3 })).rejects.toThrow(SaltMiningError);
    await expect(mineV5Salt({ ...input, startSalt: keccak256(toHex('draft-3')) }, { maxAttempts: 3 })).rejects.toThrow(/Nothing was sent/);
  });

  it('reads Clanker’s opening tick as a market cap in ETH', () => {
    expect(openingCapEth(-201_000)).toBeCloseTo(1.87, 1);
  });
});
