/**
 * The rules for a coin's own links (website, the project's X account, Telegram, Discord): one place for the launch
 * form, the launch draft store, the agent launch API and the creator's links form on the coin page, so every path
 * accepts the same spellings and stores the same URLs. Imports nothing but lib/x-link.ts: safe on the client and
 * the server.
 */
import { normalizeXLink } from './x-link';

/** `website` any https URL; the others their own hosts; `x` is `https://x.com/<handle>` (lib/x-link.ts). */
export type CoinLinks = { website: string | null; x: string | null; telegram: string | null; discord: string | null };

export const LINK_KINDS = ['website', 'x', 'telegram', 'discord'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

export const NO_LINKS: CoinLinks = { website: null, x: null, telegram: null, discord: null };

const MAX_LINK = 200;
const LINK_HOST: Record<Exclude<LinkKind, 'x'>, RegExp | null> = {
  website: null,
  telegram: /^https:\/\/t\.me\//i,
  discord: /^https:\/\/(discord\.gg|discord\.com\/invite)\//i,
};

/** What the forms say when a link is not acceptable (the same words on the launch form and the coin page). */
export const LINK_ERRORS: Record<LinkKind, string> = {
  website: 'Website must be an https URL.',
  x: 'X must be an x.com link or a handle.',
  telegram: 'Telegram must be an https://t.me/ link.',
  discord: 'Discord must be an https://discord.gg/ invite.',
};

/** One optional link: null when absent or empty, undefined when present but not acceptable, else the stored form. */
export function normalizeLink(kind: LinkKind, v: unknown): string | null | undefined {
  if (kind === 'x') return normalizeXLink(v);
  if (v == null) return null;
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  if (!s) return null;
  if (s.length > MAX_LINK || !/^https:\/\/[^\s"<>]+$/.test(s)) return undefined;
  const host = LINK_HOST[kind];
  return host && !host.test(s) ? undefined : s;
}

/** The form's links, or null when any of them is not acceptable. Missing fields (older drafts) are null. */
export function normalizeLinks(input: unknown): CoinLinks | null {
  const r = checkLinks(input);
  return r.ok ? r.links : null;
}

/**
 * The same check with a reason: the first link that is not acceptable, by name, with the message the form shows.
 * Anything that is not an object counts as "no links".
 */
export function checkLinks(input: unknown): { ok: true; links: CoinLinks } | { ok: false; field: LinkKind; message: string } {
  const o = input && typeof input === 'object' ? (input as Record<string, unknown>) : {};
  const links = { ...NO_LINKS };
  for (const kind of LINK_KINDS) {
    const v = normalizeLink(kind, o[kind]);
    if (v === undefined) return { ok: false, field: kind, message: LINK_ERRORS[kind] };
    links[kind] = v;
  }
  return { ok: true, links };
}

export function sameLinks(a: CoinLinks, b: CoinLinks): boolean {
  return LINK_KINDS.every((k) => a[k] === b[k]);
}
