import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { LOW_FUEL_THOUGHTS } from '@bootr/shared/fuel';
import { createApp } from '../src/api.js';
import { queueForApproval } from '../src/approvals.js';
import { approvals, notifications, notificationSettings, runtimes, telegramLinks, telegramLinkTokens } from '../src/db/schema.js';
import { signRequest } from '../src/hmac.js';
import { coinLabel, EVENT_RULES, flushNotifications, MAX_SENDS_PER_EPISODE, notificationsView, notificationText, raiseNotification, REJECTED_RETRY_MS, resolveNotification, sendDue, telegramText } from '../src/notifications.js';
import { evaluateHealth, FAILING_TURNS, fuelLow, keyOutdated, notifierPass, refreshReviewNotifications, type HealthFacts } from '../src/notify-health.js';
import { createTelegramLink, handleTelegramUpdate, LINK_TOKEN_TTL_MS, pollTelegramOnce, TelegramClient } from '../src/telegram.js';
import { tick } from '../src/tick.js';
import { AGENT_ID, CREATOR, finishResponse, makeWorld, seedAgent, SUPERVISOR_KEY, TOKEN, type TestWorld } from './helpers.js';

const BOT_TOKEN = '123456:SECRET-BOT-TOKEN';
const CHAT = '555';
const HOUR = 3_600_000;

type TgCall = { method: string; body: Record<string, unknown>; url: string };

/** The Telegram HTTP boundary: records every call and answers what `respond` says (200 ok by default). */
function telegramStub(respond: (call: TgCall) => Response | Promise<Response> = () => okResponse(true)) {
  const calls: TgCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const call = { url, method: url.slice(url.lastIndexOf('/') + 1), body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown> };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch: fetchImpl };
}

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ ok: true, result }), { status: 200, headers: { 'content-type': 'application/json' } });
}

function errorResponse(status: number, extra: Record<string, unknown> = {}): Response {
  return new Response(JSON.stringify({ ok: false, error_code: status, description: 'nope', ...extra }), { status, headers: { 'content-type': 'application/json' } });
}

async function linkedWorld(respond?: Parameters<typeof telegramStub>[0], chain: Parameters<typeof makeWorld>[0] = {}) {
  const w = await makeWorld(chain);
  await seedAgent(w);
  const tg = telegramStub(respond);
  w.ctx.telegram = new TelegramClient(BOT_TOKEN, tg.fetch, w.ctx.now);
  await w.db.insert(telegramLinks).values({ creator: CREATOR.toLowerCase(), chatId: CHAT, linkedAt: new Date(w.ctx.now()) });
  return { w, tg };
}

const sends = (tg: { calls: TgCall[] }) => tg.calls.filter((c) => c.method === 'sendMessage');

async function rows(w: TestWorld) {
  return w.db.select().from(notifications).where(eq(notifications.agentId, AGENT_ID));
}

function api(world: TestWorld) {
  const nowSec = () => Math.floor(world.ctx.now() / 1000);
  const app = createApp(world.ctx, nowSec);
  const send = (method: 'POST' | 'PUT', path: string, body: unknown) => {
    const text = JSON.stringify(body);
    return app.request(path, { method, body: text, headers: { 'content-type': 'application/json', authorization: signRequest(SUPERVISOR_KEY, method, path, text, nowSec()) } });
  };
  return {
    get: (path: string) => app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } }),
    post: (path: string, body: unknown) => send('POST', path, body),
    put: (path: string, body: unknown) => send('PUT', path, body),
  };
}

const facts = (over: Partial<HealthFacts> = {}): HealthFacts => ({
  now: 1_000_000_000_000,
  agentStatus: 'active',
  runtime: { status: 'waiting', pausedBy: null, failures: 0 },
  reviews: { pending: 0, expiring: 0, soonestExpiry: null },
  fuel: { spendableMicro: 10_000_000, reserveMicro: 40_000_000, recent: { thoughts: 40, spentMicroUsdc: 400_000 }, week: { thoughts: 40, spentMicroUsdc: 400_000, firstAt: 1_000_000_000_000 - 7 * 24 * HOUR } },
  gas: 'ok',
  x: { connected: true, revoked: false },
  key: { validUntil: 1_000_000_000_000 + 20 * 24 * HOUR, rotateBeforeMs: 3 * 24 * HOUR, outdated: false },
  ...over,
});

describe('evaluateHealth', () => {
  it('is all clear for a healthy agent', () => {
    expect(Object.values(evaluateHealth(facts())).every((v) => v === false)).toBe(true);
  });

  it('turns each fact into its event', () => {
    expect(evaluateHealth(facts({ gas: 'empty' })).gas_out).toEqual({});
    expect(evaluateHealth(facts({ gas: 'low' })).gas_out).toBe(false);
    expect(evaluateHealth(facts({ gas: 'sponsored' })).gas_out).toBe(false);
    expect(evaluateHealth(facts({ x: { connected: false, revoked: true } })).x_revoked).toEqual({});
    expect(evaluateHealth(facts({ runtime: { status: 'sleeping', pausedBy: null, failures: 0 } })).agent_asleep).toEqual({});
    expect(evaluateHealth(facts({ runtime: { status: 'paused', pausedBy: 'guardian', failures: 0 } })).agent_stopped).toEqual({ reason: 'paused_onchain' });
    expect(evaluateHealth(facts({ runtime: { status: 'paused', pausedBy: 'operator', failures: 0 } })).agent_stopped).toEqual({ reason: 'paused_by_bootr' });
    expect(evaluateHealth(facts({ runtime: { status: 'held', pausedBy: null, failures: 0 } })).agent_stopped).toEqual({ reason: 'blocked' });
    expect(evaluateHealth(facts({ runtime: { status: 'waiting', pausedBy: null, failures: FAILING_TURNS } })).agent_stopped).toEqual({ reason: 'failing', failures: FAILING_TURNS });
    expect(evaluateHealth(facts({ reviews: { pending: 2, expiring: 1, soonestExpiry: 1_000_000_000_000 + 3 * HOUR } }))).toMatchObject({ review_waiting: { pending: 2 }, review_expiring: { expiring: 1, hours: 3 } });
  });

  it('leaves an event out when its fact could not be read, so a failed read neither raises nor clears it', () => {
    const out = evaluateHealth(facts({ fuel: null, gas: null, x: null }));
    expect(out).not.toHaveProperty('fuel_low');
    expect(out).not.toHaveProperty('gas_out');
    expect(out).not.toHaveProperty('x_revoked');
    // a connected: false, revoked: false account (not linked yet) says nothing about a revocation either
    expect(evaluateHealth(facts({ x: { connected: false, revoked: false } }))).not.toHaveProperty('x_revoked');
  });

  it('does not tell a sleeping agent’s creator about low fuel as well', () => {
    const out = evaluateHealth(facts({ runtime: { status: 'sleeping', pausedBy: null, failures: 0 }, fuel: { ...facts().fuel!, spendableMicro: 0, reserveMicro: 0 } }));
    expect(out.agent_asleep).toEqual({});
    expect(out.fuel_low).toBe(false);
  });

  it('only gas and reviews matter before an agent is active', () => {
    const out = evaluateHealth(facts({ agentStatus: 'onboarding', gas: 'empty', runtime: { status: 'ready', pausedBy: null, failures: 0 } }));
    expect(Object.keys(out).sort()).toEqual(['gas_out', 'review_expiring', 'review_waiting']);
  });

  it('asks for a key renewal when it is about to run out or was issued under older limits', () => {
    const now = facts().now;
    expect(evaluateHealth(facts({ key: { validUntil: now + 2 * 24 * HOUR, rotateBeforeMs: 3 * 24 * HOUR, outdated: false } })).key_rotation).toEqual({ reason: 'expiring', days: 2 });
    expect(evaluateHealth(facts({ key: { validUntil: now + 20 * 24 * HOUR, rotateBeforeMs: 3 * 24 * HOUR, outdated: true } })).key_rotation).toEqual({ reason: 'outdated' });
    expect(keyOutdated({ permissionId: '0x1', sessionPolicy: { ratePerHour: 60 } }, 100_000)).toBe(true);
    expect(keyOutdated({ permissionId: '0x1', sessionPolicy: { ratePerHour: 100_000, rulesVersion: 4 } }, 100_000)).toBe(false);
    expect(keyOutdated({ permissionId: null, sessionPolicy: null }, 100_000)).toBe(false);
  });
});

describe('fuelLow', () => {
  const now = facts().now;
  const recent = { thoughts: 40, spentMicroUsdc: 4_000_000 }; // 0.10 per thought
  const week = { thoughts: 0, spentMicroUsdc: 0, firstAt: null };

  it('counts the reserve: a low float with a full reserve needs nothing from the creator', () => {
    expect(fuelLow({ spendableMicro: 100_000, reserveMicro: 40_000_000, recent, week }, now)).toBeNull();
  });

  it('is low under LOW_FUEL_THOUGHTS of everything left', () => {
    const below = (LOW_FUEL_THOUGHTS - 4) * 100_000;
    expect(fuelLow({ spendableMicro: below, reserveMicro: 0, recent, week }, now)).toEqual({ thoughtsLeft: LOW_FUEL_THOUGHTS - 4, days: null });
  });

  it('is low under two days at the recent rate even with many thoughts left', () => {
    // 100 USDC a week is about 14.3 a day; 20 USDC is 1.4 days and 200 thoughts.
    const busy = { thoughts: 1000, spentMicroUsdc: 100_000_000, firstAt: now - 7 * 24 * HOUR };
    expect(fuelLow({ spendableMicro: 20_000_000, reserveMicro: 0, recent, week: busy }, now)).toEqual({ thoughtsLeft: 200, days: 1.4 });
  });

  it('says nothing on thin data unless the wallets are empty', () => {
    const thin = { thoughts: 2, spentMicroUsdc: 2000 };
    expect(fuelLow({ spendableMicro: 1, reserveMicro: 0, recent: thin, week }, now)).toBeNull();
    expect(fuelLow({ spendableMicro: 0, reserveMicro: 0, recent: thin, week }, now)).toEqual({ thoughtsLeft: null, days: null });
  });
});

describe('dedupe, repeat and resolve', () => {
  it('keeps one open row per event and closes it on resolve', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    await raiseNotification(w.ctx, AGENT_ID, 'gas_out');
    await raiseNotification(w.ctx, AGENT_ID, 'gas_out');
    await raiseNotification(w.ctx, AGENT_ID, 'fuel_low', { thoughtsLeft: 3 });
    expect((await rows(w)).length).toBe(2);
    await resolveNotification(w.ctx, AGENT_ID, 'gas_out');
    const view = await notificationsView(w.ctx, { agentId: AGENT_ID, creator: CREATOR });
    expect(view.active).toBe(1);
    expect(view.items.map((i) => [i.event, i.state])).toEqual([
      ['fuel_low', 'active'],
      ['gas_out', 'resolved'],
    ]);
    await w.close();
  });

  it('sendDue follows the first wait, the repeat interval, the opt-out and the cap', () => {
    const t = 1_000_000_000_000;
    const row = { event: 'gas_out' as const, firstAt: new Date(t), lastSentAt: null, sendCount: 0, nextAttemptAt: null };
    expect(sendDue(row, [], t)).toBe(false); // gas gets a quarter of an hour to refill itself
    expect(sendDue(row, [], t + EVENT_RULES.gas_out.sendAfterMs)).toBe(true);
    expect(sendDue(row, ['gas_out'], t + HOUR)).toBe(false);
    const sent = { ...row, lastSentAt: new Date(t + HOUR), sendCount: 1 };
    expect(sendDue(sent, [], t + HOUR + 23 * HOUR)).toBe(false);
    expect(sendDue(sent, [], t + HOUR + 24 * HOUR)).toBe(true);
    expect(sendDue({ ...sent, sendCount: MAX_SENDS_PER_EPISODE }, [], t + 1000 * HOUR)).toBe(false);
    expect(sendDue({ ...sent, nextAttemptAt: new Date(t + 500 * HOUR) }, [], t + 100 * HOUR)).toBe(false);
  });

  it('sends once, repeats after the interval, and stops when resolved; an event that comes back keeps the last send’s clock', async () => {
    const { w, tg } = await linkedWorld();
    const t0 = w.ctx.now();
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(w.ctx);
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(1);
    w.setNow(t0 + 25 * HOUR);
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(2);
    // Flapping: closed and back within the interval sends nothing new.
    await resolveNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(w.ctx);
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(2);
    w.setNow(t0 + 50 * HOUR);
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(3);
    await resolveNotification(w.ctx, AGENT_ID, 'agent_asleep');
    w.setNow(t0 + 200 * HOUR);
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(3);
    await w.close();
  });
});

describe('the notifier pass', () => {
  it('finds a low tank and an empty gas tank, tells the linked chat once, and clears when they are fixed', async () => {
    const { w, tg } = await linkedWorld(undefined, { chain: { usdc: 0n, spenderUsdc: 0n, deposit: 0n, eth: 0n } });
    let report = await notifierPass(w.ctx);
    expect(report).toMatchObject({ checked: 1, sent: 1, failed: 0 });
    expect(sends(tg)[0]!.body.text).toContain('Low on fuel');
    expect((await rows(w)).map((r) => r.event).sort()).toEqual(['fuel_low', 'gas_out']);

    // A pass inside the check interval reads nothing new, and gas sends only after its wait.
    expect(await notifierPass(w.ctx)).toEqual({ checked: 0, sent: 0, failed: 0 });
    w.setNow(w.ctx.now() + EVENT_RULES.gas_out.sendAfterMs);
    report = await notifierPass(w.ctx);
    expect(report).toMatchObject({ checked: 1, sent: 1 });
    expect(sends(tg)[1]!.body.text).toContain('Out of gas');

    w.state.usdc = 50_000_000n;
    w.state.deposit = 1_000_000_000_000_000n;
    w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
    report = await notifierPass(w.ctx);
    expect(report).toMatchObject({ checked: 1, sent: 0 });
    expect((await rows(w)).every((r) => r.resolvedAt !== null)).toBe(true);
    await w.close();
  });

  it('works without a bot token: the inbox fills and nothing fails', async () => {
    const w = await makeWorld({ chain: { usdc: 0n, spenderUsdc: 0n } });
    await seedAgent(w);
    w.ctx.telegram = null;
    expect(await notifierPass(w.ctx)).toEqual({ checked: 1, sent: 0, failed: 0 });
    const view = await notificationsView(w.ctx, { agentId: AGENT_ID, creator: CREATOR });
    expect(view.items.map((i) => i.event)).toContain('fuel_low');
    expect(view.telegram).toEqual({ available: false, linked: false, linkedAt: null });
    await w.close();
  });

  it('leaves an event alone when the sender cannot be reached, and raises it when the sender says revoked', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    await raiseNotification(w.ctx, AGENT_ID, 'x_revoked');
    const account = w.ctx.sender.account.bind(w.ctx.sender);
    w.ctx.sender.account = async () => {
      throw new Error('sender down');
    };
    await notifierPass(w.ctx);
    expect((await rows(w)).find((r) => r.event === 'x_revoked')!.resolvedAt).toBeNull();
    w.ctx.sender.account = account;
    w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
    await notifierPass(w.ctx);
    expect((await rows(w)).find((r) => r.event === 'x_revoked')!.resolvedAt).not.toBeNull();
    w.sender.accounts = { [AGENT_ID]: { agentId: AGENT_ID, connected: false, revoked: true, handle: null, xUserId: null } };
    w.setNow(w.ctx.now() + w.ctx.config.NOTIFY_CHECK_MS + 1);
    await notifierPass(w.ctx);
    expect((await rows(w)).find((r) => r.event === 'x_revoked' && !r.resolvedAt)).toBeDefined();
    await w.close();
  });

  it('checks a limited batch, oldest first, and goes on past an agent whose check throws', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    w.ctx.spenderFor = () => {
      throw new Error('boom');
    };
    await expect(notifierPass(w.ctx)).resolves.toMatchObject({ checked: 1 });
    expect((await w.db.select().from(notificationSettings))[0]!.checkedAt).not.toBeNull();
    await w.close();
  });
});

describe('a failed send never reaches the agent', () => {
  it('a tick does not talk to Telegram at all, and runs the same with Telegram down', async () => {
    const { w, tg } = await linkedWorld(
      () => {
        throw new Error('network down');
      },
      { script: [finishResponse(Date.parse('2026-10-25T12:00:00Z'))] },
    );
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    const report = await tick(w.ctx);
    expect(report.errors).toEqual([]);
    expect(report.ran).toEqual([AGENT_ID]);
    expect(tg.calls).toEqual([]);
    await w.close();
  });

  it('an outage ends the pass after one attempt, keeps the rows, and the next pass sends them', async () => {
    let down = true;
    const { w, tg } = await linkedWorld(() => {
      if (down) throw new Error('getaddrinfo ENOTFOUND api.telegram.org');
      return okResponse(true);
    });
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await raiseNotification(w.ctx, AGENT_ID, 'x_revoked');
    await expect(flushNotifications(w.ctx)).resolves.toEqual({ sent: 0, failed: 1 });
    expect(sends(tg)).toHaveLength(1);
    expect((await rows(w)).every((r) => r.lastSentAt === null)).toBe(true);
    down = false;
    await expect(flushNotifications(w.ctx)).resolves.toEqual({ sent: 2, failed: 0 });
    await w.close();
  });

  it('a hanging Telegram is cut off by the client’s timeout', async () => {
    const hang: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('timed out')));
      });
    const client = new TelegramClient(BOT_TOKEN, hang, () => 0, 20);
    await expect(client.sendMessage(CHAT, 'x')).resolves.toEqual({ ok: false, kind: 'unavailable', status: null });
  });

  it('a chat that blocked the bot loses its link; other refusals wait an hour', async () => {
    const blocked = await linkedWorld(() => errorResponse(403));
    await raiseNotification(blocked.w.ctx, AGENT_ID, 'agent_asleep');
    await raiseNotification(blocked.w.ctx, AGENT_ID, 'x_revoked');
    await flushNotifications(blocked.w.ctx);
    expect(sends(blocked.tg)).toHaveLength(1);
    expect(await blocked.w.db.select().from(telegramLinks)).toEqual([]);
    await blocked.w.close();

    const refused = await linkedWorld(() => errorResponse(400));
    await raiseNotification(refused.w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(refused.w.ctx);
    await flushNotifications(refused.w.ctx);
    expect(sends(refused.tg)).toHaveLength(1);
    refused.w.setNow(refused.w.ctx.now() + REJECTED_RETRY_MS + 1);
    await flushNotifications(refused.w.ctx);
    expect(sends(refused.tg)).toHaveLength(2);
    await refused.w.close();
  });

  it('respects a rate limit: nothing is tried until retry_after has passed', async () => {
    let limited = true;
    const { w, tg } = await linkedWorld(() => (limited ? errorResponse(429, { parameters: { retry_after: 30 } }) : okResponse(true)));
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(w.ctx);
    limited = false;
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(1);
    w.setNow(w.ctx.now() + 31_000);
    await expect(flushNotifications(w.ctx)).resolves.toEqual({ sent: 1, failed: 0 });
    await w.close();
  });

  it('the bot token appears in no failure the client returns', async () => {
    const client = new TelegramClient(BOT_TOKEN, async () => {
      throw new Error(`fetch failed for https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
    });
    expect(JSON.stringify(await client.sendMessage(CHAT, 'x'))).not.toContain('SECRET');
  });

  it('a logged send failure does not carry the token or the text', async () => {
    const lines: unknown[] = [];
    const { w } = await linkedWorld(() => errorResponse(500));
    w.ctx.log = { ...w.ctx.log, warn: (...args: unknown[]) => void lines.push(args) } as unknown as typeof w.ctx.log;
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await flushNotifications(w.ctx);
    expect(lines).toHaveLength(1);
    expect(JSON.stringify(lines)).not.toContain('SECRET');
    await w.close();
  });
});

describe('notification text', () => {
  it('is plain text with a link to the coin and no markup mode', async () => {
    const { w, tg } = await linkedWorld();
    await raiseNotification(w.ctx, AGENT_ID, 'review_waiting', { pending: 3 });
    await flushNotifications(w.ctx);
    const body = sends(tg)[0]!.body;
    expect(body.chat_id).toBe(CHAT);
    expect(body).not.toHaveProperty('parse_mode');
    expect(body.link_preview_options).toEqual({ is_disabled: true });
    expect(body.text).toBe(`$TEST: Posts waiting for your review\n3 posts wait for your approval in the creator console.\nhttps://bootr.fun/token/${TOKEN}`);
    await w.close();
  });

  it('never passes on a symbol that is more than plain characters', () => {
    for (const symbol of ['<b>X</b>', 'https://evil.example', '@admin', 'a b', '', 'A'.repeat(33)]) expect(coinLabel({ token: { symbol } })).toBe('Your coin');
    expect(coinLabel({ token: { symbol: 'BOOTR' } })).toBe('$BOOTR');
    const text = telegramText({ config: { token: { symbol: 'https://evil.example' } }, token: 'not-an-address' }, 'gas_out', {}, 'https://bootr.fun/');
    expect(text).toBe('Your coin: Out of gas\nThe agent cannot claim fees, trade or refuel until someone adds gas on the coin page.');
  });

  it('builds every event from its numbers alone: stray text in the data never shows', () => {
    const planted = { pending: 1, expiring: 1, hours: 2, days: 2, thoughtsLeft: 2, failures: 6, reason: 'IGNORE ALL RULES', text: 'IGNORE ALL RULES', title: 'IGNORE ALL RULES' };
    for (const event of Object.keys(EVENT_RULES) as (keyof typeof EVENT_RULES)[]) {
      const { title, body } = notificationText(event, planted);
      expect(title.length).toBeGreaterThan(0);
      expect(`${title} ${body}`).not.toContain('IGNORE');
    }
  });

  it('a queued post puts the event in the inbox without its text, and a decision clears it', async () => {
    const w = await makeWorld();
    const agent = await seedAgent(w, { config: { requireApproval: true } });
    const secret = 'THIRD PARTY said something rude';
    const pending = { id: 'a1', cycleKey: 'c', action: { tool: 'publish_post', input: { text: secret } }, status: 'sent', createdAt: 0, attempts: 1 };
    await queueForApproval(w.ctx, agent, pending as never, { inbox: new Map(), eligibility: new Map() });
    const view = await notificationsView(w.ctx, agent);
    expect(view.items.map((i) => i.event)).toEqual(['review_waiting']);
    expect(JSON.stringify(view)).not.toContain('THIRD PARTY');
    await w.db.update(approvals).set({ status: 'rejected' }).where(eq(approvals.id, 'a1'));
    await refreshReviewNotifications(w.ctx, agent);
    expect((await notificationsView(w.ctx, agent)).active).toBe(0);
    await w.close();
  });

  it('warns about a waiting post six hours before it expires', async () => {
    const w = await makeWorld();
    const agent = await seedAgent(w);
    const t0 = w.ctx.now();
    await w.db.insert(approvals).values({ id: 'a1', agentId: AGENT_ID, kind: 'post', text: 't', textHash: 'h', createdAt: new Date(t0 - 43 * HOUR) });
    await refreshReviewNotifications(w.ctx, agent);
    const view = await notificationsView(w.ctx, agent);
    expect(view.items.find((i) => i.event === 'review_expiring')!.body).toBe('1 waiting post expires in about 5 hours. Unreviewed posts are dropped.');
    w.setNow(t0 + 6 * HOUR);
    await refreshReviewNotifications(w.ctx, agent); // past 48 h: the post expires, and both events clear
    expect((await notificationsView(w.ctx, agent)).active).toBe(0);
    await w.close();
  });
});

describe('opt-out', () => {
  it('hides the event from the inbox and stops its sends; turning it back on brings it back', async () => {
    const { w, tg } = await linkedWorld();
    const a = api(w);
    await raiseNotification(w.ctx, AGENT_ID, 'agent_asleep');
    await raiseNotification(w.ctx, AGENT_ID, 'x_revoked');
    const res = await a.put(`/internal/agents/${AGENT_ID}/notifications/settings`, { by: CREATOR, optOut: ['agent_asleep'] });
    expect(res.status).toBe(200);
    const view = (await res.json()) as { items: { event: string }[]; active: number; events: { key: string; enabled: boolean }[] };
    expect(view.items.map((i) => i.event)).toEqual(['x_revoked']);
    expect(view.active).toBe(1);
    expect(view.events.find((e) => e.key === 'agent_asleep')!.enabled).toBe(false);
    await flushNotifications(w.ctx);
    expect(sends(tg).map((s) => s.body.text as string)).toEqual([expect.stringContaining('X connection lost')]);

    await a.put(`/internal/agents/${AGENT_ID}/notifications/settings`, { by: CREATOR, optOut: [] });
    await flushNotifications(w.ctx);
    expect(sends(tg)).toHaveLength(2);
    await w.close();
  });

  it('refuses someone else and an unknown event', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    const a = api(w);
    const path = `/internal/agents/${AGENT_ID}/notifications/settings`;
    expect((await a.put(path, { by: '0x4000000000000000000000000000000000000009', optOut: [] })).status).toBe(403);
    expect((await a.put(path, { by: 'nobody', optOut: [] })).status).toBe(400);
    expect((await a.put(path, { by: CREATOR, optOut: ['everything'] })).status).toBe(400);
    await w.close();
  });
});

describe('linking a chat', () => {
  async function linkWorld() {
    const w = await makeWorld();
    const agent = await seedAgent(w);
    const tg = telegramStub((call) => (call.method === 'getMe' ? okResponse({ username: 'bootr_alerts_bot' }) : okResponse(true)));
    w.ctx.telegram = new TelegramClient(BOT_TOKEN, tg.fetch, w.ctx.now);
    return { w, agent, tg };
  }
  const start = (token: string, chat: number | string = CHAT, type = 'private') => ({ update_id: 1, message: { chat: { id: chat, type }, text: `/start ${token}` } });

  it('gives the creator a one-time deep link and stores only its hash', async () => {
    const { w, agent, tg } = await linkWorld();
    const link = await createTelegramLink(w.ctx, agent, CREATOR);
    if (!link.ok) throw new Error('expected a link');
    const token = /^https:\/\/t\.me\/bootr_alerts_bot\?start=([\w-]{43})$/.exec(link.url)![1]!;
    const stored = await w.db.select().from(telegramLinkTokens);
    expect(stored).toHaveLength(1);
    expect(JSON.stringify(stored)).not.toContain(token);

    await handleTelegramUpdate(w.ctx, start(token));
    expect(await w.db.select().from(telegramLinks)).toMatchObject([{ creator: CREATOR.toLowerCase(), chatId: CHAT }]);
    expect(sends(tg).at(-1)!.body.text).toContain('Linked.');

    // Once only: a second chat with the same link gets nothing.
    await handleTelegramUpdate(w.ctx, start(token, '777'));
    expect(await w.db.select().from(telegramLinks)).toMatchObject([{ chatId: CHAT }]);
    expect(sends(tg).at(-1)!.body.text).toContain('expired or was already used');
    await w.close();
  });

  it('refuses an expired link, a made-up one and a group chat', async () => {
    const { w, agent, tg } = await linkWorld();
    const link = await createTelegramLink(w.ctx, agent, CREATOR);
    if (!link.ok) throw new Error('expected a link');
    const token = link.url.split('start=')[1]!;
    await handleTelegramUpdate(w.ctx, start(token, '-100', 'group'));
    expect(await w.db.select().from(telegramLinks)).toEqual([]);
    expect(sends(tg)).toEqual([]);
    await handleTelegramUpdate(w.ctx, start('short'));
    await handleTelegramUpdate(w.ctx, start('m'.repeat(43)));
    expect(await w.db.select().from(telegramLinks)).toEqual([]);
    w.setNow(w.ctx.now() + LINK_TOKEN_TTL_MS + 1);
    await handleTelegramUpdate(w.ctx, start(token));
    expect(await w.db.select().from(telegramLinks)).toEqual([]);
    await w.close();
  });

  it('never repeats what the sender wrote, and /stop unlinks', async () => {
    const { w, tg } = await linkWorld();
    await w.db.insert(telegramLinks).values({ creator: CREATOR.toLowerCase(), chatId: CHAT, linkedAt: new Date(w.ctx.now()) });
    await handleTelegramUpdate(w.ctx, { update_id: 2, message: { chat: { id: CHAT, type: 'private' }, text: 'hello <b>there</b>' } });
    expect(sends(tg)).toEqual([]);
    await handleTelegramUpdate(w.ctx, start('<script>alert(1)</script>'));
    expect(JSON.stringify(sends(tg))).not.toContain('script');
    await handleTelegramUpdate(w.ctx, { update_id: 3, message: { chat: { id: CHAT, type: 'private' }, text: '/stop' } });
    expect(await w.db.select().from(telegramLinks)).toEqual([]);
    await w.close();
  });

  it('polls with an advancing offset and survives a failed update', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    const tg = telegramStub((call) => (call.method === 'getUpdates' ? okResponse([{ update_id: 41, message: { chat: { id: CHAT, type: 'private' }, text: '/stop' } }]) : errorResponse(500)));
    w.ctx.telegram = new TelegramClient(BOT_TOKEN, tg.fetch, w.ctx.now);
    expect(await pollTelegramOnce(w.ctx, null, 0)).toEqual({ ok: true, offset: 42 });
    expect(tg.calls[0]!.body).toMatchObject({ timeout: 0, allowed_updates: ['message'] });
    await w.close();
  });

  it('the routes answer with a link, refuse a stranger, and say so without a bot', async () => {
    const { w } = await linkWorld();
    const a = api(w);
    const path = `/internal/agents/${AGENT_ID}/notifications/telegram`;
    expect((await a.post(path, { by: '0x4000000000000000000000000000000000000009', action: 'link' })).status).toBe(403);
    expect((await a.post(path, { by: CREATOR, action: 'nope' })).status).toBe(400);
    const linked = (await (await a.post(path, { by: CREATOR, action: 'link' })).json()) as { url: string; expiresAt: string };
    expect(linked.url).toContain('https://t.me/bootr_alerts_bot?start=');
    await w.db.insert(telegramLinks).values({ creator: CREATOR.toLowerCase(), chatId: CHAT, linkedAt: new Date(w.ctx.now()) });
    expect(((await (await a.get(`/internal/agents/${AGENT_ID}/notifications`)).json()) as { telegram: { linked: boolean } }).telegram.linked).toBe(true);
    expect((await a.post(path, { by: CREATOR, action: 'unlink' })).status).toBe(200);
    expect(await w.db.select().from(telegramLinks)).toEqual([]);

    w.ctx.telegram = null;
    const none = await a.post(path, { by: CREATOR, action: 'link' });
    expect(none.status).toBe(503);
    expect(await none.json()).toMatchObject({ error: 'telegram_unavailable' });
    await w.close();
  });

  it('a Telegram that cannot be reached answers telegram_unavailable when asking for a link', async () => {
    const w = await makeWorld();
    const agent = await seedAgent(w);
    w.ctx.telegram = new TelegramClient(BOT_TOKEN, async () => {
      throw new Error('down');
    });
    expect(await createTelegramLink(w.ctx, agent, CREATOR)).toMatchObject({ ok: false, status: 503, error: 'telegram_unavailable' });
    await w.close();
  });
});

describe('the inbox routes', () => {
  it('serve the view and the badge, and bring reviews up to date first', async () => {
    const w = await makeWorld();
    await seedAgent(w);
    const a = api(w);
    await w.db.insert(approvals).values({ id: 'a1', agentId: AGENT_ID, kind: 'post', text: 't', textHash: 'h', createdAt: new Date(w.ctx.now()) });
    const view = (await (await a.get(`/internal/agents/${AGENT_ID}/notifications`)).json()) as { active: number; items: { event: string; title: string; state: string }[] };
    expect(view.active).toBe(1);
    expect(view.items[0]).toMatchObject({ event: 'review_waiting', state: 'active' });
    expect(await (await a.get(`/internal/agents/${AGENT_ID}/notifications/count`)).json()).toEqual({ active: 1 });
    expect((await a.get('/internal/agents/nobody/notifications')).status).toBe(404);
    await w.close();
  });

  it('a notifier pass leaves the runtime row alone', async () => {
    const { w } = await linkedWorld(undefined, { chain: { usdc: 0n, spenderUsdc: 0n } });
    const read = async () => (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!;
    const before = await read();
    await notifierPass(w.ctx);
    expect(await read()).toEqual(before);
    await w.close();
  });
});
