import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { parseAgentConfig } from '@bootr/agent-core';
import { agentActivity } from '../src/activity.js';
import { availableTools, executeAction, type BrokerEnv } from '../src/broker/index.js';
import { actions, images as imagesTable, inference as inferenceTable, runtimes } from '../src/db/schema.js';
import { DEFAULT_IMAGE_MODEL, MAX_IMAGES_PER_DAY, imageRequest, imageStyleOf, parseImageResponse } from '../src/images.js';
import { tick } from '../src/tick.js';
import { agentConfig, AGENT_ID, finishResponse, makeWorld, seedAgent, toolCallResponse } from './helpers.js';

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const DATA_URL = `data:image/png;base64,${PNG_BYTES.toString('base64')}`;

function imageResponse(url: string | null = DATA_URL, content = 'Here you go.'): Response {
  const message = { role: 'assistant', content, ...(url ? { images: [{ type: 'image_url', image_url: { url } }] } : {}) };
  return new Response(JSON.stringify({ id: 'img', choices: [{ message, finish_reason: 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 1300, completion_tokens_details: { image_tokens: 1290 } } }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-bootr-receipt': JSON.stringify({ requestId: 'r-img', quoteMicroUsdc: '43000', chargedMicroUsdc: '43000', paymentTxOrId: '0xtx', network: 'eip155:84532', usage: null }) },
  });
}

const withImages = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };
const env = (): BrokerEnv => ({ inbox: new Map(), eligibility: new Map(), cycle: 3 });
const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, cycleKey: 'cycle:x', action: { tool, input }, status: 'sent', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof executeAction>[3];

describe('generate_image', () => {
  it('is offered to the model only with the images power', async () => {
    const w = await makeWorld();
    try {
      const off = availableTools(w.ctx, parseAgentConfig(agentConfig(w.ctx.now())));
      expect(off.map((t) => t.name)).not.toContain('generate_image');
      const on = availableTools(w.ctx, parseAgentConfig(agentConfig(w.ctx.now(), withImages)));
      expect(on.map((t) => t.name)).toContain('generate_image');
    } finally {
      await w.close();
    }
  });

  it('builds a one-image relay request and reads the base64 picture back', () => {
    const req = imageRequest(DEFAULT_IMAGE_MODEL, { prompt: 'a fox on a hill', altText: 'A fox sitting on a green hill at dusk' });
    expect(req).toMatchObject({ model: 'google/gemini-3-pro-image', modalities: ['image', 'text'], max_tokens: 256, stream: false });
    expect(JSON.stringify(req.messages)).toContain('a fox on a hill');
    expect(JSON.stringify(req.messages)).toContain('A fox sitting on a green hill at dusk');
    // without a style: plain text, no picture attached, no reference talk
    const plain = req.messages as { role: string; content: unknown }[];
    expect(typeof plain[1]!.content).toBe('string');
    expect(String(plain[0]!.content)).not.toContain('reference');

    const ok = parseImageResponse({ choices: [{ message: { images: [{ image_url: { url: DATA_URL } }] } }] });
    expect(ok).toEqual({ ok: true, mime: 'image/png', bytes: PNG_BYTES });
    expect(parseImageResponse({ choices: [{ message: { content: 'I cannot draw that.' } }] })).toEqual({ ok: false, error: 'image_not_generated: I cannot draw that.' });
    expect(parseImageResponse({ choices: [{ message: { images: [{ image_url: { url: 'https://example.com/x.png' } }] } }] })).toMatchObject({ ok: false, error: expect.stringMatching(/^image_unreadable/) });
    expect(parseImageResponse({ choices: [{ message: { images: [{ image_url: { url: 'data:image/gif;base64,AAAA' } }] } }] })).toMatchObject({ ok: false, error: expect.stringMatching(/unsupported type/) });
  });

  it('attaches the style reference as an image_url part and the notes to the instructions', () => {
    const style = { reference: 'https://cdn.bootr.fun/coins/fox.png', notes: 'flat colours, no text' };
    const req = imageRequest(DEFAULT_IMAGE_MODEL, { prompt: 'a fox on a hill', altText: 'A fox on a hill' }, style);
    const [system, user] = req.messages as [{ role: string; content: string }, { role: string; content: { type: string; text?: string; image_url?: { url: string } }[] }];
    expect(system.content).toContain('Match its visual style, palette');
    expect(system.content).toContain('Do not copy');
    expect(system.content).toContain('Style notes from the creator: flat colours, no text');
    expect(user.content).toEqual([
      { type: 'text', text: 'a fox on a hill\n\nThe image will be described as: A fox on a hill' },
      { type: 'image_url', image_url: { url: 'https://cdn.bootr.fun/coins/fox.png' } },
    ]);
    // notes alone: no picture, the notes still reach the model
    const notesOnly = imageRequest(DEFAULT_IMAGE_MODEL, { prompt: 'x', altText: 'y' }, { reference: null, notes: 'ink on paper' });
    expect(typeof (notesOnly.messages as { content: unknown }[])[1]!.content).toBe('string');
    expect(String((notesOnly.messages as { content: unknown }[])[0]!.content)).toContain('ink on paper');
    expect(String((notesOnly.messages as { content: unknown }[])[0]!.content)).not.toContain('reference picture');

    expect(imageStyleOf({})).toEqual({ reference: null, notes: '' });
    expect(imageStyleOf({ imageStyle: { reference: 'ftp://nope', notes: 'x' } })).toEqual({ reference: null, notes: '' });
    expect(imageStyleOf({ imageStyle: style })).toEqual(style);
  });

  it('pays the relay once per action (like a thought), stores the bytes and returns an imageId', async () => {
    const w = await makeWorld({ script: [imageResponse()] });
    try {
      const agent = await seedAgent(w, { config: { ...withImages, imageStyle: { reference: 'https://cdn.bootr.fun/coins/test.png', notes: '' } } });
      const config = parseAgentConfig(agent.config);
      const input = { prompt: 'a fox on a hill', altText: 'A fox on a hill' };
      const first = await executeAction(w.ctx, agent, config, pending('act_img1', 'generate_image', input), env());
      expect(first).toMatchObject({ kind: 'completed', result: { imageId: 'img_img1', alt: 'A fox on a hill', mime: 'image/png', bytes: PNG_BYTES.length } });

      const posts = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'));
      expect(posts).toHaveLength(1);
      expect(posts[0]!.headers.get('idempotency-key')).toBe('image:act_img1');
      expect(posts[0]!.headers.get('x-max-quote-micro-usdc')).toBe('250000');
      expect(posts[0]!.body).toMatchObject({ model: DEFAULT_IMAGE_MODEL, modalities: ['image', 'text'] });
      // the coin picture rides along as the style reference
      expect((posts[0]!.body as { messages: { content: unknown }[] }).messages[1]!.content).toEqual([{ type: 'text', text: expect.stringContaining('a fox on a hill') }, { type: 'image_url', image_url: { url: 'https://cdn.bootr.fun/coins/test.png' } }]);

      const rows = await w.db.select().from(imagesTable);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'img_img1', agentId: AGENT_ID, actionId: 'act_img1', alt: 'A fox on a hill', mime: 'image/png', sizeBytes: PNG_BYTES.length, model: DEFAULT_IMAGE_MODEL });
      expect(Buffer.from(rows[0]!.bytes)).toEqual(PNG_BYTES);
      const paid = await w.db.select().from(inferenceTable).where(eq(inferenceTable.idempotencyKey, 'image:act_img1'));
      expect(paid[0]).toMatchObject({ status: 'succeeded', agentId: AGENT_ID, cycle: 3 });

      // the same action again (a resumed step after a crash): served from the store, no second relay call
      const again = await executeAction(w.ctx, agent, config, pending('act_img1', 'generate_image', input), env());
      expect(again).toMatchObject({ kind: 'completed', result: { imageId: 'img_img1' } });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(1);
    } finally {
      await w.close();
    }
  });

  it('fails without storing anything when the model returns no picture, and holds an unknown relay outcome', async () => {
    const unknown = new Response(JSON.stringify({ error: { code: 'request_outcome_unknown' } }), { status: 409, headers: { 'content-type': 'application/json' } });
    const w = await makeWorld({ script: [imageResponse(null, 'I will not draw that.'), unknown] });
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      const none = await executeAction(w.ctx, agent, config, pending('act_img2', 'generate_image', { prompt: 'x', altText: 'y' }), env());
      expect(none).toEqual({ kind: 'failed', error: 'image_not_generated: I will not draw that.' });
      expect(await w.db.select().from(imagesTable)).toHaveLength(0);

      const held = await executeAction(w.ctx, agent, config, pending('act_img3', 'generate_image', { prompt: 'x', altText: 'y' }), env());
      expect(held.kind).toBe('unknown');
      const row = await w.db.select().from(inferenceTable).where(eq(inferenceTable.idempotencyKey, 'image:act_img3'));
      expect(row[0]!.status).toBe('unknown');
    } finally {
      await w.close();
    }
  });

  it('caps images per rolling day', async () => {
    const w = await makeWorld({ script: [imageResponse()] });
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      const now = w.ctx.now();
      for (let i = 0; i < MAX_IMAGES_PER_DAY; i++) {
        await w.db.insert(imagesTable).values({ id: `img_old${i}`, agentId: AGENT_ID, actionId: `act_old${i}`, alt: 'old', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_IMAGE_MODEL, createdAt: new Date(now - (i + 1) * 3_600_000) });
      }
      const capped = await executeAction(w.ctx, agent, config, pending('act_img4', 'generate_image', { prompt: 'x', altText: 'y' }), env());
      expect(capped).toEqual({ kind: 'failed', error: `image_daily_cap: at most ${MAX_IMAGES_PER_DAY} images per 24 hours` });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);

      // a day later the oldest one left the window
      w.setNow(now + 25 * 3_600_000);
      const ok = await executeAction(w.ctx, agent, config, pending('act_img4', 'generate_image', { prompt: 'x', altText: 'y' }), env());
      expect(ok.kind).toBe('completed');
    } finally {
      await w.close();
    }
  });

  it('attaches the agent\'s own image to a post or reply as base64 media, and refuses unknown ids', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      await w.db.insert(imagesTable).values({ id: 'img_mine', agentId: AGENT_ID, actionId: 'act_mine', alt: 'A fox', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_IMAGE_MODEL, createdAt: new Date(w.ctx.now()) });
      await w.db.insert(imagesTable).values({ id: 'img_theirs', agentId: '99', actionId: 'act_theirs', alt: 'Not mine', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_IMAGE_MODEL, createdAt: new Date(w.ctx.now()) });

      const posted = await executeAction(w.ctx, agent, config, pending('act_post1', 'publish_post', { text: 'A fox for you all.', imageId: 'img_mine' }), env());
      expect(posted.kind).toBe('completed');
      expect(w.sender.published[0]).toMatchObject({ actionId: 'act_post1', text: 'A fox for you all.', media: { data: PNG_BYTES.toString('base64'), mime: 'image/png', alt: 'A fox' } });

      const missing = await executeAction(w.ctx, agent, config, pending('act_post2', 'publish_post', { text: 'Nothing here.', imageId: 'img_nope' }), env());
      expect(missing).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_not_found: img_nope/) });
      const theirs = await executeAction(w.ctx, agent, config, pending('act_post3', 'publish_post', { text: 'Nothing here.', imageId: 'img_theirs' }), env());
      expect(theirs).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_not_found/) });
      expect(w.sender.published).toHaveLength(1);

      const plain = await executeAction(w.ctx, agent, config, pending('act_post4', 'publish_post', { text: 'No picture.' }), env());
      expect(plain.kind).toBe('completed');
      expect((w.sender.published[1] as { media?: unknown }).media).toBeUndefined();
    } finally {
      await w.close();
    }
  });

  it('runs end to end in a turn: make an image, post it, and show it on the activity tape', async () => {
    const start = Date.parse('2026-10-24T12:00:00Z');
    const script = [
      toolCallResponse('generate_image', { prompt: 'a fox on a hill', altText: 'A fox on a hill' }),
      imageResponse(),
      () => toolCallResponse('publish_post', { text: 'A fox on a hill, as promised.', imageId: 'img_' + lastImageActionId(w) }),
      finishResponse(start + 3_600_000),
    ];
    const w = await makeWorld({ script: script as never });
    try {
      await seedAgent(w, { config: withImages });
      const res = await tick(w.ctx);
      expect(res.ran).toContain(AGENT_ID);
      const runtime = (await w.db.select().from(runtimes).where(eq(runtimes.agentId, AGENT_ID)))[0]!;
      expect(runtime.status).toBe('waiting');
      const acts = await w.db.select().from(actions).where(eq(actions.agentId, AGENT_ID));
      expect(acts.map((a) => (a.action as { tool: string }).tool).sort()).toEqual(['finish', 'generate_image', 'publish_post']);
      expect(acts.every((a) => a.status === 'completed')).toBe(true);
      const image = acts.find((a) => (a.action as { tool: string }).tool === 'generate_image')!;
      expect(image.result).toMatchObject({ status: 'completed', result: { imageId: `img_${image.actionId.replace(/^act_/, '')}`, alt: 'A fox on a hill' } });
      // the relay saw one thought, one image, one thought, one thought: the image is keyed by its action, not the cycle
      const keys = w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions')).map((c) => c.headers.get('idempotency-key'));
      expect(keys).toHaveLength(4);
      expect(keys[1]).toBe(`image:${image.actionId}`);
      // the sender got the picture with the post
      expect(w.sender.published).toHaveLength(1);
      expect(w.sender.published[0]).toMatchObject({ text: 'A fox on a hill, as promised.', media: { mime: 'image/png', alt: 'A fox on a hill', data: PNG_BYTES.toString('base64') } });
      // the tape
      const agent = (await w.db.query.agents.findFirst())!;
      const tape = await agentActivity(w.ctx, agent, runtime);
      expect(tape.map((t) => t.summary)).toContain('Made an image: A fox on a hill');
      expect(tape.find((t) => t.kind === 'image')).toBeTruthy();
      expect(tape.map((t) => t.summary)).toContain('Posted on X');
    } finally {
      await w.close();
    }
  });
});

/** The action id of the image the agent just made (the test's scripted post refers to it by imageId). */
function lastImageActionId(w: Awaited<ReturnType<typeof makeWorld>>): string {
  const call = w.inference.calls.find((c) => (c.headers.get('idempotency-key') ?? '').startsWith('image:act_'));
  return (call?.headers.get('idempotency-key') ?? 'image:act_').slice('image:act_'.length);
}
