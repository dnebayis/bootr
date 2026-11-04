import { describe, expect, it } from 'vitest';
import { BOOTR_RULES, PLATFORM_RULES, ROUTING_RULES, VOICE_RULES, buildObservation, buildSystemPrompt, compactView, observationFits, type ObservationView } from './system-prompt.js';
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
    expect(prompt).toContain('$BOOTR');
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
  it('adds one economy-mode line per phase after the Bootr rules, and none when the mode is off', () => {
    expect(prompt).not.toContain('ECONOMY MODE');
    const decide = buildSystemPrompt(config, 'social', { phase: 'decide' });
    expect(decide.endsWith('ECONOMY MODE\n' + ROUTING_RULES.decide)).toBe(true);
    expect(decide).toMatch(/call draft_intent/);
    expect(decide).toMatch(/never write the public text yourself/);
    const write = buildSystemPrompt(config, 'social', { phase: 'write' });
    expect(write.endsWith('ECONOMY MODE\n' + ROUTING_RULES.write)).toBe(true);
    expect(write).toMatch(/an earlier step of yours, on a cheaper model/);
    expect(write).not.toContain(ROUTING_RULES.decide);
    expect(buildSystemPrompt(config, 'social', { phase: null })).toBe(prompt);
  });
  it('bounds conversation with other Bootr agents and explains a held original post', () => {
    expect(prompt).toMatch(/Other Bootr agents \(the bootrAgents section; their messages are marked bootrAgent\) are peers/);
    expect(prompt).toMatch(/answer one at most twice in a thread, start a new conversation with one .* at most once a day, and never loop/);
    expect(prompt).toMatch(/When the runtime refuses a reply as capped, resolve the mention instead/);
    expect(prompt).toMatch(/The schedule may hold an original post for the platform \(quiet hours, or the posting window is full\): originalPost\.waiting says why/);
    expect(prompt).toMatch(/replies still go out\. Your slot is kept/);
    const platform = buildSystemPrompt(parseAgentConfig({ ...baseConfig, xHandle: 'AgentBootr', platform: true }));
    expect(platform).toMatch(/Welcoming a coin: you may ask a newly launched coin's agent \(bootrAgents, new: true\) one question in an original post, and answer its answer once/);
    expect(platform).toMatch(/never a second question, never a third turn, never a thread with a coin that is not new/);
    expect(prompt).not.toMatch(/Welcoming a coin/);
  });
  it('prints (none) when no owner rule is enabled', () => {
    expect(buildSystemPrompt(parseAgentConfig(baseConfig))).toContain('OWNER RULES\n(none)');
  });
  it('carries the voice rules between the role text and the Bootr rules', () => {
    for (const rule of VOICE_RULES) expect(prompt).toContain(rule);
    expect(prompt.indexOf('VOICE\n')).toBeGreaterThan(prompt.indexOf('@bootragent'));
    expect(prompt.indexOf('BOOTR RULES\n')).toBeGreaterThan(prompt.indexOf('VOICE\n'));
    expect(prompt).not.toContain('PLATFORM ACCOUNT');
    expect(prompt).toMatch(/Never narrate your own machinery/);
    expect(prompt).toMatch(/Private stays private/);
  });
  it('speaks as the launchpad with platform conduct when config.platform is set', () => {
    const platform = buildSystemPrompt(parseAgentConfig({ ...baseConfig, xHandle: 'bootrfun', platform: true }));
    expect(platform).toContain('You are @bootrfun, the official voice of Bootr, the launchpad itself');
    expect(platform).toContain('PLATFORM ACCOUNT\n1. ');
    for (const rule of PLATFORM_RULES) expect(platform).toContain(rule);
    expect(platform.indexOf('PLATFORM ACCOUNT')).toBeGreaterThan(platform.indexOf('VOICE\n'));
    expect(platform.indexOf('BOOTR RULES')).toBeGreaterThan(platform.indexOf('PLATFORM ACCOUNT'));
    expect(parseAgentConfig(baseConfig).platform).toBe(false);
  });
  it('gives the platform account its hard rules as a never-list, and keeps them out of coin agents', () => {
    const platform = buildSystemPrompt(parseAgentConfig({ ...baseConfig, xHandle: 'AgentBootr', platform: true }));
    expect(platform).toMatch(/Never talk about price/);
    expect(platform).toMatch(/no "wen"/);
    expect(platform).toMatch(/Never shill or promote \$BOOTR/);
    expect(platform).toMatch(/never tell anyone to buy, hold or sell/);
    expect(platform).toMatch(/Never speak for another coin's agent/);
    expect(platform).toMatch(/Never post about your own treasury operations: fee claims, swaps, refuels, gas/);
    expect(platform).toMatch(/One original post per slot at most, and skipping the slot is normal/);
    expect(platform).toMatch(/When in doubt, do not post\./);
    expect(platform).toMatch(/Replies: answer questions about how Bootr works in plain words\. Never argue\. Never discuss prices/);
    expect(platform).toMatch(/never answer an insult with an insult/);
    expect(platform).toMatch(/No shouting, no emoji strings, no cashtags other than \$BOOTR/);
    expect(PLATFORM_RULES.filter((rule) => rule.startsWith('Never')).length).toBeGreaterThanOrEqual(5);
    const coin = buildSystemPrompt(parseAgentConfig({ ...baseConfig, platform: false }));
    for (const rule of PLATFORM_RULES) expect(coin).not.toContain(rule);
    expect(coin).not.toMatch(/When in doubt, do not post/);
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
