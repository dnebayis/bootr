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
