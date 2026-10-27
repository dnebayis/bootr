import { describe, expect, it } from 'vitest';
import { TOOLS, TOOL_LIST, toFunctionDefinitions, toolEnabled, toolsFor, parseToolInput, publicChannelBlocked } from './tools.js';
import { TOOL_NAMES, type AgentConfig } from './types.js';

const caps = (on: string[]): Pick<AgentConfig, 'capabilities' | 'ownerRules'> => ({
  capabilities: { xRead: false, xReply: false, xPublish: false, research: false, memory: false, treasury: false, images: false, ...Object.fromEntries(on.map((k) => [k, true])) },
  ownerRules: [],
});

describe('tool catalog', () => {
  it('defines every tool with a capability, effect and schema', () => {
    expect(TOOL_LIST.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    expect(TOOL_LIST).toHaveLength(18);
    expect(TOOLS.treasury_execute.effect).toBe('money');
    expect(TOOLS.treasury_execute.idempotent).toBe(false);
    expect(TOOLS.publish_reply.idempotent).toBe(false);
    expect(TOOLS.read_mentions.effect).toBe('read');
    expect(TOOLS.finish.capability).toBeNull();
  });

  it('hides tools whose capability is disabled', () => {
    const names = toolsFor(caps(['xRead'])).map((t) => t.name);
    expect(names).toEqual(['read_mentions', 'read_x_thread', 'read_x_account', 'recall_conversation', 'finish']);
    expect(toolEnabled(caps([]), 'publish_reply')).toBe(false);
    expect(toolEnabled(caps(['xReply']), 'publish_reply')).toBe(true);
    expect(toolEnabled(caps(['treasury']), 'treasury_execute')).toBe(true);
    expect(toolEnabled(caps(['research']), 'treasury_read')).toBe(false);
    expect(toolEnabled(caps(['images']), 'generate_image')).toBe(true);
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

  it('parses tool input by name', () => {
    expect(parseToolInput('read_x_thread', { postId: '99' })).toEqual({ postId: '99' });
    expect(() => parseToolInput('read_x_thread', { postId: 'abc' })).toThrow();
  });
});
