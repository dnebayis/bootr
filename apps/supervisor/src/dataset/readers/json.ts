/**
 * The JSON APIs of section 6.7, one extractor each. An extractor reads the few fields named in its comment and nothing
 * else, checks every one for its type, and takes names from a fixed table of its own (a chain is "Base" because the
 * table says so, not because the response did). A measured number becomes a metric record of the day, written by code
 * (build.ts `metricSighting`); a dated list (incidents, rule documents) becomes text sightings through the same
 * cleaning as a feed's items (build.ts `buildSighting`). A response that is not the expected shape gives nothing.
 */
import { buildSighting, figure, metricSighting, type Built } from '../build.js';
import { cleanText } from '../clean.js';
import type { JsonReader, OpenSource } from '../sources.js';
import { dayOf } from '../store.js';
import type { RecordNumber, Sighting } from '../types.js';

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
const number = (source: OpenSource, value: number, unit: string, what: string, asOf: Date): RecordNumber => ({ value, unit, what, asOf: asOf.toISOString(), sourceId: source.id });

/** Rows of a dated list read at most, newest first. */
const LIST_MAX = 40;
const INCIDENT_MAX_AGE_MS = 14 * 86_400_000;

export interface Extracted {
  sightings: Sighting[];
  dropped: number;
}

const collect = (built: Built[]): Extracted => ({ sightings: built.flatMap((b) => ('sighting' in b ? [b.sighting] : [])), dropped: built.filter((b) => 'dropped' in b).length });

/** DefiLlama's chain names for the chains a record is kept for, with the entity and the name Bootr writes. */
const LLAMA_CHAINS: Record<string, { entity: string; label: string }> = {
  Base: { entity: 'base', label: 'Base' },
  Ethereum: { entity: 'ethereum', label: 'Ethereum' },
  Arbitrum: { entity: 'arbitrum', label: 'Arbitrum' },
  'OP Mainnet': { entity: 'optimism', label: 'OP Mainnet' },
  Solana: { entity: 'solana', label: 'Solana' },
};

/** `GET api.llama.fi/v2/chains`: an array; read `name` and `tvl` of the chains in LLAMA_CHAINS. */
function llamaChains(source: OpenSource, json: unknown, now: Date): Extracted {
  const sightings: Sighting[] = [];
  for (const raw of arr(json)) {
    const row = obj(raw);
    const chain = typeof row.name === 'string' ? LLAMA_CHAINS[row.name] : undefined;
    const tvl = num(row.tvl);
    if (!chain || tvl === null || tvl <= 0) continue;
    sightings.push(metricSighting(source, `tvl:${chain.entity}`, dayOf(now), `${chain.label}: ${figure(tvl)} USD of value locked, by DefiLlama's count`, [number(source, Math.round(tvl), 'usd', 'value locked', now)], [chain.entity]));
  }
  return { sightings, dropped: 0 };
}

/** `GET api.llama.fi/overview/fees|dexs`: read the top-level `total24h`, `total7d` and `total30d`; the protocol list is not read. */
function llamaOverview(source: OpenSource, json: unknown, now: Date): Extracted {
  const o = obj(json);
  const [d1, d7, d30] = [num(o.total24h), num(o.total7d), num(o.total30d)];
  if (d1 === null || d7 === null) return { sightings: [], dropped: 0 };
  const what = source.measures ?? 'total';
  const numbers = [number(source, Math.round(d1), 'usd', `${what}, 24 hours`, now), number(source, Math.round(d7), 'usd', `${what}, 7 days`, now), ...(d30 === null ? [] : [number(source, Math.round(d30), 'usd', `${what}, 30 days`, now)])];
  const headline = `${what === 'dex volume' ? 'DEX volume' : 'Protocol fees'} across all chains: ${figure(d1)} USD in 24 hours, ${figure(d7)} USD in 7 days, by DefiLlama's count`;
  return { sightings: [metricSighting(source, what.replace(/\s+/g, '-'), dayOf(now), headline, numbers, ['defi'])], dropped: 0 };
}

const LLAMA_STABLES: Record<string, { entity: string; label: string }> = { USDT: { entity: 'usdt', label: 'USDT' }, USDC: { entity: 'usdc', label: 'USDC' } };

/** `GET stablecoins.llama.fi/stablecoins`: read `peggedAssets[].symbol` and `.circulating.peggedUSD`; USDT and USDC each, and the sum over every dollar coin. */
function llamaStablecoins(source: OpenSource, json: unknown, now: Date): Extracted {
  const sightings: Sighting[] = [];
  let total = 0;
  const seen = new Set<string>();
  for (const raw of arr(obj(json).peggedAssets)) {
    const row = obj(raw);
    const supply = num(obj(row.circulating).peggedUSD);
    if (supply === null) continue;
    total += supply;
    const coin = typeof row.symbol === 'string' ? LLAMA_STABLES[row.symbol] : undefined;
    // The first row of a symbol is the coin itself; a later namesake is not.
    if (!coin || seen.has(coin.entity)) continue;
    seen.add(coin.entity);
    sightings.push(metricSighting(source, `supply:${coin.entity}`, dayOf(now), `${coin.label} in circulation: ${figure(supply)}, by DefiLlama's count`, [number(source, Math.round(supply), coin.entity, 'in circulation', now)], [coin.entity, 'stablecoins']));
  }
  if (total > 0) sightings.push(metricSighting(source, 'supply:all', dayOf(now), `Dollar stablecoins in circulation: ${figure(total)} USD, by DefiLlama's count`, [number(source, Math.round(total), 'usd', 'dollar stablecoins in circulation', now)], ['stablecoins']));
  return { sightings, dropped: 0 };
}

/**
 * `GET api.llama.fi/hacks`: an array; read `date` (unix seconds), `name`, `technique`, `classification`, `amount`,
 * `chain`, `source`, `defillamaId` and `description` of the rows of the last 14 days. A row is a text sighting of kind
 * incident: it can meet a desk's report of the same incident by its words.
 */
function llamaHacks(source: OpenSource, json: unknown, now: Date): Extracted {
  const rows = arr(json)
    .map(obj)
    .filter((r) => typeof r.date === 'number' && now.getTime() - r.date * 1000 <= INCIDENT_MAX_AGE_MS && r.date * 1000 <= now.getTime() + 86_400_000)
    .sort((a, b) => (b.date as number) - (a.date as number))
    .slice(0, LIST_MAX);
  return collect(
    rows.map((r) => {
      const at = new Date((r.date as number) * 1000);
      const name = cleanText(r.name, 60);
      const how = cleanText(r.technique, 60) || cleanText(r.classification, 60);
      const amount = num(r.amount);
      return buildSighting(
        source,
        {
          id: `hack:${cleanText(r.defillamaId, 40) || `${name}:${r.date as number}`}`,
          title: name ? `${name} hack${how && how.toLowerCase() !== 'unknown' ? `: ${how}` : ''}` : '',
          summary: r.description,
          // The list has no page per incident: a shared link would make every incident one record. What the row
          // cites is kept as a pointer instead, and meets the record of that page when there is one.
          hrefs: [r.source],
          // "on Base", "on Ethereum": a chain's bare name is a plain word, the phrase is not.
          about: arr(r.chain)
            .filter((c): c is string => typeof c === 'string')
            .slice(0, 5)
            .map((c) => `on ${c}`)
            .join(', '),
          kind: 'incident',
          eventTime: at,
          eventPrecision: 'day',
          numbers: amount && amount > 0 ? [number(source, Math.round(amount), 'usd', 'reported loss', at)] : [],
        },
        now,
      );
    }),
  );
}

/** L2BEAT's project slugs for the chains a record is kept for. */
const L2BEAT_PROJECTS: Record<string, { entity: string; label: string }> = {
  base: { entity: 'base', label: 'Base' },
  arbitrum: { entity: 'arbitrum', label: 'Arbitrum One' },
  'op-mainnet': { entity: 'optimism', label: 'OP Mainnet' },
  optimism: { entity: 'optimism', label: 'OP Mainnet' },
};

/** `GET l2beat.com/api/scaling/summary`: read `projects.<slug>.tvs.breakdown.total` and `.stage` of the projects in L2BEAT_PROJECTS. */
function l2beatSummary(source: OpenSource, json: unknown, now: Date): Extracted {
  const projects = obj(obj(json).projects);
  const sightings: Sighting[] = [];
  const done = new Set<string>();
  for (const [slug, project] of Object.entries(L2BEAT_PROJECTS)) {
    const row = obj(projects[slug]);
    const total = num(obj(obj(row.tvs).breakdown).total);
    if (total === null || total <= 0 || done.has(project.entity)) continue;
    done.add(project.entity);
    const stage = typeof row.stage === 'string' && /^Stage [0-2]$/.test(row.stage) ? row.stage : null;
    sightings.push(metricSighting(source, `tvs:${project.entity}`, dayOf(now), `${project.label} on L2BEAT: ${figure(total)} USD secured${stage ? `, ${stage}` : ''}`, [number(source, Math.round(total), 'usd', 'value secured', now)], [project.entity, 'layer2']));
  }
  return { sightings, dropped: 0 };
}

const GROWTHEPIE_CHAINS: Record<string, { entity: string; label: string }> = { base: { entity: 'base', label: 'Base' }, arbitrum: { entity: 'arbitrum', label: 'Arbitrum One' }, optimism: { entity: 'optimism', label: 'OP Mainnet' } };

/**
 * `GET api.growthepie.xyz/v1/fundamentals.json`: an array of `{metric_key, origin_key, date, value}`; read the newest
 * `txcount` and `daa` (daily active addresses) of the chains in GROWTHEPIE_CHAINS. The record is of the day the
 * numbers are for, not of the day they were read.
 */
function growthepie(source: OpenSource, json: unknown, now: Date): Extracted {
  const latest = new Map<string, { date: string; value: number }>();
  for (const raw of arr(json)) {
    const row = obj(raw);
    if ((row.metric_key !== 'txcount' && row.metric_key !== 'daa') || typeof row.origin_key !== 'string' || !GROWTHEPIE_CHAINS[row.origin_key]) continue;
    const value = num(row.value);
    if (value === null || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) continue;
    const key = `${row.origin_key}:${row.metric_key}`;
    const before = latest.get(key);
    if (!before || row.date > before.date) latest.set(key, { date: row.date, value });
  }
  const sightings: Sighting[] = [];
  for (const [chainKey, chain] of Object.entries(GROWTHEPIE_CHAINS)) {
    const tx = latest.get(`${chainKey}:txcount`);
    if (!tx || now.getTime() - Date.parse(`${tx.date}T00:00:00Z`) > 4 * 86_400_000) continue;
    const at = new Date(`${tx.date}T00:00:00.000Z`);
    const active = latest.get(`${chainKey}:daa`);
    const numbers = [number(source, Math.round(tx.value), '', 'transactions that day', at), ...(active && active.date === tx.date ? [number(source, Math.round(active.value), '', 'active addresses that day', at)] : [])];
    sightings.push(metricSighting(source, `activity:${chain.entity}`, tx.date, `${chain.label}: ${figure(tx.value)} transactions on ${tx.date}, by growthepie's count`, numbers, [chain.entity, 'layer2']));
  }
  return { sightings, dropped: 0 };
}

/** `GET api.cdp.coinbase.com/platform/v2/x402/discovery/resources`: read `pagination.total`; the listings themselves (third-party text) are not read. */
function x402Catalogue(source: OpenSource, json: unknown, now: Date): Extracted {
  const total = num(obj(obj(json).pagination).total);
  if (total === null || total <= 0) return { sightings: [], dropped: 0 };
  return { sightings: [metricSighting(source, 'resources', dayOf(now), `The x402 Bazaar lists ${figure(total)} paid resources, by Coinbase's catalogue`, [number(source, total, '', 'resources listed', now)], ['x402'])], dropped: 0 };
}

/**
 * `GET federalregister.gov/api/v1/documents.json`: read `results[]` with `document_number`, `title`, `abstract`,
 * `html_url`, `publication_date`, `type` and `agencies[].name`. A document is a text sighting of kind regulation.
 */
function federalRegister(source: OpenSource, json: unknown, now: Date): Extracted {
  return collect(
    arr(obj(json).results)
      .slice(0, LIST_MAX)
      .map(obj)
      .map((r) => {
        const day = typeof r.publication_date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.publication_date) ? new Date(`${r.publication_date}T00:00:00.000Z`) : null;
        return buildSighting(
          source,
          {
            id: `fr:${cleanText(r.document_number, 40)}`,
            title: r.title,
            summary: r.abstract,
            link: r.html_url,
            published: r.publication_date,
            about: `${cleanText(r.type, 30)} ${arr(r.agencies).map((a) => cleanText(obj(a).name, 80)).join(' ')}`,
            kind: 'regulation',
            eventTime: day,
            eventPrecision: 'day',
          },
          now,
        );
      }),
  );
}

const READERS: Record<JsonReader, (source: OpenSource, json: unknown, now: Date) => Extracted> = {
  'llama-chains': llamaChains,
  'llama-overview': llamaOverview,
  'llama-stablecoins': llamaStablecoins,
  'llama-hacks': llamaHacks,
  'l2beat-summary': l2beatSummary,
  growthepie,
  'x402-catalogue': x402Catalogue,
  'federal-register': federalRegister,
};

export function isJsonReader(name: string | undefined): name is JsonReader {
  return !!name && name in READERS;
}

/** The sightings of one JSON source's response. Throws only when the body is not JSON. */
export function readJson(source: OpenSource, body: string, now: Date): Extracted {
  if (!isJsonReader(source.reader)) return { sightings: [], dropped: 0 };
  return READERS[source.reader](source, JSON.parse(body) as unknown, now);
}
