/**
 * Layer a: the chain and Bootr's own data, which nobody else holds (docs/design/agent-behaviour.md section 6.4). Read
 * every `chainEveryMs` (10 minutes) from the indexer and, once an hour (run.ts `WEEK_READ_EVERY_MS`: they are counts
 * over a week, and `sv_inference` is the largest table there is), from three of the supervisor's own tables, at no
 * cost outside the server. Every record here is a number code read and a sentence code wrote: no coin name, no symbol,
 * no handle and no other string a creator chose is read, so nothing a third party wrote can enter by this layer.
 *
 * Exactly what is read:
 *
 *  1. Indexer `GET /platform/feed?since=<24 hours ago>` (its `platformStats`, `token` and `milestone` tables):
 *     `totals.tokens`, `totals.agentsTotal`, `totals.agentsAwake`, `totals.volume24hUsd`, `totals.volume7dUsd`,
 *     `totals.fees24hUsd`; and of each of `milestones[]`: `token`, `kind`, `value`, `at`.
 *  2. Indexer GraphQL `dailyStats` (its `daily_stat` table), the newest three rows: `timestamp`, `launches`, `trades`,
 *     `volumeUsd`, `feesUsd`, `feesAgentUsd`, `feesCreatorUsd`, `feesBurnUsd`, `feesPlatformUsd`, `awakeAgents`.
 *  3. `sv_inference`, the last 7 days, rows with `status = 'succeeded'`: their count, the count of distinct `agent_id`
 *     and the sum of `receipt.relay.chargedMicroUsdc`. Paid failures are left out, so the figure is a floor.
 *  4. `sv_service_calls`, the last 7 days, rows with `status = 'succeeded'`: their count, distinct `host`, distinct
 *     `agent_id` and the sum of `charged_micro_usdc`.
 *  5. `sv_treasury_ops`, the last 7 days, rows with `kind = 'claim_fees'` and `status = 'confirmed'`: their count and
 *     distinct `agent_id`.
 *
 * What it yields: the platform's numbers of the moment and of the last full day (fees by recipient among them), what
 * agents paid for their own thinking and for paid services in a week, how often they claimed their fees, and, for one
 * coin alone (`coin` on the record), its milestones. A platform record names no coin (the owner's decision of
 * 2026-11-14); a coin's record is for that coin's own agent in a later stage.
 *
 * Not built here, named in the note: a coin's "first trade after a quiet week" and the rest of what `coinToday`
 * computes per coin, which need the agent's last post as their anchor and belong with the stage that shows records to
 * coin agents.
 */
import { and, eq, gte, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { inference, serviceCalls, treasuryOps } from '../db/schema.js';
import type { IndexerClient } from '../indexer-client.js';
import type { Logger } from '../log.js';
import { figure, metricSighting } from './build.js';
import { CHAIN_SOURCES } from './sources.js';
import { dayOf, ingestSighting, type SourceInfo } from './store.js';
import type { RecordNumber, Sighting } from './types.js';

export const WEEK_MS = 7 * 86_400_000;
export const DAY_MS = 86_400_000;
export const MILESTONES_MAX = 50;

export const DAILY_STATS_QUERY = `query DatasetDailyStats {
  dailyStats(orderBy: "timestamp", orderDirection: "desc", limit: 3) { items { timestamp launches trades volumeUsd feesUsd feesAgentUsd feesCreatorUsd feesBurnUsd feesPlatformUsd awakeAgents } }
}`;

export interface ChainDeps {
  db: Db;
  indexer: Pick<IndexerClient, 'platformFeed' | 'graphql'>;
  log: Pick<Logger, 'info' | 'warn'>;
  recordsPerDay?: number;
  /** Leave the three week counts of the supervisor's tables out of this pass. */
  skipWeek?: boolean;
}

const INDEXER = { id: 'a:indexer', url: 'https://bootr.fun', page: 'https://bootr.fun', entities: ['bootr'], subject: ['bootr'] } as const;
const SUPERVISOR = { id: 'a:supervisor', url: 'https://bootr.fun', page: 'https://bootr.fun', entities: ['bootr'], subject: ['bootr'] } as const;
const infoOf = (id: string): SourceInfo => {
  const s = CHAIN_SOURCES.find((c) => c.id === id)!;
  return { id: s.id, name: s.name, cluster: s.cluster, group: s.group, officialFor: s.officialFor };
};

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : null);
const usd = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.round(v * 100) / 100 : null);
const plural = (n: number, one: string, many = `${one}s`) => `${figure(n)} ${n === 1 ? one : many}`;

/** The platform's numbers of the moment, from the feed's totals. One record a UTC day, refreshed as the day goes. */
export function platformNow(feed: unknown, now: Date): Sighting | null {
  const t = obj(obj(feed).totals);
  const [coins, awake, total, volume24h, volume7d, fees24h] = [count(t.tokens), count(t.agentsAwake), count(t.agentsTotal), usd(t.volume24hUsd), usd(t.volume7dUsd), usd(t.fees24hUsd)];
  if (coins === null || awake === null || total === null || volume24h === null) return null;
  const n = (value: number, unit: string, what: string): RecordNumber => ({ value, unit, what, asOf: now.toISOString(), sourceId: INDEXER.id });
  const numbers = [n(coins, '', 'coins launched'), n(awake, '', 'agents awake'), n(total, '', 'agents in all'), n(volume24h, 'usd', 'traded in 24 hours'), ...(volume7d === null ? [] : [n(volume7d, 'usd', 'traded in 7 days')]), ...(fees24h === null ? [] : [n(fees24h, 'usd', 'fees in 24 hours')])];
  const headline = `Bootr now: ${plural(coins, 'coin')} launched, ${figure(awake)} of ${plural(total, 'agent')} awake, ${figure(volume24h)} USD traded in 24 hours`;
  return metricSighting(INDEXER, 'platform', dayOf(now), headline, numbers, ['bootr'], `${headline}.`);
}

/** The last full UTC day, from the indexer's daily rollup: launches, trades, volume and the fees by who received them. */
export function platformDay(graph: unknown, now: Date): Sighting | null {
  const yesterday = Math.floor(now.getTime() / DAY_MS) * 86_400 - 86_400;
  const row = ((obj(obj(graph).dailyStats).items as unknown[] | undefined) ?? []).map(obj).find((r) => r.timestamp === yesterday);
  if (!row) return null;
  const [launches, trades, volume, fees] = [count(row.launches), count(row.trades), usd(row.volumeUsd), usd(row.feesUsd)];
  if (launches === null || trades === null || volume === null || fees === null) return null;
  const day = new Date(yesterday * 1000).toISOString().slice(0, 10);
  const at = new Date(yesterday * 1000 + DAY_MS);
  const n = (value: number, unit: string, what: string): RecordNumber => ({ value, unit, what, asOf: at.toISOString(), sourceId: INDEXER.id });
  const parts: [string, number | null][] = [
    ['agents', usd(row.feesAgentUsd)],
    ['creators', usd(row.feesCreatorUsd)],
    ['burn', usd(row.feesBurnUsd)],
    ['the platform', usd(row.feesPlatformUsd)],
  ];
  const numbers = [n(launches, '', 'launches that day'), n(trades, '', 'trades that day'), n(volume, 'usd', 'traded that day'), n(fees, 'usd', 'fees that day'), ...parts.flatMap(([who, value]) => (value === null ? [] : [n(value, 'usd', `fees to ${who} that day`)]))];
  const headline = `Bootr on ${day}: ${plural(launches, 'launch', 'launches')}, ${plural(trades, 'trade')}, ${figure(volume)} USD traded, ${figure(fees)} USD in fees`;
  const split = parts.filter(([, v]) => v !== null).map(([who, v]) => `${figure(v as number)} to ${who}`);
  return metricSighting(INDEXER, 'day', day, headline, numbers, ['bootr'], split.length ? `${headline}. Of the fees, ${split.join(', ')} (USD).` : `${headline}.`);
}

const MILESTONE_KINDS: Record<string, (value: number) => { headline: string; number: [number, string, string] | null }> = {
  first_swap: () => ({ headline: 'the coin had its first trade', number: null }),
  holders: (v) => ({ headline: `the coin reached ${plural(v, 'holder')}`, number: [v, '', 'holders reached'] }),
  volume24h: (v) => ({ headline: `the coin passed ${figure(v)} USD traded in 24 hours`, number: [v, 'usd', 'traded in 24 hours, passed'] }),
};

/** A coin's milestones (first trade, holder counts, 24 h volume), each a record of that coin alone. */
export function coinMilestones(feed: unknown): Sighting[] {
  const out: Sighting[] = [];
  for (const raw of ((obj(feed).milestones as unknown[] | undefined) ?? []).slice(0, MILESTONES_MAX)) {
    const m = obj(raw);
    const token = typeof m.token === 'string' && /^0x[0-9a-fA-F]{40}$/.test(m.token) ? m.token.toLowerCase() : null;
    const words = typeof m.kind === 'string' ? MILESTONE_KINDS[m.kind] : undefined;
    const value = count(m.value);
    const at = typeof m.at === 'number' && Number.isFinite(m.at) && m.at > 0 ? new Date(m.at * 1000) : null;
    if (!token || !words || value === null || !at) continue;
    const { headline, number } = words(value);
    const key = `a:milestone:${token}:${m.kind as string}:${value}`;
    out.push({
      ...metricSighting(INDEXER, 'milestone', dayOf(at), headline, number ? [{ value: number[0], unit: number[1], what: number[2], asOf: at.toISOString(), sourceId: INDEXER.id }] : [], ['bootr'], `${headline}.`),
      key,
      externalId: key,
      eventTime: at,
      eventPrecision: 'second',
      coin: token,
    });
  }
  return out;
}

const microToUsdc = (micro: unknown): number => Math.round(Number(micro ?? 0) / 10_000) / 100;

/** What agents paid for their own thinking, for paid services, and how often they claimed their fees, over the last 7 days. */
export async function supervisorWeek(db: Db, now: Date): Promise<Sighting[]> {
  const since = new Date(now.getTime() - WEEK_MS);
  const day = dayOf(now);
  const n = (value: number, unit: string, what: string): RecordNumber => ({ value, unit, what, asOf: now.toISOString(), sourceId: SUPERVISOR.id });
  const out: Sighting[] = [];
  const [thinking] = await db
    .select({ thoughts: sql<number>`count(*)::int`, agents: sql<number>`count(distinct ${inference.agentId})::int`, charged: sql<string>`coalesce(sum((${inference.receipt}->'relay'->>'chargedMicroUsdc')::numeric), 0)::text` })
    .from(inference)
    .where(and(eq(inference.status, 'succeeded'), gte(inference.createdAt, since)));
  if (thinking && Number(thinking.thoughts) > 0) {
    const paid = microToUsdc(thinking.charged);
    const headline = `Agents on Bootr paid ${figure(paid)} USDC for ${plural(Number(thinking.thoughts), 'thought')} of their own in the last 7 days`;
    out.push(metricSighting(SUPERVISOR, 'thinking-week', day, headline, [n(paid, 'usdc', 'paid for thinking, 7 days'), n(Number(thinking.thoughts), '', 'thoughts, 7 days'), n(Number(thinking.agents), '', 'agents that thought, 7 days')], ['bootr', 'agents'], `${headline}, across ${plural(Number(thinking.agents), 'agent')}. Each agent pays for its own model from its own treasury.`));
  }
  const [services] = await db
    .select({ calls: sql<number>`count(*)::int`, hosts: sql<number>`count(distinct ${serviceCalls.host})::int`, agents: sql<number>`count(distinct ${serviceCalls.agentId})::int`, charged: sql<string>`coalesce(sum((${serviceCalls.chargedMicroUsdc})::numeric), 0)::text` })
    .from(serviceCalls)
    .where(and(eq(serviceCalls.status, 'succeeded'), gte(serviceCalls.createdAt, since)));
  if (services && Number(services.calls) > 0) {
    const paid = microToUsdc(services.charged);
    const headline = `Agents on Bootr made ${plural(Number(services.calls), 'paid call')} to ${plural(Number(services.hosts), 'service')} over x402 in the last 7 days`;
    out.push(metricSighting(SUPERVISOR, 'services-week', day, headline, [n(Number(services.calls), '', 'paid service calls, 7 days'), n(Number(services.hosts), '', 'services called, 7 days'), n(paid, 'usdc', 'paid for services, 7 days'), n(Number(services.agents), '', 'agents that paid a service, 7 days')], ['bootr', 'x402', 'agents'], `${headline}, ${figure(paid)} USDC in all.`));
  }
  const [claims] = await db
    .select({ claims: sql<number>`count(*)::int`, agents: sql<number>`count(distinct ${treasuryOps.agentId})::int` })
    .from(treasuryOps)
    .where(and(eq(treasuryOps.kind, 'claim_fees'), eq(treasuryOps.status, 'confirmed'), gte(treasuryOps.createdAt, since)));
  if (claims && Number(claims.claims) > 0) {
    const headline = `${plural(Number(claims.agents), 'agent')} on Bootr claimed their own trading fees ${plural(Number(claims.claims), 'time')} in the last 7 days`;
    out.push(metricSighting(SUPERVISOR, 'claims-week', day, headline, [n(Number(claims.claims), '', 'fee claims, 7 days'), n(Number(claims.agents), '', 'agents that claimed fees, 7 days')], ['bootr', 'agents'], `${headline}.`));
  }
  return out;
}

export interface ChainReport {
  indexer: boolean;
  created: number;
  updated: number;
  capped: number;
}

/** One pass of layer a. Never throws: an indexer that does not answer leaves its records as they were. */
export async function runChain(deps: ChainDeps, now: Date): Promise<ChainReport> {
  const report: ChainReport = { indexer: false, created: 0, updated: 0, capped: 0 };
  const batches: [SourceInfo, Sighting[]][] = [];
  const [feed, graph] = await Promise.all([deps.indexer.platformFeed(Math.floor((now.getTime() - DAY_MS) / 1000)).catch(() => null), deps.indexer.graphql(DAILY_STATS_QUERY).catch(() => null)]);
  report.indexer = !!feed;
  batches.push([infoOf('a:indexer'), [platformNow(feed, now), platformDay(graph, now), ...coinMilestones(feed)].filter((s): s is Sighting => !!s)]);
  try {
    if (!deps.skipWeek) batches.push([infoOf('a:supervisor'), await supervisorWeek(deps.db, now)]);
  } catch (err) {
    deps.log.warn({ err }, 'dataset: reading the supervisor tables failed');
  }
  for (const [info, sightings] of batches) {
    for (const sighting of sightings) {
      try {
        // Bootr's own data: no per-source share (store.ts), only the day's cap.
        const result = await ingestSighting(deps.db, info, sighting, { now, recordsPerDay: deps.recordsPerDay, sourceRecordsPerDay: 0, sourceSightingsPerDay: 0 });
        if (result.outcome === 'created') report.created++;
        else if (result.outcome === 'updated') report.updated++;
        else if (result.outcome === 'capped') report.capped++;
      } catch (err) {
        deps.log.warn({ err, key: sighting.key }, 'dataset: a chain record was not stored');
      }
    }
  }
  return report;
}
