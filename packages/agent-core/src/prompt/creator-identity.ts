/**
 * The creator's "Identity" text from the launch form, as it reaches the agent's `identityText`.
 *
 * The text is written by the coin's creator (20 to 600 characters in the form), stored by the web app
 * under the launch draft id and published in the hosted ERC-8004 agent card as `bootr.identity`. The
 * supervisor reads it from there when it registers the launch. It fills the identity slot of the system
 * prompt, which the OWNER RULES, VOICE and BOOTR RULES sections rank above, so it describes who the
 * agent is and how it talks; it carries no authority over the runtime.
 */

/** Hard cap on the creator text, matching the launch form's `maxLength`. */
export const MAX_CREATOR_IDENTITY_CHARS = 600;

/**
 * Plain text only: `\r\n` and `\r` become `\n`, tabs become spaces, other control characters and
 * bidi/zero-width format characters are dropped, runs of blank lines collapse to one, runs of spaces to
 * one, and the result is trimmed and cut at MAX_CREATOR_IDENTITY_CHARS (by code point, so a cut never
 * splits a surrogate pair). Anything that is not a string normalizes to ''.
 */
export function normalizeCreatorIdentity(input: unknown): string {
  if (typeof input !== 'string') return '';
  const text = input
    .replace(/\r\n?/g, '\n')
    .replace(/\t/g, ' ')
    // C0/C1 controls except \n, plus bidi overrides, zero-width and byte-order marks.
    // eslint-disable-next-line no-control-regex -- the C0 range is the point
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]/g, '')
    .replace(/[ \u00a0]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return Array.from(text).slice(0, MAX_CREATOR_IDENTITY_CHARS).join('').trim();
}

/**
 * `identityText` for a launch: the creator's text first (it says who the agent is), then Bootr's default
 * identity lines for the coin or the platform. Without a creator text it is the default alone.
 */
export function composeIdentityText(creatorIdentity: string | null | undefined, defaultIdentity: string): string {
  const creator = normalizeCreatorIdentity(creatorIdentity);
  return creator ? `${creator}\n\n${defaultIdentity}` : defaultIdentity;
}
