/**
 * From an X post to a sighting the store may hold. The post goes through the same cleaning as every other source
 * (clean.ts), and the same rules decide what it may do to a record (store.ts, grades.ts); this file is the one place a
 * post's raw text is touched, and none of it is stored as it came.
 *
 * WHAT IS KEPT OF A POST, AND FOR HOW LONG (X's developer policy: stored content is kept up to date with X, and only
 * post ids may be passed on by automated means):
 *
 *   the post id, and the link code builds from it        30 days on the sighting; on its record until the record goes.
 *                                                          All of it is removed when X no longer shows the post at the
 *                                                          one check 20 hours after it was read, or when the account
 *                                                          turns protected or disappears (x-text.ts)
 *   when it was posted, the id of the post it quotes     the same
 *   link keys of pages it points at, on listed hosts     the same
 *   entity ids, a kind: words of Bootr's own lists       with the record
 *   a headline built by code: the first sentence,        44 hours at most, confirmed against X once on the way, and
 *     cleaned and cut to X_TITLE_MAX characters,           gone the moment X no longer shows the post or a listed
 *     and the numbers found in it                          page carries the same event (x-text.ts)
 *
 * Never kept: the post's text as written, anything of its author beyond the source row (id, handle, follower count),
 * pictures, counts of likes or replies. The raw text lives in memory for the length of this function.
 *
 * The headline is not the post. The links X itself found in the text are cut out first (they are data: the ones on
 * listed hosts are kept as link keys), then the whole text is cleaned and looked at by clean.ts `instructionShaped`:
 * a post that still carries a link, an @mention, a cashtag, an address, or words addressed to a reader, to agents or
 * to holders ANYWHERE in it keeps its place as a sighting and none of its words. So does a post that "ignores your
 * rules" in its fifth sentence. That filter is a noise filter (see clean.ts); what protects an agent is who may lift a
 * record, below.
 *
 * WHO A POST SPEAKS FOR. An account is official only for the entities its row in x-sources.ts names, and only for a
 * post that is about that entity: the post's own words name it, or the post links a page of that entity's own listed
 * source (the Base account linking the Base blog). A person's account is official for nothing. Nothing an account
 * carries on every post (`entities`) makes a post official. A post that quotes or links something already in a record
 * joins that record as a passenger and changes nothing of it (store.ts `attach`).
 *
 * What is not a sighting at all: a post with no words to speak of, one older than build.ts MAX_ITEM_AGE_MS, one
 * outside the scope (prices, predictions, airdrops: matching.ts `outOfScope`, read over the whole post), and, for an
 * account that also speaks of other things (`needsTopic`), one that names neither an entity nor the subject.
 */
import { MAX_ITEM_AGE_MS, sourceHosts, TOPIC, type Built } from './build.js';
import { canonicalLink, cleanText, clip, HEADLINE_MAX, instructionShaped, linkKey, numbersOf, parseDate, PRE_CUT } from './clean.js';
import { entitiesOf, ENTITIES_MAX } from './entities.js';
import { classifyKind, outOfScope, wordSet } from './matching.js';
import type { XPost } from './sender-x.js';
import { LINK_HOSTS, OPEN_SOURCES } from './sources.js';
import { REFS_MAX, type SourceInfo } from './store.js';
import type { XSource } from './x-sources.js';

export const X_TITLE_MAX = HEADLINE_MAX;
/** How much of a post is cleaned and looked at. */
export const X_TEXT_LOOKED_AT = 2_000;
/** A post needs this much to say anything: "gm" is not an event. */
export const X_MIN_CHARS = 12;
export const X_MIN_WORDS = 3;
const SNOWFLAKE_EPOCH_MS = 1_288_834_974_657n;
const X_ID = /^\d{1,25}$/;
/** A link as X shortens it. Only these are cut out of a text: a "link" that is a word would take the word with it. */
const SHORT_LINK = /^https:\/\/t\.co\/\w{1,40}$/;

/** The id of a source row for an X user id: `x:<user id>`. */
export const xSourceId = (userId: string): string => `x:${userId}`;
/** The one link of a post, built from its id alone: no handle is in it, so it still leads there when a handle changes. */
export const xPostLink = (postId: string): string => `https://x.com/i/status/${postId}`;
export const xPostKey = (postId: string): string => linkKey(xPostLink(postId));

/** The smallest post id X could have given at `at`: what a first read starts from when no post was seen yet. */
export function sinceIdAt(at: Date): string {
  const ms = BigInt(Math.max(0, at.getTime())) - SNOWFLAKE_EPOCH_MS;
  return (ms > 0n ? ms << 22n : 0n).toString();
}

/** When a post id was given: X's ids carry their time. Null for an id from before the scheme. */
export function timeOfId(postId: string): Date | null {
  if (!X_ID.test(postId)) return null;
  const ms = (BigInt(postId) >> 22n) + SNOWFLAKE_EPOCH_MS;
  return ms > SNOWFLAKE_EPOCH_MS && ms < 4_102_444_800_000n ? new Date(Number(ms)) : null;
}

/**
 * Hosts on which only one organisation publishes, with the entities that organisation's own listed source is official
 * for: a post that links such a page is about that entity. A host several groups share (github.com) says nothing.
 */
const OWN_PAGE_ENTITIES: ReadonlyMap<string, readonly string[]> = (() => {
  const byHost = new Map<string, { groups: Set<string>; entities: Set<string> }>();
  for (const s of OPEN_SOURCES) {
    for (const host of sourceHosts(s)) {
      const at = byHost.get(host) ?? { groups: new Set<string>(), entities: new Set<string>() };
      at.groups.add(s.open ? `open:${s.id}` : s.group);
      for (const e of s.open ? [] : s.officialFor) at.entities.add(e);
      byHost.set(host, at);
    }
  }
  return new Map([...byHost].filter(([, v]) => v.groups.size === 1 && v.entities.size > 0).map(([host, v]) => [host, [...v.entities]]));
})();

/** The first sentence of cleaned text, or all of it when it has no sentence end worth cutting at. */
export function firstSentence(text: string): string {
  const m = /^(.{20,}?[.!?])(?=\s+\S)/u.exec(text);
  return (m ? m[1]! : text).trim();
}

/** A listed X account as the store knows it once its id is pinned. */
export function xSourceInfo(userId: string, listed: XSource, handle: string = listed.handle): SourceInfo {
  return { id: xSourceId(userId), name: xSourceName(handle), cluster: listed.cluster, group: listed.group, officialFor: listed.officialFor, open: false };
}

/** The name a source row and a placeholder headline carry: no `@`, so it is never a mention. */
export const xSourceName = (handle: string): string => `${handle} on X`;

export function buildXSighting(userId: string, listed: XSource, post: XPost, now: Date): Built {
  if (!X_ID.test(post.id) || typeof post.text !== 'string') return { dropped: 'empty' };
  const sourceId = xSourceId(userId);
  // The links X found in the text leave it before anything reads it; a first line break ends the first paragraph.
  let raw = post.text.slice(0, PRE_CUT);
  for (const u of post.urls) if (SHORT_LINK.test(u.url)) raw = raw.split(u.url).join(' ');
  const whole = cleanText(raw, X_TEXT_LOOKED_AT);
  if (whole.length < X_MIN_CHARS || whole.split(' ').length < X_MIN_WORDS) return { dropped: 'empty' };
  const publishedAt = parseDate(post.createdAt, now.getTime()) ?? timeOfId(post.id);
  if (!publishedAt || now.getTime() - publishedAt.getTime() > MAX_ITEM_AGE_MS) return { dropped: 'old' };
  if (outOfScope(whole)) return { dropped: 'scope' };

  const links = post.urls.map((u) => canonicalLink(u.expandedUrl, LINK_HOSTS)).filter((l): l is string => !!l);
  const named = entitiesOf(whole);
  // About an entity by pointing at that entity's own page: only for entities this account may speak for at all.
  const byLink = links.flatMap((l) => OWN_PAGE_ENTITIES.get(new URL(l).hostname) ?? OWN_PAGE_ENTITIES.get(new URL(l).hostname.replace(/^www\./, '')) ?? []).filter((e) => listed.officialFor.includes(e));
  // A company or an agency naming itself says nothing about the subject (Stripe says "Stripe" on every post); a person
  // naming what they run does (Jesse Pollak on Base), so only what the account is official for is left out here.
  const own = new Set(listed.officialFor);
  if (listed.needsTopic && !named.some((e) => !own.has(e)) && !TOPIC.test(whole)) return { dropped: 'topic' };

  const withheld = instructionShaped(whole);
  const firstLine = cleanText(raw.split(/[\r\n]+/).find((line) => line.trim().length >= X_MIN_CHARS) ?? raw, X_TEXT_LOOKED_AT);
  const title = withheld ? '' : clip(firstSentence(firstLine || whole), X_TITLE_MAX);
  const namedHere = [...new Set([...named, ...byLink])];
  const official = listed.officialFor.some((e) => namedHere.includes(e));
  const refs = [...new Set([...links.map(linkKey), ...(post.quotedId && X_ID.test(post.quotedId) ? [xPostKey(post.quotedId)] : [])])].filter((k) => k !== xPostKey(post.id)).slice(0, REFS_MAX);
  return {
    sighting: {
      sourceId,
      externalId: post.id,
      kind: classifyKind(whole, 'statement'),
      title,
      excerpt: null,
      withheld,
      link: xPostLink(post.id),
      key: null,
      refs,
      entities: [...new Set([...listed.entities, ...named])].slice(0, ENTITIES_MAX),
      named: namedHere.slice(0, ENTITIES_MAX),
      words: withheld ? [] : wordSet(title),
      numbers: withheld ? [] : numbersOf(title, sourceId, publishedAt),
      // When an account posts is when the event happened only where the entity itself says so about itself.
      eventTime: official ? publishedAt : null,
      eventEnd: null,
      eventPrecision: official ? 'second' : 'unknown',
      publishedAt,
    },
  };
}
