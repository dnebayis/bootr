/**
 * Inline markup of the docs content (`components/docs/content.ts`): a strict subset of Markdown, so the same
 * string renders as React on /docs and passes through unchanged into /llms-full.txt.
 *
 *   `code`            -> code span
 *   **bold**          -> strong
 *   [text](href)      -> link; `text` may itself hold code spans and bold
 *
 * Anything else is literal text. There is no escaping: content never needs a literal backtick, `**` or `](`.
 */

export type InlineNode =
  | { kind: 'text'; text: string }
  | { kind: 'code'; text: string }
  | { kind: 'strong'; children: InlineNode[] }
  | { kind: 'link'; href: string; children: InlineNode[] };

const TOKEN = /`([^`]+)`|\*\*(.+?)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

export function parseInline(src: string): InlineNode[] {
  const out: InlineNode[] = [];
  let last = 0;
  for (const m of src.matchAll(TOKEN)) {
    if (m.index > last) out.push({ kind: 'text', text: src.slice(last, m.index) });
    if (m[1] !== undefined) out.push({ kind: 'code', text: m[1] });
    else if (m[2] !== undefined) out.push({ kind: 'strong', children: parseInline(m[2]) });
    else out.push({ kind: 'link', href: m[4]!, children: parseInline(m[3]!) });
    last = m.index + m[0].length;
  }
  if (last < src.length) out.push({ kind: 'text', text: src.slice(last) });
  return out;
}

/** The text a reader sees, without markup (headings' anchor text, table of contents, descriptions). */
export function inlineText(src: string): string {
  const walk = (nodes: InlineNode[]): string =>
    nodes.map((n) => (n.kind === 'text' || n.kind === 'code' ? n.text : walk(n.children))).join('');
  return walk(parseInline(src));
}

/** Rewrites every link through `fn` (e.g. to make site-relative links absolute), keeping the rest verbatim. */
export function mapLinks(src: string, fn: (href: string) => string): string {
  return src.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => `[${text}](${fn(href)})`);
}
