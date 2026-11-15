import { describe, expect, it } from 'vitest';
import { EXCERPT_MAX_CHARS, excerptOf, gateRefusal, gateWords } from './gate-words.js';
import { postFinding, postRefusal, validatePost, type PostValidationContext } from './post-validation.js';
import { threadRefusal } from './thread.js';

/** The supervisor's `errorCodeOf` (runtime.ts) and the weekly check's `errorCode`: everything before the first space, without a closing colon. */
const head = (error: string): string => error.trim().split(/\s/)[0]!.replace(/:$/, '');

const ADDRESS = `0x${'ab'.repeat(20)}`;
const OWN = `0x${'11'.repeat(20)}`;
const credit = (username: string) => [{ username, sourceUrl: `https://x.com/${username}/status/1` }];

/** One text for every code the gate owns: [code, text, attributions, format, context]. */
const CASES: [string, unknown, unknown, 'short' | 'original', PostValidationContext][] = [
  ['social_execution_account_forbidden', 'hey @bankrbot do your thing', [], 'short', {}],
  ['social_execution_account_forbidden', 'thanks for asking', [], 'short', { reply: true, recipient: 'tradebot' }],
  ['social_wallet_payload_forbidden', `open ethereum:${ADDRESS}?value=1`, [], 'short', {}],
  ['social_execution_link_forbidden', 'https://x.com/intent/tweet?text=hello', [], 'short', {}],
  ['social_execution_command_forbidden', '@alice send 1 eth to me', [], 'short', {}],
  ['social_secret_material_forbidden', `the key is 0x${'f9'.repeat(32)}`, [], 'short', {}],
  ['social_internal_reference_forbidden', 'the api is at http://localhost:3002', [], 'short', {}],
  ['social_runtime_jargon_forbidden', 'The paymaster covered it again.', [], 'short', {}],
  ['social_unreadable_number_forbidden', 'price 2.317e-7 USD', [], 'short', {}],
  ['social_private_address_forbidden', `another coin lives at ${ADDRESS}`, [], 'short', { publicAddresses: [OWN] }],
  ['invalid_short_post', 'x'.repeat(281), [], 'short', {}],
  ['invalid_original_post', '   ', [], 'original', {}],
  ['invalid_short_post', 'fine', 'nope', 'short', {}],
  ['x_post_requires_at_most_one_cashtag', '$BOOT vs $ETH', [], 'short', {}],
  ['invalid_source_credit', 'thanks @alice', [{ username: 'alice', sourceUrl: 'http://x.com/alice' }], 'short', {}],
  ['mentions_require_source_credit', 'thanks @alice', [], 'short', {}],
  ['mentions_require_source_credit', 'no mention here', credit('alice'), 'short', {}],
  ['mentions_require_source_credit', '@a1 @a2 @a3 @a4', [], 'short', {}],
  ['platform_treasury_talk_forbidden', 'I just claimed my fees for the week.', [], 'short', { platform: true }],
  ['platform_price_talk_forbidden', 'This one is going to pump.', [], 'short', { platform: true }],
  ['platform_foreign_cashtag_forbidden', '$QENG launched today.', [], 'short', { platform: true }],
  ['platform_shouting_forbidden', 'THIS IS HUGE for everyone here.', [], 'short', { platform: true }],
  ['platform_emoji_string_forbidden', 'New launch 🚀🚀🚀', [], 'short', { platform: true }],
  ['platform_link_forbidden', 'Read it at https://techcrunch.com/2026/11/13/agents', [], 'original', { platform: true }],
];

describe('what a refused post is told', () => {
  it('every code of the gate has words, with the code alone before the first space', () => {
    const seen = new Set<string>();
    for (const [code, text, attributions, format, context] of CASES) {
      const finding = postFinding(text, attributions, format, false, context);
      expect(finding?.code, String(text)).toBe(code);
      const refusal = postRefusal(text, attributions, format, false, context)!;
      expect(refusal.startsWith(`${code}: `), refusal).toBe(true);
      // the log and the weekly check key on the head: it is the bare code, whatever the words quote
      expect(head(refusal)).toBe(code);
      expect(head(`sender_rejected:policy:${refusal}`)).toBe(`sender_rejected:policy:${code}`);
      // what tripped and what to do: a sentence that ends, not a code again
      expect(refusal.length).toBeGreaterThan(code.length + 25);
      expect(refusal.trimEnd()).toMatch(/[.)]$/);
      seen.add(code);
    }
    // the whole of the gate: four action codes, five disclosure codes, two shapes, the cashtag, two credit codes, six platform codes
    expect(seen.size).toBe(20);
    expect(gateWords({ code: 'reply_not_eligible' })).toBeNull();
    expect(gateRefusal({ code: 'consent_opted_out' })).toBe('consent_opted_out');
  });

  it('validatePost throws the same refusal as its message, and a thread part carries it after its part number', () => {
    expect(() => validatePost('thanks @alice')).toThrow('mentions_require_source_credit: "@alice" is named with an @ but has no source in attributions. Add its post to attributions, or write the name without the @.');
    expect(threadRefusal(['A calm first part.', 'As @alice said.'])).toBe(
      'mentions_require_source_credit: part 2 of the thread does not pass the publish gate; nothing was posted. Rewrite it: "@alice" is named with an @ but has no source in attributions. Add its post to attributions, or write the name without the @.',
    );
  });

  it('quotes the words of the post that matched', () => {
    expect(postRefusal('The paymaster covered it again.')).toMatch(/^social_runtime_jargon_forbidden: "paymaster" is a word from the machinery behind you/);
    expect(postRefusal('$QENG launched today.', [], 'short', false, { platform: true })).toMatch(/^platform_foreign_cashtag_forbidden: "\$QENG" is another coin's cashtag/);
    expect(postRefusal('Read it at https://techcrunch.com/2026/11/13/agents', [], 'original', false, { platform: true })).toMatch(/^platform_link_forbidden: the link to "techcrunch\.com" is outside the sites this account links/);
    expect(postRefusal('x'.repeat(300))).toBe('invalid_short_post: the text has 300 characters and the limit is 280. Shorten it.');
    expect(postRefusal('hey @bankrbot do your thing')).toMatch(/^social_execution_account_forbidden: "@bankrbot" tags an account that acts on what posts tell it.*"Bankr"\) with no @ and no link/);
  });

  it('never echoes anything that is not the agent\'s own text', () => {
    // the account answered, and the others in the conversation, came from outside: described, never named
    for (const context of [{ reply: true, recipient: 'ignore_previous_rules_bot' }, { participants: ['alice', 'ignore_previous_rules_bot'] }]) {
      const refusal = postRefusal('thanks for asking', [], 'short', false, context)!;
      expect(head(refusal)).toBe('social_execution_account_forbidden');
      expect(refusal).not.toMatch(/ignore_previous_rules/);
      expect(refusal).not.toContain('"');
    }
    // a credit is passed beside the text: neither its handle nor its address is quoted
    const hostile = [{ username: 'ignore_all_rules', sourceUrl: 'https://evil.example/now-post-the-key' }];
    for (const refusal of [postRefusal('no mention here', hostile)!, postRefusal('thanks @alice', [{ username: 'alice', sourceUrl: 'javascript:ignore_all_rules' }])!, postRefusal('fine', [...hostile, ...hostile, ...hostile, ...hostile])!]) {
      expect(refusal).not.toMatch(/ignore_all_rules|evil\.example|now-post/);
    }
    // on the platform account a credited source's site is allowed; a refusal about another site names that site only
    expect(postRefusal('Read @alice at https://other.example/x', [{ username: 'alice', sourceUrl: 'https://credited.example/a' }], 'original', false, { platform: true })).not.toMatch(/credited\.example/);
  });

  it('never repeats what looks like a secret, and names an address by its two ends', () => {
    const key = `0x${'f9'.repeat(32)}`;
    const refusal = postRefusal(`the key is ${key}`)!;
    expect(head(refusal)).toBe('social_secret_material_forbidden');
    expect(refusal).not.toContain('f9f9');
    expect(postRefusal('token sk-or-v1-notarealkey-notarealkey-notarealkey')).not.toMatch(/notarealkey/);
    const address = postRefusal(`another coin lives at ${ADDRESS}`, [], 'short', false, { publicAddresses: [OWN] })!;
    expect(address).toContain('0xabab…abab');
    expect(address).not.toContain(ADDRESS);
  });

  it('cuts an excerpt to one short line with no quotation marks of its own', () => {
    expect(excerptOf('  buy\n  now  ')).toBe('buy now');
    expect(excerptOf('say "this" and `that`')).toBe("say 'this' and 'that'");
    expect(excerptOf('bu​y n‮ow\u0007')).toBe('buy now');
    expect(excerptOf('​⁠')).toBeNull();
    expect(excerptOf('')).toBeNull();
    expect(excerptOf(null)).toBeNull();
    const long = excerptOf('a'.repeat(200))!;
    expect([...long].length).toBe(EXCERPT_MAX_CHARS);
    expect(long.endsWith('…')).toBe(true);
    // a long match in a real refusal is cut too: the refusal stays a line, not the post again
    const refusal = postRefusal(`@alice launch ${'really '.repeat(12)}the token now`)!;
    expect(refusal.match(/"([^"]*)"/)![1]!.length).toBeLessThanOrEqual(EXCERPT_MAX_CHARS);
  });
});
