/**
 * Who runs the agent, on the web's server side (docs/design/byo-agent.md sections 13.3 and 13.6): what the config view
 * says, the switch request and its call to the agent service, the launch draft's `runner`, and the mock store that
 * stands in for the agent service in mock mode.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OWN_AGENT_MODEL_ID, OWN_ERRORS } from '@bootr/shared/own-agent';
import { mock, mockLaunch, mockStore } from '@/lib/mock';
import { FALLBACK_MODELS } from '@/lib/models';
import { normalizeRunner, readLaunchDraft, saveDraftIdentity, updateLaunchDraftLinks } from './launch-drafts';
import { parseRunnerSwitch, sanitizeConfig, sanitizeOwn, SupervisorError, SupervisorUnavailable, switchAgentRunner } from './supervisor';

const KERNEL = '0x1111111111111111111111111111111111111111';
const CREATOR = '0x2222222222222222222222222222222222222222';
const BASE = { agentId: 7, kernel: KERNEL, creator: CREATOR, worker: { postIntervalMs: 7_200_000 }, model: 'anthropic/claude-haiku-4.5' };

describe('the config view: runner and own', () => {
  it('an agent service that names no runner is the Bootr agent: every coin from before this', () => {
    expect(sanitizeConfig(BASE)).toMatchObject({ runner: 'hosted', own: null });
    expect(sanitizeConfig({ ...BASE, runner: 'hosted', own: { lastTurnAt: '2026-11-12T10:00:00Z', clients: 2 } })).toMatchObject({ runner: 'hosted', own: null });
    expect(sanitizeConfig({ ...BASE, runner: 'cloud' })).toMatchObject({ runner: 'hosted', own: null });
  });

  it('an own agent carries its last turn and its client count, and nothing malformed', () => {
    expect(sanitizeConfig({ ...BASE, runner: 'own', own: { lastTurnAt: '2026-11-12T10:00:00.000Z', clients: 2 } })).toMatchObject({ runner: 'own', own: { lastTurnAt: '2026-11-12T10:00:00.000Z', clients: 2 }, model: 'anthropic/claude-haiku-4.5' });
    expect(sanitizeConfig({ ...BASE, runner: 'own' })!.own).toEqual({ lastTurnAt: null, clients: 0 });
    expect(sanitizeOwn({ runner: 'own', own: { lastTurnAt: 'yesterday', clients: -1 } })).toEqual({ lastTurnAt: null, clients: 0 });
    expect(sanitizeOwn({ runner: 'own', own: { lastTurnAt: null, clients: 1.5 } })).toEqual({ lastTurnAt: null, clients: 0 });
    expect(sanitizeOwn(null)).toBeNull();
  });
});

describe('the switch request', () => {
  it('takes hosted or own, and a model id only when one is sent', () => {
    expect(parseRunnerSwitch({ runner: 'own' })).toEqual({ runner: 'own' });
    expect(parseRunnerSwitch({ runner: 'hosted', model: 'openai/gpt-4.1-mini', token: 't', extra: 1 })).toEqual({ runner: 'hosted', model: 'openai/gpt-4.1-mini' });
    expect(parseRunnerSwitch({ runner: 'hosted', model: null })).toEqual({ runner: 'hosted' });
    for (const bad of [null, [], 'own', {}, { runner: 'cloud' }, { runner: 'hosted', model: 7 }, { runner: 'hosted', model: 'has space' }, { runner: 'hosted', model: 'x'.repeat(81) }]) expect(parseRunnerSwitch(bad), JSON.stringify(bad)).toBeNull();
  });
});

describe('switchAgentRunner: the call to the agent service', () => {
  const fetchMock = vi.fn();
  beforeEach(() => {
    process.env.SUPERVISOR_URL = 'http://supervisor.test';
    process.env.SUPERVISOR_SERVICE_KEY = 'unit-test-supervisor-key-0123456789abcdef';
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.SUPERVISOR_URL;
    delete process.env.SUPERVISOR_SERVICE_KEY;
  });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts the request with the signer and the offered models, signed, and reads the answer strictly', async () => {
    fetchMock.mockResolvedValue(json(200, { runner: 'hosted', revision: 4, notes: ['The Bootr agent pays for its thinking from fuel. This coin holds 3 USDC; under 1 USDC it stays silent.', 7, 'x'.repeat(400)], extra: true }));
    const res = await switchAgentRunner('7', { runner: 'hosted', model: 'openai/gpt-4.1-mini', by: CREATOR, allowedModels: ['openai/gpt-4.1-mini'] });
    expect(res).toEqual({ runner: 'hosted', revision: 4, notes: ['The Bootr agent pays for its thinking from fuel. This coin holds 3 USDC; under 1 USDC it stays silent.'] });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://supervisor.test/internal/agents/7/runner');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toMatch(/^HMAC \d+:[0-9a-f]{64}$/);
    expect(JSON.parse(init.body as string)).toEqual({ runner: 'hosted', model: 'openai/gpt-4.1-mini', by: CREATOR, allowedModels: ['openai/gpt-4.1-mini'] });
  });

  it('turns each refusal into an error the route relays with its code and words', async () => {
    for (const code of ['own_agent_disabled', 'runner_unchanged', 'model_required', 'model_not_allowed', 'not_creator', 'unknown_coin'] as const) {
      fetchMock.mockResolvedValueOnce(json(OWN_ERRORS[code].status, { error: code, message: OWN_ERRORS[code].message }));
      const err = await switchAgentRunner('7', { runner: 'own', by: CREATOR, allowedModels: [] }).catch((e: unknown) => e);
      expect(err, code).toBeInstanceOf(SupervisorError);
      expect(err).toMatchObject({ status: OWN_ERRORS[code].status, code, message: OWN_ERRORS[code].message });
    }
  });

  it('an agent service from before the switch existed answers a bare 404: own agents are not there', async () => {
    fetchMock.mockResolvedValue(new Response('404 Not Found', { status: 404 }));
    await expect(switchAgentRunner('7', { runner: 'own', by: CREATOR, allowedModels: [] })).rejects.toMatchObject({ code: 'own_agent_disabled', status: 404 });
  });

  it('a busy or absent agent service is unavailable, never a silent success', async () => {
    fetchMock.mockResolvedValueOnce(json(503, { error: 'supervisor_unavailable', message: OWN_ERRORS.supervisor_unavailable.message }));
    await expect(switchAgentRunner('7', { runner: 'own', by: CREATOR, allowedModels: [] })).rejects.toBeInstanceOf(SupervisorUnavailable);
    fetchMock.mockRejectedValueOnce(new Error('connect refused'));
    await expect(switchAgentRunner('7', { runner: 'own', by: CREATOR, allowedModels: [] })).rejects.toBeInstanceOf(SupervisorUnavailable);
    delete process.env.SUPERVISOR_URL;
    await expect(switchAgentRunner('7', { runner: 'own', by: CREATOR, allowedModels: [] })).rejects.toBeInstanceOf(SupervisorUnavailable);
  });
});

describe('the launch draft: runner', () => {
  const DRAFT = '0b7f6a52-3c1e-4d0a-9f3e-2a5b8c1d4e6f';
  const OTHER = '3b241101-e2bb-4255-8caf-4136c566a962';
  const TEXT = 'A patient onchain analyst for small Base coins. Short, plain, no hype.';
  const coin = { name: 'Quiet Engine', symbol: 'QENG', image: 'https://example.org/q.png', imageIpfs: null, xHandle: null, links: { website: null, x: null, telegram: null, discord: null } };
  let dir = '';
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'bootr-drafts-runner-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('is stored only for an own-agent launch, survives a links edit, and is absent on every other draft', async () => {
    expect(normalizeRunner('own')).toBe('own');
    for (const other of ['hosted', undefined, null, 'OWN', 1]) expect(normalizeRunner(other)).toBe('hosted');
    await saveDraftIdentity(DRAFT, TEXT, null, { dir, coin, runner: 'own' });
    expect((await readLaunchDraft(DRAFT, { dir }))?.runner).toBe('own');
    expect(JSON.parse(await readFile(path.join(dir, `${DRAFT}.json`), 'utf8')).runner).toBe('own');
    await updateLaunchDraftLinks(DRAFT, { ...coin.links, website: 'https://example.org' }, { dir });
    expect((await readLaunchDraft(DRAFT, { dir }))?.runner).toBe('own');

    await saveDraftIdentity(OTHER, TEXT, null, { dir, coin, runner: 'hosted' });
    const hosted = await readLaunchDraft(OTHER, { dir });
    expect(hosted).toEqual({ identity: TEXT, coin, worker: null, source: 'bootr', tokenSettings: null });
    expect('runner' in JSON.parse(await readFile(path.join(dir, `${OTHER}.json`), 'utf8'))).toBe(false);
  });
});

describe('mock mode: the store stands in for the agent service', () => {
  const kernelOf = (name: string) => mockStore().tokens.find((t) => t.name === name)!.kernel;
  const BY = '0x00000000000000000000000000000000000e2e01';

  it('every seeded coin is a Bootr agent, with no own block', () => {
    for (const t of mockStore().tokens.slice(0, 12)) expect(mock.agentConfig(t.kernel)).toMatchObject({ runner: 'hosted', own: null });
  });

  it('switches to own and back: one stored value, a revision, a tape row, the notes, and the model line follows', () => {
    const kernel = kernelOf('Vault Keeper');
    const before = mock.agentConfig(kernel);
    const toOwn = mock.switchRunner(kernel, { runner: 'own' }, BY);
    expect(toOwn).toEqual({ ok: true, response: { runner: 'own', revision: before.revision + 1, notes: ['Connect an AI client, or the agent stays silent.'] } });
    expect(mock.agentConfig(kernel)).toMatchObject({ runner: 'own', own: { lastTurnAt: null, clients: 0 }, model: before.model, instructions: before.instructions });
    expect(mockStore().tokens.find((t) => t.kernel === kernel)!.model).toBe(OWN_AGENT_MODEL_ID);
    expect(mock.agentActivity(kernel, { limit: 1 }).items[0]!.summary).toContain('who runs the agent');
    expect(mock.switchRunner(kernel, { runner: 'own' }, BY)).toEqual({ ok: false, error: 'runner_unchanged' });

    expect(mock.switchRunner(kernel, { runner: 'hosted', model: 'nobody/knows-this' }, BY)).toEqual({ ok: false, error: 'model_not_allowed' });
    const back = mock.switchRunner(kernel, { runner: 'hosted', model: FALLBACK_MODELS[0]!.id }, BY);
    expect(back).toMatchObject({ ok: true, response: { runner: 'hosted', revision: before.revision + 2 } });
    expect((back as { response: { notes: string[] } }).response.notes[0]).toMatch(/^The Bootr agent pays for its thinking from fuel\. This coin holds [\d.]+ USDC; under 1 USDC it stays silent\.$/);
    expect(mock.agentConfig(kernel)).toMatchObject({ runner: 'hosted', own: null, model: FALLBACK_MODELS[0]!.id });
    expect(mockStore().tokens.find((t) => t.kernel === kernel)!.model).toBe(FALLBACK_MODELS[0]!.id);
  });

  it('refuses the chat of an own coin before a message is stored, and takes it again on the Bootr agent', () => {
    const kernel = kernelOf('Late Night Degen');
    const messages = mock.agentChat(kernel).messages.length;
    mock.switchRunner(kernel, { runner: 'own' }, BY);
    expect(mock.sendAgentChat(kernel, 'What did you do today?')).toEqual({ ok: false, status: 409, error: 'chat_not_available', message: OWN_ERRORS.chat_not_available.message });
    expect(mock.agentChat(kernel).messages.length).toBe(messages);
    mock.switchRunner(kernel, { runner: 'hosted' }, BY);
    expect(mock.sendAgentChat(kernel, 'What did you do today?')).toMatchObject({ ok: true });
    expect(mock.agentChat(kernel).messages.length).toBe(messages + 2);
  });

  it('a mock launch with the reserved model id is an own coin that keeps a model for a switch back', () => {
    const id = mockLaunch({ name: 'Own Mock', symbol: 'OWNM', image: '', model: OWN_AGENT_MODEL_ID, buyback: false, xHandle: null, instructions: 'A patient onchain analyst for small Base coins.' });
    const token = mockStore().tokens.find((t) => t.id === id)!;
    expect(token.model).toBe('own-agent');
    const cfg = mock.agentConfig(token.kernel);
    expect(cfg).toMatchObject({ runner: 'own', own: { lastTurnAt: null, clients: 0 } });
    expect(FALLBACK_MODELS.some((m) => m.id === cfg.model)).toBe(true);
    expect(mock.switchRunner(token.kernel, { runner: 'hosted' }, BY)).toMatchObject({ ok: true });
  });
});
