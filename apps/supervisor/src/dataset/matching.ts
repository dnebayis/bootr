/**
 * Which record a sighting belongs to (docs/design/agent-behaviour.md section 6.4, "Matching a sighting to a record"),
 * cheapest first and without a model:
 *
 *  1. The same identity: a key code made itself (a chain event, a day's metric), or the same canonical link (tracking
 *     removed, `www.` and the scheme ignored). An official post and its blog page meet here.
 *  2. A stated relation: the source itself says what it is about. In this stage that is a link in the item to a page
 *     that is already a record's link; with layer c it is also X's own relation (a post that quotes or reposts a post
 *     already in a record), which arrives in the same `refs` field. An item that points at two different records (a
 *     weekly round-up) states no single relation and goes on to step 3. A link is something its writer chose, so it
 *     places a sighting only on a record it shares an entity with and inside the window step 3 uses, and a sighting
 *     that got onto a record by pointing at it is carried there and gives it nothing: no headline, no link, no time,
 *     no entity, no number, and it is never official (store.ts `attach`).
 *  3. Entities and words: a shared entity, a compatible kind, within MATCH_WINDOW_MS of the record, and a word-set
 *     overlap of OVERLAP_MIN or more (stop words and kind words out, numbers kept as words).
 *  4. NOT in this stage: what step 3 leaves between LEFTOVER_MIN and OVERLAP_MIN goes to the cheapest model as a
 *     yes-or-no question on two clipped texts. The seam is `matchByWords`'s `leftover` and the `judgeLeftover` option
 *     of store.ts `ingestSighting`: with no judge, a leftover sighting starts a record of its own.
 *
 * How "overlap" is read here: a sighting's title against each title the record already has, one at a time (never
 * against the record's words pooled: the common words of five desks would match anything), as the shared words over
 * the smaller of the two sets (two desks' titles for one event share most of the shorter one and little of the
 * longer), and never on less than SHARED_MIN shared words or a Jaccard under JACCARD_MIN, so a two-word title cannot
 * be swallowed by a long one. Three more guards keep different events apart: titles that carry different identifiers
 * (v1.9.1 and v1.9.2, proposal 17 and 18) are never one event; two items of one source are one event only when one
 * title is the other with a word or two added (every word of the shorter in the longer, and a Jaccard of
 * SAME_SOURCE_MIN), because a source does not publish one event twice and its titles share their opening words; and a
 * metric or a chain record is matched by its key alone.
 *
 * When a sighting is tied to one record by its link or a stated relation and to another by its words, the two records
 * were one event seen from two sides (a post-mortem page nobody had linked yet, and the desks' reports): store.ts
 * merges them, but only two records that already share an entity and are of kinds that can be one event. One
 * sighting's link and words are never enough by themselves to fold two stories together.
 */
import type { RecordKind } from './types.js';

export const MATCH_WINDOW_MS = 48 * 3_600_000;
/** A record stops taking new sightings by words this long after it was first seen, however often it was reinforced. */
export const MATCH_MAX_SPAN_MS = 7 * 24 * 3_600_000;
export const OVERLAP_MIN = 0.5;
export const LEFTOVER_MIN = 0.25;
export const JACCARD_MIN = 0.3;
export const SHARED_MIN = 3;
export const SAME_SOURCE_MIN = 0.8;
/** An unclassified item (`statement`) joins a record of another kind only on a clearer overlap. */
export const CROSS_KIND_MIN = 0.6;
export const WORDS_MAX = 40;

const STOP_WORDS = new Set(
  (
    'a an the and or but if then than that this these those of in on at by for from to into onto with without within over under about after before as is are was were be been being it its their his her our your my we they he she you i ' +
    'has have had will would can could may might should do does did not no yes up down out off new now more most less via per vs amid says said say here how what why when where who which also just still yet'
  ).split(' '),
);
/** Words that say what kind of thing happened, not which one: they are in every title of their kind. */
const KIND_WORDS =
  /^(?:launch|announc|introduc|unveil|debut|releas|updat|upgrad|propos|govern|report|exploit|attack)\w*$|^(?:vot(?:e|es|ed|ing)|hack(?:s|ed|er|ers|ing)?|charg(?:e|es|ed|ing)|sue[sd]?|fil(?:e|es|ed|ing)|plan(?:s|ned|ning)?|dao|news|press|statement|post|blog|incident|outage|issue|live|today|week|crypto|blockchain|protocol|network|project|team|company|platform)$/;

/** A crude stem: possessive, plural and tense endings and a final `e` off, so "launches", "launched" and "launch" are one word. */
function stem(word: string): string {
  let w = word.replace(/['’]s$/, '');
  // A compound, a version or a ticker is a name as written.
  if (w.length < 5 || !/^\p{L}+$/u.test(w)) return w;
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (w.endsWith(suffix) && !w.endsWith('ss') && w.length - suffix.length >= 4) {
      w = w.slice(0, -suffix.length);
      break;
    }
  }
  return w.endsWith('e') && w.length >= 5 ? w.slice(0, -1) : w;
}

/** The words of a cleaned title as a set: lowercased, stemmed, stop words and kind words out, numbers kept, at most WORDS_MAX, sorted. */
export function wordSet(title: string): string[] {
  const tokens = title.toLowerCase().match(/[\p{L}\p{N}]+(?:[.'’-][\p{L}\p{N}]+)*/gu) ?? [];
  const out = new Set<string>();
  for (const token of tokens) {
    if (out.size >= WORDS_MAX) break;
    if (token.length > 40) continue;
    const word = stem(token);
    if (word.length < 2 && !/\d/.test(word)) continue;
    if (STOP_WORDS.has(token) || STOP_WORDS.has(word) || KIND_WORDS.test(token)) continue;
    out.add(word);
  }
  return [...out].sort();
}

/** The identifiers among a word set: versions and bare numbers (`v1.9.1`, `1.2.0`, `17`, `8004`), without a leading `v`. */
export function identifiersOf(words: readonly string[]): string[] {
  return words.filter((w) => /^v?\d+(?:\.\d+)*$/.test(w)).map((w) => w.replace(/^v/, ''));
}

export interface Overlap {
  shared: number;
  /** Shared words over the smaller set. */
  overlap: number;
  jaccard: number;
}

export function overlapOf(a: readonly string[], b: readonly string[]): Overlap {
  if (!a.length || !b.length) return { shared: 0, overlap: 0, jaccard: 0 };
  const set = new Set(a);
  let shared = 0;
  for (const w of new Set(b)) if (set.has(w)) shared++;
  const union = new Set([...a, ...b]).size;
  return { shared, overlap: shared / Math.min(set.size, new Set(b).size), jaccard: shared / union };
}

const KIND_GROUPS: Record<RecordKind, string> = {
  launch: 'shipped',
  product: 'shipped',
  release: 'shipped',
  incident: 'broke',
  outage: 'broke',
  governance: 'governance',
  regulation: 'regulation',
  statement: 'said',
  research: 'said',
  metric: 'metric',
};

/** Whether two kinds can be one event: the same family, or one side unclassified (`statement`). */
export function kindsCompatible(a: RecordKind, b: RecordKind): 'same' | 'cross' | 'no' {
  if (a === 'metric' || b === 'metric') return 'no';
  if (KIND_GROUPS[a] === KIND_GROUPS[b]) return 'same';
  return a === 'statement' || b === 'statement' ? 'cross' : 'no';
}

/** What step 3 needs of a sighting. */
export interface WordsProbe {
  sourceId: string;
  kind: RecordKind;
  entities: readonly string[];
  words: readonly string[];
  /** When the source published it, else when it was seen. */
  at: Date;
}

/** What step 3 needs of a record it might belong to: the titles its sources gave it, each as a word set with its source. */
export interface WordsCandidate {
  id: string;
  kind: RecordKind;
  entities: readonly string[];
  sightings: readonly { sourceId: string; words: readonly string[] }[];
  firstSeenAt: Date;
  lastReinforcedAt: Date;
}

export interface WordsMatch {
  /** The record the sighting joins, or null. */
  recordId: string | null;
  overlap: number;
  /** Records step 3 could not decide (LEFTOVER_MIN up to OVERLAP_MIN), best first: what step 4 would ask a model about. */
  leftover: { recordId: string; overlap: number }[];
}

/** Step 3. Pure: the caller hands over the records of the window (store.ts `wordCandidates`). */
export function matchByWords(probe: WordsProbe, candidates: readonly WordsCandidate[]): WordsMatch {
  const none: WordsMatch = { recordId: null, overlap: 0, leftover: [] };
  if (probe.kind === 'metric' || !probe.entities.length || probe.words.length < 2) return none;
  const at = probe.at.getTime();
  const ids = identifiersOf(probe.words);
  let best = null as { id: string; overlap: number; jaccard: number } | null;
  const leftover: { recordId: string; overlap: number }[] = [];
  for (const c of candidates) {
    const compatible = kindsCompatible(probe.kind, c.kind);
    if (compatible === 'no') continue;
    if (at < c.firstSeenAt.getTime() - MATCH_WINDOW_MS || at > c.lastReinforcedAt.getTime() + MATCH_WINDOW_MS || at > c.firstSeenAt.getTime() + MATCH_MAX_SPAN_MS) continue;
    if (!c.entities.some((e) => probe.entities.includes(e))) continue;
    // The record is the probe's event when one of the titles it already has says so. A title is compared with a
    // title, never with all the record's words together: pooled, the common words of five desks match anything.
    let undecided = 0;
    for (const s of c.sightings) {
      const theirs = identifiersOf(s.words);
      if (ids.length && theirs.length && (ids.some((i) => !theirs.includes(i)) || theirs.some((i) => !ids.includes(i)))) continue;
      const o = overlapOf(probe.words, s.words);
      // One source's own items are one event only when one title is the other with a word or two added ("... (updated)"):
      // a forum's or a regulator's titles share their opening words, "Raise the USDC supply cap" and "Raise the WETH
      // supply cap" differ by one word and are two proposals, and "Proposal: X" is not "Proposal: X and Y".
      const sameSource = s.sourceId === probe.sourceId;
      const enough = sameSource ? o.overlap === 1 && o.jaccard >= SAME_SOURCE_MIN : o.overlap >= (compatible === 'cross' ? CROSS_KIND_MIN : OVERLAP_MIN) && o.jaccard >= JACCARD_MIN;
      if (enough && o.shared >= SHARED_MIN) {
        if (!best || o.overlap > best.overlap || (o.overlap === best.overlap && o.jaccard > best.jaccard)) best = { id: c.id, overlap: o.overlap, jaccard: o.jaccard };
      } else if (o.overlap >= LEFTOVER_MIN && o.shared >= 2 && !sameSource) {
        undecided = Math.max(undecided, o.overlap);
      }
    }
    if (undecided > 0 && best?.id !== c.id) leftover.push({ recordId: c.id, overlap: undecided });
  }
  if (best) return { recordId: best.id, overlap: best.overlap, leftover: [] };
  leftover.sort((a, b) => b.overlap - a.overlap);
  return { recordId: null, overlap: 0, leftover: leftover.slice(0, 3) };
}

const KIND_RULES: readonly [RecordKind, RegExp][] = [
  ['incident', /\b(?:hack(?:ed|s)?|exploit(?:ed|s)?|drain(?:ed|s)?|stolen|breach(?:ed)?|attack(?:ed|er|ers)?|vulnerabilit(?:y|ies)|phishing|compromised?|rug ?pull|post-?mortem)\b/i],
  ['outage', /\b(?:outage|downtime|degraded|halt(?:ed|s)?|disruption|unavailable|stalled)\b/i],
  ['regulation', /\b(?:sec|cftc|regulators?|regulatory|regulation|lawsuit|sues|sued|settlement|senate|congress|sanction(?:s|ed)?|enforcement|rulemaking|proposed rule|final rule|mica|licen[cs]e[ds]?)\b/i],
  ['governance', /\b(?:proposal|vot(?:e|es|ed|ing)|governance|dao|snapshot|temp(?:erature)? check|delegates?|e[ir][pc]-\d+)\b/i],
  ['release', /\bv\d+(?:\.\d+)+\b|\b(?:releases?|released|upgrades?|upgraded|hard ?fork|changelog)\b/i],
  ['launch', /\b(?:launch(?:es|ed|ing)?|introduc(?:es|ing|ed)|unveil(?:s|ed)?|debut(?:s|ed)?|rolls? out|goes live|now live|announc(?:es|ed|ing))\b/i],
  ['product', /\b(?:integrat(?:es|ed|ion)|partnership|partners with|adds? support|now supports?|now available)\b/i],
  ['research', /\b(?:paper|study|research|survey|benchmark)\b/i],
];

/** The kind of an item: its source's own kind, or, for a source that carries every kind (`statement`), what its title's words say. */
export function classifyKind(title: string, defaultKind: RecordKind): RecordKind {
  if (defaultKind !== 'statement') return defaultKind;
  for (const [kind, re] of KIND_RULES) if (re.test(title)) return kind;
  return defaultKind;
}

const OUT_OF_SCOPE =
  /\b(?:price (?:prediction|analysis|target|rally|surge|crash|slump|drop|action)|all-time high|ath|slides?|slid|surges?|surged|soars?|soared|plunges?|plunged|plummets?|tumbles?|tumbled|rall(?:y|ies|ied)|rebounds?|dips?|pumps?|dumps?|bull(?:ish| run| market)|bear(?:ish| market)|breakout|resistance|support level|analysts? (?:says?|flags?|predicts?|sees?|expects?|warns?)|could (?:hit|reach)|price of|trading at|whales?|memecoins?|meme coins?|airdrops?|top \d+ (?:coins|tokens|cryptos?)|best (?:coins|tokens|crypto)|gainers?|losers?|liquidat(?:ed|ions?)|open interest|funding rates?|etf (?:in|out)flows?|inflation|tariffs?|recession|rate cut|rate hike|interest rates?|jobs report|elections?|geopolitic(?:s|al)|war|agi (?:by|timeline)|ai art|horoscope)\b/i;

/**
 * Whether a title lies outside the scope section 6.4 draws: prices and predictions, rankings, single wallets,
 * memecoin and airdrop talk, macro, elections. Such an item is not a sighting: a careful account could not post it.
 */
export function outOfScope(title: string): boolean {
  return OUT_OF_SCOPE.test(title);
}
