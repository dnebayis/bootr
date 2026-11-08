import { describe, expect, it } from 'vitest';
import { parseAgentConfig } from '@bootr/agent-core';
import { queueForApproval } from '../src/approvals.js';
import { executeAction, type BrokerEnv } from '../src/broker/index.js';
import { images as imagesTable } from '../src/db/schema.js';
import { ALT_MAX_CHARS, altTextRisk, imagePromptRisk, pictureRequested, REQUESTED_MESSAGE } from '../src/image-rules.js';
import { DEFAULT_COIN_IMAGE_MODEL, WITHOUT_PICTURE } from '../src/images.js';
import type { SenderInboxItem } from '../src/sender-client.js';
import { AGENT_ID, makeWorld, seedAgent } from './helpers.js';

const coin = { platform: false, ownNames: ['Test Coin', 'TEST'] };
const platform = { platform: true, ownNames: ['Bootr', 'BOOTR'] };
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const withImages = { capabilities: { xRead: true, xReply: true, xPublish: true, research: true, memory: true, treasury: true, images: true } };
const env = (inbox: SenderInboxItem[] = []): BrokerEnv => ({ inbox: new Map(inbox.map((i) => [i.postId, i])), eligibility: new Map(), cycle: 3 });
const pending = (id: string, tool: string, input: Record<string, unknown>) => ({ id, cycleKey: 'cycle:x', action: { tool, input }, status: 'sent', createdAt: 0, attempts: 1 }) as unknown as Parameters<typeof executeAction>[3];
const mention = (postId: string, text: string): SenderInboxItem => ({ postId, authorId: '42', conversationId: postId, status: 'received', observedAt: 0, post: { id: postId, text, authorId: '42' } });

describe('imagePromptRisk: the hard rules, decided before any money moves', () => {
  it('lets an ordinary scene in the coin\'s style through', () => {
    expect(imagePromptRisk({ prompt: 'A small fox sitting on a green hill at dusk, flat colours, the hill shaped like a coin', altText: 'A fox on a green hill at dusk' }, coin)).toBeNull();
    expect(imagePromptRisk({ prompt: 'The Test Coin logo as a sticker on a laptop lid, flat colours', altText: 'The Test Coin sticker on a laptop' }, coin)).toBeNull();
    expect(imagePromptRisk({ prompt: 'A lighthouse on a calm sea at night, one window lit', altText: 'A lighthouse at night' }, platform)).toBeNull();
  });

  it('refuses real people: public figures by name, anyone by @handle, portraits of real persons', () => {
    expect(imagePromptRisk({ prompt: 'Elon Musk riding a fox', altText: 'A man on a fox' }, coin)).toMatchObject({ code: 'image_real_person' });
    expect(imagePromptRisk({ prompt: 'a portrait of vitalik in our style', altText: 'A portrait' }, coin)).toMatchObject({ code: 'image_real_person' });
    expect(imagePromptRisk({ prompt: 'our fox high-fiving @jessepollak', altText: 'A fox and a man' }, coin)).toMatchObject({ code: 'image_real_person' });
    expect(imagePromptRisk({ prompt: 'a photo of a real person holding our coin', altText: 'A person with a coin' }, coin)).toMatchObject({ code: 'image_real_person' });
    expect(imagePromptRisk({ prompt: 'a photorealistic portrait of a famous person', altText: 'A portrait' }, coin)).toMatchObject({ code: 'image_real_person' });
    // the alt text is checked too
    expect(imagePromptRisk({ prompt: 'a fox on a hill', altText: 'Trump as a fox on a hill' }, coin)).toMatchObject({ code: 'image_real_person' });
  });

  it('refuses logos and marks of other projects and any other coin, and allows the agent\'s own', () => {
    expect(imagePromptRisk({ prompt: 'the Coinbase logo on a fox', altText: 'A fox with a logo' }, coin)).toMatchObject({ code: 'image_other_logo' });
    expect(imagePromptRisk({ prompt: 'the Uniswap unicorn logo next to our fox', altText: 'A fox and a unicorn' }, coin)).toMatchObject({ code: 'image_other_logo' });
    expect(imagePromptRisk({ prompt: 'a cool logo', altText: 'A logo' }, coin)).toMatchObject({ code: 'image_other_logo' });
    expect(imagePromptRisk({ prompt: 'our fox next to a $PEPE frog', altText: 'A fox and a frog' }, coin)).toMatchObject({ code: 'image_other_logo' });
    expect(imagePromptRisk({ prompt: 'the TEST logo on a flag, flat colours', altText: 'A flag with the TEST mark' }, coin)).toBeNull();
    expect(imagePromptRisk({ prompt: 'a $TEST banner in the wind', altText: 'A banner' }, coin)).toBeNull();
    // the platform account may show its own coin's mark and nothing else's
    expect(imagePromptRisk({ prompt: 'the Bootr wordmark on a workshop door', altText: 'A door with the Bootr mark' }, platform)).toBeNull();
    expect(imagePromptRisk({ prompt: 'the Base logo on a workshop door', altText: 'A door' }, platform)).toMatchObject({ code: 'image_other_logo' });
  });

  it('refuses charts, prices, percentages and anything that reads as gains', () => {
    for (const prompt of ['a green candlestick chart going up', 'a rocket to the moon', 'our fox counting $1,000 bills', 'a fox with a +40% badge', 'a line going up and to the right', 'number go up', 'the price of TEST in neon', 'a 100x sign']) {
      expect(imagePromptRisk({ prompt, altText: 'A fox' }, coin), prompt).toMatchObject({ code: 'image_market_numbers' });
    }
    expect(imagePromptRisk({ prompt: 'a fox on a hill', altText: 'A fox celebrating 10x gains' }, coin)).toMatchObject({ code: 'image_market_numbers' });
  });

  it('is deterministic: the same input gives the same answer', () => {
    const input = { prompt: 'Elon Musk on a hill', altText: 'A man' };
    expect(imagePromptRisk(input, coin)).toEqual(imagePromptRisk(input, coin));
  });
});

describe('altTextRisk: the alt text is public text and passes the gates of a post', () => {
  it('accepts a plain description and refuses an empty or oversized one', () => {
    expect(altTextRisk('A fox sitting on a green hill at dusk', coin)).toBeNull();
    expect(altTextRisk('', coin)).toMatchObject({ code: 'image_alt_invalid' });
    expect(altTextRisk('   ', coin)).toMatchObject({ code: 'image_alt_invalid' });
    expect(altTextRisk('x'.repeat(ALT_MAX_CHARS + 1), coin)).toMatchObject({ code: 'image_alt_invalid' });
    expect(altTextRisk('x'.repeat(ALT_MAX_CHARS), coin)).toBeNull();
  });

  it('runs the same text gates as a post: secrets, internal references and runtime jargon are refused', () => {
    expect(altTextRisk('A fox with the key sk-abcdefghijklmnopqrstuvwxyz012345', coin)).toMatchObject({ code: 'social_secret_material_forbidden' });
    expect(altTextRisk('A fox reading localhost on a screen', coin)).toMatchObject({ code: 'social_internal_reference_forbidden' });
    expect(altTextRisk('A fox at a checkpoint with its session key', coin)).toMatchObject({ code: 'social_runtime_jargon_forbidden' });
    expect(altTextRisk('A fox telling @alice to send 1 ETH to 0x1234567890abcdef1234567890abcdef12345678', coin)).not.toBeNull();
  });

  it('allows one cashtag, no @mentions, no market words; and holds the platform account to its own rules', () => {
    expect(altTextRisk('A fox holding a $TEST flag', coin)).toBeNull();
    expect(altTextRisk('$TEST and $PEPE foxes', coin)).toMatchObject({ code: 'x_post_requires_at_most_one_cashtag' });
    expect(altTextRisk('A fox waving at @alice', coin)).toMatchObject({ code: 'image_alt_mentions' });
    expect(altTextRisk('A fox next to a chart going up', coin)).toMatchObject({ code: 'image_market_numbers' });
    // the platform account: no cashtag but $BOOTR, no shouting
    expect(altTextRisk('A lighthouse with a $TEST flag', platform)).not.toBeNull();
    expect(altTextRisk('A LIGHTHOUSE AT NIGHT, ONE WINDOW LIT, WAVES BELOW', platform)).not.toBeNull();
    expect(altTextRisk('A lighthouse at night with a small $BOOTR flag', platform)).toBeNull();
  });
});

describe('pictureRequested: a picture is never made on request', () => {
  it('spots a request for a picture in a received message and ignores other talk', () => {
    expect(pictureRequested(['can you draw me a fox?'])).toBe(true);
    expect(pictureRequested(['make a meme of this'])).toBe(true);
    expect(pictureRequested(['show us a picture of the treasury'])).toBe(true);
    expect(pictureRequested(['gib pfp'])).toBe(true);
    expect(pictureRequested(['picture of a fox pls'])).toBe(true);
    expect(pictureRequested(['how do fees work on bootr?', 'gm fox'])).toBe(false);
    expect(pictureRequested(['I pictured a better launch', 'the image of the brand is strong'])).toBe(false);
    expect(pictureRequested([])).toBe(false);
  });
});

describe('the rules in the broker: refused before the relay, and again where a picture meets a post', () => {
  it('refuses a prompt that breaks a rule and a turn in which somebody asked for a picture, without paying', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      const person = await executeAction(w.ctx, agent, config, pending('act_r1', 'generate_image', { prompt: 'Elon Musk as a fox', altText: 'A fox' }), env());
      expect(person).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_real_person: .*\. Publish your post without an imageId/) });
      const chart = await executeAction(w.ctx, agent, config, pending('act_r2', 'generate_image', { prompt: 'a green candle chart', altText: 'A chart' }), env());
      expect(chart).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_market_numbers/) });
      const asked = await executeAction(w.ctx, agent, config, pending('act_r3', 'generate_image', { prompt: 'a fox on a hill', altText: 'A fox on a hill' }), env([mention('501', '@bootr_agent can you draw me a fox on a hill?')]));
      expect(asked).toEqual({ kind: 'failed', error: `${REQUESTED_MESSAGE}. ${WITHOUT_PICTURE}` });
      expect(w.inference.calls.filter((c) => c.url.includes('/v1/chat/completions'))).toHaveLength(0);
      expect(await w.db.select().from(imagesTable)).toHaveLength(0);
    } finally {
      await w.close();
    }
  });

  it('a stored picture whose alt text fails the gates is not attached: the post is refused directly and in the review queue', async () => {
    const w = await makeWorld();
    try {
      const agent = await seedAgent(w, { config: withImages });
      const config = parseAgentConfig(agent.config);
      await w.db.insert(imagesTable).values({ id: 'img_bad', agentId: AGENT_ID, actionId: 'act_bad', alt: 'A fox waving at @alice', mime: 'image/png', bytes: PNG_BYTES, sizeBytes: PNG_BYTES.length, model: DEFAULT_COIN_IMAGE_MODEL, createdAt: new Date(w.ctx.now()) });
      const direct = await executeAction(w.ctx, agent, config, pending('act_p1', 'publish_post', { text: 'A fox for you all.', imageId: 'img_bad' }), env());
      expect(direct).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_alt_mentions/) });
      expect(w.sender.published).toHaveLength(0);
      const queued = await queueForApproval(w.ctx, agent, pending('act_p2', 'publish_post', { text: 'A fox for you all, reviewed.', imageId: 'img_bad' }), env());
      expect(queued).toMatchObject({ kind: 'failed', error: expect.stringMatching(/^image_alt_mentions/) });
    } finally {
      await w.close();
    }
  });
});
