/**
 * The shapes of Bootr's own dataset (docs/design/agent-behaviour.md section 6.4): a source, a sighting (one thing one
 * source showed once) and a record (one event, however many sources carried it). Everything here is plain data; the
 * rules live in clean.ts (what may be stored), matching.ts (which sighting belongs to which record) and grades.ts (how
 * a record is sourced).
 */

export const RECORD_KINDS = ['launch', 'release', 'incident', 'governance', 'regulation', 'product', 'metric', 'statement', 'outage', 'research'] as const;
export type RecordKind = (typeof RECORD_KINDS)[number];

/**
 * The clusters of section 6.4 with their weight: home ground 3, near 2, far 1. A record takes the heaviest cluster of
 * its sources; the weight orders what is kept when the day's cap is near and, in a later stage, what a turn is shown.
 */
export const CLUSTERS = {
  bootr: 3,
  base: 3,
  agents: 3,
  x402: 3,
  launchpads: 3,
  ethereum: 2,
  l2: 2,
  stablecoins: 2,
  payments: 2,
  'ai-labs': 2,
  security: 2,
  regulators: 2,
  governance: 2,
  x: 2,
  defi: 1,
  data: 1,
  'ai-research': 1,
  research: 1,
  news: 1,
} as const;
export type Cluster = keyof typeof CLUSTERS;
export const clusterWeight = (cluster: string): number => (CLUSTERS as Record<string, number>)[cluster] ?? 1;

/** The layer a source belongs to: `a` the chain and Bootr's own data, `b` open sources read without X, `c` X accounts (a later stage). */
export type Layer = 'a' | 'b' | 'c';

/** How a layer-b source is read (readers/): a feed (RSS or Atom, GitHub releases included), a JSON API, an HTML page's list of links. */
export type SourceKind = 'feed' | 'json' | 'html' | 'chain' | 'x';

export const GRADES = [1, 2, 3, 4, 5] as const;
export type Grade = (typeof GRADES)[number];
/** The five steps as section 6.4 words them. A grade describes how a record is sourced, never whether it is true. */
export const GRADE_WORDS: Record<Grade, string> = {
  1: 'single sighting',
  2: 'repeated, unsourced or one group',
  3: 'an outside source is cited or two independent groups',
  4: 'an official source of one of its entities',
  5: 'official and two more independent groups',
};

export const RECORD_STATUSES = ['open', 'corroborated', 'disputed', 'corrected', 'withdrawn'] as const;
export type RecordStatus = (typeof RECORD_STATUSES)[number];

/** How exactly an event's time is known. `planned` = announced for the future; `unknown` = the source gave none. */
export const EVENT_PRECISIONS = ['second', 'day', 'range', 'planned', 'unknown'] as const;
export type EventPrecision = (typeof EVENT_PRECISIONS)[number];

/** A number a record carries: the only numbers an agent may state from it. */
export interface RecordNumber {
  value: number;
  /** `usd`, `usdc`, `%`, a token symbol in lowercase, or '' for a plain count. */
  unit: string;
  /** What it counts, in code's own words (`tvl`, `thoughts`, `holders`) or a few cleaned words that stood by it in a title. */
  what: string;
  /** ISO time the value is as of, when the source said; null otherwise. */
  asOf: string | null;
  sourceId: string;
}

/** One source's place on a record. `group` is the organisation that counts once for independence. */
export interface RecordSource {
  sourceId: string;
  cluster: string;
  group: string;
  /**
   * The entity itself speaks here about itself: the source is official for an entity the item is about (its own text
   * names it, or the source is about nothing else) and, on a record that existed already, the record had that entity.
   */
  official: boolean;
  /** An open venue (anyone with an account writes there): carried, never counted as an independent group. */
  open?: boolean;
  /** Canonical https link on a host of the source list, or null. */
  link: string | null;
  /** ISO time Bootr first saw this source carry the event. */
  seenAt: string;
}

export interface RecordChange {
  at: string;
  /** What changed, in code's words: `headline`, `number:<what>`, `status`, `kind`. */
  what: string;
  from?: string;
  to?: string;
}

/** Who already posted about a record. Written by a later stage (the publish path), never by the dataset process. */
export interface RecordPosted {
  agentId: string;
  postId: string;
  at: string;
}

/**
 * One thing one source showed, after cleaning: every string in it has been through clean.ts and is bounded. `key` is
 * an identity code made itself (a chain event, a metric of a day), `link` the canonical link, `refs` the links or ids
 * the source itself said it is about (a quoted post, a cited page): matching reads those three before any word.
 */
export interface Sighting {
  sourceId: string;
  /** The source's own id for the item (a feed guid, a document number, a transaction hash), bounded. */
  externalId: string;
  kind: RecordKind;
  /** At most TITLE_MAX characters; '' when the text was withheld. */
  title: string;
  /** At most EXCERPT_MAX characters; null when there was none or it was withheld. */
  excerpt: string | null;
  /** The text read like an instruction (clean.ts `instructionShaped`): the sighting counts, its words are not kept. */
  withheld: boolean;
  link: string | null;
  key: string | null;
  /** Link keys (clean.ts `linkKey`) of the pages the item itself points at, on hosts of the source list, its own page left out. */
  refs: string[];
  entities: string[];
  /**
   * The entities the item itself is about: the ones its own text names, and the one a single-subject source is about
   * (sources.ts `subject`). A source is official for an item only through these, never through what it merely carries.
   */
  named: string[];
  /** The title's word set (matching.ts `wordSet`). */
  words: string[];
  numbers: RecordNumber[];
  /** When it happened or will happen, apart from when it was seen. */
  eventTime: Date | null;
  eventEnd: Date | null;
  eventPrecision: EventPrecision;
  /** What the source gave as its publication time, when it gave one. */
  publishedAt: Date | null;
  /** A summary code built itself from numbers (layer a, metrics). Never text from outside. */
  summary?: string | null;
  /** The coin a chain record is about (lowercase address): a later stage shows it to that coin's agent alone. */
  coin?: string | null;
}
