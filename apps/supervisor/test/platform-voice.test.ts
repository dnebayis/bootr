import { parseAction } from '@bootr/agent-core';
import { describe, expect, it } from 'vitest';
import type { SupervisorContext } from '../src/context.js';
import { voicedAction } from '../src/platform-voice.js';

const ctx = (on: boolean) => ({ config: { PLATFORM_PLAIN_VOICE: on } }) as unknown as Pick<SupervisorContext, 'config'>;
const platform = { config: { platform: true } };
const coin = { config: {} };

describe('voicedAction: the platform account publishes in lowercase and without emoji', () => {
  it('rewrites a post, every part of a thread, a scheduled post and a reply of the platform account', () => {
    const post = parseAction({ tool: 'publish_post', input: { text: 'Agents can Pay for search now 🥾', thread: [{ text: 'Second Part, with $BOOTR 👛' }] } });
    expect(voicedAction(ctx(true), platform, post)).toMatchObject({ tool: 'publish_post', input: { text: 'agents can pay for search now', thread: [{ text: 'second part, with $BOOTR' }] } });
    const reply = parseAction({ tool: 'publish_reply', input: { postId: '801', text: 'Good Question @Asker 🙂' } });
    expect(voicedAction(ctx(true), platform, reply)).toMatchObject({ tool: 'publish_reply', input: { postId: '801', text: 'good question @Asker' } });
    const later = parseAction({ tool: 'schedule_post', input: { text: 'Tomorrow: The Numbers 📊', sendAt: '2026-11-15T09:00:00Z' } });
    expect((voicedAction(ctx(true), platform, later) as typeof later).input).toMatchObject({ text: 'tomorrow: the numbers' });
  });

  it("leaves a coin agent's text, a text with the setting off and every other tool as they are", () => {
    const post = parseAction({ tool: 'publish_post', input: { text: 'Agents can Pay for search now 🥾' } });
    expect(voicedAction(ctx(true), coin, post)).toBe(post);
    expect(voicedAction(ctx(false), platform, post)).toBe(post);
    const note = parseAction({ tool: 'remember', input: { text: 'Jesse Pollak posted about Search 🥾' } });
    expect(voicedAction(ctx(true), platform, note)).toBe(note);
  });
});

describe('voicedAction: a cashtag written twice keeps its $ once, for every agent', () => {
  it('fixes a coin agent, the platform account and the platform with its voice off, each part of a thread by itself', () => {
    const post = parseAction({ tool: 'publish_post', input: { text: 'A $TEST fact: each $TEST trade pays the agent.', thread: [{ text: 'And $TEST again, and $TEST.' }, { text: 'Just $TEST.' }] } });
    expect(voicedAction(ctx(true), coin, post)).toMatchObject({ input: { text: 'A $TEST fact: each TEST trade pays the agent.', thread: [{ text: 'And $TEST again, and TEST.' }, { text: 'Just $TEST.' }] } });
    expect(voicedAction(ctx(false), platform, post)).toMatchObject({ input: { text: 'A $TEST fact: each TEST trade pays the agent.' } });
    expect(voicedAction(ctx(true), platform, post)).toMatchObject({ input: { text: 'a $TEST fact: each test trade pays the agent.' } });
    const reply = parseAction({ tool: 'publish_reply', input: { postId: '801', text: '$TEST is the coin; $TEST has an agent.' } });
    expect(voicedAction(ctx(true), coin, reply)).toMatchObject({ input: { text: '$TEST is the coin; TEST has an agent.' } });
    const later = parseAction({ tool: 'schedule_post', input: { text: '$TEST then $TEST', sendAt: '2026-11-15T09:00:00Z' } });
    expect((voicedAction(ctx(true), coin, later) as typeof later).input).toMatchObject({ text: '$TEST then TEST' });
  });

  it('leaves two different cashtags for the gate to refuse', () => {
    const post = parseAction({ tool: 'publish_post', input: { text: '$TEST and $OTHER' } });
    expect(voicedAction(ctx(true), coin, post)).toBe(post);
  });
});
