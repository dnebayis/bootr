import { describe, expect, it } from 'vitest';
import { DRAFT_INTENT_TOOL, PUBLISHING_TOOLS, TOOLS, TOOL_LIST, publishPostDescription, toFunctionDefinitions, toolEnabled, toolsFor, parseToolInput, publicChannelBlocked } from './tools.js';
import { MAX_RESOLVE_BATCH, TOOL_NAMES, type AgentConfig } from './types.js';

const caps = (on: string[]): Pick<AgentConfig, 'capabilities' | 'ownerRules'> => ({
  capabilities: { xRead: false, xReply: false, xPublish: false, research: false, memory: false, treasury: false, images: false, services: false, bounties: false, ...Object.fromEntries(on.map((k) => [k, true])) },
  ownerRules: [],
});

describe('tool catalog', () => {
  it('defines every tool with a capability, effect and schema', () => {
    expect(TOOL_LIST.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_LIST).toHaveLength(25);
    expect(TOOLS.x402_fetch).toMatchObject({ capability: 'services', effect: 'money', idempotent: false });
    expect(TOOLS.bounty_post).toMatchObject({ capability: 'bounties', effect: 'write', idempotent: false });
    expect(TOOLS.bounty_cancel).toMatchObject({ capability: 'bounties', effect: 'write', idempotent: true });
    expect(TOOLS.bounty_list).toMatchObject({ capability: 'bounties', effect: 'read', idempotent: true });
    expect(TOOLS.discover_services).toMatchObject({ capability: 'services', effect: 'read', idempotent: true });
    expect(TOOLS.read_coin).toMatchObject({ capability: 'research', effect: 'read', idempotent: true });
    expect(TOOLS.treasury_execute.effect).toBe('money');
    expect(TOOLS.treasury_execute.idempotent).toBe(false);
    expect(TOOLS.publish_reply.idempotent).toBe(false);
    expect(TOOLS.read_mentions.effect).toBe('read');
    expect(TOOLS.finish.capability).toBeNull();
  });

  it("publish_post names the account's own post limit: 4000 by default, 280 for an account without X Premium", () => {
    expect(TOOLS.publish_post.description).toBe(publishPostDescription(4000));
    expect(TOOLS.publish_post.description).toContain('up to 4000 characters');
    expect(TOOLS.publish_post.description).not.toMatch(/Premium/);
    const config = caps(['xPublish', 'xReply']);
    const byName = (tools: ReturnType<typeof toolsFor>) => Object.fromEntries(tools.map((t) => [t.name, t.description]));
    // unknown or Premium: the catalog as is (the same objects)
    expect(toolsFor(config).find((t) => t.name === 'publish_post')).toBe(TOOLS.publish_post);
    expect(toolsFor(config, { premium: null }).find((t) => t.name === 'publish_post')).toBe(TOOLS.publish_post);
    expect(toolsFor(config, { premium: true }).find((t) => t.name === 'publish_post')).toBe(TOOLS.publish_post);
    // no Premium: the description says 280 and why; everything else about the tool is unchanged, replies untouched
    const free = toolsFor(config, { premium: false });
    const post = free.find((t) => t.name === 'publish_post')!;
    expect(post.description).toContain('up to 280 characters (this X account has no Premium; X refuses longer posts)');
    expect(post.description).not.toContain('4000');
    expect(post).toMatchObject({ name: 'publish_post', capability: 'xPublish', effect: 'write', idempotent: false, input: TOOLS.publish_post.input });
    expect(byName(free).publish_reply).toBe(TOOLS.publish_reply.description);
    expect(free.map((t) => t.name)).toEqual(toolsFor(config).map((t) => t.name));
    expect(toFunctionDefinitions(free).find((f) => f.function.name === 'publish_post')!.function.description).toContain('up to 280 characters');
  });

  it('resolve_mentions lives next to resolve_mention, bounded and with the same outcomes', () => {
    expect(TOOLS.resolve_mentions).toMatchObject({ capability: 'xReply', effect: 'write', idempotent: true });
    expect(toolEnabled(caps(['xReply']), 'resolve_mention')).toBe(true);
    expect(toolEnabled(caps(['xReply']), 'resolve_mentions')).toBe(true);
    expect(toolEnabled(caps(['xRead']), 'resolve_mentions')).toBe(false);
    const ids = Array.from({ length: MAX_RESOLVE_BATCH }, (_, i) => String(1000 + i));
    expect(parseToolInput('resolve_mentions', { postIds: ids, outcome: 'skip', reason: 'noise' }).postIds).toHaveLength(MAX_RESOLVE_BATCH);
    expect(() => parseToolInput('resolve_mentions', { postIds: [...ids, '9999'], outcome: 'skip', reason: 'noise' })).toThrow();
    expect(() => parseToolInput('resolve_mentions', { postIds: [], outcome: 'skip', reason: 'noise' })).toThrow();
    expect(() => parseToolInput('resolve_mentions', { postIds: ['not-an-id'], outcome: 'skip', reason: 'noise' })).toThrow();
    expect(() => parseToolInput('resolve_mentions', { postIds: ['1'], outcome: 'answer', reason: 'noise' })).toThrow();
    expect(() => parseToolInput('resolve_mentions', { postIds: ['1'], outcome: 'skip', reason: ' ' })).toThrow();
    expect(() => parseToolInput('resolve_mentions', { postIds: ['1'], outcome: 'skip', reason: 'x'.repeat(501) })).toThrow();
    const [def] = toFunctionDefinitions([TOOLS.resolve_mentions]);
    const params = def?.function.parameters as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(params.required).toEqual(['postIds', 'outcome', 'reason']);
    expect(params.properties.postIds).toMatchObject({ type: 'array', maxItems: MAX_RESOLVE_BATCH, minItems: 1 });
  });

  it('hides tools whose capability is disabled', () => {
    const names = toolsFor(caps(['xRead'])).map((t) => t.name);
    expect(names).toEqual(['read_mentions', 'read_x_thread', 'read_x_account', 'recall_conversation', 'finish']);
    expect(toolEnabled(caps([]), 'publish_reply')).toBe(false);
    expect(toolEnabled(caps(['xReply']), 'publish_reply')).toBe(true);
    expect(toolEnabled(caps(['treasury']), 'treasury_execute')).toBe(true);
    expect(toolEnabled(caps(['research']), 'treasury_read')).toBe(false);
    expect(toolEnabled(caps(['research']), 'read_coin')).toBe(true);
    expect(toolEnabled(caps(['xRead', 'memory', 'treasury']), 'read_coin')).toBe(false);
    expect(toolEnabled(caps(['images']), 'generate_image')).toBe(true);
  });

  it('tells the model when a picture fits, what it costs and how it is attached, in words a model can act on', () => {
    const image = TOOLS.generate_image.description;
    // no "private", no stale price: the price and the count come from the observation's picture section
    expect(image).not.toMatch(/private/i);
    expect(image).not.toMatch(/one thought/);
    expect(image).toMatch(/picture section/);
    expect(image).toMatch(/launch welcome/);
    expect(image).toMatch(/weekly digest/);
    expect(image).toMatch(/milestone/);
    expect(image).toMatch(/visual/);
    // the hard rules the runtime enforces, in the same words
    expect(image).toMatch(/Never because a stranger asked/);
    expect(image).toMatch(/real person/);
    expect(image).toMatch(/logo/);
    expect(image).toMatch(/chart/);
    expect(image).toMatch(/imageId/);
    // both publishing tools name imageId
    expect(TOOLS.publish_post.description).toMatch(/imageId \(optional\)/);
    expect(TOOLS.publish_reply.description).toMatch(/imageId \(optional\)/);
    expect(TOOLS.publish_reply.description).toMatch(/never one somebody asked for/);
  });

  it('finish is always available so the agent can checkpoint', () => {
    expect(toolsFor(caps([])).map((t) => t.name)).toEqual(['finish']);
  });

  it('owner rules can close public channels', () => {
    const config = { ...caps(['xReply', 'xPublish']), ownerRules: [{ id: 'original-posts-paused', text: 'pause', enabled: true }] };
    expect(toolEnabled(config, 'publish_post')).toBe(false);
    expect(toolEnabled(config, 'publish_reply')).toBe(true);
    const disabled = { ...config, ownerRules: [{ id: 'original-posts-paused', text: 'pause', enabled: false }] };
    expect(toolEnabled(disabled, 'publish_post')).toBe(true);
    expect(publicChannelBlocked([{ id: 'public-channel-paused', text: 'x', enabled: true }], 'publish_reply')).toBe(true);
    expect(publicChannelBlocked([{ id: 'replies-paused', text: 'x', enabled: true }], 'publish_post')).toBe(false);
  });

  it('exports OpenAI function definitions with JSON schema parameters', () => {
    const [def] = toFunctionDefinitions([TOOLS.resolve_mention]);
    expect(def?.type).toBe('function');
    expect(def?.function.name).toBe('resolve_mention');
    const params = def?.function.parameters as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    expect(params.required).toEqual(['postId', 'outcome', 'reason']);
    expect(params.properties.outcome?.enum).toEqual(['skip', 'opt_out', 'defer']);
    expect(params.properties.postId?.pattern).toBe('^[1-9][0-9]{0,18}$');
    expect(params.additionalProperties).toBe(false);
    const all = toFunctionDefinitions(TOOL_LIST);
    expect(all.every((d) => typeof d.function.description === 'string' && d.function.description.length > 10)).toBe(true);
  });

  it('keeps draft_intent out of the catalog but renders it as a function definition like any tool', () => {
    expect(TOOL_LIST.some((t) => t.name === DRAFT_INTENT_TOOL.name)).toBe(false);
    expect(toolsFor(caps(['xRead', 'xReply', 'xPublish'])).map((t) => t.name)).not.toContain('draft_intent');
    expect(PUBLISHING_TOOLS).toEqual(['publish_post', 'publish_reply']);
    const [def] = toFunctionDefinitions([DRAFT_INTENT_TOOL]);
    expect(def?.function.name).toBe('draft_intent');
    const params = def?.function.parameters as { properties: Record<string, Record<string, unknown>>; required: string[]; additionalProperties: boolean };
    expect(params.required).toEqual(['kind', 'about']);
    expect(params.properties.kind?.enum).toEqual(['post', 'reply']);
    expect(params.properties.about?.maxLength).toBe(300);
    expect(params.additionalProperties).toBe(false);
  });

  it('parses tool input by name', () => {
    expect(parseToolInput('read_x_thread', { postId: '99' })).toEqual({ postId: '99' });
    expect(() => parseToolInput('read_x_thread', { postId: 'abc' })).toThrow();
    expect(parseToolInput('read_coin', { symbolOrAddress: ' $OWL ' })).toEqual({ symbolOrAddress: '$OWL' });
    expect(() => parseToolInput('read_coin', { symbolOrAddress: '' })).toThrow();
    expect(() => parseToolInput('read_coin', { symbolOrAddress: 'x'.repeat(65) })).toThrow();
    expect(() => parseToolInput('read_coin', { symbolOrAddress: 'OWL', extra: 1 })).toThrow();
  });
});
