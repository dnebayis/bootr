/**
 * Layer c in the owner's view (src/dataset/view.ts): the day's X reads with their cost, every listed account with its
 * status and the reason a suspended one is suspended, and the owner's "look again", which only marks the row.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createApp } from '../src/api.js';
import { dsSources } from '../src/db/schema.js';
import { runXAccounts } from '../src/dataset/layer-c.js';
import { syncSources } from '../src/dataset/store.js';
import type { DatasetDayView } from '../src/dataset/view.js';
import { pendingId, syncXSources } from '../src/dataset/x-pin.js';
import { signRequest } from '../src/hmac.js';
import { quietLog } from './dataset-helpers.js';
import { FakeSenderX } from './dataset-x-helpers.js';
import { SUPERVISOR_KEY, makeWorld, type TestWorld } from './helpers.js';

let world: TestWorld | null = null;
afterEach(async () => {
  await world?.close();
  world = null;
});

async function setup() {
  const w = (world = await makeWorld());
  const nowSec = () => Math.floor(w.ctx.now() / 1000);
  const app = createApp(w.ctx, nowSec);
  const now = new Date(w.ctx.now());
  const get = async (path: string) => (await app.request(path, { headers: { authorization: signRequest(SUPERVISOR_KEY, 'GET', path, '', nowSec()) } })).json() as Promise<DatasetDayView>;
  const post = (path: string, body: unknown, key = SUPERVISOR_KEY) => {
    const raw = JSON.stringify(body);
    return app.request(path, { method: 'POST', body: raw, headers: { 'content-type': 'application/json', authorization: signRequest(key, 'POST', path, raw, nowSec()) } });
  };
  await syncSources(w.ctx.db, now);
  await syncXSources(w.ctx.db, now);
  return { app, get, post, db: w.ctx.db, now };
}

describe('layer c in the owner’s view', () => {
  it('lists the 41 accounts as pending and has no day note while the layer is off', async () => {
    const { get, db, now } = await setup();
    await runXAccounts({ db, log: quietLog, x: null, cap: 0 }, now);
    const view = await get('/internal/dataset/day');
    expect(view.x.day).toBeNull();
    expect(view.x.accounts).toHaveLength(41);
    expect(view.x.accounts.every((a) => a.status === 'pending' && a.tier === 1)).toBe(true);
  });

  it("shows the day's reads with their cost, and a suspended account with its reason", async () => {
    const { get, db, now } = await setup();
    const x = new FakeSenderX(250, () => now);
    x.users.set('base', { id: '666', username: 'base', followers: 7, protected: false });
    await runXAccounts({ db, log: quietLog, x, cap: 250 }, now);
    const view = await get('/internal/dataset/day');
    expect(view.x.day).toMatchObject({ limit: 250, units: 16, userReads: 8, usd: 0.08, worstUsd: 1.25 });
    const base = view.x.accounts.find((a) => a.listedAs === 'base')!;
    expect(base.status).toBe('suspended');
    expect(base.statusReason).toMatch(/^7 followers/);
    expect(view.x.accounts.filter((a) => a.status === 'active')).toHaveLength(7);
  });

  it('marks a suspended account for another look and nothing else', async () => {
    const { post, db, now } = await setup();
    const x = new FakeSenderX(250, () => now);
    x.users.set('base', { id: '666', username: 'base', followers: 7, protected: false });
    await runXAccounts({ db, log: quietLog, x, cap: 250 }, now);
    const before = x.calls.length;
    expect((await post('/internal/dataset/x/review', { id: pendingId('base') })).status).toBe(200);
    expect((await db.query.dsSources.findFirst({ where: eq(dsSources.id, pendingId('base')) }))?.status).toBe('review');
    expect(x.calls.length).toBe(before);
    expect((await post('/internal/dataset/x/review', { id: pendingId('base') })).status).toBe(404);
    expect((await post('/internal/dataset/x/review', { id: 'b:base-blog' })).status).toBe(400);
    expect((await post('/internal/dataset/x/review', { id: pendingId('ethereum') }, 'another-key-of-thirty-two-characters-xx')).status).toBe(401);
  });
});
