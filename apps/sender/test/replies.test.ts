import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { reads } from '../src/db/schema.js';
import { MAX_REPLY_PAGES } from '../src/replies.js';
import { AGENT, AGENT_X_ID, json, setup } from './helpers.js';

const JOB_POST = '7000';

const reply = (id: string, authorId: string, over: Record<string, unknown> = {}) => ({
  id,
  text: `entry ${id} 0x${'a'.repeat(40)}`,
  author_id: authorId,
  conversation_id: JOB_POST,
  created_at: '2026-10-24T13:00:00.000Z',
  referenced_tweets: [{ type: 'replied_to', id: JOB_POST }],
  ...over,
});

describe('POST /internal/read/replies', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  const read = (body: Record<string, unknown>) => env.call('POST', '/internal/read/replies', { agentId: AGENT, conversationId: JOB_POST, ...body });

  it('reads one conversation with recent search, expands authors and media, drops the job post and the agent\'s own replies, and meters every post returned', async () => {
    env.fake.on('GET', '/2/tweets/search/recent', ({ url }) => {
      expect(url.searchParams.get('query')).toBe(`conversation_id:${JOB_POST}`);
      expect(url.searchParams.get('expansions')).toBe('author_id,attachments.media_keys');
      expect(url.searchParams.get('user.fields')).toBe('username,created_at,verified,verified_type');
      expect(url.searchParams.get('media.fields')).toBe('media_key,type,url,preview_image_url');
      expect(url.searchParams.get('tweet.fields')).toContain('attachments');
      return json({
        data: [
          reply('7003', '31', { attachments: { media_keys: ['3_1'] } }),
          reply('7002', '32', { entities: { urls: [{ start: 0, end: 10, url: 'https://t.co/x', expanded_url: 'https://example.org/page' }] } }),
          reply('7001', AGENT_X_ID),
          { id: JOB_POST, text: 'Bounty: ...', author_id: AGENT_X_ID, conversation_id: JOB_POST },
        ],
        includes: {
          users: [
            { id: '31', username: 'maker', created_at: '2024-01-01T00:00:00.000Z', verified: false, verified_type: 'none' },
            { id: '32', username: 'linker', created_at: '2026-10-20T00:00:00.000Z', verified: true, verified_type: 'blue' },
          ],
          media: [{ media_key: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg' }],
        },
        meta: { result_count: 4 },
      });
    });
    const res = await read({});
    expect(res.status).toBe(200);
    expect(res.body.fetched).toBe(4);
    expect(res.body.truncated).toBe(false);
    expect(res.body.items).toEqual([
      {
        id: '7003',
        text: `entry 7003 0x${'a'.repeat(40)}`,
        authorId: '31',
        createdAt: '2026-10-24T13:00:00.000Z',
        conversationId: JOB_POST,
        inReplyToId: JOB_POST,
        author: { id: '31', username: 'maker', createdAt: '2024-01-01T00:00:00.000Z', verified: false, verifiedType: 'none' },
        urls: [],
        media: [{ mediaKey: '3_1', type: 'photo', url: 'https://pbs.twimg.com/media/abc.jpg', previewImageUrl: null }],
      },
      {
        id: '7002',
        text: `entry 7002 0x${'a'.repeat(40)}`,
        authorId: '32',
        createdAt: '2026-10-24T13:00:00.000Z',
        conversationId: JOB_POST,
        inReplyToId: JOB_POST,
        author: { id: '32', username: 'linker', createdAt: '2026-10-20T00:00:00.000Z', verified: true, verifiedType: 'blue' },
        urls: [{ url: 'https://t.co/x', expandedUrl: 'https://example.org/page' }],
        media: [],
      },
    ]);
    const [metered] = await env.db.select().from(reads).where(eq(reads.agentId, AGENT));
    expect(metered).toMatchObject({ kind: 'replies', count: 4 });
    expect(JSON.stringify(res.body)).not.toContain('access-token-secret');
  });

  it('follows next_token for at most three pages, stops at max, and says when it was cut', async () => {
    let page = 0;
    env.fake.on('GET', '/2/tweets/search/recent', ({ url }) => {
      page += 1;
      const token = url.searchParams.get('next_token');
      if (page > 1) expect(token).toBe(`t${page - 1}`);
      return json({ data: Array.from({ length: 10 }, (_, i) => reply(String(8000 + page * 10 + i), String(40 + page * 10 + i))), meta: { result_count: 10, next_token: `t${page}` } });
    });
    const res = await read({});
    expect(res.status).toBe(200);
    expect(page).toBe(MAX_REPLY_PAGES);
    expect(res.body.items).toHaveLength(30);
    expect(res.body.truncated).toBe(true);
    page = 0;
    const capped = await read({ max: 15 });
    expect(capped.body.items).toHaveLength(15);
    expect(capped.body.truncated).toBe(true);
    expect(page).toBe(2);
  });

  it('refuses when the day\'s read budget is spent, and passes X\'s refusal through on the first page', async () => {
    await env.db.insert(reads).values({ agentId: AGENT, kind: 'mentions', day: '2026-10-24', count: 400 });
    const spent = await read({});
    expect(spent.status).toBe(429);
    expect(spent.body.error).toBe('read_budget_exhausted');
    expect(env.fake.count('GET', '/2/tweets/search/recent')).toBe(0);
    await env.db.delete(reads).where(eq(reads.agentId, AGENT));
    env.fake.on('GET', '/2/tweets/search/recent', () => json({ title: 'Forbidden' }, 403));
    const refused = await read({});
    expect(refused.status).toBe(502);
    expect(refused.body.error).toBe('x_forbidden');
  });

  it('validates the body and needs a connected account', async () => {
    expect((await read({ conversationId: 'abc' })).status).toBe(400);
    expect((await env.call('POST', '/internal/read/replies', { agentId: 'nobody', conversationId: JOB_POST })).status).toBe(409);
  });
});
