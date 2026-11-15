import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ADMIN_COOKIE, newSessionId, signToken } from '@/lib/server/session-core';
import { POST } from './route';

/**
 * `POST /api/admin/dataset/x-review`: the owner's "look again" on a suspended X account of the dataset. Owner-only,
 * same-origin, and it forwards one signed POST of an X source id to the agent service and nothing else.
 */
const ADMIN = '0x4000000000000000000000000000000000000004';
const STRANGER = '0x5000000000000000000000000000000000000005';

const cookie = (address: string) => signToken({ a: address, e: Math.floor(Date.now() / 1000) + 600, k: 'admin', s: newSessionId() });
const request = (body: unknown, token?: string, origin = 'https://bootr.fun') =>
  new NextRequest('https://bootr.fun/api/admin/dataset/x-review', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...(origin ? { origin } : {}), ...(token ? { cookie: `${ADMIN_COOKIE}=${token}` } : {}) } });

let upstream: { url: string; body: string }[];
let answer: number;
beforeEach(() => {
  vi.stubEnv('SESSION_SECRET', 'a-session-secret-of-enough-length');
  vi.stubEnv('ADMIN_ADDRESSES', ADMIN);
  vi.stubEnv('SUPERVISOR_URL', 'http://supervisor:3004');
  vi.stubEnv('SUPERVISOR_SERVICE_KEY', 'test-supervisor-key-fedcba9876543210fedcba');
  upstream = [];
  answer = 200;
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    upstream.push({ url, body: String(init?.body ?? '') });
    return Response.json(answer === 200 ? { ok: true } : { error: 'not_found' }, { status: answer });
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('POST /api/admin/dataset/x-review', () => {
  it('answers nobody but a signed-in admin from the site itself, and asks the agent service nothing otherwise', async () => {
    expect((await POST(request({ id: 'x:12345' }))).status).toBe(401);
    expect((await POST(request({ id: 'x:12345' }, await cookie(STRANGER)))).status).toBe(401);
    expect((await POST(request({ id: 'x:12345' }, await cookie(ADMIN), 'https://evil.example'))).status).toBe(403);
    expect((await POST(request({ id: 'x:12345' }, await cookie(ADMIN), ''))).status).toBe(403);
    expect(upstream).toEqual([]);
  });

  it('takes an X source id and nothing else', async () => {
    const token = await cookie(ADMIN);
    for (const id of ['b:base-blog', 'x:@not a handle', 'x:', 42, null]) expect((await POST(request({ id }, token))).status).toBe(400);
    expect((await POST(request('not json', token))).status).toBe(400);
    expect(upstream).toEqual([]);
  });

  it('forwards one signed request, and passes on that the account is not suspended', async () => {
    const token = await cookie(ADMIN);
    expect((await POST(request({ id: 'x:@base' }, token))).status).toBe(200);
    expect(upstream).toEqual([{ url: 'http://supervisor:3004/internal/dataset/x/review', body: JSON.stringify({ id: 'x:@base' }) }]);
    answer = 404;
    expect((await POST(request({ id: 'x:12345' }, token))).status).toBe(404);
  });
});
