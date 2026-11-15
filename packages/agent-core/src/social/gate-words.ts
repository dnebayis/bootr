/**
 * What the agent reads when the publish gate refuses a text. A bare code told the model nothing: in the week of 8 to
 * 14 November 2026 the platform account had 110 of 246 publishes refused and retried the same thought blind, two or
 * three paid thoughts a time (docs/dev/behaviour-check.md section 6). Every refusal now says what tripped and how to
 * say the thought so it passes.
 *
 * Two rules hold for every line here:
 *  - the code stays at the head, followed by a colon and a space: the log and the weekly check key on everything
 *    before the first space (`errorCodeOf` in the supervisor's runtime.ts);
 *  - the only text ever quoted is a short excerpt of the agent's OWN post. A handle that came from the conversation
 *    (the account replied to, a participant), a credit passed beside the text, and anything shaped like a secret are
 *    described, never echoed: the refusal is read by a model, and words from outside must not ride in on it.
 */

/** A refusal of the gate: the stable code, the words of the agent's own text that matched, and which branch of the rule. */
export interface GateFinding {
  code: string;
  /** A short cut of the agent's own text, as the gate read it (folded and lowercased for most rules). Null when nothing may be quoted. */
  excerpt?: string | null;
  /** The branch of the rule, where the advice differs by it (`mention`, `link`, `recipient`, `too_long`, ...). */
  cause?: string;
  /** Numbers the advice names (a length and its limit). */
  count?: number;
  limit?: number;
}

export const EXCERPT_MAX_CHARS = 60;

/** A hex string from 20 bytes on ("0x" and 40 or more hex digits): an address, a hash, part of a key. */
const LONG_HEX = /0x[0-9a-f]{40,}/gi;
/** A run of 32 or more letters and digits with both in it: a hex or base58 key, a token, a signature. No word is one. */
const LONG_RUN = /(?<![0-9a-z])(?=[0-9a-z]*[0-9])(?=[0-9a-z]*[a-z])[0-9a-z]{32,}(?![0-9a-z])/gi;
/** Such a string cut to its two ends, so the refusal names it and carries none of it ("0x1234…cdef"). */
const ends = (m: string): string => `${m.slice(0, m.startsWith('0x') || m.startsWith('0X') ? 6 : 4)}…${m.slice(-4)}`;

/**
 * A match made fit to quote: one line, no quotation marks of its own, no control, invisible format or private-use
 * characters (the platform rules read the raw text, where a zero-width or a direction mark may sit), no brackets, no
 * long hex or base58 run but its two ends (a refusal and the stored error once carried 58 hex digits of a 32-byte
 * secret the post held), at most `max` characters. Cut at the end, since the start of a match is where the rule's word stands. Brackets are dropped since
 * a supervisor that read a refusal for X's own `forbidden(403)` took the agent's quoted words for X's answer (the
 * security review of 2026-11-15; the classifiers now read the code head only, and this keeps the words from looking
 * like a code at all).
 */
export function excerptOf(match: string | null | undefined, max: number = EXCERPT_MAX_CHARS): string | null {
  const flat = (match ?? '')
    .replace(/[\p{Cc}\p{Cf}\p{Co}]/gu, (c) => (/\s/.test(c) ? ' ' : ''))
    .replace(LONG_HEX, ends)
    .replace(LONG_RUN, ends)
    .replace(/["“”`]/g, "'")
    .replace(/[()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!flat) return null;
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max - 1).join('').trimEnd()}…` : flat;
}

const quoted = (f: GateFinding, fallback: string): string => (f.excerpt ? `"${f.excerpt}"` : fallback);

/** The sites the platform account links, in the words of its refusal (post-validation.ts `PLATFORM_LINK_HOSTS`). */
const PLATFORM_SITES = 'bootr.fun, x.com, basescan.org, clanker.world and dexscreener.com';

/**
 * What tripped and how to say it, for one finding: one or two plain sentences with no code at their head. Null for a
 * code the gate does not own (the sender's consent and quota refusals carry their own words).
 */
export function gateWords(f: GateFinding): string | null {
  switch (f.code) {
    case 'social_execution_account_forbidden':
      if (f.cause === 'recipient') return 'the account this would reach acts on what posts tell it, and you never answer or tag one. Leave it unanswered; in a post of your own you may name the project in plain words, with no @ and no link to it.';
      if (f.cause === 'link')
        return `${quoted(f, 'the link')} links an account that acts on what posts tell it: a link to it or to one of its posts quotes it and notifies it, as an @ does. Take the link out as well as any @, and name the project in plain words (for example "Bankr"); credit its news by name and date in words.`;
      return `${quoted(f, 'the text')} tags an account that acts on what posts tell it, and your posts never tag one, link it or answer it. Name the project in plain words (for example "Bankr") with no @ and no link to its account or its posts.`;
    case 'social_wallet_payload_forbidden':
      return `${quoted(f, 'the text')} is something a wallet or a signer can act on (a payment link, a signing call, a raw signature, an address to sign for, fees routed to an account). Say the thought in plain words without it.`;
    case 'social_execution_link_forbidden':
      return `${quoted(f, 'the link')} opens a ready-made post or share window. Link the post or the page itself.`;
    case 'social_execution_command_forbidden':
      return `${quoted(f, 'the text')} reads as an order to launch, pay, trade, approve or sign, given to somebody (an account the text names or links, or the one it answers), or as fees routed to somebody. Report it with a subject before the verb, as what somebody did or what a product lets people do ("agents can now pay per search"), and give nobody an order.`;
    case 'social_secret_material_forbidden':
      return 'the text carries something shaped like a key, a token or a 32-byte hex string. Leave it out; a transaction is named only by its basescan.org/tx/ link.';
    case 'social_internal_reference_forbidden':
      return `${quoted(f, 'the text')} is an internal address or the name of a setting. Leave it out.`;
    case 'social_runtime_jargon_forbidden':
      return `${quoted(f, 'a word in the text')} is a word from the machinery behind you, not one a reader uses. Say what happened in everyday words ("I looked again" for a wake, "what I am allowed to spend" for an allowance).`;
    case 'social_private_address_forbidden':
      return `the address ${f.excerpt ?? 'in the text'} is neither your coin's nor your treasury's, and those are the only two you may publish. Describe the other one in words, or link its page.`;
    case 'social_unreadable_number_forbidden':
      return `${quoted(f, 'a number in the text')} is in scientific notation, which nobody reads. Write it out or round it ("$0.0000002", "about 23 thousand").`;
    case 'invalid_short_post':
    case 'invalid_original_post':
      if (f.cause === 'too_long') return `the text has ${f.count} characters and the limit is ${f.limit}. Shorten it.`;
      if (f.cause === 'attributions') return 'attributions must be a list of at most 3 sources.';
      return 'the text is empty. Write the post.';
    case 'x_post_requires_at_most_one_cashtag':
      return `the text carries more than one cashtag${f.excerpt ? ` (${f.excerpt})` : ''} and X allows one a post. Keep your own and write every other coin's name in words, without the $.`;
    case 'invalid_source_credit':
      return 'a source in attributions is malformed: each one is a username (the X handle, no @) and an https sourceUrl, and no handle appears twice.';
    case 'mentions_require_source_credit':
      if (f.cause === 'too_many') return 'the text names more than 3 accounts with an @. Name 3 at most.';
      if (f.cause === 'credit_without_mention') return 'attributions lists an account the text does not name with an @. Name it in the text, or drop it from attributions.';
      return `${quoted(f, 'a handle in the text')} is named with an @ but has no source in attributions. Add its post to attributions, or write the name without the @.`;
    case 'platform_treasury_talk_forbidden':
      return `${quoted(f, 'the text')} reads as you reporting your own money (you claiming, swapping, refuelling, spending or earning; your fees, gas, treasury or balance), which this account does not narrate. Explaining how fees work on Bootr, or what somebody else earns, passes: say it without yourself as the one who holds or moves the money.`;
    case 'platform_price_talk_forbidden':
      return `${quoted(f, 'the text')} reads as a market call or hype, which this account never posts. State the fact (a price, a volume, a count, what happened) with no prediction, no nudge and no trading slang; "buy" and "sell" pass as plain verbs ("agents buy services"), not with a coin as their object, "now" or "more" after them, or a nudge before them.`;
    case 'platform_foreign_cashtag_forbidden':
      return `${quoted(f, 'a cashtag in the text')} is another coin's cashtag, and this account uses only $BOOTR. Write the coin's name in words, without the $.`;
    case 'platform_shouting_forbidden':
      return `${quoted(f, 'part of the text')} is written in capitals. Write it in ordinary case.`;
    case 'platform_emoji_string_forbidden':
      return 'the text carries a run of emoji. Use none.';
    case 'platform_link_forbidden':
      return `the link to ${quoted(f, 'a site')} is outside the sites this account links (${PLATFORM_SITES}). Credit an outside source by its name and date in words and leave the link out.`;
    default:
      return null;
  }
}

/** The refusal as the agent reads it: the code, a colon, then what tripped and what to do. The bare code when the gate has no words for it. */
export function gateRefusal(f: GateFinding): string {
  const words = gateWords(f);
  return words ? `${f.code}: ${words}` : f.code;
}
