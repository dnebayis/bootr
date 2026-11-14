/**
 * From what a reader found to a sighting the store may hold. This is the one place raw strings of an open source turn
 * into stored fields, and every one of them goes through clean.ts here: the title and the excerpt are cleaned and
 * bounded, the link must be an https URL on the source's own hosts, the pages an item points at are kept only as link
 * keys on hosts of the source list, numbers are found by pattern, entities by the checked-in list, the kind by fixed
 * words. An item whose title reads like an instruction keeps its place as a sighting and loses its words.
 *
 * What is not a sighting at all: an item with no title, one older than MAX_ITEM_AGE_MS (a feed's back catalogue is not
 * news on the day Bootr first reads it), one outside the scope (matching.ts `outOfScope`), and, for a broad source
 * (`needsTopic`), one that names neither an entity of the list nor the subject (crypto, stablecoins, agents, AI).
 */
import { canonicalLink, cleanText, EXCERPT_MAX, EXTERNAL_ID_MAX, instructionShaped, linkKey, numbersOf, parseDate, TITLE_MAX } from './clean.js';
import { entitiesOf, ENTITIES_MAX } from './entities.js';
import { classifyKind, outOfScope, wordSet } from './matching.js';
import { LINK_HOSTS, type OpenSource } from './sources.js';
import { REFS_MAX } from './store.js';
import type { EventPrecision, RecordKind, RecordNumber, Sighting } from './types.js';

export const MAX_ITEM_AGE_MS = 7 * 86_400_000;

const TOPIC = /\b(?:crypto\w*|digital assets?|virtual assets?|digital (?:euro|dollar|pound|currenc(?:y|ies))|cbdcs?|blockchains?|stablecoins?|token(?:s|i[sz]ed|i[sz]ation)?|defi|on-?chain|web3|smart contracts?|ai agents?|agentic|artificial intelligence|language models?|llms?|ai)\b/i;

/** What a reader hands over for one item: raw strings from the source, and what code itself already knows about it. */
export interface RawItem {
  id: unknown;
  title: unknown;
  summary?: unknown;
  link?: unknown;
  published?: unknown;
  /** Raw addresses the item points at. */
  hrefs?: readonly unknown[];
  /** Raw text that names entities without being shown (a chain name, an agency). */
  about?: unknown;
  kind?: RecordKind;
  /** When code knows the event's own time (a dated list of incidents, a document's publication day). */
  eventTime?: Date | null;
  eventPrecision?: EventPrecision;
  numbers?: RecordNumber[];
  /** The item has no date of its own and is known to be new (an HTML page's new link). */
  undated?: boolean;
}

export type Built = { sighting: Sighting } | { dropped: 'empty' | 'old' | 'scope' | 'topic' };

export function sourceHosts(source: Pick<OpenSource, 'url' | 'page' | 'hosts'>): Set<string> {
  const hosts = [new URL(source.url).hostname, ...(source.page ? [new URL(source.page).hostname] : []), ...(source.hosts ?? [])].map((h) => h.toLowerCase());
  return new Set(hosts.flatMap((h) => [h, h.replace(/^www\./, '')]));
}

export function buildSighting(source: OpenSource, item: RawItem, now: Date): Built {
  const title = cleanText(item.title, TITLE_MAX);
  if (!title) return { dropped: 'empty' };
  const publishedAt = parseDate(item.published, now.getTime());
  if (publishedAt && now.getTime() - publishedAt.getTime() > MAX_ITEM_AGE_MS) return { dropped: 'old' };
  if (!publishedAt && !item.undated && !item.eventTime) return { dropped: 'old' };
  if (outOfScope(title)) return { dropped: 'scope' };
  const rawExcerpt = cleanText(item.summary, EXCERPT_MAX);
  const about = `${title} ${rawExcerpt} ${cleanText(item.about, 300)}`;
  const named = entitiesOf(about);
  const own = new Set([...(source.entities ?? []), ...source.officialFor]);
  if (source.needsTopic && !named.some((e) => !own.has(e)) && !TOPIC.test(about)) return { dropped: 'topic' };
  const withheld = instructionShaped(title);
  const excerpt = withheld || !rawExcerpt || instructionShaped(rawExcerpt) ? null : rawExcerpt;
  const hosts = sourceHosts(source);
  const link = canonicalLink(item.link, hosts);
  const ownKey = link ? linkKey(link) : null;
  const refs = [...new Set((item.hrefs ?? []).map((h) => canonicalLink(h, LINK_HOSTS)).filter((l): l is string => !!l && !hosts.has(new URL(l).hostname)).map(linkKey))].filter((k) => k !== ownKey).slice(0, REFS_MAX);
  const id = cleanText(item.id, EXTERNAL_ID_MAX) || link || title;
  const namedHere = [...new Set([...(source.subject ?? []), ...named])];
  // The time an item was published is when the event happened only where the entity itself says so about itself.
  const official = source.officialFor.some((e) => namedHere.includes(e));
  const eventTime = item.eventTime ?? (official ? publishedAt : null);
  return {
    sighting: {
      sourceId: source.id,
      externalId: id,
      kind: item.kind ?? classifyKind(title, source.defaultKind),
      title: withheld ? '' : title,
      excerpt,
      withheld,
      link,
      key: null,
      refs,
      entities: [...new Set([...(source.entities ?? []), ...named])].slice(0, ENTITIES_MAX),
      named: namedHere.slice(0, ENTITIES_MAX),
      words: withheld ? [] : wordSet(title),
      numbers: withheld ? [] : (item.numbers ?? numbersOf(title, source.id, publishedAt)),
      eventTime,
      eventEnd: null,
      eventPrecision: eventTime ? (item.eventPrecision ?? 'second') : 'unknown',
      publishedAt,
    },
  };
}

/**
 * A reading code made itself: one record per source, subject and day, found again by its key. The headline and the
 * summary are sentences written here from numbers; nothing in them is a string a source wrote, except `label`, which
 * the caller takes from its own fixed table.
 */
export function metricSighting(source: Pick<OpenSource, 'id' | 'page' | 'url' | 'entities' | 'hosts' | 'subject'>, subject: string, day: string, headline: string, numbers: RecordNumber[], entities: readonly string[], summary: string | null = null): Sighting {
  const key = `m:${source.id}:${subject}:${day}`;
  const at = new Date(`${day}T00:00:00.000Z`);
  return {
    sourceId: source.id,
    externalId: key,
    kind: 'metric',
    title: headline,
    excerpt: null,
    withheld: false,
    link: source.page ? canonicalLink(source.page, sourceHosts(source)) : null,
    key,
    refs: [],
    entities: [...new Set([...(source.entities ?? []), ...entities])].slice(0, ENTITIES_MAX),
    // What code itself says the reading is about.
    named: [...new Set([...(source.subject ?? []), ...entities])].slice(0, ENTITIES_MAX),
    words: [],
    numbers,
    eventTime: at,
    eventEnd: null,
    eventPrecision: 'day',
    publishedAt: null,
    summary,
  };
}

/** A plain figure for a headline code writes: `5.22B`, `73.3M`, `9,650,367`. */
export function figure(value: number): string {
  const n = Math.abs(value);
  if (n >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (n >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return Number.isInteger(value) ? value.toLocaleString('en-US') : value.toFixed(2);
}
