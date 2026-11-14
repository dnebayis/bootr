import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, newSessionId, signToken } from '@/lib/server/session-core';
import { GET } from './route';

/**
 * `GET /api/admin/dataset`: the owner's read of one day of the dataset. Owner-only (the admin session cookie, as on
 * `/api/admin/config`), read-only, and it forwards one signed GET to the agent service and nothing else.
 */
const ADMIN = '0x4000000000000000000000000000000000000004';
const STRANGER = '0x5000000000000000000000000000000000000005';

async function cookie(address: string, ttlSec = 600): Promise<string> {
  return signToken({ a: address, e: Math.floor(Date.now() / 1000) + ttlSec, k: 'admin', s: newSessionId() });
}
const request = (query: string, token?: string) => new NextRequest(`https://bootr.fun/api/admin/dataset${query}`, token ? { headers: { cookie: `${ADMIN_COOKIE}=${token}` } } : undefined);

let upstream: string[];
beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a-session-secret-of-enough-length');
  vi.stubEnv('ADMIN_ADDRESSES', ADMIN);
  vi.stubEnv('SUPERVISOR_URL', 'http://supervisor:3004');
  vi.stubEnv('SUPERVISOR_SERVICE_KEY', 'test-supervisor-key-fedcba9876543210fedcba');
  upstream = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    upstream.push(`${init?.method ?? 'GET'} ${url}`);
    return Response.json({ enabled: true, day: new URL(url).searchParams.get('day'), totals: { records: 0, sightings: 0, byGrade: {}, byKind: {}, byMatch: {}, capped: 0 }, records: [], sources: [] });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/admin/dataset', () => {
  it('answers nobody but a signed-in admin, and asks the agent service nothing for anyone else', async () => {
    expect((await GET(request('?day=2026-11-15'))).status).toBe(401);
    expect((await GET(request('?day=2026-11-15', 'not-a-token'))).status).toBe(401);
    expect((await GET(request('?day=2026-11-15', await cookie(STRANGER)))).status).toBe(401);
    expect((await GET(request('?day=2026-11-15', await cookie(ADMIN, -10)))).status).toBe(401);
    expect(upstream).toEqual([]);
  });

  it('forwards one signed read of the day and never caches the answer', async () => {
    const res = await GET(request('?day=2026-11-15', await cookie(ADMIN)));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ enabled: true, day: '2026-11-15', records: [] });
    expect(upstream).toEqual(['GET http://supervisor:3004/internal/dataset/day?day=2026-11-15']);
  });

  it("without a day it is today's; a day that is not one is refused before anything is asked", async () => {
    const res = await GET(request('', await cookie(ADMIN)));
    expect(res.status).toBe(200);
    expect(upstream).toEqual([`GET http://supervisor:3004/internal/dataset/day?day=${new Date().toISOString().slice(0, 10)}`]);
    upstream.length = 0;
    for (const bad of ['?day=yesterday', '?day=2026-13-45', '?day=', "?day=2026-11-15'%20or%201=1"]) expect((await GET(request(bad, await cookie(ADMIN)))).status, bad).toBe(400);
    expect(upstream).toEqual([]);
  });

  it('says so when the agent service is down or has no dataset yet', async () => {
    vi.stubGlobal('fetch', async () => new Response('down', { status: 503 }));
    const down = await GET(request('?day=2026-11-15', await cookie(ADMIN)));
    expect(down.status).toBe(503);
    expect(await down.json()).toMatchObject({ error: 'supervisor_unavailable' });
    vi.stubGlobal('fetch', async () => new Response('{}', { status: 404 }));
    const old = await GET(request('?day=2026-11-15', await cookie(ADMIN)));
    expect(old.status).toBe(404);
    expect(await old.json()).toMatchObject({ error: 'dataset_not_deployed' });
  });
});
