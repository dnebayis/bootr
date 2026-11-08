/**
 * The dry run: the whole path of a picture, from the model's decision to the X media upload, with every outside
 * service stubbed at its HTTP boundary and answering in the shape it answers live:
 *   - the relay (OpenRouter chat completions through apps/inference): scripted thoughts and one image answer with
 *     `message.images[0].image_url.url` as a base64 data URL and `usage.completion_tokens_details.image_tokens`;
 *   - the sender: the real apps/sender app (its HMAC auth, publish route, policy gate and media upload code), on an
 *     in-memory database, reached through the supervisor's own SenderClient;
 *   - X: a fake api.x.com answering `POST /2/media/upload`, `POST /2/media/metadata` and `POST /2/tweets` as X does.
 * No money moves and nothing is posted: this is what a `--dry-run` of the live path looks like.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig } from '@bootr/agent-core';
import { agentActivity } from '../src/activity.js';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import { actions, images as imagesTable, runtimes } from '../src/db/schema.js';
import { SenderClient } from '../src/sender-client.js';
import { tick } from '../src/tick.js';
import { saveAccount } from '../../sender/src/accounts.js';
import { MEDIA_SCOPE } from '../../sender/src/oauth.js';
import { acceptPosts, AGENT_HANDLE, AGENT_X_ID, json, setup as senderSetup, SERVICE_KEY as SENDER_SERVICE_KEY, type FakeX } from '../../sender/test/helpers.js';
import { AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse, type TestWorld } from './helpers.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52, 1, 2, 3, 4, 5, 6, 7, 8]);
const DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;
const withImages = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };

/** The relay's answer to one picture, in OpenRouter's shape. */
function imageResponse(): Response {
  const body = {
    id: 'gen-img',
    model: 'google/gemini-3.1-flash-image',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Here is the picture.', images: [{ type: 'image_url', image_url: { url: DATA_URL } }] } }],
    usage: { prompt_tokens: 2210, completion_tokens: 1131, total_tokens: 3341, completion_tokens_details: { image_tokens: 1120 } },
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r-img', quoteMicroUsdc: '82000', chargedMicroUsdc: '76000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) },
  });
}

/** X's media endpoints as they answer live: the upload gives a media id, the alt text call answers 200. */
function acceptMedia(fake: FakeX) {
  const uploads: { form: FormData }[] = [];
  const metadata: unknown[] = [];
  fake.on('POST', '/2/media/upload', ({ body }) => {
    uploads.push({ form: body as FormData });
    return json({ data: { id: '1880028106020515840', media_key: '3_1880028106020515840', expires_after_secs: 86400 } }, 200);
  });
  fake.on('POST', '/2/media/metadata', ({ body }) => {
    metadata.push(body);
    return json({}, 200);
  });
  return { uploads, metadata };
}

/** The real sender app behind the supervisor's SenderClient: HMAC-signed calls go straight to the Hono app. */
async function wireSender(w: TestWorld, scopes: string) {
  const sender = await senderSetup();
  // The supervisor signs with the wall clock; the sender's clock and the account's token life must agree with it.
  sender.clock.t = new Date();
  await saveAccount(sender.ctx, AGENT_ID, { accessToken: 'access-token-secret', refreshToken: 'refresh-token-secret', expiresAt: new Date(Date.now() + 2 * 3_600_000), scopes }, { id: AGENT_X_ID, username: AGENT_HANDLE });
  acceptPosts(sender.fake, sender.clock);
  const x = acceptMedia(sender.fake);
  const fetchImpl: typeof fetch = (input, init) => Promise.resolve(sender.app.request(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url, init as RequestInit));
  (w.ctx as { sender: SenderClient }).sender = new SenderClient('http://sender.test', SENDER_SERVICE_KEY, fetchImpl);
  return { sender, x };
}

describe('dry run: a picture from the decision to the X media upload', () => {
  let w: TestWorld;
  let wired: Awaited<ReturnType<typeof wireSender>>;
  afterEach(async () => {
    await wired.sender.close();
    await w.close();
  });

  it('the model decides, the relay draws, the sender uploads the bytes with the alt text and posts with media_ids', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const script = [
      toolCallResponse('generate_image', { prompt: 'A small fox on a green hill at dusk, flat colours', altText: 'A fox on a green hill at dusk' }),
      imageResponse(),
      () => toolCallResponse('publish_post', { text: 'A fox on a hill, as promised.', imageId: imageIdOf(w) }),
      finishResponse(start + 3_600_000),
    ];
    w = await makeWorld({ script: script as never });
    wired = await wireSender(w, `tweet.read tweet.write users.read offline.access ${MEDIA_SCOPE}`);
    await seedAgent(w, { config: withImages });

    const res = await tick(w.ctx);
    expect(res.ran).toContain(AGENT_ID);
    expect(res.errors).toEqual([]);

    // the relay saw: a thought, the picture (its own key, max_tokens sized for the picture), a thought, a thought
    const relay = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
    expect(relay).toHaveLength(4);
    expect(relay[1]!.headers.get('idempotency-key')).toMatch(/^image:act_/);
    expect(relay[1]!.body).toMatchObject({ model: 'google/gemini-3.1-flash-image', modalities: ['image', 'text'], max_tokens: 1120 + 1024 });

    // the sender uploaded exactly the bytes the relay returned, set the alt text, and posted with the media id, in that
    // order (the turn's mention read is the other X call)
    const paths = wired.sender.fake.calls.map((c) => c.path).filter((p) => p.startsWith('/2/media') || p === '/2/tweets');
    expect(paths).toEqual(['/2/media/upload', '/2/media/metadata', '/2/tweets']);
    const form = wired.x.uploads[0]!.form;
    expect(form.get('media_category')).toBe('tweet_image');
    expect(form.get('media_type')).toBe('image/png');
    expect(Buffer.from(await (form.get('media') as Blob).arrayBuffer())).toEqual(PNG_BYTES);
    expect(wired.x.metadata).toEqual([{ id: '1880028106020515840', metadata: { alt_text: { text: 'A fox on a green hill at dusk' } } }]);
    const tweet = wired.sender.fake.calls.find((c) => c.path === '/2/tweets')!;
    expect(tweet.body).toEqual({ text: 'A fox on a hill, as promised.', media: { media_ids: ['1880028106020515840'] } });

    // the supervisor recorded the post with X's id, the picture row exists, and the tape shows both
    const acts = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
    const post = acts.find((a) => (a.action as { tool: string }).tool === 'publish_post')!;
    expect(post.status).toBe('completed');
    expect((post.result as { result: { postId: string } }).result.postId).toMatch(/^\d+$/);
    expect(await w.db.select().from(imagesTable)).toHaveLength(1);
    const runtime = (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!;
    expect(runtime.status).toBe('waiting');
    const agent = (await w.db.query.agents.findFirst())!;
    const tape = await agentActivity(w.ctx, agent, runtime);
    expect(tape.find((t) => t.kind === 'post')).toMatchObject({ summary: 'Posted on X', image: { alt: 'A fox on a green hill at dusk' } });
    expect(tape.find((t) => t.kind === 'image')).toMatchObject({ summary: 'Made an image: A fox on a green hill at dusk' });
  });

  it('an X account connected without the media.write scope: the sender refuses before X, nothing is recorded, and the model is told in plain words', async () => {
    w = await makeWorld();
    wired = await wireSender(w, 'tweet.read tweet.write users.read offline.access');
    const agent = await seedAgent(w, { config: withImages });
    const config = parseAgentConfig(agent.config);
    await w.db.insert(imagesTable).values({ id: 'img_ready', agentId: AGENT_ID, actionId: 'act_ready', alt: 'A fox on a hill', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: 'google/gemini-3.1-flash-image', createdAt: new Date(w.ctx.now()) });
    const env: BrokerEnv = { inbox: new Map(), eligibility: new Map(), cycle: 1 };
    const pending = { id: 'act_scope', cycleKey: 'cycle:x', action: { tool: 'publish_post', input: { text: 'A fox on a hill, as promised.', imageId: 'img_ready' } }, status: 'sent', createdAt: 0, attempts: 1 } as unknown as Parameters<typeof executeAction>[3];
    const out = await executeAction(w.ctx, agent, config, pending, env);
    expect(out).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_not_authorized: your X account was connected without permission to upload pictures; nothing was posted\. Publish your post without an imageId/) });
    expect((out as { error: string }).error).toMatch(/reconnect the account from the console/);
    // nothing reached X and the sender kept no receipt: the same text may go out again without the picture
    expect(wired.sender.fake.calls).toHaveLength(0);
    const receipt = await wired.sender.call('GET', '/internal/receipt/act_scope');
    expect(receipt.status).toBe(404);
    const plain = await executeAction(w.ctx, agent, config, { ...pending, id: 'act_scope2', action: { tool: 'publish_post', input: { text: 'A fox on a hill, as promised.' } } } as never, env);
    expect(plain.kind).toBe('completed');
    expect(wired.sender.fake.calls.map((c) => c.path)).toEqual(['/2/tweets']);
  });
});

/** The id of the picture the agent just made (the scripted post refers to it). */
function imageIdOf(w: TestWorld): string {
  const call = w.inference.calls.find((c) => (c.headers.get('idempotency-key') ?? '').startsWith('image:act_'));
  return `img_${(call?.headers.get('idempotency-key') ?? 'image:act_').slice('image:act_'.length)}`;
}
