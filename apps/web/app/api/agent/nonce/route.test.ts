import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { POST } from './route';

/** The nonce store is bounded (10,000 entries): a flood of nonces from one address used to push out the ones real callers were about to sign. */
describe('POST /api/agent/nonce', () => {
  const call = (ip: string) => POST(new NextRequest('http://localhost/api/agent/nonce', { method: 'POST', headers: { 'x-real-ip': ip } }));

  it('hands out single-use nonces, 30 a minute per IP, then answers 429 rate_limited with Retry-After', async () => {
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      const res = await call('203.0.113.7');
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nonce: string; expiresIn: number };
      expect(body.nonce).toMatch(/^[0-9a-f]{32}$/);
      expect(body.expiresIn).toBe(600);
      seen.add(body.nonce);
    }
    expect(seen.size).toBe(30);
    const refused = await call('203.0.113.7');
    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(refused.headers.get('cache-control')).toBe('no-store');
    expect(await refused.json()).toEqual({ error: 'rate_limited', message: expect.stringContaining('30 requests per minute per IP') });
    // another address is not affected
    expect((await call('203.0.113.8')).status).toBe(200);
  });
});
