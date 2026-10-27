import { describe, expect, it } from 'vitest';
import { MAX_CREATOR_IDENTITY_CHARS, composeIdentityText, normalizeCreatorIdentity } from './creator-identity.js';
import { buildSystemPrompt } from './system-prompt.js';
import { parseAgentConfig } from '../types.js';
import { baseConfig } from '../test/fixtures.js';

describe('normalizeCreatorIdentity', () => {
  it('keeps plain multi-line text, trimmed', () => {
    expect(normalizeCreatorIdentity('  A patient onchain analyst.\nShort, plain, no hype.  ')).toBe('A patient onchain analyst.\nShort, plain, no hype.');
  });
  it('normalizes line endings, tabs and whitespace runs', () => {
    expect(normalizeCreatorIdentity('Who:\tanalyst\r\n\r\n\r\n\r\nHow:   dry   \r\nNever:  tips')).toBe('Who: analyst\n\nHow: dry\nNever: tips');
  });
  it('drops control, zero-width and bidi characters', () => {
    expect(normalizeCreatorIdentity('Hel\u0000lo​ wor‮ld\u001b[31m﻿')).toBe('Hello world[31m');
  });
  it('cuts at the cap by code point without splitting surrogate pairs', () => {
    const emoji = '😀'.repeat(MAX_CREATOR_IDENTITY_CHARS + 5);
    const out = normalizeCreatorIdentity(emoji);
    expect(Array.from(out)).toHaveLength(MAX_CREATOR_IDENTITY_CHARS);
    expect(out.length).toBe(MAX_CREATOR_IDENTITY_CHARS * 2);
    expect(normalizeCreatorIdentity('x'.repeat(1000))).toHaveLength(MAX_CREATOR_IDENTITY_CHARS);
  });
  it('normalizes anything that is not a string to the empty string', () => {
    for (const v of [undefined, null, 5, {}, ['a'], '   \n  ']) expect(normalizeCreatorIdentity(v)).toBe('');
  });
});

describe('composeIdentityText', () => {
  const defaults = 'You are the agent behind Test Coin ($TEST).\nBe concrete.';
  it('puts the creator text first, then the default lines', () => {
    expect(composeIdentityText(' A dry analyst. ', defaults)).toBe('A dry analyst.\n\nYou are the agent behind Test Coin ($TEST).\nBe concrete.');
  });
  it('is the default alone without a creator text', () => {
    expect(composeIdentityText(null, defaults)).toBe(defaults);
    expect(composeIdentityText('', defaults)).toBe(defaults);
    expect(composeIdentityText('​  ', defaults)).toBe(defaults);
  });
  it('opens the system prompt and stays below the OWNER RULES section', () => {
    const config = parseAgentConfig({
      ...baseConfig,
      identityText: composeIdentityText('A dry analyst for small Base coins.', defaults),
      ownerRules: [{ id: 'tone', text: 'Stay friendly.', enabled: true }],
    });
    const prompt = buildSystemPrompt(config);
    expect(prompt.startsWith('A dry analyst for small Base coins.\n\nYou are the agent behind Test Coin ($TEST).\nBe concrete.\n\nOWNER RULES\n[tone] Stay friendly.')).toBe(true);
    expect(prompt.indexOf('A dry analyst')).toBeLessThan(prompt.indexOf('OWNER RULES'));
    expect(prompt.indexOf('OWNER RULES')).toBeLessThan(prompt.indexOf('BOOTR RULES'));
  });
});
