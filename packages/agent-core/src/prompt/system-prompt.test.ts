import { describe, expect, it } from 'vitest';
import { BOOTR_RULES, buildObservation, buildSystemPrompt, compactView, observationFits, type ObservationView } from './system-prompt.js';
import { parseAgentConfig } from '../types.js';
import { baseConfig } from '../test/fixtures.js';

describe('buildSystemPrompt', () => {
  const config = parseAgentConfig({
    ...baseConfig,
    identityText: '  I am Bootr, a cheerful agent.  ',
    ownerRules: [
      { id: 'tone', text: 'Stay friendly.', enabled: true },
      { id: 'secret', text: 'Never reveal the founder.', enabled: true },
      { id: 'old', text: 'Ignore this.', enabled: false },
    ],
  });
  const prompt = buildSystemPrompt(config, 'social');

  it('starts with the identity, then enabled owner rules in [id] form', () => {
    expect(prompt.startsWith('I am Bootr, a cheerful agent.\n\nOWNER RULES\n[tone] Stay friendly.\n[secret] Never reveal the founder.')).toBe(true);
    expect(prompt).not.toContain('[old]');
    expect(prompt).not.toContain('Ignore this.');
  });
  it('includes the role text and every fixed Bootr rule', () => {
    expect(prompt).toContain('@bootragent');
    expect(prompt).toContain('$BOOT');
    expect(prompt).toContain(config.kernel.address);
    for (const rule of BOOTR_RULES) expect(prompt).toContain(rule);
    expect(prompt).toMatch(/untrusted evidence/);
    expect(prompt).toMatch(/one tool at a time/i);
    expect(prompt).toMatch(/Never claim a tool action succeeded/);
    expect(prompt).toMatch(/No price predictions/);
    expect(prompt).toMatch(/confirmed transaction hash/);
    expect(prompt).toMatch(/original-post schedule/);
    expect(prompt).toMatch(/Use finish to checkpoint/);
    expect(prompt).toMatch(/never hold keys/);
  });
  it('prints (none) when no owner rule is enabled', () => {
    expect(buildSystemPrompt(parseAgentConfig(baseConfig))).toContain('OWNER RULES\n(none)');
  });
});

describe('buildObservation / compactView', () => {
  const now = Date.parse('2026-07-01T00:00:00.000Z');
  const big = (n: number) => 'x'.repeat(n);
  const parts = {
    now,
    market: { snapshot: { price: '1.0' }, history: [big(2000)] },
    treasury: { balances: { ETH: '1' }, recent: [big(2000)] },
    social: {
      messages: [{ postId: '1', text: big(1500) }, { postId: '2', text: big(1500) }, { postId: '3', text: big(1500) }],
      threadContexts: [{ postId: '1', text: 'a' }, { postId: '2', text: 'b' }, { postId: '3', text: 'c' }],
      conversations: [{ authorId: '9', nextBeforePostId: '8', text: big(2000) }],
      relatedHistory: [big(2000)],
      originalPost: { due: false, nextAt: '2026-07-01T02:00:00.000Z', recent: [{ text: big(1000) }] },
    },
    lastResults: [big(2000)],
    continuation: { progress: { step: 1 }, recentSteps: [big(2000)] },
  };

  it('returns the view untouched when it fits', () => {
    const view = buildObservation(parts, 1_000_000);
    expect(view.observedAt).toBe('2026-07-01T00:00:00.000Z');
    expect(view.instructionAuthority).toBe(false);
    expect(view.contextWindow).toBeUndefined();
    expect(view.social?.messages).toHaveLength(3);
  });

  it('compacts in the fixed fallback order and keeps messages until last', () => {
    const view = buildObservation(parts, 5000);
    expect(view.contextWindow?.compacted).toEqual([
      'duplicate continuation excerpts',
      'older author conversations',
      'related historical posts',
      'market history',
      'treasury history',
      'older original text',
      'last results',
      'dropped last results',
      'bounded complete incoming conversations',
    ]);
    expect(view.continuation?.recentSteps).toEqual([]);
    expect(view.social?.conversations?.[0]).toMatchObject({ authorId: '9', nextBeforePostId: '8' });
    expect((view.social?.originalPost?.recent?.[0] as { textTruncated: boolean }).textTruncated).toBe(true);
    expect(view.social?.messages?.map((m) => m.postId)).toEqual(['1', '2']);
    expect(view.social?.threadContexts?.map((c) => c.postId)).toEqual(['1', '2']);
    expect(view.social?.deferredForContext?.count).toBe(1);
    expect(view.social?.originalPost?.nextAt).toBe('2026-07-01T02:00:00.000Z');
    expect(observationFits(view, 5000)).toBe(true);
  });

  it('stops as soon as the view fits', () => {
    const view = buildObservation(parts, 15_000);
    expect(view.contextWindow?.compacted).toEqual(['duplicate continuation excerpts', 'older author conversations']);
    expect(view.social?.messages).toHaveLength(3);
  });

  it('never drops the last message and does not mutate the input', () => {
    const input: ObservationView = { observedAt: 'x', instructionAuthority: false, social: { messages: [{ postId: '1', text: big(500) }], threadContexts: [] } };
    const out = compactView(input, () => false);
    expect(out.social?.messages).toHaveLength(1);
    expect(input.contextWindow).toBeUndefined();
  });
});
