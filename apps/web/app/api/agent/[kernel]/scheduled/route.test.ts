import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';
import { env } from '@/lib/env';
import { mockStore } from '@/lib/mock';
import { sanitizeScheduled } from '@/lib/server/scheduled';
import { POST as cancel } from './cancel/route';
import { POST as list } from './list/route';

const ORIGIN = 'http://localhost:3000';

/** One POST with the headers a same-site page sends. */
function request(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', origin: ORIGIN, host: 'localhost:3000', 'x-forwarded-for': `203.0.113.${Math.floor(Math.random() * 200)}`, ...headers }, body: JSON.stringify(body) });
}

const params = (kernel: string) => ({ params: Promise.resolve({ kernel }) }) as never;
const call = (handler: (req: NextRequest, ctx: never) => Promise<Response>, kernel: string, path: string, body: unknown, headers?: Record<string, string>) => handler(request(`/api/agent/${kernel}/${path}`, body, headers), params(kernel));

describe('the scheduled posts routes of the console (mock mode)', () => {
  const kernel = mockStore().tokens[0]!.kernel;
  const id = 'sch_0123456789abcdef';

  it('refuses another site, like every private console route', async () => {
    expect(env.useMock).toBe(true);
    const evil = { origin: 'https://evil.example' };
    expect((await call(list, kernel, 'scheduled/list', {}, evil)).status).toBe(403);
    expect((await call(cancel, kernel, 'scheduled/cancel', { id }, evil)).status).toBe(403);
  });

  it('answers the list and a cancel inside a console session, with the session token', async () => {
    const listed = (await (await call(list, kernel, 'scheduled/list', {})).json()) as { items: unknown[]; mayQueue: number; token: string };
    expect(listed).toMatchObject({ items: [], mayQueue: 0 });
    expect(listed.token).toBeTruthy();
    const after = await call(cancel, kernel, 'scheduled/cancel', { id });
    expect(after.status).toBe(200);
    expect(Object.keys((await after.json()) as object).sort()).toEqual(['items', 'mayQueue', 'token']);
  });

  it('checks the id before anything else', async () => {
    for (const bad of [undefined, '', 'approval-1', 'sch_XYZ', `${id}0`, 42]) expect((await call(cancel, kernel, 'scheduled/cancel', { id: bad })).status, String(bad)).toBe(400);
    expect((await call(list, 'nope', 'scheduled/list', {})).status).toBe(400);
  });
});

describe('what the agent service says about the queue is cleaned before the console sees it', () => {
  it('keeps well-formed posts and drops everything else', () => {
    const good = { id: 'sch_0123456789abcdef', sendAt: '2026-11-14T10:00:00.000Z', status: 'waiting', text: 'A thought for ten.', parts: 2, picture: true, thread: ['Its second part.'] };
    const view = sanitizeScheduled({
      items: [
        good,
        { ...good, id: 'sch_bad' },
        { ...good, id: 'sch_1111111111111111', status: 'sent' },
        { ...good, id: 'sch_2222222222222222', sendAt: 'soon' },
        { ...good, id: 'sch_3333333333333333', text: 'x'.repeat(5000) },
        { ...good, id: 'sch_4444444444444444', status: 'waiting_review', parts: 'many', picture: 'yes', thread: [1, 'kept'], extra: '<script>' },
        null,
      ],
      mayQueue: 4,
      secret: 'not passed on',
    });
    expect(view).toEqual({
      items: [good, { id: 'sch_4444444444444444', sendAt: '2026-11-14T10:00:00.000Z', status: 'waiting_review', text: 'A thought for ten.', parts: 2, picture: false, thread: ['kept'] }],
      mayQueue: 4,
    });
    expect(sanitizeScheduled(null)).toEqual({ items: [], mayQueue: 0 });
    expect(sanitizeScheduled({ items: 'none', mayQueue: -1 })).toEqual({ items: [], mayQueue: 0 });
  });
});
