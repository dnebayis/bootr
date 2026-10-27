import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, parseKey } from '../src/crypto.js';
import { accounts } from '../src/db/schema.js';
import { ENC_KEY, setup } from './helpers.js';

describe('AES-256-GCM token encryption', () => {
  it('round-trips', () => {
    const ct = encrypt('hello token', ENC_KEY, 'access:a');
    expect(ct.startsWith('v1.')).toBe(true);
    expect(ct).not.toContain('hello');
    expect(decrypt(ct, ENC_KEY, 'access:a')).toBe('hello token');
    expect(encrypt('hello token', ENC_KEY, 'access:a')).not.toBe(ct); // random IV
  });

  it('fails on wrong AAD, wrong key or tampering', () => {
    const ct = encrypt('secret', ENC_KEY, 'access:a');
    expect(() => decrypt(ct, ENC_KEY, 'access:b')).toThrow();
    expect(() => decrypt(ct, parseKey('22'.repeat(32)), 'access:a')).toThrow();
    const raw = Buffer.from(ct.slice(3), 'base64url');
    raw[raw.length - 1] = (raw[raw.length - 1] ?? 0) ^ 1;
    expect(() => decrypt(`v1.${raw.toString('base64url')}`, ENC_KEY, 'access:a')).toThrow();
  });

  it('rejects malformed keys', () => {
    expect(() => parseKey('abc')).toThrow();
    expect(() => parseKey('zz'.repeat(32))).toThrow();
  });

  it('never stores tokens in plaintext', async () => {
    const env = await setup();
    const [row] = await env.db.select().from(accounts);
    expect(row?.encryptedAccessToken).not.toContain('access-token-secret');
    expect(row?.encryptedRefreshToken).not.toContain('refresh-token-secret');
    expect(decrypt(row!.encryptedAccessToken, ENC_KEY, 'access:agent-1')).toBe(
      'access-token-secret',
    );
    await env.close();
  });
});
