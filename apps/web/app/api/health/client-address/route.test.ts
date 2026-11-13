import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from './route';

const ask = async (headers: Record<string, string>) => (await GET(new NextRequest('https://bootr.fun/api/health/client-address', { headers }))).json();

describe('GET /api/health/client-address', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('says which headers arrived and which one is counted by, and never an address', async () => {
    vi.stubEnv('TRUSTED_PROXY', '');
    const body = await ask({ 'cf-connecting-ip': '203.0.113.7', 'x-real-ip': '172.70.1.1', 'x-forwarded-for': '203.0.113.7, 172.70.1.1' });
    expect(body).toEqual({ trustedProxy: null, cloudflare: true, realIp: true, forwardedFor: true, countedBy: 'real-ip' });
    expect(JSON.stringify(body)).not.toMatch(/203\.0\.113|172\.70/);
  });

  it('with TRUSTED_PROXY=cloudflare counts by Cloudflare\'s header, and by unknown when it did not arrive', async () => {
    vi.stubEnv('TRUSTED_PROXY', 'cloudflare');
    expect(await ask({ 'cf-connecting-ip': '2001:db8:1:2:3:4:5:6' })).toMatchObject({ trustedProxy: 'cloudflare', cloudflare: true, countedBy: 'cloudflare' });
    expect(await ask({ 'x-real-ip': '172.70.1.1' })).toMatchObject({ trustedProxy: 'cloudflare', cloudflare: false, realIp: true, countedBy: 'unknown' });
    expect(await ask({ 'cf-connecting-ip': 'not an address' })).toMatchObject({ cloudflare: false, countedBy: 'unknown' });
  });

  it('with nothing that names a visitor is unknown', async () => {
    vi.stubEnv('TRUSTED_PROXY', '');
    expect(await ask({})).toEqual({ trustedProxy: null, cloudflare: false, realIp: false, forwardedFor: false, countedBy: 'unknown' });
  });
});
