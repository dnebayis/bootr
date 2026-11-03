import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { PUBLISH_BODY_LIMIT, INTERNAL_BODY_LIMIT } from '../src/app.js';
import { accounts } from '../src/db/schema.js';
import { bodyHash, MAX_MEDIA_BYTES, publishSchema } from '../src/publish.js';
import { AGENT, acceptPosts, json, setup, type FakeX } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9, 9, 9]);
const media = { data: PNG.toString('base64'), mime: 'image/png', alt: 'A fox on a hill' };
const req = { agentId: AGENT, actionId: 'act-0001-image', text: 'A fox on a hill, as promised.', media };

/** X media endpoints: the upload answers with a media id, the metadata call with 200. */
function acceptMedia(fake: FakeX, opts: { uploadStatus?: number; metadataStatus?: number } = {}) {
  const uploads: { form: FormData; headers: Headers }[] = [];
  const metadata: unknown[] = [];
  fake.on('POST', '/2/media/upload', ({ body, headers }) => {
    uploads.push({ form: body as FormData, headers });
    if (opts.uploadStatus && opts.uploadStatus >= 400) return json({ title: 'nope' }, opts.uploadStatus);
    return json({ data: { id: '1880028106020515840', media_key: '3_1880028106020515840', expires_after_secs: 86400 } }, 200);
  });
  fake.on('POST', '/2/media/metadata', ({ body }) => {
    metadata.push(body);
    return json({}, opts.metadataStatus ?? 200);
  });
  return { uploads, metadata };
}

describe('publish with a picture', () => {
  let env: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    env = await setup();
  });
  afterEach(async () => env.close());

  it('uploads the image (v2 multipart), sets the alt text and posts with media_ids', async () => {
    acceptPosts(env.fake, env.clock);
    const x = acceptMedia(env.fake);
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(res.body.providerPostId).toMatch(/^\d+$/);

    expect(x.uploads).toHaveLength(1);
    const form = x.uploads[0]!.form;
    expect(form).toBeInstanceOf(FormData);
    expect(form.get('media_category')).toBe('tweet_image');
    expect(form.get('media_type')).toBe('image/png');
    const file = form.get('media') as Blob;
    expect(file.type).toBe('image/png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(PNG);
    expect(x.uploads[0]!.headers.get('authorization')).toBe('Bearer access-token-secret');
    expect(x.uploads[0]!.headers.get('content-type')).toBeNull(); // fetch sets the multipart boundary itself

    expect(x.metadata).toEqual([{ id: '1880028106020515840', metadata: { alt_text: { text: 'A fox on a hill' } } }]);
    const tweet = env.fake.calls.find((c) => c.path === '/2/tweets')!;
    expect(tweet.body).toEqual({ text: req.text, media: { media_ids: ['1880028106020515840'] } });
    // the X calls happen in order: upload, alt text, post
    expect(env.fake.calls.map((c) => c.path)).toEqual(['/2/media/upload', '/2/media/metadata', '/2/tweets']);
  });

  it('the picture is part of the body hash: same media replays, another media conflicts', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake);
    const first = await env.call('POST', '/internal/publish', req);
    const again = await env.call('POST', '/internal/publish', { ...req, media: { ...media } });
    expect(again.status).toBe(200);
    expect(again.body.duplicate).toBe(true);
    expect(again.body.receipt).toEqual(first.body.receipt);
    const other = await env.call('POST', '/internal/publish', { ...req, media: { ...media, alt: 'Another caption' } });
    expect(other.status).toBe(409);
    expect(other.body.error).toBe('action_id_conflict');
    expect(env.fake.count('POST', '/2/media/upload')).toBe(1);
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);

    const parsed = publishSchema.parse(req);
    expect(bodyHash(parsed)).not.toBe(bodyHash(publishSchema.parse({ ...req, media: undefined })));
    // the hash covers the bytes, not their base64 spelling
    expect(bodyHash(parsed)).toBe(bodyHash(publishSchema.parse({ ...req, media: { ...media, data: `${media.data}` } })));
  });

  it('needs the media.write scope: an account connected without it gets 409 and nothing is recorded', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake);
    await env.db
      .update(accounts)
      .set({ scopes: 'tweet.read tweet.write users.read offline.access' })
      .where(eq(accounts.agentId, AGENT));
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('media_not_authorized');
    expect(env.fake.calls).toHaveLength(0);
    const receipt = await env.call('GET', `/internal/receipt/${req.actionId}`);
    expect(receipt.status).toBe(404);
    // the same account still posts text
    const text = await env.call('POST', '/internal/publish', { ...req, media: undefined });
    expect(text.body.status).toBe('sent');
  });

  it('a failed upload rejects the action without posting (nothing was published; retry with a new actionId)', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake, { uploadStatus: 500 });
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('rejected');
    expect(res.body.receipt.error).toMatch(/^media_upload_failed: provider_unavailable\(500\)/);
    expect(env.fake.count('POST', '/2/tweets')).toBe(0);
    expect(env.fake.count('POST', '/2/media/metadata')).toBe(0);
    // final for this actionId
    const again = await env.call('POST', '/internal/publish', req);
    expect(again.body.status).toBe('rejected');
    expect(again.body.duplicate).toBe(true);
    expect(env.fake.count('POST', '/2/media/upload')).toBe(1);
  });

  it('posts even when the alt text call fails', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake, { metadataStatus: 400 });
    const res = await env.call('POST', '/internal/publish', req);
    expect(res.body.status).toBe('sent');
    expect(env.fake.count('POST', '/2/tweets')).toBe(1);
  });

  it('validates the picture: base64, type, size', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake);
    const bad = await env.call('POST', '/internal/publish', { ...req, media: { ...media, data: 'not base64!!' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_request');
    const gif = await env.call('POST', '/internal/publish', { ...req, media: { ...media, mime: 'image/gif' } });
    expect(gif.status).toBe(400);
    const big = await env.call('POST', '/internal/publish', {
      ...req,
      media: { ...media, data: Buffer.alloc(MAX_MEDIA_BYTES + 1, 1).toString('base64') },
    });
    expect(big.status).toBe(400);
    expect(big.body.error).toBe('invalid_media');
    expect(env.fake.calls).toHaveLength(0);
  });

  it('accepts a publish body of a few MB while other internal routes keep the small limit', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake);
    const bytes = Buffer.alloc(1024 * 1024, 7); // 1 MB image, ~1.4 MB of base64: over the 256 KB internal limit
    const res = await env.call('POST', '/internal/publish', { ...req, media: { ...media, data: bytes.toString('base64') } });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('sent');
    expect(INTERNAL_BODY_LIMIT).toBeLessThan(bytes.length);
    expect(PUBLISH_BODY_LIMIT).toBeGreaterThan(Math.ceil((MAX_MEDIA_BYTES * 4) / 3));
    const other = await env.call('POST', '/internal/read/thread', { agentId: AGENT, postId: '1', pad: 'x'.repeat(INTERNAL_BODY_LIMIT) });
    expect(other.status).toBe(413);
  });

  it('a reply carries the picture too', async () => {
    acceptPosts(env.fake, env.clock);
    acceptMedia(env.fake);
    env.fake.on('GET', '/2/tweets/777', () =>
      json({ data: { id: '777', text: '@bootr_agent show me', author_id: '42' }, includes: { users: [{ id: '42', username: 'alice' }] } }),
    );
    const res = await env.call('POST', '/internal/publish', {
      ...req,
      actionId: 'act-0002-image-reply',
      text: 'Here it is.',
      replyTo: '777',
      replyEligibility: { eligible: true },
    });
    expect(res.body.status).toBe('sent');
    const tweet = env.fake.calls.find((c) => c.path === '/2/tweets')!;
    expect(tweet.body).toEqual({ text: 'Here it is.', reply: { in_reply_to_tweet_id: '777' }, media: { media_ids: ['1880028106020515840'] } });
  });
});
