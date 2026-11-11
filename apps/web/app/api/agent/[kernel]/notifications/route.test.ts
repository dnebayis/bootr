import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { mockStore } from '@/lib/mock';
import { REVIEW_STATEMENT } from '../approvals/review';
import { POST as chatList } from '../chat/list/route';
import { POST as chatSend } from '../chat/send/route';
import { POST as list } from './list/route';
import { GET as count } from './route';
import { POST as settings } from './settings/route';
import { POST as telegram } from './telegram/route';

const ORIGIN = 'http://localhost:3000';

/** One POST with the headers a same-site page sends. */
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200)}`, ...headers }, body: JSON.stringify(body) });
}

const params = (kernel: string) => ({ params: Promise.resolve({ kernel }) }) as never;
const call = (handler: (req: NextRequest, ctx: never) => Promise<Response>, kernel: string, path: string, body: unknown, headers?: Record<string, string>) => handler(request(`/api/agent/${kernel}/${path}`, body, headers), params(kernel));

describe('the console routes (mock mode)', () => {
  const kernel = mockStore().tokens[0]!.kernel;

  it('one signature statement opens the console, and the old review statement still counts', () => {
    const coin = '$BOOTR (#1153600, 0x1111111111111111111111111111111111111111).';
    expect(REVIEW_STATEMENT.exec(`Open the console of Bootr coin ${coin}`)?.slice(1)).toEqual(['BOOTR', '1153600', '0x1111111111111111111111111111111111111111']);
    expect(REVIEW_STATEMENT.exec(`Review the posts of Bootr coin ${coin}`)?.slice(1)).toEqual(['BOOTR', '1153600', '0x1111111111111111111111111111111111111111']);
    expect(REVIEW_STATEMENT.test(`Update the agent of Bootr coin ${coin}`)).toBe(false);
  });

  it('refuses another site on every private route', async () => {
    expect(env.useMock).toBe(true);
    const evil = { origin: 'https://evil.example' };
    expect((await call(list, kernel, 'notifications/list', {}, evil)).status).toBe(403);
    expect((await call(settings, kernel, 'notifications/settings', { optOut: [] }, evil)).status).toBe(403);
    expect((await call(telegram, kernel, 'notifications/telegram', { action: 'link' }, evil)).status).toBe(403);
    expect((await call(chatList, kernel, 'chat/list', {}, evil)).status).toBe(403);
    expect((await call(chatSend, kernel, 'chat/send', { text: 'hi' }, evil)).status).toBe(403);
  });

  it('the public badge is a count and nothing more', async () => {
    const res = await count(new NextRequest(`${ORIGIN}/api/agent/${kernel}/notifications`), params(kernel));
    expect(Object.keys((await res.json()) as object)).toEqual(['active']);
    expect((await count(new NextRequest(`${ORIGIN}/api/agent/nope/notifications`), params('nope'))).status).toBe(400);
  });

  it('serves the inbox, turns an event off and back on', async () => {
    const view = (await (await call(list, kernel, 'notifications/list', {})).json()) as { items: { event: string }[]; active: number; events: { key: string; enabled: boolean }[]; token: string };
    expect(view.token).toBeTruthy();
    expect(view.items.map((i) => i.event)).toContain('fuel_low');
    const off = (await (await call(settings, kernel, 'notifications/settings', { optOut: ['fuel_low'] })).json()) as typeof view;
    expect(off.items.map((i) => i.event)).not.toContain('fuel_low');
    expect(off.active).toBe(view.active - 1);
    expect(off.events.find((e) => e.key === 'fuel_low')!.enabled).toBe(false);
    const on = (await (await call(settings, kernel, 'notifications/settings', { optOut: [] })).json()) as typeof view;
    expect(on.active).toBe(view.active);
  });

  it('checks the settings and the Telegram action before anything else', async () => {
    expect((await call(settings, kernel, 'notifications/settings', { optOut: 'fuel_low' })).status).toBe(400);
    expect((await call(settings, kernel, 'notifications/settings', { optOut: ['<b>'] })).status).toBe(400);
    expect((await call(telegram, kernel, 'notifications/telegram', { action: 'hack' })).status).toBe(400);
  });

  it('makes a deep link and removes the chat', async () => {
    const linked = (await (await call(telegram, kernel, 'notifications/telegram', { action: 'link' })).json()) as { url: string };
    expect(linked.url).toMatch(/^https:\/\/t\.me\//);
    const removed = (await (await call(telegram, kernel, 'notifications/telegram', { action: 'unlink' })).json()) as { url: string | null };
    expect(removed.url).toBeNull();
  });

  it('chats: shows the cost, answers, and refuses an empty or a long message', async () => {
    const before = (await (await call(chatList, kernel, 'chat/list', {})).json()) as { messages: unknown[]; quote: { approxMicroUsdc: number; refusal: string | null } };
    expect(before.quote.approxMicroUsdc).toBeGreaterThan(0);
    expect(before.quote.refusal).toBeNull();
    expect((await call(chatSend, kernel, 'chat/send', { text: '  ' })).status).toBe(400);
    expect((await call(chatSend, kernel, 'chat/send', { text: 'x'.repeat(1001) })).status).toBe(400);
    const sent = (await (await call(chatSend, kernel, 'chat/send', { text: 'Please remember that we launch on Friday' })).json()) as { reply: { text: string; remembered: boolean } };
    expect(sent.reply.remembered).toBe(true);
    const asked = (await (await call(chatSend, kernel, 'chat/send', { text: 'Make a picture for your next post' })).json()) as { reply: { text: string; requested?: boolean } };
    expect(asked.reply).toMatchObject({ requested: true, text: 'I will do that in my next turn.' });
    const after = (await (await call(chatList, kernel, 'chat/list', {})).json()) as { messages: unknown[] };
    expect(after.messages).toHaveLength(before.messages.length + 4);
  });
});
