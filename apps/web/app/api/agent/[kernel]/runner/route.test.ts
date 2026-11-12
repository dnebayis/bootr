/**
 * `POST /api/agent/:kernel/runner` (docs/design/byo-agent.md section 13.6, route 15): inside the console's signed
 * session, the request is checked, the agent service is handed the signer and the models offered right now, and its
 * answer or refusal is relayed as it is. The agent service decides on the flag; this route never does.
 */
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_ERRORS } from '@bootr/shared/own-agent';
import { FALLBACK_MODELS } from '@/lib/models';
import { signReviewToken } from '../approvals/review';
import { POST } from './route';

const h = vi.hoisted(() => ({ switchAgentRunner: vi.fn(), getAgentConfig: vi.fn(), allowedModels: null as string[] | null }));

vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: false } };
});
vi.mock('@/lib/server/supervisor', async (original) => {
  const actual = await original<typeof import('@/lib/server/supervisor')>();
  return { ...actual, switchAgentRunner: h.switchAgentRunner, getAgentConfig: h.getAgentConfig };
});
vi.mock('@/lib/server/relay-models', async (original) => {
  const actual = await original<typeof import('@/lib/server/relay-models')>();
  return { ...actual, relayModels: async () => ({ models: FALLBACK_MODELS }) };
});
vi.mock('@/lib/server/admin-config', async (original) => {
  const actual = await original<typeof import('@/lib/server/admin-config')>();
  return { ...actual, readConfig: async () => ({ ...(await actual.readConfig()), ...(h.allowedModels ? { allowedModels: h.allowedModels } : {}) }) };
});

const KERNEL = '0x00000000000000000000000000000000000000aa';
const CREATOR = '0x000000000000000000000000000000000000c0de';
const AGENT = '1153600';
const ctx = { params: Promise.resolve({ kernel: KERNEL }) } as never;
let ip = 0;

async function token(kernel = KERNEL) {
  return signReviewToken({ k: 'review', a: CREATOR, kernel, agentId: AGENT, e: Math.floor(Date.now() / 1000) + 600 });
}

function request(body: unknown, headers: Record<string, string> = {}) {
  ip += 1;
  return new NextRequest(`https://bootr.fun/api/agent/${KERNEL}/runner`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://bootr.fun', host: 'bootr.fun', 'x-real-ip': `10.6.${ip >> 8}.${ip & 255}`, ...headers },
    body: JSON.stringify(body),
  });
}

const read = async (res: Response) => ({ status: res.status, body: (await res.json()) as Record<string, unknown> });

beforeEach(() => {
  process.env.SESSION_SECRET = 'unit-test-session-secret-0123456789';
  h.allowedModels = null;
  h.switchAgentRunner.mockReset();
  // The settings as the agent service stores them when the route reads them: revision 2.
  h.getAgentConfig.mockReset();
  h.getAgentConfig.mockResolvedValue({ revision: 2 });
  h.switchAgentRunner.mockResolvedValue({ runner: 'own', revision: 3, notes: ['Connect an AI client, or the agent stays silent.'] });
});

describe('POST /api/agent/:kernel/runner', () => {
  it('to own: hands the agent service the signer and answers what it said, with the session token', async () => {
    const t = await token();
    const { status, body } = await read(await POST(request({ token: t, runner: 'own' }), ctx));
    expect(status).toBe(200);
    expect(body).toEqual({ runner: 'own', revision: 3, notes: ['Connect an AI client, or the agent stays silent.'], token: t });
    // no model list is read for a switch to own
    // ...and the revision the route read goes with the request, so a copy of it sent again is refused by the agent service
    expect(h.getAgentConfig).toHaveBeenCalledWith(AGENT);
    expect(h.switchAgentRunner).toHaveBeenCalledWith(AGENT, { runner: 'own', by: CREATOR, allowedModels: [], expectedRevision: 2 });
  });

  it('to the Bootr agent: passes the models offered right now (the catalog under the admin allow-list) and the model the creator picked', async () => {
    h.allowedModels = [FALLBACK_MODELS[0]!.id, FALLBACK_MODELS[1]!.id];
    h.switchAgentRunner.mockResolvedValue({ runner: 'hosted', revision: 4, notes: ['The Bootr agent pays for its thinking from fuel. This coin holds 3 USDC; under 1 USDC it stays silent.', 'Pictures are made by Bootr again and paid from fuel.'] });
    const { status, body } = await read(await POST(request({ token: await token(), runner: 'hosted', model: FALLBACK_MODELS[1]!.id }), ctx));
    expect(status).toBe(200);
    expect(body).toMatchObject({ runner: 'hosted', revision: 4 });
    expect(h.switchAgentRunner).toHaveBeenCalledWith(AGENT, { runner: 'hosted', model: FALLBACK_MODELS[1]!.id, by: CREATOR, allowedModels: [FALLBACK_MODELS[0]!.id, FALLBACK_MODELS[1]!.id], expectedRevision: 2 });
  });

  it('a coin the agent service does not know is unknown_coin, and settings that changed under the switch are relayed as settings_changed', async () => {
    const { SupervisorError } = await import('@/lib/server/supervisor');
    h.getAgentConfig.mockResolvedValueOnce(null);
    const unknown = await read(await POST(request({ token: await token(), runner: 'own' }), ctx));
    expect([unknown.status, unknown.body.error]).toEqual([OWN_ERRORS.unknown_coin.status, 'unknown_coin']);
    expect(h.switchAgentRunner).not.toHaveBeenCalled();
    h.switchAgentRunner.mockRejectedValueOnce(new SupervisorError(OWN_ERRORS.settings_changed.status, 'settings_changed', OWN_ERRORS.settings_changed.message));
    const changed = await read(await POST(request({ token: await token(), runner: 'own' }), ctx));
    expect(changed).toEqual({ status: 409, body: { error: 'settings_changed', message: OWN_ERRORS.settings_changed.message } });
  });

  it('relays the agent service’s refusals with their code and words: the flag, the model, nothing to change', async () => {
    const { SupervisorError, SupervisorUnavailable } = await import('@/lib/server/supervisor');
    for (const code of ['own_agent_disabled', 'runner_unchanged', 'model_required', 'model_not_allowed', 'not_creator'] as const) {
      h.switchAgentRunner.mockRejectedValueOnce(new SupervisorError(OWN_ERRORS[code].status, code, OWN_ERRORS[code].message));
      const { status, body } = await read(await POST(request({ token: await token(), runner: code === 'own_agent_disabled' ? 'own' : 'hosted' }), ctx));
      expect(status, code).toBe(OWN_ERRORS[code].status);
      expect(body, code).toEqual({ error: code, message: OWN_ERRORS[code].message });
    }
    // the step in progress outlasted the wait, or the service is down: nothing was done
    h.switchAgentRunner.mockRejectedValueOnce(new SupervisorUnavailable('supervisor responded 503'));
    const down = await read(await POST(request({ token: await token(), runner: 'own' }), ctx));
    expect(down.status).toBe(503);
    expect(down.body.error).toBe('supervisor_unavailable');
  });

  it('refuses a body it cannot read before anyone is asked to prove who they are', async () => {
    for (const bad of [{ runner: 'cloud' }, {}, { runner: 'hosted', model: 'not a model id!' }, { runner: 'own', model: 42 }]) {
      const { status, body } = await read(await POST(request({ token: await token(), ...bad }), ctx));
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_request');
    }
    expect(h.switchAgentRunner).not.toHaveBeenCalled();
  });

  it('is the console’s session: same origin only, a token for this coin, never a bare request', async () => {
    const t = await token();
    expect((await read(await POST(request({ token: t, runner: 'own' }, { origin: 'https://evil.example' }), ctx))).status).toBe(403);
    expect((await read(await POST(request({ token: await token('0x00000000000000000000000000000000000000bb'), runner: 'own' }), ctx))).status).toBe(401);
    expect((await read(await POST(request({ token: `${t}x`, runner: 'own' }), ctx))).status).toBe(401);
    expect((await read(await POST(request({ runner: 'own' }), ctx))).status).toBeGreaterThanOrEqual(400);
    expect(h.switchAgentRunner).not.toHaveBeenCalled();
  });
});
