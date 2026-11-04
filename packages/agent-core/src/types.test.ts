import { describe, expect, it } from 'vitest';
import { agentConfigSchema, draftIntentInputSchema, parseAction, parseAgentConfig, workerOutputSchema } from './types.js';
import { baseConfig } from './test/fixtures.js';

describe('agentConfigSchema', () => {
  it('applies defaults', () => {
    const config = parseAgentConfig(baseConfig);
    expect(config.postIntervalMs).toBe(2 * 60 * 60 * 1000);
    expect(config.dormancyPeriodMs).toBe(90 * 24 * 60 * 60 * 1000);
    expect(config.capabilities.treasury).toBe(false);
    expect(config.capabilities.images).toBe(false);
    expect(config.ownerRules).toEqual([]);
    expect(config.revision).toBe(0);
  });
  it('rejects duplicate owner rule ids and bad handles', () => {
    expect(() =>
      parseAgentConfig({ ...baseConfig, ownerRules: [{ id: 'a', text: 'x', enabled: true }, { id: 'a', text: 'y', enabled: true }] }),
    ).toThrow(/duplicate owner rule id/);
    expect(agentConfigSchema.safeParse({ ...baseConfig, xHandle: '@bad' }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...baseConfig, xUserId: '0123' }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...baseConfig, replyAuthorIds: ['1', '1'] }).success).toBe(false);
  });
  it('takes economy mode as routing.decideModel, null or absent meaning off', () => {
    expect(parseAgentConfig(baseConfig).routing).toBeUndefined();
    expect(parseAgentConfig({ ...baseConfig, routing: { decideModel: null } }).routing).toEqual({ decideModel: null });
    expect(parseAgentConfig({ ...baseConfig, routing: { decideModel: 'deepseek/deepseek-v3.2' } }).routing).toEqual({ decideModel: 'deepseek/deepseek-v3.2' });
    expect(agentConfigSchema.safeParse({ ...baseConfig, routing: { decideModel: '' } }).success).toBe(false);
    expect(agentConfigSchema.safeParse({ ...baseConfig, routing: {} }).success).toBe(false);
  });
});

describe('draftIntentInputSchema', () => {
  it('accepts a post or a reply intent with a short brief, and demands a target for replies', () => {
    expect(draftIntentInputSchema.parse({ kind: 'post', about: 'Say that holders doubled this week, per read_market.' })).toEqual({ kind: 'post', about: 'Say that holders doubled this week, per read_market.' });
    expect(draftIntentInputSchema.parse({ kind: 'reply', target: '42', about: 'Answer the fee question: 1% to the agent.' }).target).toBe('42');
    expect(draftIntentInputSchema.safeParse({ kind: 'reply', about: 'no target' }).success).toBe(false);
    expect(draftIntentInputSchema.safeParse({ kind: 'post', about: 'x'.repeat(301) }).success).toBe(false);
    expect(draftIntentInputSchema.safeParse({ kind: 'post', about: ' ' }).success).toBe(false);
    expect(draftIntentInputSchema.safeParse({ kind: 'thread', about: 'nope' }).success).toBe(false);
    expect(draftIntentInputSchema.safeParse({ kind: 'post', about: 'ok', text: 'extra' }).success).toBe(false);
  });
  it('is not a catalog action', () => {
    expect(() => parseAction({ tool: 'draft_intent', input: { kind: 'post', about: 'x' } })).toThrow();
  });
});

describe('actionSchema', () => {
  it('parses a typed action and rejects unknown tools or extra keys', () => {
    const action = parseAction({ tool: 'publish_reply', input: { postId: '42', text: 'hello' } });
    expect(action.tool).toBe('publish_reply');
    expect(() => parseAction({ tool: 'nope', input: {} })).toThrow();
    expect(() => parseAction({ tool: 'read_mentions', input: { extra: 1 } })).toThrow();
    expect(() => parseAction({ tool: 'treasury_execute', input: { preparedId: 'p1' } })).toThrow();
  });
  it('accepts a worker output without an action', () => {
    expect(workerOutputSchema.parse({ state: { n: 1 }, done: true }).done).toBe(true);
  });
});
