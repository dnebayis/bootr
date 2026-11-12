import { CONNECT_COIN_STATEMENT, connectCoinStatement } from '@bootr/shared/own-agent';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { issueNonce, verifySiwe } from './siwe-verify';

// The chain this deployment runs on is read from `env.chainId` (NEXT_PUBLIC_CHAIN_ID). Here a test sets it.
const deployment = vi.hoisted(() => ({ chainId: 8453 as 8453 | 84532 }));
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get chainId() {
        return deployment.chainId;
      },
    },
  };
});

const PK = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const signer = privateKeyToAccount(PK);
const OTHER = '0x000000000000000000000000000000000000dEaD';

/** A SIWE message for the site, as a wallet would sign it. */
function message(address: string, nonce: string, now: number, over: { chainId?: number; statement?: string } = {}): string {
  return new SiweMessage({
    domain: 'bootr.fun',
    address,
    statement: over.statement ?? 'Sign in to Bootr',
    uri: 'https://bootr.fun',
    version: '1',
    chainId: over.chainId ?? deployment.chainId,
    nonce,
    issuedAt: new Date(now).toISOString(),
  }).prepareMessage();
}

describe('verifySiwe', () => {
  const rpc = process.env.BASE_RPC_URL;
  beforeEach(() => {
    deployment.chainId = 8453;
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

  it('takes a message for the chain this deployment runs on and for no other, whatever the statement (security review L2)', async () => {
    const connect = connectCoinStatement('OWL', '1153601', '0x1111111111111111111111111111111111111111', 'BCDF-GHJK');
    const attempt = async (chainId: number, statement?: string) => {
      const now = Date.now();
      const { nonce } = issueNonce(now);
      const text = message(signer.address, nonce, now, { chainId, ...(statement ? { statement } : {}) });
      // A perfectly good signature of the message: the chain in it is the only thing at fault.
      const signature = await signer.signMessage({ message: text });
      return verifySiwe({ message: text, signature }, { expectedNonce: nonce, now, ...(statement ? { statement: CONNECT_COIN_STATEMENT } : {}) });
    };
    for (const statement of [undefined, connect]) {
      // The production site: Base, and not Base Sepolia, which it used to take as well.
      deployment.chainId = 8453;
      expect(await attempt(8453, statement)).toMatchObject({ ok: true, address: signer.address });
      const sepolia = await attempt(84532, statement);
      expect(sepolia).toMatchObject({ ok: false, status: 401, reason: 'unsupported_chain', chainId: 84532 });
      expect((sepolia as { error: string }).error).toContain('chainId must be 8453 (Base), the chain this site runs on, got 84532.');
      // A test deployment on Base Sepolia: the same rule the other way round, so its own setups keep working.
      deployment.chainId = 84532;
      expect(await attempt(84532, statement)).toMatchObject({ ok: true, address: signer.address });
      const mainnet = await attempt(8453, statement);
      expect(mainnet).toMatchObject({ ok: false, reason: 'unsupported_chain', chainId: 8453 });
      expect((mainnet as { error: string }).error).toContain('chainId must be 84532 (Base Sepolia)');
      // Neither takes anything else.
      for (const chainId of [1, 10, 8454, 845320]) expect([chainId, (await attempt(chainId, statement)).ok]).toEqual([chainId, false]);
    }
  });

  it('spends the nonce of a message for another chain like any other attempt', async () => {
    const now = Date.now();
    const { nonce } = issueNonce(now);
    const wrong = message(signer.address, nonce, now, { chainId: 84532 });
    expect(await verifySiwe({ message: wrong, signature: await signer.signMessage({ message: wrong }) }, { expectedNonce: nonce, now })).toMatchObject({ ok: false, reason: 'unsupported_chain' });
    const right = message(signer.address, nonce, now);
    expect(await verifySiwe({ message: right, signature: await signer.signMessage({ message: right }) }, { expectedNonce: nonce, now })).toMatchObject({ ok: false, reason: 'nonce_spent' });
  });
});
