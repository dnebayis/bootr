/**
 * Small pure pieces of how a thread, a post written ahead and a comment are shown (docs/design/agent-tools-2.md
 * sections 3.5, 4.2 and 5.5): the link to the post a comment is about, the comment's line split around the words
 * that carry that link, and the sentence that tells a creator when a post written ahead goes out. Used by the
 * server-side sanitizers and by the components alike, so both hold a handle and a post id to the same form.
 */

/** An X handle and a post id as X writes them. A link to a post on X is built from these two and from nothing else. */
export const X_HANDLE_STRICT_RE = /^[A-Za-z0-9_]{1,15}$/;
export const X_POST_ID_RE = /^[0-9]{1,25}$/;

/**
 * The link to the post a comment is about: `https://x.com/<handle>/status/<id>`, built here, so the only place it can
 * lead is that post on X. Null when the handle or the id is not text in X's own form; a link that came with them is
 * never read.
 */
export function aboutHref(about: unknown): string | null {
  const a = (about && typeof about === 'object' && !Array.isArray(about) ? about : null) as { handle?: unknown; postId?: unknown } | null;
  if (!a || typeof a.handle !== 'string' || typeof a.postId !== 'string') return null;
  return X_HANDLE_STRICT_RE.test(a.handle) && X_POST_ID_RE.test(a.postId) ? `https://x.com/${a.handle}/status/${a.postId}` : null;
}

/**
 * A comment's line split around the words that name its source ("a post by @handle"); those words become the link to
 * that post. A line that does not carry them is kept whole and the link follows it.
 */
export function aboutParts(summary: string, handle: string): { before: string; link: string; after: string } {
  const phrase = `a post by @${handle}`;
  const i = summary.indexOf(phrase);
  return i < 0 ? { before: `${summary} `, link: `The post by @${handle}`, after: '' } : { before: summary.slice(0, i), link: phrase, after: summary.slice(i + phrase.length) };
}

/**
 * What a creator is told about the time of a post their agent wrote ahead and that waits for their review. Before its
 * time: when it goes out, and that only an approval lets it. After its time: that approving now sends it at once, and
 * that a post too far past its time is not sent at all. `now` is 0 until the page knows the time; the sentence then
 * names the time alone. `when` and `until` are the page's own ways to write a time ("Fri 14 Nov, 10:00", "in 3 h").
 */
export function scheduledNote(scheduledFor: string, now: number, fmt: { when: (iso: string) => string; until: (iso: string, now: number) => string }): string {
  const when = fmt.when(scheduledFor);
  const at = Date.parse(scheduledFor);
  if (now && Number.isFinite(at) && at <= now) return `Its time was ${when}. Approve it and it goes out at once; a post too far past its time is not sent.`;
  const until = fmt.until(scheduledFor, now);
  return `Goes out ${when}${until && until !== 'now' ? ` (${until})` : ''}, and only if you approve it. Not approved in time, it is not sent.`;
}
