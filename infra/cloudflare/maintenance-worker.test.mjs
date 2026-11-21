// node --test infra/cloudflare/maintenance-worker.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker, { originDown, PAGE } from './maintenance-worker.js';

const page = (url = 'https://bootr.fun/') => new Request(url, { headers: { accept: 'text/html,application/xhtml+xml' } });
const api = (url = 'https://bootr.fun/api/platform') => new Request(url, { headers: { accept: 'application/json' } });
const origin = (status, body = 'origin') => async () => new Response(body, { status });

test('an origin that is up passes through untouched, errors of the app included', async () => {
  for (const status of [200, 404, 500]) {
    globalThis.fetch = origin(status, `body ${status}`);
    const res = await worker.fetch(page());
    assert.equal(res.status, status);
    assert.equal(await res.text(), `body ${status}`);
  }
  globalThis.fetch = async () => new Response(null, { status: 304 });
  assert.equal((await worker.fetch(page())).status, 304);
});

test("a page load while the origin is down gets Bootr's updating page, which reloads itself", async () => {
  for (const status of [502, 503, 504, 520, 522, 524]) {
    globalThis.fetch = origin(status, 'Are you the site owner?');
    const res = await worker.fetch(page('https://bootr.fun/token/0xb1c3'));
    assert.equal(res.status, 503);
    assert.equal(res.headers.get('retry-after'), '15');
    assert.equal(res.headers.get('cache-control'), 'no-store');
    const html = await res.text();
    assert.equal(html, PAGE);
    assert.match(html, /bootr is updating/);
    assert.match(html, /http-equiv="refresh"/);
  }
});

test('the API keeps the origin answer while it is down, and gets a JSON 503 when there is none', async () => {
  globalThis.fetch = origin(503, 'upstream');
  const res = await worker.fetch(api());
  assert.equal(res.status, 503);
  assert.equal(await res.text(), 'upstream');

  globalThis.fetch = async () => { throw new Error('connection refused'); };
  const none = await worker.fetch(api());
  assert.equal(none.status, 503);
  assert.deepEqual(await none.json(), { error: 'updating', retryAfter: 15 });
  const pageNone = await worker.fetch(page());
  assert.match(await pageNone.text(), /bootr is updating/);
});

test('a POST is never answered with the page', async () => {
  globalThis.fetch = origin(503, 'upstream');
  const res = await worker.fetch(new Request('https://bootr.fun/api/agent/launch', { method: 'POST', headers: { accept: 'text/html' }, body: '{}' }));
  assert.equal(await res.text(), 'upstream');
});

test('which answers mean the origin is down', () => {
  assert.deepEqual([500, 501, 502, 503, 504, 505, 520, 527, 530].map(originDown), [false, false, true, true, true, false, true, true, false]);
});
