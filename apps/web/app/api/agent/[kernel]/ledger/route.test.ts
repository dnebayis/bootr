import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { GET } from './route';

const call = (kernel: string, query = '', ip = '203.0.113.7') => GET(new NextRequest(`https://site.example/api/agent/${kernel}/ledger${query}`, { headers: { 'x-real-ip': ip } }), { params: Promise.resolve({ kernel }) } as never);

describe('GET /api/agent/:kernel/ledger', () => {
  it('refuses what is not a coin wallet or a cursor of its own, before any upstream read', async () => {
    const bad = await call('not-an-address', '', '203.0.113.1');
    expect(bad.status).toBe(400);
    const cursor = await call('0x1111111111111111111111111111111111111111', '?cursor=..%2Fadmin', '203.0.113.1');
    expect(cursor.status).toBe(400);
    expect(((await cursor.json()) as { message: string }).message).toMatch(/cursor/);
    const long = await call('0x1111111111111111111111111111111111111111', `?cursor=${'a'.repeat(401)}`, '203.0.113.1');
    expect(long.status).toBe(400);
  });

  it('takes 30 requests a minute from one address, then says when to come back', async () => {
    for (let i = 0; i < 30; i++) expect((await call('nope', '', '203.0.113.9')).status).toBe(400);
    const limited = await call('nope', '', '203.0.113.9');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
    // Another visitor is not held back.
    expect((await call('nope', '', '203.0.113.10')).status).toBe(400);
  });
});
