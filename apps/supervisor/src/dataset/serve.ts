/**
 * The serving seam of the dataset (docs/design/agent-behaviour.md section 6.4, "How a turn gets its records"): given an
 * agent, its beat, a lowest grade and a limit, the records that fit, best first. No model, two reads. It is the one way
 * a record reaches a turn, and it is written for both kinds of caller:
 *
 *   - the platform account (stage 5, built: records-turn.ts): every cluster by its weight, every grade, its own coin's
 *     chain records, up to 5;
 *       recordsFor(ctx, { agentId, beat: { topics: 'all', coin: <own token>, withoutSources: ['a:indexer'] }, minGrade: 1, limit: 5 })
 *   - a coin agent, hosted or own (stage 7, not built): its own coin's chain records always, plus the creator's topics
 *     (cluster names or entity ids: `base`, `agents`, `x402`), grade 3 and above, up to 3;
 *       recordsFor(ctx, { agentId, beat: { topics: ['base', 'agents'], coin: <own token> }, minGrade: 3, limit: 3 })
 *     An own agent's MCP tool reads more through the same call with a larger limit. The caller then notes what it
 *     showed (served.ts `noteServed`), which is what makes a later citation of the record valid.
 *
 * What fits:
 *   - not expired, not withdrawn, carried by a source within `SERVE_WINDOW_MS`, with a headline a source really gave
 *     (a record whose words were withheld at the door has nothing to write from);
 *   - of the beat: any cluster (`'all'`), or one of the named clusters or entities; at or above `minGrade`. A record
 *     about a coin is served to that coin's own agent alone, whatever its grade and whatever the topics, and to nobody
 *     else: another Bootr coin is never a subject (the owner's decision of 2026-11-14);
 *   - not something this agent already used: the record's `posted` list, the said-ledger's record ids, a post of its
 *     own that cites it and waits (scheduled, in review), and a record it was offered `OFFERS_MAX` times with a due
 *     slot and passed over (served.ts);
 *   - carried by at least one source that is still read (`active`), and, unless the caller asks (`openVenues`), by at
 *     least one that is not an open venue. A record only a forum or a preprint server carries is a stranger's topic:
 *     its grade is 1 by construction, and one stranger must not be able to put a line in front of an agent that posts
 *     in Bootr's name. No caller asks for them today;
 *   - an incident without the sourcing rule R5 asks for (an official source, or a security source and one more group)
 *     is a report whatever its grade (`reportOnly`), and is not served at all to a caller whose lowest grade is 3;
 *   - the headline is read once more here, after folding look-alike letters: a headline that mixes scripts inside a
 *     word, or that reads as an instruction once folded, is not served. The filter at the door (clean.ts) is a noise
 *     filter and may have been looser when the record was stored; this is the same filter, asked again at the last
 *     moment. It is still not a wall: what a served headline says is a stranger's sentence, and the block that carries
 *     it says so (records-section.ts).
 *
 * The order ("beat match x grade x freshness, zero if the agent posted it, lower if others did"): the beat's weight
 * (the record's cluster weight, 3 for its own coin) times the grade, over one plus the record's age in days, over one
 * plus the number of other Bootr agents that posted about it, a little less for each time it was already offered. At
 * most `SERVE_PER_GROUP` records of one organisation are returned, so five posts of one company are not the day.
 */
import { and, desc, eq, gt, gte, inArray, isNull, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { dsRecords, dsSources, recordsServed, said } from '../db/schema.js';
import { instructionShaped } from './clean.js';
import { executionSource } from './execution-posts.js';
import { incidentSourced } from './grades.js';
import { OFFERS_MAX } from './served.js';
import type { EventPrecision, Grade, RecordKind, RecordNumber, RecordPosted, RecordSource, RecordStatus } from './types.js';

const DAY_MS = 86_400_000;
/** A record no source carried for this long is not offered, whatever its expiry says. */
export const SERVE_WINDOW_MS = 14 * DAY_MS;
/** Rows the one query brings back for a request, before the checks code makes. */
export const SERVE_CANDIDATES = 60;
/** Records of one organisation in one answer. */
export const SERVE_PER_GROUP = 2;
/** The most a caller may ask for. */
export const SERVE_LIMIT_MAX = 20;
/** Record ids of the said-ledger one request reads at most. */
export const SERVE_SAID_MAX = 1000;
/** A source whose own records the platform's numbers post already carries (`platformNumbers`): left out for it. */
export const PLATFORM_TOTALS_SOURCE = 'a:indexer';

/** What an agent follows. */
export interface Beat {
  /** `'all'`: every cluster, by its weight (the platform account). A list: these clusters or entity ids only (a coin agent's topics; empty = none). */
  topics: 'all' | readonly string[];
  /** The agent's own coin (its token address): that coin's chain records always fit. Null: no coin's record is served. */
  coin: string | null;
  /** Sources whose records are left out unless they are about the agent's own coin. */
  withoutSources?: readonly string[];
}

export interface ServeRequest {
  agentId: string;
  beat: Beat;
  /** The lowest grade served (the agent's own coin's records are served whatever their grade). */
  minGrade: Grade;
  limit: number;
  /** Also serve records that only open venues carry. Off unless set; see the head of this file. */
  openVenues?: boolean;
}

/** One source of a served record, with the name the source list gives it. */
export interface ServedSource {
  sourceId: string;
  name: string;
  group: string;
  official: boolean;
  open: boolean;
}

export interface ServedRecord {
  id: string;
  kind: RecordKind;
  grade: Grade;
  groups: number;
  /** A sighting pointed at a page of another listed source. */
  cited: boolean;
  status: RecordStatus;
  headline: string;
  link: string | null;
  cluster: string;
  weight: number;
  coin: string | null;
  firstSeenAt: Date;
  observationCount: number;
  eventTime: Date | null;
  eventEnd: Date | null;
  eventPrecision: EventPrecision;
  numbers: RecordNumber[];
  /** The sources that are still read, official ones first. */
  sources: ServedSource[];
  /** An incident without the sourcing rule R5 asks for: a report, whatever the grade says. */
  reportOnly: boolean;
  /** Other Bootr agents that already posted about it. */
  othersPosted: number;
  /** Turns this agent was already offered it with a due slot. */
  offered: number;
  score: number;
}

type Ctx = { db: Db; now(): number };

/** Cyrillic and Greek letters that read as Latin ones, as fee-claims.ts folds them. */
const LOOKALIKES: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', х: 'x', у: 'y', і: 'i', ј: 'j', ѕ: 's', ԁ: 'd', һ: 'h', ո: 'n', ց: 'g', ο: 'o', ρ: 'p', ν: 'v', ι: 'i', α: 'a', ε: 'e', κ: 'k', τ: 't', υ: 'u', А: 'A', Е: 'E', О: 'O', Р: 'P', С: 'C', Х: 'X', Н: 'H', В: 'B', М: 'M', Т: 'T', К: 'K', Α: 'A', Β: 'B', Ε: 'E', Η: 'H', Ι: 'I', Κ: 'K', Μ: 'M', Ν: 'N', Ο: 'O', Ρ: 'P', Τ: 'T', Χ: 'X' };
const OTHER_SCRIPT = /[\u0370-\u03ff\u0400-\u052f]/;
const MIXED_WORD = /(?:[a-z][\u0370-\u03ff\u0400-\u052f]|[\u0370-\u03ff\u0400-\u052f][a-z])/i;

/** `text` with look-alike letters of other scripts as the Latin ones they read as. */
export function foldLookalikes(text: string): string {
  return text.replace(/[\u0370-\u03ff\u0400-\u052f]/g, (c) => LOOKALIKES[c] ?? c);
}

/**
 * Whether a stored headline may be put in front of a model: it is a source's own words (not the placeholder of a
 * withheld title), no word of it mixes Latin letters with Cyrillic or Greek ones, and it does not read as an
 * instruction, as written or with its look-alike letters folded. Pure.
 */
export function servableHeadline(headline: string): boolean {
  if (typeof headline !== 'string' || !headline.trim() || headline.startsWith('an item from ')) return false;
  if (MIXED_WORD.test(headline)) return false;
  if (instructionShaped(headline)) return false;
  return !OTHER_SCRIPT.test(headline) || !instructionShaped(foldLookalikes(headline));
}

/** A source's name as a block may carry it: letters, digits and plain punctuation, 40 characters. The list is checked in; an X account's name (a later stage) is not. */
export function sourceName(name: string, sourceId: string): string {
  const plain = foldLookalikes(String(name ?? '')).replace(/[^\p{L}\p{N} .&'()/-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 40).trim();
  return plain && !instructionShaped(plain) ? plain : sourceId.replace(/^[abx]:/, '');
}

const textList = (values: readonly string[]): SQL =>
  sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  );

/** The records that fit `req`, best first, at most `req.limit`. Reads only; the caller notes what it then shows. */
export async function recordsFor(ctx: Ctx, req: ServeRequest): Promise<ServedRecord[]> {
  const limit = Math.max(0, Math.min(SERVE_LIMIT_MAX, Math.floor(req.limit)));
  if (limit <= 0) return [];
  const now = ctx.now();
  const nowIso = new Date(now).toISOString();
  const coin = req.beat.coin ? req.beat.coin.toLowerCase() : null;
  const topics = req.beat.topics === 'all' ? null : [...new Set(req.beat.topics.map((t) => t.toLowerCase()))].slice(0, 16);
  if (!coin && topics && topics.length === 0) return [];

  // What the said-ledger says this agent already cited: the third place a used record is on record, after the
  // record's own `posted` list and the served row (both asked in the query below).
  const cited = await ctx.db
    .select({ recordIds: said.recordIds })
    .from(said)
    .where(and(eq(said.agentId, req.agentId), gt(said.postedAt, new Date(now - SERVE_WINDOW_MS)), sql`${said.recordIds} <> '[]'::jsonb`))
    .orderBy(desc(said.postedAt))
    .limit(SERVE_SAID_MAX);
  const saidIds = [...new Set(cited.flatMap((r) => (Array.isArray(r.recordIds) ? r.recordIds : [])).filter((id): id is string => typeof id === 'string'))].slice(0, SERVE_SAID_MAX);

  const own: SQL = coin ? sql`${dsRecords.coin} = ${coin}` : sql`false`;
  const inBeat: SQL = topics === null ? sql`true` : topics.length ? sql`(${dsRecords.cluster} in (${textList(topics)}) or ${dsRecords.entities} ?| array[${textList(topics)}]::text[])` : sql`false`;
  const without = [...new Set(req.beat.withoutSources ?? [])].slice(0, 8);
  const notWithout: SQL = without.length ? sql`not exists (select 1 from jsonb_array_elements(${dsRecords.sources}) as src where src->>'sourceId' in (${textList(without)}))` : sql`true`;
  const outside = and(isNull(dsRecords.coin), gte(dsRecords.grade, req.minGrade), inBeat, notWithout)!;
  // beat x grade x freshness, in the database, so the limit cuts the right end.
  const score = sql<number>`((case when ${own} then 3 else ${dsRecords.weight} end) * ${dsRecords.grade})::float8 / (1 + greatest(0, extract(epoch from (${nowIso}::timestamptz - ${dsRecords.firstSeenAt}))) / 86400.0)`;
  const rows = await ctx.db
    .select({ record: dsRecords, offered: recordsServed.offered, score })
    .from(dsRecords)
    .leftJoin(recordsServed, eq(recordsServed.id, sql`${req.agentId} || ':' || ${dsRecords.id}`))
    .where(
      and(
        gt(dsRecords.expiresAt, new Date(now)),
        gte(dsRecords.lastReinforcedAt, new Date(now - SERVE_WINDOW_MS)),
        ne(dsRecords.status, 'withdrawn'),
        or(own, outside),
        sql`not (${dsRecords.posted} @> ${JSON.stringify([{ agentId: req.agentId }])}::jsonb)`,
        or(isNull(recordsServed.id), and(isNull(recordsServed.citedAt), sql`${recordsServed.offered} < ${OFFERS_MAX}`)),
        ...(saidIds.length ? [notInArray(dsRecords.id, saidIds)] : []),
      ),
    )
    .orderBy(desc(score), desc(dsRecords.firstSeenAt))
    .limit(SERVE_CANDIDATES);
  if (!rows.length) return [];

  const sourceIds = [...new Set(rows.flatMap((r) => (r.record.sources as unknown as RecordSource[]).map((s) => s.sourceId)))];
  const known = sourceIds.length ? await ctx.db.select({ id: dsSources.id, name: dsSources.name, status: dsSources.status, xHandle: dsSources.xHandle }).from(dsSources).where(inArray(dsSources.id, sourceIds)) : [];
  const sourceRow = new Map(known.map((s) => [s.id, s]));

  const out: ServedRecord[] = [];
  for (const { record: r, offered, score: base } of rows) {
    if (!servableHeadline(r.headline)) continue;
    const all = r.sources as unknown as RecordSource[];
    // Only what a source that is still read carried counts: a suspended or retired source vouches for nothing.
    const live = all.filter((s) => sourceRow.get(s.sourceId)?.status === 'active');
    if (!live.length) continue;
    if (!req.openVenues && live.every((s) => s.open === true)) continue;
    const reportOnly = r.kind === 'incident' && !incidentSourced(live);
    const isOwn = coin !== null && r.coin === coin;
    if (reportOnly && req.minGrade >= 3 && !isOwn) continue;
    // A link an execution account's post gave the record (@bankrbot, @clanker_world) is not served: posted, it would
    // quote that post and notify the account, and "x.com/i/status/<id>" does not show the gate whose post it is.
    const botLinks = new Set(all.filter((s) => s.link && sourceRow.has(s.sourceId) && executionSource(sourceRow.get(s.sourceId)!)).map((s) => s.link));
    const others = new Set((r.posted as unknown as RecordPosted[]).map((p) => p?.agentId).filter((id): id is string => typeof id === 'string' && id !== req.agentId)).size;
    const times = Number(offered ?? 0);
    out.push({
      id: r.id,
      kind: r.kind as RecordKind,
      grade: r.grade as Grade,
      groups: r.groups,
      cited: r.cited,
      status: r.status as RecordStatus,
      headline: r.headline,
      link: r.link && !botLinks.has(r.link) ? r.link : null,
      cluster: r.cluster,
      weight: r.weight,
      coin: r.coin,
      firstSeenAt: r.firstSeenAt,
      observationCount: r.observationCount,
      eventTime: r.eventTime,
      eventEnd: r.eventEnd,
      eventPrecision: r.eventPrecision as EventPrecision,
      numbers: (r.numbers as unknown as RecordNumber[]).filter((n) => n && typeof n.value === 'number' && Number.isFinite(n.value)),
      sources: [...live].sort((a, b) => Number(b.official) - Number(a.official)).map((s) => ({ sourceId: s.sourceId, name: sourceName(sourceRow.get(s.sourceId)!.name, s.sourceId), group: s.group, official: s.official === true, open: s.open === true })),
      reportOnly,
      othersPosted: others,
      offered: times,
      score: (Number(base) / (1 + others)) * 0.8 ** times,
    });
  }
  out.sort((a, b) => b.score - a.score || b.firstSeenAt.getTime() - a.firstSeenAt.getTime());
  const perGroup = new Map<string, number>();
  const picked: ServedRecord[] = [];
  for (const record of out) {
    if (picked.length >= limit) break;
    const group = record.sources[0]!.group;
    const n = perGroup.get(group) ?? 0;
    if (n >= SERVE_PER_GROUP) continue;
    perGroup.set(group, n + 1);
    picked.push(record);
  }
  return picked;
}
