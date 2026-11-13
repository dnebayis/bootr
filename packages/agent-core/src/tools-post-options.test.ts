import { describe, expect, it } from 'vitest';
import { TOOLS, publishPostDescription, publishPostInput, toFunctionDefinitions, toolsFor } from './tools.js';
import type { AgentConfig } from './types.js';

const config: Pick<AgentConfig, 'capabilities' | 'ownerRules'> = {
  capabilities: { xRead: true, xReply: true, xPublish: true, research: false, memory: false, treasury: false, images: false, services: false, bounties: false },
  ownerRules: [],
};

/** The description and the schema keys as they were before `thread`, `about` and `topic` existed. */
const BEFORE = 'Publish one original post when the supplied schedule says it is due. Fresh content in your own voice, up to 4000 characters, no templates and no catch-up bursts. imageId (optional) attaches a picture you made this turn with generate_image.';
const BEFORE_KEYS = ['text', 'attributions', 'imageId'];
const OFF = { threadMore: 0, comments: false, topic: false };

const propertiesOf = (tools: ReturnType<typeof toolsFor>): string[] => {
  const def = toFunctionDefinitions(tools).find((f) => f.function.name === 'publish_post')!;
  return Object.keys((def.function.parameters as { properties: Record<string, unknown> }).properties);
};

describe('publish_post: thread, about and topic', () => {
  it('the catalog offers all three, each with its own sentence', () => {
    const text = TOOLS.publish_post.description;
    expect(text.startsWith(BEFORE)).toBe(true);
    expect(text).toContain(' thread (optional) adds up to 3 more connected posts of at most 280 characters each when one post cannot carry the thought; most posts need none.');
    expect(text).toMatch(/ about \(optional\) is \{postId\} of a post you read in this turn/);
    expect(text).toMatch(/no link to that post and no @ for its author; topic \(optional\) is your own one word for what the post is about\.$/);
    // two sentences longer than it was
    expect(text.slice(BEFORE.length).split('. ').length).toBe(2);
    expect(propertiesOf(toolsFor(config))).toEqual(['text', 'thread', 'attributions', 'imageId', 'about', 'topic']);
    // nothing in it is a way to quote or to reply to somebody
    expect(propertiesOf(toolsFor(config))).not.toContain('quote');
  });

  it('a piece that is off loses its sentence and its field; with all three off the tool is what it was', () => {
    expect(publishPostDescription(4000, OFF)).toBe(BEFORE);
    const off = toolsFor(config, { post: OFF });
    expect(off.find((t) => t.name === 'publish_post')!.description).toBe(BEFORE);
    expect(propertiesOf(off)).toEqual(BEFORE_KEYS);
    expect(off.map((t) => t.name)).toEqual(toolsFor(config).map((t) => t.name));
    // the account's own limit still shows, alone
    expect(toolsFor(config, { premium: false, post: OFF }).find((t) => t.name === 'publish_post')!.description).toBe(publishPostDescription(280, OFF));
    expect(publishPostDescription(280, OFF)).toContain('up to 280 characters (this X account has no Premium; X refuses longer posts)');

    // each piece by itself
    const noThread = toolsFor(config, { post: { threadMore: 0 } });
    expect(noThread.find((t) => t.name === 'publish_post')!.description).not.toContain('thread (optional)');
    expect(propertiesOf(noThread)).toEqual(['text', 'attributions', 'imageId', 'about', 'topic']);
    const noComments = toolsFor(config, { post: { comments: false } });
    expect(noComments.find((t) => t.name === 'publish_post')!.description).not.toContain('about (optional)');
    expect(noComments.find((t) => t.name === 'publish_post')!.description).toMatch(/ topic \(optional\) is your own one word for what the post is about\.$/);
    expect(propertiesOf(noComments)).toEqual(['text', 'thread', 'attributions', 'imageId', 'topic']);
    const noTopic = toolsFor(config, { post: { topic: false } });
    expect(noTopic.find((t) => t.name === 'publish_post')!.description).toMatch(/no @ for its author\.$/);
    expect(propertiesOf(noTopic)).toEqual(['text', 'thread', 'attributions', 'imageId', 'about']);
  });

  it('a smaller thread limit says its own number, and the schema shown stays strict', () => {
    expect(publishPostDescription(4000, { threadMore: 1 })).toContain('thread (optional) adds up to 1 more connected post of at most 280 characters each');
    expect(publishPostDescription(4000, { threadMore: 9 })).toContain('adds up to 3 more connected posts');
    expect(publishPostInput()).toBe(TOOLS.publish_post.input);
    const shown = publishPostInput(OFF);
    expect(shown.safeParse({ text: 'a' }).success).toBe(true);
    expect(shown.safeParse({ text: 'a', thread: [{ text: 'b' }] }).success).toBe(false);
    expect(shown.safeParse({ text: 'a', about: { postId: '1' } }).success).toBe(false);
    expect(shown.safeParse({ text: 'a', topic: 'x' }).success).toBe(false);
  });
});
