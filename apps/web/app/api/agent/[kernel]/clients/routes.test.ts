import { OWN_ERRORS, type ClientsResponse, type OwnErrorBody } from '@bootr/shared/own-agent';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { COIN, CREATOR, SECOND_COIN, startFakeSupervisor, type FakeSupervisor } from '../../../../../../../packages/mcp/test/fake-supervisor.mjs';
import { signReviewToken } from '../approvals/review';
import { POST as list } from './list/route';
import { POST as revoke } from './revoke/route';

/**
 * The console's two client routes (docs/design/byo-agent.md section 13.6, routes 13 and 14) against the fake
 * supervisor: inside the console's signed session, forwarded by agent id, and never refused by the flag.
 */

vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: false } };
});

const SITE = 'https://bootr.fun';
const KEY = 'test-service-key-of-at-least-32-characters';
type Listed = ClientsResponse & { token: string };

let fake: FakeSupervisor;
let session = '';
let ip = 0;

beforeAll(async () => {
  fake = await startFakeSupervisor({ key: KEY });
});
afterAll(() => fake.close());

beforeEach(async () => {
  vi.stubEnv('OWN_AGENT_ENABLED', 'true');
  vi.stubEnv('SUPERVISOR_URL', fake.url);
  vi.stubEnv('SUPERVISOR_SERVICE_KEY', KEY);
  vi.stubEnv('SESSION_SECRET', 'a-session-secret-for-the-tests-only');
  session = await signReviewToken({ k: 'review', a: CREATOR, kernel: COIN.kernel.toLowerCase(), agentId: COIN.agentId, e: Math.floor(Date.now() / 1000) + 600 });
  fake.backend.clients.clear();
  fake.backend.ownEnabled = true;
  Object.assign(fake.control, { status: null, raw: null, delayMs: 0 });
  fake.seen.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

function call(route: (req: NextRequest, ctx: never) => Promise<Response>, path: 'list' | 'revoke', body: Record<string, unknown>, opts: { kernel?: string; headers?: Record<string, string> } = {}) {
  const kernel = opts.kernel ?? COIN.kernel;
  ip += 1;
  const req = new NextRequest(`${SITE}/api/agent/${kernel}/clients/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, host: 'bootr.fun', 'x-real-ip': `10.4.${ip >> 8}.${ip & 255}`, ...opts.headers },
    body: JSON.stringify(body),
  });
  return route(req, { params: Promise.resolve({ kernel }) } as never);
}

async function error(res: Response, code: keyof typeof OWN_ERRORS): Promise<OwnErrorBody> {
  const body = (await res.json()) as OwnErrorBody;
  expect(body.error).toBe(code);
  expect(res.status).toBe(OWN_ERRORS[code].status);
  return body;
}

describe('POST /api/agent/[kernel]/clients/list', () => {
  it('lists the coin’s clients by its agent id and hands the session token back', async () => {
    fake.backend.issueCredential(COIN, 'Laptop');
    fake.backend.issueCredential(COIN, 'Desktop');
    fake.backend.issueCredential(SECOND_COIN, 'Another coin');
    const res = await call(list, 'list', { token: session });
    const body = (await res.json()) as Listed;
    expect(res.status).toBe(200);
    expect(body.clients.map((c) => c.label)).toEqual(['Laptop', 'Desktop']);
    expect(body).toMatchObject({ max: 3, token: session });
    expect(Object.keys(body.clients[0]!).sort()).toEqual(['clientId', 'createdAt', 'expiresAt', 'label', 'lastUsedAt']);
    expect(fake.seen).toEqual([{ method: 'GET', path: `/internal/agents/${COIN.agentId}/clients`, body: {}, authorized: true }]);
  });

  it('needs the console’s session and the site’s own origin', async () => {
    expect((await call(list, 'list', { token: 'forged.token' })).status).toBe(401);
    expect((await call(list, 'list', {})).status).toBeGreaterThanOrEqual(400);
    expect((await call(list, 'list', { token: session }, { headers: { origin: 'https://evil.example' } })).status).toBe(403);
    // A session for one coin does not open another's clients.
    expect((await call(list, 'list', { token: session }, { kernel: SECOND_COIN.kernel })).status).toBe(401);
    expect(fake.seen).toHaveLength(0);
  });

  it('answers with own agents switched off, here and at the agent service', async () => {
    fake.backend.issueCredential(COIN, 'Laptop');
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    fake.backend.ownEnabled = false;
    const body = (await (await call(list, 'list', { token: session })).json()) as Listed;
    expect(body.clients.map((c) => c.label)).toEqual(['Laptop']);
  });

  it('answers supervisor_unavailable when the agent service does not', async () => {
    vi.stubEnv('SUPERVISOR_URL', 'http://127.0.0.1:9');
    await error(await call(list, 'list', { token: session }), 'supervisor_unavailable');
  });
});

describe('POST /api/agent/[kernel]/clients/revoke', () => {
  it('disconnects one client, names who asked, and the credential stops working', async () => {
    const laptop = fake.backend.issueCredential(COIN, 'Laptop');
    fake.backend.issueCredential(COIN, 'Desktop');
    const before = (await (await call(list, 'list', { token: session })).json()) as Listed;
    const clientId = before.clients.find((c) => c.label === 'Laptop')!.clientId;
    fake.seen.length = 0;
    const res = await call(revoke, 'revoke', { token: session, clientId });
    const body = (await res.json()) as Listed;
    expect(body.clients.map((c) => c.label)).toEqual(['Desktop']);
    expect(body.token).toBe(session);
    expect(fake.seen).toEqual([{ method: 'POST', path: `/internal/agents/${COIN.agentId}/clients/revoke`, body: { by: CREATOR, clientId }, authorized: true }]);
    expect(() => fake.backend.run('status', { credential: laptop })).toThrow('credential_revoked');
    await error(await call(revoke, 'revoke', { token: session, clientId }), 'client_not_found');
  });

  it('disconnects all of them, with own agents switched off too', async () => {
    fake.backend.issueCredential(COIN, 'Laptop');
    fake.backend.issueCredential(COIN, 'Desktop');
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    fake.backend.ownEnabled = false;
    const body = (await (await call(revoke, 'revoke', { token: session, all: true })).json()) as Listed;
    expect(body.clients).toEqual([]);
    expect(fake.seen.at(-1)!.body).toEqual({ by: CREATOR, all: true });
  });

  it('refuses a request that names no client, or a malformed one, without asking', async () => {
    for (const bad of [{}, { clientId: 5 }, { clientId: 'cli_../../agents' }, { clientId: 'cli_XYZ' }, { all: 'yes' }]) {
      expect((await error(await call(revoke, 'revoke', { token: session, ...bad }), 'invalid_request')).field).toBe('clientId');
    }
    expect(fake.seen).toHaveLength(0);
    expect((await call(revoke, 'revoke', { all: true })).status).toBeGreaterThanOrEqual(400);
    expect(fake.seen).toHaveLength(0);
  });
});
