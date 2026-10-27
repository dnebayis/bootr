import { describe, expect, it } from 'vitest';

import { adminConfigHeaders, hmacHex, signRequest, signingString, verifyRequest } from './hmac';

const KEY = 'test-service-key-0123456789';
const NOW = 1_800_000_000;

describe('HMAC (apps/sender scheme)', () => {
  it('round-trips sign/verify', () => {
    const body = JSON.stringify({ xHandle: 'bootr' });
    const path = '/internal/agent/0xabc/social';
    const h = signRequest(KEY, 'POST', path, body, NOW);
    expect(h).toMatch(/^HMAC 1800000000:[0-9a-f]{64}$/);
    expect(verifyRequest(KEY, h, 'POST', path, body, NOW + 10)).toEqual({ ok: true });
  });

  it('matches the documented signing string', () => {
    const s = signingString('1', 'post', '/p?q=1', '');
    expect(s).toBe('1\nPOST\n/p?q=1\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });

  it('rejects tampering, staleness, bad format and a missing key', () => {
    const path = '/internal/agent/0xabc/social';
    const h = signRequest(KEY, 'POST', path, '{}', NOW);
    expect(verifyRequest(KEY, h, 'POST', path, '{"a":1}', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRequest(KEY, h, 'POST', '/other', '{}', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRequest('other-key', h, 'POST', path, '{}', NOW)).toEqual({ ok: false, reason: 'bad_signature' });
    expect(verifyRequest(KEY, h, 'POST', path, '{}', NOW + 301)).toEqual({ ok: false, reason: 'stale_timestamp' });
    expect(verifyRequest(KEY, 'Bearer x', 'POST', path, '{}', NOW)).toEqual({ ok: false, reason: 'malformed_authorization' });
    expect(verifyRequest(KEY, undefined, 'POST', path, '{}', NOW)).toEqual({ ok: false, reason: 'missing_authorization' });
    expect(verifyRequest('', h, 'POST', path, '{}', NOW)).toEqual({ ok: false, reason: 'not_configured' });
  });

  it('signs admin-config requests for both schemes', () => {
    const h = adminConfigHeaders(KEY, 'https://bootr.fun/api/admin/config', NOW);
    expect(h['x-bootr-timestamp']).toBe(String(NOW));
    expect(h['x-bootr-signature']).toBe(hmacHex(KEY, `${NOW}.GET./api/admin/config`));
    expect(verifyRequest(KEY, h.authorization, 'GET', '/api/admin/config', '', NOW)).toEqual({ ok: true });
  });
});
