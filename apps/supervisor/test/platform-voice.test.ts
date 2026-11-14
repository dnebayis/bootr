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
