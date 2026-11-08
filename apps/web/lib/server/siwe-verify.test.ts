import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { issueNonce, verifySiwe } from './siwe-verify';

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const signer = privateKeyToAccount(PK);
const OTHER = '0x000000000000000000000000000000000000dEaD';

/** A SIWE message for the site, as a wallet would sign it. */
function message(address: string, nonce: string, now: number): string {
  return new SiweMessage({
    domain: 'bootr.fun',
    address,
    statement: 'Sign in to Bootr',
    uri: 'https://bootr.fun',
    version: '1',
    chainId: 8453,
    nonce,
    issuedAt: new Date(now).toISOString(),
  }).prepareMessage();
}

describe('verifySiwe', () => {
  const rpc = process.env.BASE_RPC_URL;
  beforeEach(() => {
    // Nothing listens here: a verification that needed the chain would fail as unverifiable.
    process.env.BASE_RPC_URL = 'http://127.0.0.1:9/';
  });
  afterEach(() => {
    if (rpc === undefined) delete process.env.BASE_RPC_URL;
    else process.env.BASE_RPC_URL = rpc;
  });

  it('accepts an EOA signature without asking the chain', async () => {
    const now = Date.now();
    const { nonce } = issueNonce(now);
    const text = message(signer.address, nonce, now);
    const signature = await signer.signMessage({ message: text });
    const out = await verifySiwe({ message: text, signature }, { expectedNonce: nonce, now });
    expect(out).toMatchObject({ ok: true, address: signer.address });
  });

  it('names the signer when the message claims another address, and spends the nonce either way', async () => {
    const now = Date.now();
    const { nonce } = issueNonce(now);
    const text = message(OTHER, nonce, now);
    const signature = await signer.signMessage({ message: text });
    const out = await verifySiwe({ message: text, signature }, { expectedNonce: nonce, now });
    expect(out).toMatchObject({ ok: false, status: 401, reason: 'bad_signature' });
    expect((out as { error: string }).error).toContain(signer.address);
    expect(await verifySiwe({ message: text, signature }, { expectedNonce: nonce, now })).toMatchObject({ ok: false, reason: 'nonce_spent' });
  });
});
