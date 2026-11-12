import { createHash } from 'node:crypto';
import { OWN_ERRORS, type ActResult, type OwnErrorBody, type OwnErrorCode, type TurnOpen } from '@bootr/shared/own-agent';
import { NextRequest } from 'next/server';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ACT_BODY_BYTES, readOwnBody, resetOwnLimits, RUN_PER_MINUTE, UPLOAD_BODY_BYTES, UPLOADS_IN_FLIGHT, uploadsInFlight } from '@/lib/server/own-agent';
import { COIN, startFakeSupervisor, TINY_PNG_BASE64, type FakeSupervisor } from '../../../../../../packages/mcp/test/fake-supervisor.mjs';
import { POST as act } from './act/route';
import { POST as disconnect } from './disconnect/route';
import { POST as due } from './due/route';
import { POST as finish } from './finish/route';
import { POST as status } from './status/route';
import { POST as turn } from './turn/route';
import { POST as upload } from './upload/route';

/**
 * The public run routes (docs/design/byo-agent.md section 13.6, routes 6 to 12) against the fake supervisor: the
 * bearer credential and where it travels, the refusal of a web page, the limits, the body caps, the relay of results
 * and of every error code, and the flag.
 */

vi.mock('@/lib/env', async (original) => {
  const actual = await original<typeof import('@/lib/env')>();
  return { ...actual, env: { ...actual.env, useMock: false } };
});

const SITE = 'https://bootr.fun';
const KEY = 'test-service-key-of-at-least-32-characters';
const ROUTES = { status, due, turn, act, finish, upload, disconnect };
type Op = keyof typeof ROUTES;

let fake: FakeSupervisor;
let credential = '';
let ip = 0;
const nextIp = () => `10.6.${(ip += 1) >> 8}.${ip & 255}`;

beforeAll(async () => {
  fake = await startFakeSupervisor({ key: KEY });
});
afterAll(() => fake.close());

beforeEach(() => {
  vi.stubEnv('OWN_AGENT_ENABLED', 'true');
  vi.stubEnv('SUPERVISOR_URL', fake.url);
  vi.stubEnv('SUPERVISOR_SERVICE_KEY', KEY);
  resetOwnLimits();
  Object.assign(fake.control, { status: null, raw: null, delayMs: 0 });
  Object.assign(fake.backend, { ownEnabled: true, runner: 'own', turn: null, due: { social: true, treasury: false, judge: false } });
  credential = fake.backend.issueCredential();
  fake.seen.length = 0;
});
afterEach(() => vi.unstubAllEnvs());

function call(op: Op, body: unknown = {}, headers: Record<string, string> = {}, bearer: string | null = credential) {
  const req = new NextRequest(`${SITE}/api/agent/run/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-real-ip': nextIp(), ...(bearer === null ? {} : { authorization: `Bearer ${bearer}` }), ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return ROUTES[op](req);
}

async function error(res: Response, code: OwnErrorCode): Promise<OwnErrorBody> {
  const body = (await res.json()) as OwnErrorBody;
  expect(body.error).toBe(code);
  expect(res.status).toBe(OWN_ERRORS[code].status);
  expect(body.message.startsWith(OWN_ERRORS[code].message)).toBe(true);
  return body;
}

async function openTurn(): Promise<TurnOpen> {
  const res = await call('turn', { role: 'social' });
  expect(res.status).toBe(200);
  return (await res.json()) as TurnOpen;
}

describe('the bearer credential', () => {
  it('never leaves this server: the forward carries its SHA-256 first in the signed body, and every route forwards to its own operation', async () => {
    const hash = createHash('sha256').update(credential).digest('hex');
    for (const op of ['status', 'due', 'turn', 'act', 'finish', 'upload'] as const) {
      await call(op, op === 'turn' ? { role: 'social' } : { turnId: 'otn_none' });
      // The upload asks whether the credential is live before it reads the body: that call carries the hash alone.
      for (const seen of fake.seen) {
        expect(seen).toMatchObject({ method: 'POST', authorized: true });
        expect(seen.body.credentialHash).toBe(hash);
        expect(seen.raw.startsWith(`{"credentialHash":"${hash}"`)).toBe(true);
        expect(seen.raw + seen.path).not.toContain('bootr_agt_');
        expect(seen.raw + seen.path).not.toContain(credential.slice(10));
        expect(seen.body).not.toHaveProperty('credential');
      }
      expect(fake.seen.at(-1)!.path).toBe(`/internal/own/run/${op}`);
      fake.seen.length = 0;
    }
    const res = await call('disconnect');
    expect(await res.json()).toEqual({ ok: true });
    expect(fake.seen.at(-1)!.path).toBe('/internal/own/run/disconnect');
    await error(await call('status'), 'credential_revoked');
  });

  it('cannot be replaced by a field of the body, as a credential or as a hash', async () => {
    const other = fake.backend.issueCredential();
    const hash = createHash('sha256').update(credential).digest('hex');
    const otherHash = createHash('sha256').update(other).digest('hex');
    await call('status', { credential: other, credentialHash: otherHash });
    const seen = fake.seen.at(-1)!;
    expect(seen.body.credentialHash).toBe(hash);
    expect(seen.body).not.toHaveProperty('credential');
    expect(seen.raw).not.toContain(otherHash);
    expect(seen.raw).not.toContain('bootr_agt_');
  });

  it('is refused when missing or malformed, before the agent service is asked', async () => {
    await error(await call('status', {}, {}, null), 'unauthorized');
    for (const bad of ['', 'bootr_agt_short', `bootr_agt_${'a'.repeat(44)}`, `bootr_xxx_${'a'.repeat(43)}`, `${credential} extra`, `bootr_agt_${'a'.repeat(42)}!`]) {
      await error(await call('status', {}, {}, bad), 'unauthorized');
    }
    for (const scheme of ['Basic', 'bearer', 'HMAC', 'Token']) await error(await call('status', {}, { authorization: `${scheme} ${credential}` }), 'unauthorized');
    expect(fake.seen).toHaveLength(0);
    // Well formed and unknown: the agent service is the one that knows.
    await error(await call('status', {}, {}, `bootr_agt_${'a'.repeat(43)}`), 'unauthorized');
    expect(fake.seen).toHaveLength(1);
  });

  it('is never taken from a web page: any Origin header is refused, the site’s own included', async () => {
    for (const origin of [SITE, 'https://evil.example', 'null', '']) {
      for (const op of Object.keys(ROUTES) as Op[]) await error(await call(op, {}, { origin }), 'unauthorized');
    }
    expect(fake.seen).toHaveLength(0);
  });

  it('never reaches a log line', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    await call('status');
    vi.stubEnv('SUPERVISOR_URL', 'http://127.0.0.1:9');
    await error(await call('act', { turnId: 'x', tool: 'publish_post', input: {} }), 'supervisor_unavailable');
    vi.stubEnv('SUPERVISOR_URL', fake.url);
    vi.stubEnv('SUPERVISOR_SERVICE_KEY', 'another-service-key-of-at-least-32-chars');
    await error(await call('status'), 'supervisor_unavailable');
    fake.control.status = 500;
    vi.stubEnv('SUPERVISOR_SERVICE_KEY', KEY);
    await error(await call('due'), 'supervisor_unavailable');
    const logged = spies.flatMap((s) => s.mock.calls.flat()).map(String).join('\n');
    expect(logged).not.toContain('bootr_agt_');
    expect(logged).not.toContain(credential.slice(10));
    for (const s of spies) s.mockRestore();
  });
});

describe('the answers', () => {
  it('relays status and due as the agent service gave them', async () => {
    expect(await (await call('status')).json()).toMatchObject({ coin: COIN, runner: 'own', postsLeftToday: 21 });
    const view = (await (await call('due')).json()) as { social: { due: boolean; reasons: string[] }; nextCheckAt: string };
    expect(view.social).toMatchObject({ due: true, reasons: ['pending_mention'] });
    expect(Date.parse(view.nextCheckAt)).toBeGreaterThan(Date.now());
  });

  it('answers a hosted coin’s status and refuses its other calls', async () => {
    fake.backend.runner = 'hosted';
    expect(await (await call('status')).json()).toMatchObject({ runner: 'hosted' });
    await error(await call('due'), 'agent_runs_hosted');
    await error(await call('turn', { role: 'social' }), 'agent_runs_hosted');
  });

  it('carries a turn: open, resume, a completed, a failed, a pending and a held call, each with HTTP 200', async () => {
    const opened = await openTurn();
    expect(opened).toMatchObject({ role: 'social', resumed: false, stepBudget: 8, stepsUsed: 0 });
    expect(opened.tools).toContain('bootr_agent_publish_reply');
    expect((await (await call('turn', { role: 'social' })).json()) as TurnOpen).toMatchObject({ turnId: opened.turnId, resumed: true });
    await error(await call('turn', { role: 'treasury' }), 'turn_open');

    const post = { turnId: opened.turnId, tool: 'publish_post', input: { text: 'gm from the owl' } };
    const first = (await (await call('act', post)).json()) as ActResult;
    expect(first).toMatchObject({ status: 'completed', tool: 'publish_post', stepsUsed: 1, turnEnded: false });
    // The same call again is the same action: nothing is posted twice.
    const again = (await (await call('act', post)).json()) as ActResult;
    expect(again.actionId).toBe(first.actionId);
    expect(again.stepsUsed).toBe(1);
    expect(fake.backend.posts).toHaveLength(1);
    // A read runs again and is a step of its own.
    const read = { turnId: opened.turnId, tool: 'read_mentions', input: {} };
    expect(((await (await call('act', read)).json()) as ActResult).stepsUsed).toBe(2);
    expect(((await (await call('act', read)).json()) as ActResult).stepsUsed).toBe(3);

    const failed = await call('act', { turnId: opened.turnId, tool: 'publish_reply', input: { text: 'the price will double' } });
    expect(failed.status).toBe(200);
    expect(await failed.json()).toMatchObject({ status: 'failed', error: expect.stringContaining('social_price_prediction_forbidden') });

    await error(await call('act', { turnId: opened.turnId, tool: 'treasury_execute', input: {} }), 'tool_unavailable');
    await error(await call('act', { turnId: opened.turnId, tool: 'publish_post', input: {} }), 'invalid_tool_call');
    await error(await call('act', { turnId: 'otn_other', tool: 'publish_post', input: {} }), 'turn_not_found');

    const held = (await (await call('act', { turnId: opened.turnId, tool: 'x402_fetch', input: { url: 'https://api.example' } })).json()) as ActResult;
    expect(held).toMatchObject({ status: 'held', turnEnded: true });
    await error(await call('act', post), 'turn_closed');
  });

  it('relays a pending call with its retryAt, then its result', async () => {
    fake.backend.due.treasury = true;
    const opened = (await (await call('turn', { role: 'treasury' })).json()) as TurnOpen;
    const body = { turnId: opened.turnId, tool: 'treasury_execute', input: { opId: 'op_1' } };
    const pending = (await (await call('act', body)).json()) as ActResult;
    expect(pending.status).toBe('pending');
    expect(Date.parse(pending.retryAt!)).toBeGreaterThan(Date.now());
    expect((await (await call('act', body)).json()) as ActResult).toMatchObject({ status: 'completed', actionId: pending.actionId });
    const done = (await (await call('finish', { turnId: opened.turnId, memory: 'm', agenda: 'a', summary: 's', nextAt: new Date(Date.now() + 3_600_000).toISOString() })).json()) as ActResult;
    expect(done).toMatchObject({ tool: 'finish', status: 'completed', turnEnded: true });
  });

  it('relays every error code with its status, its words, retryAt and field', async () => {
    const retryAt = new Date(Date.now() + 90_000).toISOString();
    for (const code of Object.keys(OWN_ERRORS) as OwnErrorCode[]) {
      if (code === 'supervisor_unavailable') continue;
      resetOwnLimits();
      fake.backend.failNext(code, { retryAt, field: 'role', ...(code === 'invalid_tool_call' ? { detail: 'text is required.' } : {}) });
      const res = await call('turn', { role: 'social' });
      const body = await error(res, code);
      expect(body.retryAt, code).toBe(retryAt);
      expect(body.field, code).toBe('role');
      expect(Number(res.headers.get('retry-after')), code).toBeGreaterThan(0);
      if (code === 'invalid_tool_call') expect(body.message).toBe(`${OWN_ERRORS.invalid_tool_call.message} text is required.`);
      else expect(body.message, code).toBe(OWN_ERRORS[code].message);
    }
  });

  it('answers supervisor_unavailable for an error it does not know, a 5xx and a silent service', async () => {
    fake.control.status = 418;
    await error(await call('status'), 'supervisor_unavailable');
    fake.control.status = 503;
    await error(await call('status'), 'supervisor_unavailable');
    vi.stubEnv('SUPERVISOR_URL', 'http://127.0.0.1:9');
    await error(await call('act', { turnId: 'x', tool: 'publish_post', input: {} }), 'supervisor_unavailable');
  });
});

describe('the limits and the body caps', () => {
  it('takes 120 a minute per credential over all run routes, whatever the IP', async () => {
    for (let i = 0; i < RUN_PER_MINUTE; i++) expect((await call(i % 2 ? 'status' : 'disconnect', {}, {}, `bootr_agt_${'b'.repeat(43)}`)).status).toBe(401);
    const over = await call('status', {}, {}, `bootr_agt_${'b'.repeat(43)}`);
    const body = await error(over, 'rate_limited');
    expect(Date.parse(body.retryAt!)).toBeGreaterThan(Date.now());
    expect(fake.seen).toHaveLength(RUN_PER_MINUTE);
    // Another client is not held up by it.
    expect((await call('status')).status).toBe(200);
  });

  it('takes 120 a minute per IP before a credential is looked at', async () => {
    const headers = { 'x-real-ip': '10.5.0.1' };
    for (let i = 0; i < 120; i++) await call('status', {}, headers, 'not-a-credential');
    await error(await call('status', {}, headers), 'rate_limited');
    expect(fake.seen).toHaveLength(0);
  });

  it('takes one due call per interval per credential', async () => {
    expect((await call('due')).status).toBe(200);
    const again = await call('due');
    const body = await error(again, 'rate_limited');
    expect(Date.parse(body.retryAt!) - Date.now()).toBeLessThanOrEqual(20_000);
    expect(fake.seen.filter((s) => s.path.endsWith('/due'))).toHaveLength(1);
    // Other routes and other clients go on.
    expect((await call('status')).status).toBe(200);
    expect((await call('due', {}, {}, fake.backend.issueCredential())).status).toBe(200);
  });

  it('does not count a look that found the agent busy: the client may come back at retryAt', async () => {
    const retryAt = new Date(Date.now() + 2000).toISOString();
    fake.backend.failNext('runtime_busy', { retryAt });
    const busy = await call('due');
    expect((await error(busy, 'runtime_busy')).retryAt).toBe(retryAt);
    expect(Number(busy.headers.get('retry-after'))).toBeGreaterThan(0);
    // The agent service holds nobody to the interval, so this route is the only place that does.
    expect((await call('due')).status).toBe(200);
    await error(await call('due'), 'rate_limited');
    expect(fake.seen.filter((s) => s.path.endsWith('/due'))).toHaveLength(2);
    // Any other refusal still counts as a look.
    const other = fake.backend.issueCredential();
    fake.backend.failNext('agent_onboarding');
    await error(await call('due', {}, {}, other), 'agent_onboarding');
    await error(await call('due', {}, {}, other), 'rate_limited');
  });

  it('relays runtime_busy, agent_paused and payload_too_large from any run route', async () => {
    const retryAt = new Date(Date.now() + 3000).toISOString();
    for (const op of ['status', 'turn', 'act', 'finish', 'upload'] as const) {
      fake.backend.failNext('runtime_busy', { retryAt });
      expect((await error(await call(op, { role: 'social' }), 'runtime_busy')).retryAt, op).toBe(retryAt);
    }
    for (const op of ['act', 'finish', 'upload'] as const) {
      fake.backend.failNext('agent_paused');
      await error(await call(op, {}), 'agent_paused');
    }
    fake.backend.failNext('payload_too_large');
    await error(await call('upload', { turnId: 'x', dataBase64: 'AAAA' }), 'payload_too_large');
  });

  it('caps a step’s body at 64 KB and an upload’s at 8 MB, whatever length is declared', async () => {
    const opened = await openTurn();
    fake.seen.length = 0;
    await error(await call('act', { turnId: opened.turnId, tool: 'remember', input: { text: 'x'.repeat(ACT_BODY_BYTES) } }), 'payload_too_large');
    await error(await call('status', { pad: 'x'.repeat(20_000) }), 'payload_too_large');
    await error(await call('upload', { turnId: opened.turnId, mime: 'image/png', dataBase64: 'A'.repeat(UPLOAD_BODY_BYTES), alt: 'a', description: 'd' }), 'payload_too_large');
    // A declared length that lies is not believed: the stream is cut at the cap.
    await error(await call('status', { pad: 'x'.repeat(20_000) }, { 'content-length': '10' }), 'payload_too_large');
    // Nothing was forwarded; the upload only asked, with the hash alone, whether its credential is live.
    expect(fake.seen.map((s) => s.path)).toEqual(['/internal/own/run/verify']);
    // An upload that declares more than the cap is refused before even that.
    fake.seen.length = 0;
    await error(await call('upload', { turnId: opened.turnId }, { 'content-length': String(UPLOAD_BODY_BYTES + 1) }), 'payload_too_large');
    expect(fake.seen).toHaveLength(0);
    await error(await call('act', '{"turnId":'), 'invalid_request');
    await error(await call('act', '"text"'), 'invalid_request');
  });

  it('carries a picture of a few megabytes to the agent service', async () => {
    const opened = await openTurn();
    const png = Buffer.concat([Buffer.from(TINY_PNG_BASE64, 'base64'), Buffer.alloc(3 * 1024 * 1024, 7)]);
    const res = await call('upload', { turnId: opened.turnId, mime: 'image/png', dataBase64: png.toString('base64'), alt: 'An owl at night', description: 'A drawing of an owl on a branch.' });
    expect(await res.json()).toMatchObject({ tool: 'upload_picture', status: 'completed', result: { mime: 'image/png', bytes: png.length, alt: 'An owl at night' } });
    const refused = await call('upload', { turnId: opened.turnId, mime: 'image/png', dataBase64: Buffer.from('MZ this is a program').toString('base64'), alt: 'a', description: 'd' });
    expect(refused.status).toBe(200);
    expect(await refused.json()).toMatchObject({ status: 'failed', error: expect.stringContaining('image_type_refused') });
  });
});

/**
 * An upload whose body is a stream that makes its bytes only when they are asked for and counts them: `pulled()` is
 * how much of the body this server read. The bytes are a well-formed `UploadPictureRequest` of `bytes` bytes.
 */
function streamedUpload(bytes: number, bearer: string, turnId = 'otn_none', opts: { stall?: boolean } = {}) {
  const head = new TextEncoder().encode(`{"turnId":"${turnId}","mime":"image/png","alt":"An owl","description":"An owl on a branch.","dataBase64":"${TINY_PNG_BASE64}`);
  const tail = new TextEncoder().encode('"}');
  const fill = new Uint8Array(64 * 1024).fill(0x41);
  let left = Math.max(0, bytes - head.length - tail.length);
  let pulled = 0;
  let stage: 'head' | 'fill' | 'done' = 'head';
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        const send = (chunk: Uint8Array) => {
          pulled += chunk.length;
          controller.enqueue(chunk);
        };
        if (stage === 'head') {
          stage = 'fill';
          return send(head);
        }
        if (stage === 'fill' && left > 0) {
          // A body that stalls keeps its connection and sends nothing more.
          if (opts.stall) return new Promise<void>(() => {});
          const chunk = fill.subarray(0, Math.min(fill.length, left));
          left -= chunk.length;
          return send(chunk);
        }
        if (stage !== 'done') {
          stage = 'done';
          send(tail);
        }
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const req = new NextRequest(`${SITE}/api/agent/run/upload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-real-ip': nextIp(), authorization: `Bearer ${bearer}` }, body, duplex: 'half' } as ConstructorParameters<typeof NextRequest>[1]);
  return { req, pulled: () => pulled };
}

describe('uploads under load (security review H1)', () => {
  const MB = 1024 * 1024;

  it('reads nothing of a hundred concurrent uploads whose credentials nobody holds', async () => {
    const junk = Array.from({ length: 100 }, (_, i) => streamedUpload(8 * MB - 1024, `bootr_agt_${String(i).padStart(3, '0')}${'j'.repeat(40)}`));
    const answers = await Promise.all(junk.map((u) => upload(u.req)));
    for (const res of answers) await error(res, 'unauthorized');
    // Not one byte of the 800 MB on offer was read, and the agent service was asked a hundred small questions.
    expect(junk.reduce((sum, u) => sum + u.pulled(), 0)).toBe(0);
    expect(fake.seen).toHaveLength(100);
    for (const seen of fake.seen) {
      expect(seen.path).toBe('/internal/own/run/verify');
      expect(seen.raw.length).toBeLessThan(100);
    }
    expect(uploadsInFlight()).toBe(0);
  });

  it('reads nothing for a revoked credential, a hosted coin or a coin still being set up', async () => {
    const revoked = fake.backend.issueCredential();
    fake.backend.runAs('disconnect', revoked);
    const a = streamedUpload(MB, revoked);
    await error(await upload(a.req), 'credential_revoked');
    fake.backend.runner = 'hosted';
    const b = streamedUpload(MB, credential);
    await error(await upload(b.req), 'agent_runs_hosted');
    fake.backend.runner = 'own';
    fake.backend.failNext('agent_onboarding');
    const c = streamedUpload(MB, credential);
    await error(await upload(c.req), 'agent_onboarding');
    expect(a.pulled() + b.pulled() + c.pulled()).toBe(0);
    expect(fake.seen.every((s) => s.path === '/internal/own/run/verify')).toBe(true);
  });

  it('holds four uploads at a time over all clients: the rest are told to come back and are not read', async () => {
    const opened = await openTurn();
    fake.control.delayMs = 150;
    const clients = Array.from({ length: 10 }, () => streamedUpload(2 * MB, fake.backend.issueCredential(), opened.turnId));
    const answers = await Promise.all(clients.map((u) => upload(u.req)));
    const taken = answers.map((r, i) => ({ status: r.status, pulled: clients[i]!.pulled() }));
    expect(taken.filter((t) => t.status === 200)).toHaveLength(UPLOADS_IN_FLIGHT);
    expect(taken.filter((t) => t.status === 429)).toHaveLength(10 - UPLOADS_IN_FLIGHT);
    for (const t of taken) expect(t.pulled).toBe(t.status === 200 ? 2 * MB : 0);
    for (const res of answers.filter((r) => r.status === 429)) {
      const body = await error(res, 'rate_limited');
      expect(Date.parse(body.retryAt!)).toBeGreaterThan(Date.now());
      expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0);
    }
    expect(fake.seen.filter((s) => s.path === '/internal/own/run/upload')).toHaveLength(UPLOADS_IN_FLIGHT);
    // Every place is free again afterwards.
    expect(uploadsInFlight()).toBe(0);
    fake.control.delayMs = 0;
    expect((await upload(streamedUpload(MB, credential, opened.turnId).req)).status).toBe(200);
  });

  it('takes one upload at a time from one client', async () => {
    const opened = await openTurn();
    fake.control.delayMs = 100;
    const [first, second] = [streamedUpload(MB, credential, opened.turnId), streamedUpload(MB, credential, opened.turnId)];
    const answers = await Promise.all([upload(first.req), upload(second.req)]);
    expect(answers.map((r) => r.status).sort()).toEqual([200, 429]);
    expect([first.pulled(), second.pulled()].sort((x, y) => x - y)).toEqual([0, MB]);
    expect(uploadsInFlight()).toBe(0);
  });

  it('frees the place of an upload that fails, is too large or never finishes arriving', async () => {
    const opened = await openTurn();
    await error(await upload(streamedUpload(UPLOAD_BODY_BYTES + MB, credential, opened.turnId).req), 'payload_too_large');
    expect(uploadsInFlight()).toBe(0);
    fake.backend.failNext('turn_closed');
    // The scripted refusal answers the question before the read; the next upload is refused by the upload itself.
    await error(await upload(streamedUpload(MB, credential, opened.turnId).req), 'turn_closed');
    await error(await upload(streamedUpload(MB, credential, 'otn_other').req), 'turn_not_found');
    expect(uploadsInFlight()).toBe(0);
    // A body that stops arriving is given up on after the deadline and the rest is not waited for.
    const stalled = streamedUpload(MB, credential, opened.turnId, { stall: true });
    const late = await readOwnBody(stalled.req, UPLOAD_BODY_BYTES, 40);
    expect(late).toBeInstanceOf(Response);
    expect((await error(late as Response, 'invalid_request')).message).toContain('did not arrive in time');
  });
});

describe('with own agents switched off', () => {
  it('answers own_agent_disabled on every run route without asking the agent service', async () => {
    vi.stubEnv('OWN_AGENT_ENABLED', 'false');
    for (const op of Object.keys(ROUTES) as Op[]) await error(await call(op, { role: 'social' }), 'own_agent_disabled');
    // Before the credential is even looked at.
    await error(await call('status', {}, {}, null), 'own_agent_disabled');
    expect(fake.seen).toHaveLength(0);
  });
});
