/**
 * The platform account's voice, made certain in code: all lowercase and no emoji. The prompt asks for it; this makes
 * the text that reaches X right even when the model slips, without refusing the post and buying another thought.
 *
 * Kept as written: links (a path is case-sensitive), cashtags ($BOOTR), @handles, and 0x addresses and hashes (a
 * checksummed address is mixed case on purpose). Everything else is lowercased; emoji, their joiners and variation
 * selectors are removed and the gaps they leave are closed.
 */
const EMOJI = /\p{Extended_Pictographic}|[\u{1F1E6}-\u{1F1FF}]|[\u{1F3FB}-\u{1F3FF}]|\u{FE0F}|\u{200D}|\u{20E3}/gu;
const KEEP = /https?:\/\/\S+|(?<![\w@/.-])(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*|\$[A-Za-z][A-Za-z0-9_]*|0x[0-9a-fA-F]{6,}|[@＠][A-Za-z0-9_]+/gi;

const CASHTAG = /(?<![a-z0-9_])\$([a-z][a-z0-9_]*)\b/gi;
const LINK = /https?:\/\/\S+|(?<![\w@/.-])(?:www\.)?(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;

/**
 * One cashtag, written once: when every cashtag in the text is the same symbol, the later ones lose their `$`
 * ("0.3% of each $BOOTR trade" after "a $BOOTR fact" reads "0.3% of each BOOTR trade"). X allows one cashtag a post
 * and counts a repeat as a second, so the gate refused four such posts in the week of 8 to 14 November 2026 for a
 * symbol the post was allowed to name. Two different symbols are left as they are, and refused by the gate as before;
 * a `$` inside a link is never touched. Applied for every agent, to each part of a thread by itself.
 */
export function oneCashtag(text: string): string {
  const links = [...text.matchAll(LINK)].map((m) => [m.index, m.index + m[0].length] as const);
  const tags = [...text.matchAll(CASHTAG)].filter((m) => !links.some(([from, to]) => m.index >= from && m.index < to));
  if (tags.length < 2 || new Set(tags.map((m) => m[1]!.toUpperCase())).size > 1) return text;
  let out = text;
  for (const m of tags.slice(1).reverse()) out = out.slice(0, m.index) + out.slice(m.index + 1);
  return out;
}

export function plainVoice(text: string): string {
  const bare = text
    .replace(EMOJI, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([.,!?;:])/g, '$1')
    .replace(/[ \t]+$/gm, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  let out = '';
  let at = 0;
  for (const m of bare.matchAll(KEEP)) {
    out += bare.slice(at, m.index).toLowerCase() + m[0];
    at = m.index + m[0].length;
  }
  return out + bare.slice(at).toLowerCase();
}
