import { CONNECT_COIN_STATEMENT, connectCoinStatement, connectDraftStatement, OWN_ERRORS, USER_CODE_RE, type OwnErrorBody } from '@bootr/shared/own-agent';
import { NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as platform } from '@/app/api/platform/route';
import { resetOwnLimits } from '@/lib/server/own-agent';
import { issueNonce } from '@/lib/server/siwe-verify';
import { COIN, DRAFT_ID, OWN_ERRORS as FAKE_ERRORS, SECOND_COIN, startFakeSupervisor, type FakeSupervisor } from '../../../../../../packages/mcp/test/fake-supervisor.mjs';
import { POST as approve } from './approve/route';
import { GET as coins } from './coins/route';
import { GET as draft } from './draft/route';
import { GET as grant } from './grant/route';
import { POST as start } from './start/route';
import { POST as token } from './token/route';

/**
 * The public connect routes (docs/design/byo-agent.md section 13.6, routes 1 to 5 and 16) against the fake supervisor
 * of the contract: what is forwarded, what is relayed, the limits, the body cap, the wallet signature of an approval
 * and the flag. The fake checks this server's HMAC header, so a route that signed wrongly would not get an answer.
 */

// The routes answer from the mock in mock mode, and it is the forward that is under test.
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: false } };
});

const SITE = 'https://bootr.fun';
const KEY = 'test-service-key-of-at-least-32-characters';
const creator = privateKeyToAccount(generatePrivateKey());
const stranger = privateKeyToAccount(generatePrivateKey());

let fake: FakeSupervisor;
let ip = 0;
const nextIp = () => `10.7.${(ip += 1) >> 8}.${ip & 255}`;

beforeAll(async () => {
  fake = await startFakeSupervisor({ key: KEY });
  fake.backend.creator = creator.address;
});
afterAll(() => fake.close());

beforeEach(() => {
  vi.stubEnv('OWN_AGENT_ENABLED', 'true');
  vi.stubEnv('SUPERVISOR_URL', fake.url);
  vi.stubEnv('SUPERVISOR_SERVICE_KEY', KEY);
  resetOwnLimits();
  fake.seen.length = 0;
  Object.assign(fake.control, { status: null, raw: null, delayMs: 0 });
  fake.backend.ownEnabled = true;
});
afterEach(() => vi.unstubAllEnvs());

function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${SITE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: SITE, host: 'bootr.fun', 'x-real-ip': nextIp(), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

function get(path: string, headers: Record<string, string> = {}) {
  return new NextRequest(`${SITE}${path}`, { headers: { 'x-real-ip': nextIp(), ...headers } });
}

async function error(res: Response, code: keyof typeof OWN_ERRORS): Promise<OwnErrorBody> {
  const body = (await res.json()) as OwnErrorBody;
  expect(body.error).toBe(code);
  expect(res.status).toBe(OWN_ERRORS[code].status);
  expect(body.message.startsWith(OWN_ERRORS[code].message)).toBe(true);
  expect(res.headers.get('cache-control')).toBe('no-store');
  return body;
}

async function started(input: Record<string, unknown> = { clientName: 'Claude Code' }) {
  const res = await start(post('/api/agent/connect/start', input));
  expect(res.status).toBe(200);
  return (await res.json()) as { deviceCode: string; userCode: string; verificationUri: string; verificationUriComplete: string; expiresIn: number; interval: number };
}

async function signed(statement: string, signer = creator, over: Partial<SiweMessage> = {}) {
  const message = new SiweMessage({ domain: 'bootr.fun', address: signer.address, statement, uri: SITE, version: '1', chainId: 8453, nonce: issueNonce().nonce, issuedAt: new Date().toISOString(), ...over }).prepareMessage();
  return { message, signature: await signer.signMessage({ message }) };
}

const coinStatement = (code: string, coin = COIN) => connectCoinStatement(coin.symbol, coin.agentId, coin.kernel, code);

describe('the fake supervisor', () => {
  it('holds the contract’s error table', () => {
    expect(FAKE_ERRORS).toEqual(OWN_ERRORS);
  });
});

describe('GET /api/platform', () => {
  it('says whether own agents are switched on', async () => {
    expect(((await (await platform()).json()) as { ownAgent: boolean }).ownAgent).toBe(true);
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    expect(((await (await platform()).json()) as { ownAgent: boolean }).ownAgent).toBe(false);
    vi.stubEnv('OWN_AGENT_ENABLED', '');
    expect(await (await platform()).json()).toMatchObject({ ownAgent: false, launchesPaused: false });
    // Only the word `true` switches it on.
    vi.stubEnv('OWN_AGENT_ENABLED', '1');
    expect(((await (await platform()).json()) as { ownAgent: boolean }).ownAgent).toBe(false);
  });
});

describe('POST /api/agent/connect/start', () => {
  it('forwards the request with the site’s own URL and relays the answer', async () => {
    const answer = await started({ clientName: 'Claude Code', coin: '$OWL', siteUrl: 'https://evil.example', extra: 1 });
    expect(answer.userCode).toMatch(USER_CODE_RE);
    expect(answer).toMatchObject({ verificationUri: `${SITE}/connect`, verificationUriComplete: `${SITE}/connect/${answer.userCode}`, expiresIn: 600, interval: 5 });
    expect(fake.seen).toEqual([{ method: 'POST', path: '/internal/own/connect/start', body: { clientName: 'Claude Code', coin: '$OWL', siteUrl: SITE }, authorized: true }]);
  });

  it('keeps a client’s name to one clean line', async () => {
    await started({ clientName: `  Cursor‮\n​IDE ${'x'.repeat(80)}`, coin: 5 });
    const sent = fake.seen[0]!.body as { clientName: string; coin?: string };
    expect(sent.clientName.startsWith('Cursor IDE x')).toBe(true);
    expect(sent.clientName).toHaveLength(40);
    expect(sent.coin).toBeUndefined();
  });

  it('takes 5 a minute per IP', async () => {
    const headers = { 'x-real-ip': '10.8.0.1' };
    for (let i = 0; i < 5; i++) expect((await start(post('/api/agent/connect/start', {}, headers))).status).toBe(200);
    const sixth = await start(post('/api/agent/connect/start', {}, headers));
    const body = await error(sixth, 'rate_limited');
    expect(Date.parse(body.retryAt!)).toBeGreaterThan(Date.now());
    expect(Number(sixth.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fake.seen).toHaveLength(5);
  });

  it('refuses a body that is too large or is not a JSON object', async () => {
    await error(await start(post('/api/agent/connect/start', { clientName: 'x'.repeat(20_000) })), 'payload_too_large');
    await error(await start(post('/api/agent/connect/start', '{')), 'invalid_request');
    await error(await start(post('/api/agent/connect/start', '[1]')), 'invalid_request');
    expect(fake.seen).toHaveLength(0);
  });

  it('answers supervisor_unavailable when the agent service is unset, down, broken or refuses this server', async () => {
    vi.stubEnv('SUPERVISOR_URL', '');
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
    vi.stubEnv('SUPERVISOR_URL', 'http://127.0.0.1:9');
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
    vi.stubEnv('SUPERVISOR_URL', fake.url);
    fake.control.status = 500;
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
    Object.assign(fake.control, { status: 200, raw: '<html>not json</html>' });
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
    Object.assign(fake.control, { status: 404, raw: null });
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
  });

  it('does not pass off a refused service signature as a credential error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubEnv('SUPERVISOR_SERVICE_KEY', 'another-service-key-of-at-least-32-chars');
    await error(await start(post('/api/agent/connect/start', {})), 'supervisor_unavailable');
    expect(fake.seen[0]).toMatchObject({ authorized: false });
    expect(warn.mock.calls.flat().join(' ')).toContain('bad_signature');
    warn.mockRestore();
  });
});

describe('GET /api/agent/connect/grant', () => {
  it('shows a waiting request and never asks about a malformed code', async () => {
    const { userCode } = await started({ clientName: 'Codex', coin: 'OWL' });
    fake.seen.length = 0;
    const res = await grant(get(`/api/agent/connect/grant?code=${userCode}`));
    expect(await res.json()).toMatchObject({ userCode, clientName: 'Codex', coinHint: 'OWL', status: 'pending' });
    expect(fake.seen[0]!.path).toBe(`/internal/own/connect/grant?code=${userCode}`);
    for (const bad of ['', 'ABCD-EFGH', 'bcdf-ghjk', 'BCDF-GHJK&x=1', 'BCDFGHJK', '../../x']) {
      await error(await grant(get(`/api/agent/connect/grant?code=${encodeURIComponent(bad)}`)), 'grant_not_found');
    }
    expect(fake.seen).toHaveLength(1);
    await error(await grant(get('/api/agent/connect/grant?code=ZZZZ-ZZZZ')), 'grant_not_found');
    expect(fake.seen).toHaveLength(2);
  });

  it('takes 30 a minute per IP', async () => {
    const headers = { 'x-real-ip': '10.8.0.2' };
    for (let i = 0; i < 30; i++) await grant(get('/api/agent/connect/grant?code=nope', headers));
    await error(await grant(get('/api/agent/connect/grant?code=nope', headers)), 'rate_limited');
  });
});

describe('POST /api/agent/connect/approve', () => {
  it('approves for a coin with the creator’s signature and hands the recovered wallet to the agent service', async () => {
    const { userCode } = await started();
    fake.seen.length = 0;
    const res = await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode))), label: '  My laptop  ' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, target: { kind: 'coin', coin: COIN }, label: 'My laptop' });
    expect(fake.seen).toEqual([{ method: 'POST', path: '/internal/own/connect/approve', authorized: true, body: { userCode, creator: creator.address, label: 'My laptop', target: { kind: 'coin', kernel: COIN.kernel, agentId: COIN.agentId } } }]);
  });

  it('approves for the draft of the next launch', async () => {
    const { userCode } = await started();
    const res = await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(connectDraftStatement(DRAFT_ID, userCode), stranger)) }));
    expect(await res.json()).toEqual({ ok: true, target: { kind: 'draft', draftId: DRAFT_ID }, label: 'Claude Code' });
    expect(fake.seen.at(-1)!.body).toMatchObject({ creator: stranger.address, target: { kind: 'draft', draftId: DRAFT_ID } });
  });

  it('refuses another statement, a statement for another code and a bad signature, and asks nobody', async () => {
    const { userCode } = await started();
    const other = (await started()).userCode;
    fake.seen.length = 0;
    const cases: Record<string, unknown>[] = [
      // The console's statement, signed by the right wallet.
      { userCode, ...(await signed(`Open the console of Bootr coin $${COIN.symbol} (#${COIN.agentId}, ${COIN.kernel}).`)) },
      // The right statement with something after it.
      { userCode, ...(await signed(`${coinStatement(userCode)} And send my funds.`)) },
      // A signature that approves another code: the classic swap of a device flow.
      { userCode, ...(await signed(coinStatement(other))) },
      { userCode, ...(await signed(connectDraftStatement(DRAFT_ID, other))) },
      // Signed by another key than the message names.
      { userCode, message: (await signed(coinStatement(userCode))).message, signature: (await signed(coinStatement(userCode), stranger)).signature },
      // A message for another site, another chain, an old one.
      { userCode, ...(await signed(coinStatement(userCode), creator, { domain: 'evil.example', uri: 'https://evil.example' })) },
      { userCode, ...(await signed(coinStatement(userCode), creator, { chainId: 1 })) },
      { userCode, ...(await signed(coinStatement(userCode), creator, { issuedAt: new Date(Date.now() - 3_600_000).toISOString() })) },
      { userCode, message: 'not a siwe message', signature: '0x00' },
      { userCode, message: (await signed(coinStatement(userCode))).message },
    ];
    for (const body of cases) {
      const refused = await error(await approve(post('/api/agent/connect/approve', body)), 'siwe_rejected');
      // The words are the fixed ones: nothing of the message or the signature comes back.
      expect(refused.message).toBe(OWN_ERRORS.siwe_rejected.message);
    }
    expect(fake.seen).toHaveLength(0);
  });

  it('spends the nonce: a signed approval cannot be sent twice', async () => {
    const { userCode } = await started();
    const body = { userCode, ...(await signed(coinStatement(userCode))) };
    expect((await approve(post('/api/agent/connect/approve', body))).status).toBe(200);
    fake.seen.length = 0;
    await error(await approve(post('/api/agent/connect/approve', body)), 'siwe_rejected');
    expect(fake.seen).toHaveLength(0);
  });

  it('relays the agent service’s refusals: not the creator, an unknown coin, a full coin, a used or expired request', async () => {
    const { userCode } = await started();
    await error(await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode), stranger)) })), 'not_creator');
    const ghost = { ...COIN, kernel: '0x9999999999999999999999999999999999999999' };
    await error(await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode, ghost))) })), 'unknown_coin');
    // The agent id in the statement must be the coin's own.
    await error(await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode, { ...COIN, agentId: SECOND_COIN.agentId }))) })), 'unknown_coin');
    for (const code of ['too_many_clients', 'grant_expired', 'grant_used', 'grant_not_found'] as const) {
      fake.backend.failNext(code);
      await error(await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode))) })), code);
    }
    // Still pending after all that: the creator's own signature takes it.
    expect((await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode))) }))).status).toBe(200);
    await error(await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode))) })), 'grant_used');
  });

  it('is for the site’s own page: another origin, or none, is refused before the signature is looked at', async () => {
    const { userCode } = await started();
    fake.seen.length = 0;
    const body = { userCode, ...(await signed(coinStatement(userCode))) };
    for (const origin of ['https://evil.example', 'https://bootr.fun.evil.example', 'null']) {
      await error(await approve(post('/api/agent/connect/approve', body, { origin })), 'invalid_request');
    }
    const none = new NextRequest(`${SITE}/api/agent/connect/approve`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': nextIp() }, body: JSON.stringify(body) });
    await error(await approve(none), 'invalid_request');
    expect(fake.seen).toHaveLength(0);
    // The nonce was not spent by the refusals.
    expect((await approve(post('/api/agent/connect/approve', body))).status).toBe(200);
  });

  it('checks the code and the label before anything else, and takes 10 a minute per IP', async () => {
    const good = await signed(coinStatement('BCDF-GHJK'));
    expect((await error(await approve(post('/api/agent/connect/approve', { userCode: 'ABCD-EFGH', ...good })), 'invalid_request')).field).toBe('userCode');
    expect((await error(await approve(post('/api/agent/connect/approve', { userCode: 'BCDF-GHJK', ...good, label: 5 })), 'invalid_request')).field).toBe('label');
    await error(await approve(post('/api/agent/connect/approve', { userCode: 'BCDF-GHJK', ...good, pad: 'x'.repeat(20_000) })), 'payload_too_large');
    const headers = { 'x-real-ip': '10.8.0.3' };
    for (let i = 0; i < 10; i++) await approve(post('/api/agent/connect/approve', { userCode: 'nope' }, headers));
    await error(await approve(post('/api/agent/connect/approve', { userCode: 'nope' }, headers)), 'rate_limited');
    expect(fake.seen).toHaveLength(0);
  });

  it('reads the two statements exactly as the contract writes them', () => {
    expect(CONNECT_COIN_STATEMENT.exec(coinStatement('BCDF-GHJK'))?.slice(1)).toEqual([COIN.symbol, COIN.agentId, COIN.kernel, 'BCDF-GHJK']);
  });
});

describe('POST /api/agent/connect/token', () => {
  it('answers pending, then the credential once, then grant_used', async () => {
    const { userCode, deviceCode } = await started();
    const poll = () => token(post('/api/agent/connect/token', { deviceCode }));
    expect(await (await poll()).json()).toEqual({ status: 'pending' });
    await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(coinStatement(userCode))) }));
    resetOwnLimits();
    const res = await poll();
    const body = (await res.json()) as { status: string; credential: string; clientId: string; target: unknown };
    expect(body).toMatchObject({ status: 'approved', label: 'Claude Code', target: { kind: 'coin', coin: COIN } });
    expect(body.credential).toMatch(/^bootr_agt_[A-Za-z0-9_-]{43}$/);
    expect(res.headers.get('cache-control')).toBe('no-store');
    resetOwnLimits();
    await error(await poll(), 'grant_used');
  });

  it('takes one poll per interval per device code, whatever the IP', async () => {
    const { deviceCode } = await started();
    fake.seen.length = 0;
    expect((await token(post('/api/agent/connect/token', { deviceCode }))).status).toBe(200);
    const again = await token(post('/api/agent/connect/token', { deviceCode }));
    const body = await error(again, 'slow_down');
    expect(Date.parse(body.retryAt!) - Date.now()).toBeLessThanOrEqual(5000);
    expect(Number(again.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(fake.seen).toHaveLength(1);
    // Another client's code is not held up by it.
    const second = await started();
    expect((await token(post('/api/agent/connect/token', { deviceCode: second.deviceCode }))).status).toBe(200);
  });

  it('refuses a malformed device code without asking, and relays an unknown one', async () => {
    for (const deviceCode of [undefined, 5, '', 'short', 'x'.repeat(200), 'has spaces in it and is long enough']) {
      expect((await error(await token(post('/api/agent/connect/token', { deviceCode })), 'invalid_request')).field).toBe('deviceCode');
    }
    expect(fake.seen).toHaveLength(0);
    await error(await token(post('/api/agent/connect/token', { deviceCode: 'A'.repeat(43) })), 'grant_not_found');
  });

  it('bounds the polls of one IP', async () => {
    const headers = { 'x-real-ip': '10.8.0.4' };
    for (let i = 0; i < 60; i++) await token(post('/api/agent/connect/token', {}, headers));
    await error(await token(post('/api/agent/connect/token', {}, headers)), 'rate_limited');
  });
});

describe('GET /api/agent/connect/draft and /coins', () => {
  it('says when a client is connected to a draft', async () => {
    const id = '11111111-2222-4333-8444-555555555555';
    expect(await (await draft(get(`/api/agent/connect/draft?draft=${id}`))).json()).toEqual({ connected: false, clients: [] });
    const { userCode, deviceCode } = await started({ clientName: 'Cursor' });
    await approve(post('/api/agent/connect/approve', { userCode, ...(await signed(connectDraftStatement(id, userCode), stranger)) }));
    await token(post('/api/agent/connect/token', { deviceCode }));
    const after = (await (await draft(get(`/api/agent/connect/draft?draft=${id}`))).json()) as { connected: boolean; clients: { label: string }[] };
    expect(after.connected).toBe(true);
    expect(after.clients.map((c) => c.label)).toEqual(['Cursor']);
    fake.seen.length = 0;
    for (const bad of ['', 'nope', `${id}/../x`, DRAFT_ID.toUpperCase()]) expect((await error(await draft(get(`/api/agent/connect/draft?draft=${encodeURIComponent(bad)}`)), 'invalid_request')).field).toBe('draft');
    expect(fake.seen).toHaveLength(0);
  });

  it('lists the coins a wallet launched', async () => {
    const res = await coins(get(`/api/agent/connect/coins?creator=${creator.address.toLowerCase()}`));
    expect(await res.json()).toEqual({ coins: [COIN, SECOND_COIN] });
    // The agent service is asked with the checksummed address.
    expect(fake.seen.at(-1)!.path).toBe(`/internal/own/connect/coins?creator=${creator.address}`);
    expect(await (await coins(get(`/api/agent/connect/coins?creator=${stranger.address}`))).json()).toEqual({ coins: [] });
    for (const bad of ['', '0x12', 'vitalik.eth', `${creator.address}&x=1`]) expect((await error(await coins(get(`/api/agent/connect/coins?creator=${encodeURIComponent(bad)}`)), 'invalid_request')).field).toBe('creator');
  });
});

describe('with own agents switched off', () => {
  it('answers own_agent_disabled on start, approve, token and draft without asking the agent service', async () => {
    const { userCode, deviceCode } = await started();
    const body = { userCode, ...(await signed(coinStatement(userCode))) };
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    fake.seen.length = 0;
    await error(await start(post('/api/agent/connect/start', {})), 'own_agent_disabled');
    await error(await approve(post('/api/agent/connect/approve', body)), 'own_agent_disabled');
    await error(await token(post('/api/agent/connect/token', { deviceCode })), 'own_agent_disabled');
    await error(await draft(get(`/api/agent/connect/draft?draft=${DRAFT_ID}`)), 'own_agent_disabled');
    expect(fake.seen).toHaveLength(0);
  });

  it('still reads a request and a wallet’s coins', async () => {
    const { userCode } = await started();
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    fake.backend.ownEnabled = false;
    expect(await (await grant(get(`/api/agent/connect/grant?code=${userCode}`))).json()).toMatchObject({ userCode, status: 'pending' });
    expect(await (await coins(get(`/api/agent/connect/coins?creator=${creator.address}`))).json()).toEqual({ coins: [COIN, SECOND_COIN] });
  });

  it('relays the agent service’s own refusal when only the site has the flag on', async () => {
    fake.backend.ownEnabled = false;
    await error(await start(post('/api/agent/connect/start', {})), 'own_agent_disabled');
    expect(fake.seen).toHaveLength(1);
  });
});
