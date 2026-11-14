/**
 * RSS and Atom, read by hand. There is no XML parser here on purpose: nothing a document declares is ever expanded
 * (a DOCTYPE and its entities are text that is thrown away, so an entity bomb has nothing to expand into), every scan
 * is a forward search over a body that fetch.ts already cut at the source's byte cap, at most FEED_ITEMS_MAX items are
 * looked at and each is cut to ITEM_MAX characters before a pattern runs over it. What comes out is raw strings; they
 * become stored fields only through clean.ts (build.ts).
 */
import { decodeEntities } from '../clean.js';

export const FEED_ITEMS_MAX = 60;
/** Item blocks looked at in one document, kept or not: a feed of a million empty items is not read to its end. */
export const FEED_BLOCKS_MAX = 600;
const ITEM_MAX = 64_000;
const HREFS_MAX = 20;

export interface FeedItem {
  /** The feed's own id for the item (`guid`, `id`), else its link, else its title. Raw. */
  id: string;
  title: string;
  link: string | null;
  /** The description, summary or content. Raw, often escaped HTML. */
  summary: string;
  published: string | null;
  /** Raw `href`s found in the summary. */
  hrefs: string[];
}

const OPENING = new Map<string, RegExp>();
const opening = (name: string): RegExp => {
  let re = OPENING.get(name);
  if (!re) OPENING.set(name, (re = new RegExp(`<${name}(?:\\s[^>]{0,500})?>`, 'i')));
  return re;
};

function field(block: string, lower: string, names: readonly string[]): string {
  for (const name of names) {
    const open = opening(name).exec(block);
    if (!open) continue;
    const start = open.index + open[0].length;
    const end = lower.indexOf(`</${name.toLowerCase()}`, start);
    if (end < 0) continue;
    const value = block.slice(start, end).trim();
    if (value) return value;
  }
  return '';
}

const unwrap = (value: string): string => value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();

function atomLink(block: string): string | null {
  let fallback: string | null = null;
  for (const m of block.matchAll(/<link\s([^>]{0,1000})\/?>/gi)) {
    const attrs = m[1] ?? '';
    const href = /href\s*=\s*(?:"([^"]{1,2000})"|'([^']{1,2000})')/i.exec(attrs);
    if (!href) continue;
    const url = href[1] ?? href[2] ?? '';
    const rel = /rel\s*=\s*["']([a-z]+)["']/i.exec(attrs)?.[1]?.toLowerCase();
    if (!rel || rel === 'alternate') return url;
    fallback ??= rel === 'self' ? null : url;
  }
  return fallback;
}

function hrefsOf(summary: string): string[] {
  // A description is escaped HTML: the quotes around an href arrive as `&quot;`.
  const text = summary.slice(0, ITEM_MAX).replace(/&quot;|&#34;/g, '"').replace(/&apos;|&#39;/g, "'").replace(/&amp;/g, '&');
  const out: string[] = [];
  for (const m of text.matchAll(/href\s*=\s*(?:"([^"]{1,2000})"|'([^']{1,2000})')/gi)) {
    if (out.length >= HREFS_MAX) break;
    out.push(m[1] ?? m[2] ?? '');
  }
  return out;
}

/**
 * The items of an RSS or Atom document, newest as the feed orders them, at most FEED_ITEMS_MAX. Never throws.
 *
 * One forward pass. The next `<item` and the next `<entry` are each remembered and searched again only once the scan
 * has passed them, so a body of `<itemx` or `<entryway` tags (which are not items) is skipped in the time it takes to
 * read it once: searching both from every skipped tag made a 2 MB body cost minutes. At most FEED_BLOCKS_MAX blocks
 * are opened, whatever they hold.
 */
export function parseFeed(xml: string): FeedItem[] {
  const items: FeedItem[] = [];
  const lower = xml.toLowerCase();
  let nextItem = lower.indexOf('<item');
  let nextEntry = lower.indexOf('<entry');
  let at = 0;
  for (let looked = 0; items.length < FEED_ITEMS_MAX && looked < FEED_BLOCKS_MAX; ) {
    if (nextItem >= 0 && nextItem < at) nextItem = lower.indexOf('<item', at);
    if (nextEntry >= 0 && nextEntry < at) nextEntry = lower.indexOf('<entry', at);
    const start = nextItem < 0 ? nextEntry : nextEntry < 0 ? nextItem : Math.min(nextItem, nextEntry);
    if (start < 0) break;
    const tag = start === nextItem ? 'item' : 'entry';
    // `<items>` or `<entryway>` is not an item.
    const after = lower.charAt(start + tag.length + 1);
    if (after !== '>' && after !== ' ' && after !== '\n' && after !== '\t' && after !== '\r') {
      at = start + tag.length + 1;
      continue;
    }
    looked++;
    const close = lower.indexOf(`</${tag}>`, start);
    const end = Math.min(close < 0 ? xml.length : close, start + ITEM_MAX);
    const block = xml.slice(start, end);
    const blockLower = lower.slice(start, end);
    at = close < 0 ? xml.length : close + tag.length + 3;
    const title = unwrap(field(block, blockLower, ['title']));
    const summary = unwrap(field(block, blockLower, ['description', 'summary', 'content:encoded', 'content']));
    const rssLink = unwrap(field(block, blockLower, ['link']));
    // An address in XML has its `&` written as `&amp;`.
    const rawLink = (/^https?:\/\//i.test(rssLink) ? rssLink : null) ?? atomLink(block);
    const link = rawLink === null ? null : decodeEntities(rawLink.slice(0, 2000));
    const id = unwrap(field(block, blockLower, ['guid', 'id'])) || link || title;
    const published = unwrap(field(block, blockLower, ['pubDate', 'published', 'updated', 'dc:date'])) || null;
    if (!id) continue;
    items.push({ id, title, link, summary, published, hrefs: hrefsOf(summary) });
  }
  return items;
}
