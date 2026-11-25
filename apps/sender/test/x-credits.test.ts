import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { X_CREDITS_HOLD_MAX_MS, X_CREDITS_HOLD_MS, XClient } from '../src/x-client.js';
import { AGENT, json, setup } from './helpers.js';

/**
 * The X app's pay-per-use credits are shared by every agent. On 2026-11-25 a 3.5 hour outage had every agent ask X
 * again each tick and the supervisor buy seven turns whose posts X refused. One 402 now holds every X call in this
 * process for 30 minutes, doubling to four hours while X keeps refusing, and the first success clears it.
 */
const MIN = 60_000;
const depleted = () => json({ title: 'CreditsDepleted', detail: 'Your enrolled account does not have any credits to fulfill this request.' }, 402);

describe('the app-wide X credits hold', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
    process.env.SENDER_LOG_SILENT = '1';
  });
  afterEach(async () => env.close());

  const publish = (n: number) => env.call('POST', '/internal/publish', { agentId: AGENT, actionId: `act-000${n}-post`, text: `post number ${n} from the agent` });
  const status = async () => (await env.call('GET', '/internal/x-credits')).body as { state: string; since: string | null; until: string | null; windowMs: number | null; refused: number };

  it('is clear until X answers 402, then answers every call itself without asking X', async () => {
    expect(await status()).toEqual({ state: 'clear', since: null, until: null, windowMs: null, refused: 0 });
    env.fake.on('POST', '/2/tweets', depleted);
    env.fake.on('GET', /\/2\/users\/\d+\/mentions/, depleted);
    const t0 = env.clock.now().getTime();

    const first = await publish(1);
    expect(first.body.status).toBe('rejected');
    expect(first.body.receipt.error).toMatch(/^http_402\(402\): /);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
    expect(await status()).toEqual({ state: 'held', since: new Date(t0).toISOString(), until: new Date(t0 + X_CREDITS_HOLD_MS).toISOString(), windowMs: X_CREDITS_HOLD_MS, refused: 0 });

    // a write and a read of the same app within the hold: the same 402, with the hold's end, and X is not called
    env.clock.advance(10 * MIN);
    const calls = env.fake.calls.length;
    const second = await publish(2);
    expect(second.body.status).toBe('rejected');
    expect(second.body.receipt.error).toMatch(/^http_402\(402\): X credits are used up/);
    const read = await env.call('POST', '/internal/read/mentions', { agentId: AGENT });
    expect([read.status, read.body.error, read.body.retryAt]).toEqual([502, 'x_http_402', new Date(t0 + X_CREDITS_HOLD_MS).toISOString()]);
    expect(env.fake.calls.length).toBe(calls);
    expect((await status()).refused).toBe(2);
  });

  it('asks X again when the hold runs out, doubles the hold on each further 402 up to four hours, and clears on the first success', async () => {
    let now = 1_000_000;
    let sent = 0;
    let answer = depleted;
    const x = new XClient({ baseUrl: 'https://api.x.test', now: () => now, sleep: async () => {}, fetch: (async () => (sent++, answer())) as typeof fetch });
    const windows: number[] = [];
    for (let n = 1; n <= 6; n++) {
      await x.createPost('token', { text: `post ${n}` });
      // a second call inside the hold is answered here
      await x.createPost('token', { text: `post ${n} again` });
      const s = x.creditsStatus();
      expect(s.state).toBe('held');
      windows.push(s.windowMs!);
      // one call reached X per hold
      expect(sent).toBe(n);
      now = s.until! + 1000;
      expect(x.creditsStatus().state).toBe('probing');
    }
    expect(windows).toEqual([30 * MIN, 60 * MIN, 120 * MIN, 240 * MIN, 240 * MIN, 240 * MIN]);
    expect(windows.at(-1)).toBe(X_CREDITS_HOLD_MAX_MS);
    expect(x.creditsStatus()).toMatchObject({ since: 1_000_000, refused: 6 });

    // the credits are back: the probing call goes through and the next 402 starts from 30 minutes again
    answer = () => json({ data: { id: '9', text: 'ok' } }, 201);
    expect((await x.createPost('token', { text: 'back' })).ok).toBe(true);
    expect(x.creditsStatus()).toEqual({ state: 'clear', since: null, until: null, windowMs: null, refused: 0 });
    answer = depleted;
    await x.createPost('token', { text: 'gone again' });
    expect(x.creditsStatus().windowMs).toBe(X_CREDITS_HOLD_MS);
  });

  it('a 402 that lands while a hold already stands does not double it', async () => {
    let now = 0;
    const answers: (() => Response)[] = [];
    const x = new XClient({ baseUrl: 'https://api.x.test', now: () => now, sleep: async () => {}, fetch: (async () => answers.shift()!()) as typeof fetch });
    // two calls leave before either answer is back
    answers.push(depleted, depleted);
    const [a, b] = await Promise.all([x.me('token-a'), x.me('token-b')]);
    expect([a.ok, b.ok]).toEqual([false, false]);
    expect(x.creditsStatus()).toMatchObject({ state: 'held', windowMs: X_CREDITS_HOLD_MS, until: X_CREDITS_HOLD_MS });
    // another token is held too: the credits belong to the app
    const held = await x.me('token-c');
    expect(held).toEqual({ ok: false, error: { definite: true, status: 402, code: 'http_402', message: expect.stringContaining('not asked again'), retryAt: X_CREDITS_HOLD_MS } });
    expect(answers.length).toBe(0);
    // an error that is not a success (404) leaves a probing hold as it is; a success clears it
    now = X_CREDITS_HOLD_MS + 1;
    answers.push(() => json({ title: 'Not Found' }, 404));
    await x.me('token-a');
    expect(x.creditsStatus().state).toBe('probing');
    answers.push(() => json({ data: { id: '1', username: 'a' } }));
    expect((await x.me('token-a')).ok).toBe(true);
    expect(x.creditsStatus().state).toBe('clear');
  });
});
