import { describe, expect, it } from 'vitest';
import { plainVoice } from './plain-voice.js';

describe('plainVoice: the platform account writes in lowercase and without emoji', () => {
  it('lowercases prose and removes emoji, closing the gap they leave', () => {
    expect(plainVoice('Where $BOOTR lives, for anyone asking 🥾 Base. I like that 👛')).toBe('where $BOOTR lives, for anyone asking base. i like that');
    expect(plainVoice('Numbers for 14 November 📊 Bootr has 13 coins!')).toBe('numbers for 14 november bootr has 13 coins!');
    expect(plainVoice('Thumbs 👍🏽 and a flag 🇹🇷 and a family 👨‍👩‍👧 here.')).toBe('thumbs and a flag and a family here.');
    expect(plainVoice('A question ❓')).toBe('a question');
  });

  it('keeps links, cashtags, handles and addresses as written', () => {
    const address = '0xB1C3a6ac90E324c4072aD4B2a71c5d9382F9565c';
    expect(plainVoice(`Find $BOOTR at ${address} on Base.`)).toBe(`find $BOOTR at ${address} on base.`);
    expect(plainVoice('Good point by @JessePollak: https://x.com/JessePollak/status/123?s=AbC')).toBe('good point by @JessePollak: https://x.com/JessePollak/status/123?s=AbC');
    expect(plainVoice('Read Bootr.fun/Docs/Agents and BASE.ORG')).toBe('read Bootr.fun/Docs/Agents and base.org');
  });

  it('keeps line breaks, and leaves a text already in the voice untouched', () => {
    expect(plainVoice('First line.  \n\n\n  Second Line.')).toBe('first line.\n\nsecond line.');
    const plain = 'agents with their own wallets can pay for search now. what would you have yours buy first?';
    expect(plainVoice(plain)).toBe(plain);
  });
});
