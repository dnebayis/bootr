import { NextRequest } from 'next/server';
import { SiweMessage } from 'siwe';
import { privateKeyToAccount } from 'viem/accounts';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_MODELS } from '@/lib/models';
import { issueNonce } from '@/lib/server/siwe-verify';
import { POST as postConfig } from './[kernel]/config/route';
import { PUT as putLinks } from './[kernel]/links/route';
import { POST as launch } from './launch/route';
import { POST as xConnect } from './x-connect/route';

const h = vi.hoisted(() => ({ chainDown: false, fetchTokenCreator: vi.fn(), relayModels: vi.fn(), allowedModels: null as string[] | null }));

// The signature check without an RPC: a real ECDSA check, or the chain being down.
vi.mock('viem', async (original) => {
  const actual = await original<typeof import('viem')>();
  return {
    ...actual,
    createPublicClient: () => ({
      verifyMessage: async (args: Parameters<typeof actual.verifyMessage>[0]) => {
        if (h.chainDown) throw new Error('rpc down, key=do-not-repeat');
        return actual.verifyMessage(args);
      },
    }),
  };
});
// These routes skip the signature in mock mode, and it is the signature that is under test.
vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: false } };
});
vi.mock('@/lib/server/sender', async (original) => {
  const actual = await original<typeof import('@/lib/server/sender')>();
  return { ...actual, fetchTokenCreator: h.fetchTokenCreator };
});
vi.mock('@/lib/server/relay-models', async (original) => {
  const actual = await original<typeof import('@/lib/server/relay-models')>();
  return { ...actual, relayModels: h.relayModels };
});
vi.mock('@/lib/server/admin-config', async (original) => {
  const actual = await original<typeof import('@/lib/server/admin-config')>();
  return { ...actual, readConfig: async () => ({ ...(await actual.readConfig()), ...(h.allowedModels ? { allowedModels: h.allowedModels } : {}) }) };
});

// Throwaway keys (the same one as e2e/agent-api.spec.ts): their addresses own nothing.
const wallet = privateKeyToAccount('0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d');
const other = privateKeyToAccount('0x5de4111afa1a4b94908f83103eb1f1706367c2e68ea870594951c30d5a1a1b6b');
const CREATOR = '0x000000000000000000000000000000000000c0de';
const KERNEL = '0x00000000000000000000000000000000000000aa';
const AGENT = '1153600';

async function signed(statement: string, signer = wallet, over: Partial<SiweMessage> = {}) {
  const message = new SiweMessage({
    domain: 'bootr.fun',
    address: wallet.address,
    statement,
    uri: 'https://bootr.fun',
    version: '1',
    chainId: 84532,
    nonce: issueNonce().nonce,
    issuedAt: new Date().toISOString(),
    ...over,
  }).prepareMessage();
  return { message, signature: await signer.signMessage({ message }) };
}

let ip = 0;
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  // Each request its own client, so the rate limits stay out of the way.
  ip += 1;
  return new NextRequest(`https://bootr.fun${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: 'https://bootr.fun', host: 'bootr.fun', 'x-real-ip': `10.9.${ip >> 8}.${ip & 255}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}
const kernelCtx = { params: Promise.resolve({ kernel: KERNEL }) } as never;
const LAUNCH = 'Prepare a Bootr launch.';
const LINKS = `Update the links of Bootr coin $ABC (#${AGENT}, ${KERNEL}).`;
const CONFIG = `Update the agent of Bootr coin $ABC (#${AGENT}, ${KERNEL}).`;
const CONNECT = `Connect the X account of Bootr agent #${AGENT} (${KERNEL}).`;

type Refusal = { error: string; message: string; reason?: string; field?: string };
const read = async (res: Response) => ({ status: res.status, raw: await res.clone().text(), body: (await res.json()) as Refusal });

beforeEach(() => {
  h.chainDown = false;
  h.allowedModels = null;
  h.relayModels.mockReset();
  h.relayModels.mockResolvedValue({ models: FALLBACK_MODELS });
  h.fetchTokenCreator.mockReset();
  h.fetchTokenCreator.mockResolvedValue({ creator: CREATOR, agentId: AGENT, symbol: 'ABC', metadata: null, xHandle: null });
});

describe('a refused signature', () => {
  it('names the address it recovered to and the one the message needed, never the signature', async () => {
    const auth = await signed(LAUNCH, other);
    const { status, raw, body } = await read(await launch(request('/api/agent/launch', auth)));
    expect(status).toBe(401);
    expect(body.error).toBe('siwe_rejected');
    expect(body.reason).toBe('bad_signature');
    expect(body.message).toContain(`recovered to ${other.address}`);
    expect(body.message).toContain(wallet.address);
    expect(body.message).toContain('POST /api/agent/nonce');
    expect(raw).not.toContain(auth.signature);
  });

  it('says the check could not run when the chain is down, without its error', async () => {
    h.chainDown = true;
    const { status, raw, body } = await read(await launch(request('/api/agent/launch', await signed(LAUNCH))));
    expect(status).toBe(401);
    expect(body.reason).toBe('signature_unverifiable');
    expect(raw).not.toContain('do-not-repeat');
  });

  it('spends the nonce on the first attempt, and says so on the second', async () => {
    const auth = await signed(LAUNCH, other);
    await launch(request('/api/agent/launch', auth));
    const { status, body } = await read(await launch(request('/api/agent/launch', auth)));
    expect(status).toBe(401);
    expect(body.reason).toBe('nonce_spent');
    expect(body.message).toMatch(/Request a new nonce/);
  });

  it('spells out the statement it wanted, and repeats the one it got only in part', async () => {
    const { status, raw, body } = await read(await launch(request('/api/agent/launch', await signed(`Launch ${'y'.repeat(4000)}`))));
    expect(status).toBe(400);
    expect(body.reason).toBe('wrong_statement');
    expect(body.message).toContain('"Prepare a Bootr launch."');
    expect(raw.length).toBeLessThan(600);
  });

  it('names the uri, domain and chain it wanted', async () => {
    const uri = await read(await launch(request('/api/agent/launch', await signed(LAUNCH, wallet, { uri: 'https://evil.example', domain: 'evil.example' }))));
    expect(uri.status).toBe(401);
    expect(uri.body.reason).toBe('uri_mismatch');
    expect(uri.body.message).toContain('uri must be https://bootr.fun');
    const domain = await read(await launch(request('/api/agent/launch', await signed(LAUNCH, wallet, { domain: 'evil.example' }))));
    expect(domain.body.reason).toBe('domain_mismatch');
    expect(domain.body.message).toContain('host of uri (bootr.fun)');
    const chain = await read(await launch(request('/api/agent/launch', await signed(LAUNCH, wallet, { chainId: 1 }))));
    expect(chain.body.reason).toBe('unsupported_chain');
    expect(chain.body.message).toContain('8453');
  });

  it('says what is wrong with a malformed message, and which field is missing', async () => {
    const lower = (await signed(LAUNCH)).message.replace(wallet.address, wallet.address.toLowerCase());
    const bad = await read(await launch(request('/api/agent/launch', { message: lower, signature: '0x00' })));
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBe('malformed_message');
    expect(bad.body.message).toContain('EIP-55');
    const noMessage = await read(await launch(request('/api/agent/launch', { signature: '0x00' })));
    expect(noMessage.body.message).toMatch(/^message is required/);
    const noSignature = await read(await launch(request('/api/agent/launch', { message: 'x', signature: 'nope' })));
    expect(noSignature.body.message).toMatch(/^signature is required/);
    expect(noSignature.raw).not.toContain('nope');
  });
});

describe('a body that is not an object', () => {
  it.each(['null', '5', '[]', '{'])('%s is invalid_json on every signed route', async (raw) => {
    for (const res of [
      await launch(request('/api/agent/launch', raw)),
      await xConnect(request('/api/agent/x-connect', raw)),
      await putLinks(request(`/api/agent/${KERNEL}/links`, raw), kernelCtx),
      await postConfig(request(`/api/agent/${KERNEL}/config`, raw), kernelCtx),
    ]) {
      const { status, body } = await read(res);
      expect(status).toBe(400);
      expect(body.error).toBe('invalid_json');
      expect(body.message).toContain('{message, signature');
    }
  });
});

describe('the launch fields', () => {
  const good = { name: 'Quiet Engine', symbol: 'QENG', identity: 'A patient onchain analyst for small Base coins.' };
  const refuse = async (fields: Record<string, unknown>) => read(await launch(request('/api/agent/launch', { ...(await signed(LAUNCH)), launch: { ...good, ...fields } })));

  it.each([
    [{ name: '' }, 'name', 'got 0 characters'],
    [{ symbol: 'bad symbol' }, 'symbol', '"BAD SYMBOL"'.toLowerCase()],
    [{ identity: 'short' }, 'identity', 'plain text'],
    [{ model: 'nope/nope' }, 'model', '"nope/nope"'],
    [{ worker: 'pirate' }, 'worker', '"pirate"'],
    [{ launchThrough: 'pump' }, 'launchThrough', '"pump"'],
    [{ fuelUsdc: 'lots' }, 'fuelUsdc', '"lots"'],
    [{ devBuyEth: 'lots' }, 'devBuyEth', '"lots"'],
    [{ gasEth: 'lots' }, 'gasEth', '"lots"'],
    [{ gasEth: '0.00000001' }, 'gasEth', 'at least'],
    [{ links: { telegram: 'https://telegram.org/x' } }, 'links.telegram', 'https://t.me/'],
  ])('%j names %s and says to sign again', async (fields, field, says) => {
    const { status, body } = await refuse(fields);
    expect(status).toBe(400);
    expect(body.error).toBe('invalid_request');
    expect(body.field).toBe(field);
    expect(body.message).toContain(says);
    expect(body.message).toContain('fresh nonce');
  });

  it('checks model against the relay and the allow-list, like GET /api/models', async () => {
    const id = 'openai/gpt-5.5';
    const fields = { model: id, image: { dataUrl: 'not an image' } };
    h.allowedModels = [id];
    // Allowed, and the relay is down or does not list it: refused.
    expect((await refuse(fields)).body.field).toBe('model');
    // Allowed and on the relay's list: past the model check, to the next field.
    h.relayModels.mockResolvedValue({ models: [...FALLBACK_MODELS, { id, label: id, provider: 'OpenAI', pricePerThoughtUsd: 0.1 }] });
    expect((await refuse(fields)).body.field).not.toBe('model');
    // On the relay's list, not allowed: refused.
    h.allowedModels = ['anthropic/claude-haiku-4.5'];
    expect((await refuse(fields)).body.field).toBe('model');
  });

  it('keeps a long value out of the answer', async () => {
    const { raw, body } = await refuse({ symbol: 'x'.repeat(100_000), model: 'y'.repeat(100_000) });
    expect(body.field).toBe('symbol');
    expect(raw.length).toBeLessThan(400);
  });

  it('names a non-text value by its type', async () => {
    const { body } = await refuse({ symbol: { a: 1 } });
    expect(body.message).toContain('an object');
  });

  it('says what the launcher’s chain has to be', async () => {
    const { status, body } = await read(await launch(request('/api/agent/launch', { ...(await signed(LAUNCH, wallet, { chainId: 8453 })), launch: good })));
    expect(status).toBe(400);
    expect(body.error).toBe('wrong_chain');
    expect(body.message).toContain('chain 8453');
    expect(body.message).toContain('chainId to 84532');
  });
});

describe('the creator routes', () => {
  const routes: [string, string, (auth: object) => Promise<Response>][] = [
    ['x-connect', CONNECT, (auth) => xConnect(request('/api/agent/x-connect', auth))],
    ['links', LINKS, (auth) => putLinks(request(`/api/agent/${KERNEL}/links`, { ...auth, links: {} }), kernelCtx)],
    ['config', CONFIG, (auth) => postConfig(request(`/api/agent/${KERNEL}/config`, { ...auth, changes: { requireApproval: true } }), kernelCtx)],
  ];

  it.each(routes)('%s: not_creator names the signer and the creator it needed', async (_name, statement, call) => {
    const { status, body } = await read(await call(await signed(statement)));
    expect(status).toBe(403);
    expect(body.error).toBe('not_creator');
    expect(body.message).toContain(`signed by ${wallet.address}`);
    expect(body.message).toContain(`creator is ${CREATOR}`);
    expect(body.message).toContain('fresh nonce');
  });

  it.each(routes)('%s: not_creator names the agent when the statement has the wrong one', async (_name, statement, call) => {
    h.fetchTokenCreator.mockResolvedValue({ creator: wallet.address, agentId: '7', symbol: 'ABC', metadata: null, xHandle: null });
    const { status, body } = await read(await call(await signed(statement)));
    expect(status).toBe(403);
    expect(body.error).toBe('not_creator');
    expect(body.message).toContain(`names agent #${AGENT}`);
    expect(body.message).toContain('agent #7');
  });

  it.each(routes)('%s: unknown_coin names the treasury and the likely mistake', async (_name, statement, call) => {
    h.fetchTokenCreator.mockResolvedValue(null);
    const { status, body } = await read(await call(await signed(statement)));
    expect(status).toBe(404);
    expect(body.error).toBe('unknown_coin');
    expect(body.message).toContain(KERNEL);
    expect(body.message).toContain('not the coin’s address');
  });

  it.each(routes)('%s: an indexer failure is upstream_failed, and does not repeat its error', async (_name, statement, call) => {
    h.fetchTokenCreator.mockRejectedValue(new Error('secret-indexer-host unreachable'));
    const { status, raw, body } = await read(await call(await signed(statement)));
    expect(status).toBe(502);
    expect(body.error).toBe('upstream_failed');
    expect(raw).not.toContain('secret-indexer-host');
  });

  it('names both treasuries when the statement is for another coin', async () => {
    const elsewhere = '0x00000000000000000000000000000000000000bb';
    const { status, body } = await read(await putLinks(request(`/api/agent/${KERNEL}/links`, { ...(await signed(LINKS.replace(KERNEL, elsewhere))), links: {} }), kernelCtx));
    expect(status).toBe(400);
    expect(body.field).toBe('statement');
    expect(body.message).toContain(elsewhere);
    expect(body.message).toContain(KERNEL);
  });

  it('says which Origin it wants, bounded', async () => {
    const seen = await read(await putLinks(request(`/api/agent/${KERNEL}/links`, {}, { origin: `https://evil.example/${'z'.repeat(5000)}` }), kernelCtx));
    expect(seen.status).toBe(403);
    expect(seen.body.error).toBe('forbidden');
    expect(seen.body.message).toContain('Origin: https://bootr.fun');
    expect(seen.raw.length).toBeLessThan(400);
    const none = new NextRequest(`https://bootr.fun/api/agent/${KERNEL}/config`, { method: 'POST', body: '{}' });
    const missing = await read(await postConfig(none, kernelCtx));
    expect(missing.status).toBe(403);
    expect(missing.body.message).toContain('no Origin header');
  });

  it('takes links from a program with no Origin: the signature and the creator check still decide', async () => {
    const put = (body: unknown) => new NextRequest(`https://bootr.fun/api/agent/${KERNEL}/links`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-real-ip': '10.9.200.1' }, body: JSON.stringify(body) });
    const unsigned = await read(await putLinks(put({ links: {} }), kernelCtx));
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error).toBe('siwe_rejected');
    expect(unsigned.body.reason).toBe('missing_fields');
    const stranger = await read(await putLinks(put({ ...(await signed(LINKS)), links: {} }), kernelCtx));
    expect(stranger.status).toBe(403);
    expect(stranger.body.error).toBe('not_creator');
    const foreign = await read(await putLinks(request(`/api/agent/${KERNEL}/links`, { ...(await signed(LINKS)), links: {} }, { origin: 'https://evil.example' }), kernelCtx));
    expect(foreign.status).toBe(403);
    expect(foreign.body.error).toBe('forbidden');
    expect(foreign.body.message).toContain('A script sends no Origin');
  });

  it('names the bad kernel, bounded, and the field in changes', async () => {
    const bad = { params: Promise.resolve({ kernel: `0x${'q'.repeat(5000)}` }) } as never;
    const kernel = await read(await postConfig(request('/api/agent/x/config', {}), bad));
    expect(kernel.status).toBe(400);
    expect(kernel.body.field).toBe('kernel');
    expect(kernel.raw.length).toBeLessThan(300);
    const changes = await read(await postConfig(request(`/api/agent/${KERNEL}/config`, { changes: { worker: { postIntervalMs: 1 } } }), kernelCtx));
    expect(changes.status).toBe(400);
    expect(changes.body.field).toBe('worker.postIntervalMs');
    expect(changes.body.message).toContain('postIntervalMs from');
  });
});

describe('rate limits', () => {
  it('says the limit and the wait', async () => {
    const headers = { 'x-real-ip': '10.8.8.8' };
    let last: Response | undefined;
    for (let i = 0; i < 6; i++) last = await launch(request('/api/agent/launch', '{', headers));
    const { status, body } = await read(last!);
    expect(status).toBe(429);
    expect(body.error).toBe('rate_limited');
    expect(body.message).toMatch(/5 requests per minute per IP\. Retry in \d+ seconds/);
    expect(last!.headers.get('retry-after')).toMatch(/^\d+$/);
  });
});
