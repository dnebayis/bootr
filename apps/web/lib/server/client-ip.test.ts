import { afterEach, describe, expect, it, vi } from 'vitest';
import { clientIp, ipKey } from './ipfs';

/**
 * Who a per-address limit counts (security review M4). Behind Cloudflare and Traefik the header the limits keyed on
 * was either a Cloudflare address many visitors share or whatever the caller wrote. `TRUSTED_PROXY=cloudflare` keys on
 * the address Cloudflare saw and on nothing a caller can write; unset, nothing changes.
 */

const headers = (h: Record<string, string>) => new Headers(h);

afterEach(() => vi.unstubAllEnvs());

describe('clientIp with TRUSTED_PROXY unset', () => {
  it('is as it was: X-Real-IP, else the last hop of X-Forwarded-For, else unknown; CF-Connecting-IP means nothing', () => {
    expect(clientIp(headers({ 'x-real-ip': ' 203.0.113.7 ' }))).toBe('203.0.113.7');
    expect(clientIp(headers({ 'x-forwarded-for': '198.51.100.1, 203.0.113.9' }))).toBe('203.0.113.9');
    expect(clientIp(headers({ 'x-real-ip': '203.0.113.7', 'x-forwarded-for': '198.51.100.1' }))).toBe('203.0.113.7');
    expect(clientIp(headers({}))).toBe('unknown');
    expect(clientIp(headers({ 'cf-connecting-ip': '198.51.100.44' }))).toBe('unknown');
    expect(clientIp(headers({ 'cf-connecting-ip': '198.51.100.44', 'x-real-ip': '172.16.0.2' }))).toBe('172.16.0.2');
    // Any other value of the variable is the same as unset.
    for (const value of ['', '1', 'true', 'traefik', 'cloud flare']) {
      vi.stubEnv('TRUSTED_PROXY', value);
      expect([value, clientIp(headers({ 'cf-connecting-ip': '198.51.100.44', 'x-real-ip': '172.16.0.2' }))]).toEqual([value, '172.16.0.2']);
    }
  });
});

describe('clientIp with TRUSTED_PROXY=cloudflare', () => {
  it('is the address Cloudflare saw, whatever the caller wrote in the headers the limits used to read', () => {
    vi.stubEnv('TRUSTED_PROXY', 'cloudflare');
    // Cloudflare's own address in X-Real-IP (what Traefik sees) no longer makes every visitor one visitor,
    expect(clientIp(headers({ 'cf-connecting-ip': '198.51.100.44', 'x-real-ip': '172.68.1.1', 'x-forwarded-for': '198.51.100.44, 172.68.1.1' }))).toBe('198.51.100.44');
    expect(clientIp(headers({ 'cf-connecting-ip': '198.51.100.45', 'x-real-ip': '172.68.1.1' }))).toBe('198.51.100.45');
    // and a caller cannot pick its own key by writing a header.
    for (const forged of [{ 'x-real-ip': '1.2.3.4' }, { 'x-forwarded-for': '1.2.3.4' }, { 'x-forwarded-for': '1.2.3.4, 5.6.7.8', 'x-real-ip': '9.9.9.9' }, { 'true-client-ip': '1.2.3.4' }] as Record<string, string>[]) {
      expect(clientIp(headers({ ...forged, 'cf-connecting-ip': '203.0.113.50' }))).toBe('203.0.113.50');
      // A request that did not come through Cloudflare has no address of its own: all of them share one key.
      expect(clientIp(headers(forged))).toBe('unknown');
    }
    vi.stubEnv('TRUSTED_PROXY', ' Cloudflare ');
    expect(clientIp(headers({ 'cf-connecting-ip': '198.51.100.44', 'x-real-ip': '172.68.1.1' }))).toBe('198.51.100.44');
  });

  it('keys an IPv6 visitor by its /64, so a new address of the same network is the same visitor', () => {
    vi.stubEnv('TRUSTED_PROXY', 'cloudflare');
    const one = clientIp(headers({ 'cf-connecting-ip': '2001:db8:abcd:12:1111:2222:3333:4444' }));
    expect(one).toBe('2001:db8:abcd:12::/64');
    for (const same of ['2001:db8:abcd:12::1', '2001:0DB8:ABCD:0012:ffff:ffff:ffff:ffff', '2001:db8:abcd:12:0:0:0:9']) expect(clientIp(headers({ 'cf-connecting-ip': same }))).toBe(one);
    expect(clientIp(headers({ 'cf-connecting-ip': '2001:db8:abcd:13::1' }))).toBe('2001:db8:abcd:13::/64');
  });

  it('takes nothing that is not an address: such a request shares the key of those without one', () => {
    vi.stubEnv('TRUSTED_PROXY', 'cloudflare');
    for (const bad of ['', 'unknown', '1.2.3', '1.2.3.4.5', '256.1.1.1', '1.2.3.4, 5.6.7.8', '1.2.3.4:80', 'localhost', '2001:db8:::1', '2001:db8', 'gggg::1', '1:2:3:4:5:6:7:8:9', `1.2.3.4${'x'.repeat(100)}`, '::1::', 'a'.repeat(46)]) {
      expect([bad, clientIp(headers({ 'cf-connecting-ip': bad }))]).toEqual([bad, 'unknown']);
    }
  });
});

describe('ipKey', () => {
  it('reads IPv4, IPv6 in its short and long forms, and an IPv4 address written as IPv6', () => {
    expect(ipKey('203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey(' 203.0.113.7 ')).toBe('203.0.113.7');
    expect(ipKey('::1')).toBe('0:0:0:0::/64');
    expect(ipKey('::')).toBe('0:0:0:0::/64');
    expect(ipKey('fe80::1')).toBe('fe80:0:0:0::/64');
    expect(ipKey('2001:db8::')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:db8:0:0:1:2:3:4')).toBe('2001:db8:0:0::/64');
    expect(ipKey('2001:0db8:0000:0000:0001:0002:0003:0004')).toBe('2001:db8:0:0::/64');
    expect(ipKey('::ffff:203.0.113.7')).toBe('203.0.113.7');
    expect(ipKey('::ffff:cb00:7107')).toBe('203.0.113.7');
    expect(ipKey('0:0:0:0:0:ffff:cb00:7107')).toBe('203.0.113.7');
    expect(ipKey('64:ff9b::203.0.113.7')).toBe('64:ff9b:0:0::/64');
    expect(ipKey(null)).toBeNull();
    expect(ipKey(undefined)).toBeNull();
  });
});
