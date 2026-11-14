/**
 * HTML pages without a feed (docs/design/agent-behaviour.md section 6.7): a page is read by its list of links and a
 * hash of what it shows; only new links become sightings. Nothing here runs or renders the page: comments, script,
 * style and other non-text blocks are cut out in one forward pass (linear, whatever the page nests or leaves open),
 * links are found by a bounded pattern on a bounded window, at most ANCHOR_TRIES_MAX tags a page, and the strings that
 * come out are raw until clean.ts has been over them (build.ts).
 */
import { createHash } from 'node:crypto';

export const PAGE_LINKS_MAX = 400;
/** `<a` tags looked at on one page, matched or not: what bounds the work on a page made of nothing else. */
const ANCHOR_TRIES_MAX = 4000;
const ANCHOR_WINDOW = 8200;
/** What is cut out before anything is read: `[opening, closing]`, lowercase. */
const BLOCKS: readonly (readonly [string, string])[] = [
  ['<script', '</script'],
  ['<style', '</style'],
  ['<noscript', '</noscript'],
  ['<svg', '</svg'],
  ['<template', '</template'],
  ['<iframe', '</iframe'],
  ['<!--', '--'],
];

/** `html` without its comments and its script, style and other non-text blocks. An unclosed block takes the rest of the page with it. */
export function stripBlocks(html: string): string {
  const lower = html.toLowerCase();
  const parts: string[] = [];
  // The next opening of each kind, searched again only once the scan has passed it: one forward pass in all.
  const next = BLOCKS.map(([open]) => lower.indexOf(open));
  let at = 0;
  for (;;) {
    let which = -1;
    for (let i = 0; i < BLOCKS.length; i++) {
      if (next[i]! >= 0 && next[i]! < at) next[i] = lower.indexOf(BLOCKS[i]![0], at);
      if (next[i]! >= 0 && (which < 0 || next[i]! < next[which]!)) which = i;
    }
    if (which < 0) break;
    const start = next[which]!;
    parts.push(html.slice(at, start));
    const close = lower.indexOf(BLOCKS[which]![1], start + BLOCKS[which]![0].length);
    if (close < 0) return parts.join(' ');
    const end = lower.indexOf('>', close);
    if (end < 0) return parts.join(' ');
    at = end + 1;
  }
  parts.push(html.slice(at));
  return parts.join(' ');
}

/** What a reader of the page sees, as one line of text: blocks and tags out, whitespace collapsed. For hashing and for a watched field. */
export function visibleText(html: string): string {
  return stripBlocks(html)
    .replace(/<[^<>]{0,5000}>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export const hashOf = (text: string): string => createHash('sha256').update(text).digest('hex');

export interface PageLink {
  /** Absolute URL, as written on the page and resolved against it. Raw. */
  href: string;
  /** The link's text with its inner tags removed. Raw. */
  text: string;
}

const ANCHOR = /<a\s[^<>]{0,2000}?href\s*=\s*(?:"([^"]{1,2000})"|'([^']{1,2000})')[^<>]{0,2000}>([\s\S]{0,4000}?)<\/a\s*>/iy;

/** The links of a page with their texts, at most PAGE_LINKS_MAX; of several links to one address the longest text is kept. */
export function pageLinks(html: string, baseUrl: string): PageLink[] {
  const byHref = new Map<string, string>();
  const body = stripBlocks(html);
  const lower = body.toLowerCase();
  let at = lower.indexOf('<a');
  for (let tries = 0; at >= 0 && tries < ANCHOR_TRIES_MAX && byHref.size < PAGE_LINKS_MAX; tries++) {
    // Each tag is tried on its own bounded window, so a page of unclosed anchors costs a fixed amount per tag.
    ANCHOR.lastIndex = 0;
    const m = ANCHOR.exec(body.slice(at, at + ANCHOR_WINDOW));
    at = lower.indexOf('<a', at + 2);
    if (!m) continue;
    let href: string;
    try {
      href = new URL((m[1] ?? m[2] ?? '').replace(/&amp;/g, '&'), baseUrl).toString();
    } catch {
      continue;
    }
    const text = (m[3] ?? '').replace(/<[^<>]{0,2000}>/g, ' ').replace(/\s+/g, ' ').trim();
    const before = byHref.get(href);
    if (before === undefined || text.length > before.length) byHref.set(href, text);
  }
  return [...byHref.entries()].map(([href, text]) => ({ href, text }));
}

/**
 * The one of `values` that stands right after the word `after` in the page's text (only spaces and punctuation
 * between), or null: a watched field read by its place and a fixed list, never by what the page says around it.
 */
export function watchedValue(text: string, after: string, values: readonly string[]): string | null {
  const lower = text.slice(0, 200_000).toLowerCase();
  const needle = after.toLowerCase();
  // The longest value first, so "Last Call" is not read as something shorter.
  const ordered = [...values].sort((a, b) => b.length - a.length);
  for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, at + 1)) {
    const rest = lower.slice(at + needle.length, at + needle.length + 60).replace(/^[^a-z0-9]+/, '');
    const value = ordered.find((v) => rest.startsWith(v.toLowerCase()) && !/[a-z0-9]/.test(rest.charAt(v.length)));
    if (value) return value;
  }
  return null;
}
