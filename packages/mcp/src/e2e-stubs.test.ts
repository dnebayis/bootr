import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
// @ts-expect-error -- a plain script of the end-to-end run, with no types of its own
import { DEFAULT_ACCOUNT, startStubX, STRANGER } from '../test/stub-x.mjs';

/**
 * The stand-in for X that the end-to-end script runs the sender against (`test/stub-x.mjs`), asked the way
 * `apps/sender/src/x-client.ts` asks X, and the script's own refusal to touch anything that is not local.
 */
type Stub = { url: string; close(): Promise<void> };
let stub: Stub;
const auth = { authorization: 'Bearer any-token' };
type Loose = { data: Record<string, unknown> & { id: string } } & Record<string, unknown>;
const get = async <T = Loose>(p: string) => (await (await fetch(`${stub.url}${p}`, { headers: auth })).json()) as T;
const post = async (p: string, body: unknown) => {
  const res = await fetch(`${stub.url}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as Loose & { id: string; text: string } };
};

beforeAll(async () => {
  stub = (await startStubX()) as Stub;
});
afterAll(() => stub.close());

describe('the X stand-in', () => {
  it('is the agent’s account, and serves a mention a reply is eligible for', async () => {
    expect((await get('/2/users/me')).data).toMatchObject(DEFAULT_ACCOUNT);
    const made = (await post('/__stub/mention', { text: 'what does this coin do?' })).json;
    expect(made.text).toBe(`@${DEFAULT_ACCOUNT.username} what does this coin do?`);
    const list = await get<{ data: Record<string, unknown>[]; includes: { users: Record<string, unknown>[] }; meta: { newest_id: string; result_count: number } }>(`/2/users/${DEFAULT_ACCOUNT.id}/mentions?max_results=100`);
    expect(list.meta).toMatchObject({ result_count: 1, newest_id: made.id });
    // Addressed to the agent at the start of the text, by a verified account: what the reply rules ask for.
    expect(list.data[0]).toMatchObject({ id: made.id, author_id: STRANGER.id, in_reply_to_user_id: DEFAULT_ACCOUNT.id, entities: { mentions: [{ start: 0, username: DEFAULT_ACCOUNT.username, id: DEFAULT_ACCOUNT.id }] } });
    expect(list.includes.users[0]).toMatchObject({ id: STRANGER.id, verified: true, verified_type: 'blue' });
    expect(made.id).toMatch(/^[1-9][0-9]{0,18}$/);
    // Nothing newer than what was read.
    expect((await get<{ meta: { result_count: number } }>(`/2/users/${DEFAULT_ACCOUNT.id}/mentions?since_id=${made.id}`)).meta.result_count).toBe(0);
    expect((await get(`/2/tweets/${made.id}`)).data).toMatchObject({ id: made.id });
  });

  it('records a reply, a picture with its alt text and a post, and says what it received', async () => {
    const mention = (await post('/__stub/mention', { text: 'gm' })).json;
    const reply = await post('/2/tweets', { text: 'gm to you', reply: { in_reply_to_tweet_id: mention.id } });
    expect(reply.status).toBe(201);
    const form = new FormData();
    const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    form.set('media', new Blob([bytes], { type: 'image/png' }), 'image');
    form.set('media_category', 'tweet_image');
    form.set('media_type', 'image/png');
    const uploaded = (await (await fetch(`${stub.url}/2/media/upload`, { method: 'POST', headers: auth, body: form })).json()) as { data: { id: string } };
    expect(uploaded.data.id).toMatch(/^\d+$/);
    expect((await post('/2/media/metadata', { id: uploaded.data.id, metadata: { alt_text: { text: 'A dot' } } })).status).toBe(200);
    const posted = await post('/2/tweets', { text: 'a post', media: { media_ids: [uploaded.data.id] } });
    const received = await get<{ posts: Record<string, unknown>[]; media: Record<string, unknown>[]; metadata: unknown[]; requests: { path: string; hasBearer: boolean }[] }>('/__stub/received');
    expect(received.posts).toHaveLength(2);
    expect(received.posts[0]).toMatchObject({ id: posted.json.data.id, text: 'a post', media_ids: [uploaded.data.id] });
    expect(received.posts[1]).toMatchObject({ text: 'gm to you', in_reply_to_tweet_id: mention.id, conversation_id: mention.id });
    expect(received.media).toEqual([expect.objectContaining({ id: uploaded.data.id, mime: 'image/png', bytes: bytes.length, firstBytesHex: bytes.subarray(0, 12).toString('hex') })]);
    expect(received.metadata).toEqual([{ id: uploaded.data.id, altText: 'A dot' }]);
    expect(received.requests.every((r) => r.hasBearer)).toBe(true);
    // The replies of the mention's conversation, as a bounty job's entries are collected.
    const replies = await get<{ data: { text: string }[] }>(`/2/tweets/search/recent?query=${encodeURIComponent(`conversation_id:${mention.id}`)}`);
    expect(replies.data.map((r) => r.text)).toEqual(['gm to you']);
    expect((await post('/2/tweets', {})).status).toBe(400);
    expect((await fetch(`${stub.url}/2/unknown`, { headers: auth })).status).toBe(404);
    expect((await post('/__stub/reset', {})).status).toBe(200);
    expect((await get<{ posts: unknown[] }>('/__stub/received')).posts).toEqual([]);
  });
});

describe('the end-to-end script', () => {
  const script = path.resolve(import.meta.dirname, '../test/own-agent-e2e.mjs');
  const run = (env: Record<string, string>) => promisify(execFile)(process.execPath, [script], { env: { PATH: process.env.PATH ?? '', ...env } }).then(
    () => ({ code: 0, stderr: '' }),
    (e: { code: number; stderr: string }) => e,
  );

  it('refuses a site, a chain, a stand-in or a database that is not local, before it sends anything', async () => {
    const localEnv = { SITE: 'http://127.0.0.1:9', RPC: 'http://127.0.0.1:9', STUB: 'http://127.0.0.1:9' };
    for (const [bad, words] of [
      [{ SITE: 'https://bootr.fun' }, 'SITE must be a local web app'],
      [{ RPC: 'https://mainnet.base.org' }, 'RPC must be a local anvil fork'],
      [{ STUB: 'https://api.x.com' }, 'STUB must be the local stand-in for X'],
      [{ DATABASE_URL: 'postgres://user@db.example.com:5432/bootr' }, 'DATABASE_URL must be a local database'],
      [{ SUPERVISOR_URL: 'https://supervisor.example.com' }, 'SUPERVISOR_URL must be the local supervisor'],
    ] as const) {
      const out = await run({ ...localEnv, ...bad });
      expect(out.code, words).not.toBe(0);
      expect(out.stderr, words).toContain(words);
    }
  });
});
