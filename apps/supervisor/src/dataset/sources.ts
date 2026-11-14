/**
 * The open sources of the dataset's layer b: the 72 rows of docs/design/agent-behaviour.md section 6.7, each of which
 * answered a plain request on 2026-11-14. This file is the list: only a commit changes what Bootr reads, which hosts a
 * record may link to and which source is official for which entity. `n` is the row of the note.
 *
 *  - `kind` says how it is read (readers/): `feed` (RSS or Atom, GitHub release feeds included), `json` (one of the
 *    extractors of readers/json.ts, named by `reader`) or `html` (`links`: the page's list of links, only new ones
 *    become sightings; `watch`: one page whose change is the event).
 *  - `group` is the organisation behind the source. Two sources of one group count once when independence is counted
 *    (grades.ts): the Base blog, the Base status page and the CDP docs are all Coinbase.
 *  - `officialFor` are the entity ids (entities.ts) the source may lift a record to grade 4 for. A news desk has none:
 *    it can lift a record to grade 3, never to 4.
 *  - `entities` are carried by every item of the source, whatever its title says.
 *  - `needsTopic`: a broad source (a central bank, a general tech desk, arXiv) whose items are kept only when they name
 *    an entity of the list, so that macro, elections and the rest of what lies outside the scope never become records.
 *  - `everyMin`: 15 minutes for the home cluster, an hour for the rest, six hours for the JSON APIs (some are megabytes).
 *  - `read: false` rows are listed and not read, with the reason.
 *
 * The schedule comes to about 2,600 small conditional requests a day, with no fee.
 */
import type { Cluster, RecordKind } from './types.js';

export type JsonReader = 'llama-chains' | 'llama-overview' | 'llama-stablecoins' | 'llama-hacks' | 'l2beat-summary' | 'growthepie' | 'x402-catalogue' | 'federal-register';

export interface OpenSource {
  n: number;
  /** `b:<slug>`: the id in `sv_ds_sources` and on every sighting. */
  id: string;
  name: string;
  url: string;
  kind: 'feed' | 'json' | 'html';
  reader?: JsonReader | 'links' | 'watch';
  /** `llama-overview`: what the totals count. */
  measures?: string;
  cluster: Cluster;
  group: string;
  officialFor: readonly string[];
  entities?: readonly string[];
  defaultKind: RecordKind;
  everyMin: number;
  /** Bytes of the body read at most. */
  maxBytes: number;
  /** Hosts its items link to besides the host of `url` and of `page`. */
  hosts?: readonly string[];
  /** The page a person would open for what a JSON source measures: the link of its records. */
  page?: string;
  needsTopic?: boolean;
  /** `links`: only links under one of these paths are items. */
  paths?: readonly string[];
  /** `watch`: a field of the page whose value is the event (an EIP's status): the first of `values` after the word `after`. Without it, a changed page is the event. */
  watch?: { after: string; values: readonly string[] };
  read: boolean;
  /** Why a row is not read. */
  reason?: string;
}

const KB = 1024;
const MB = 1024 * KB;
const HOME = 15;
const REST = 60;
const SIX_HOURS = 360;

type Row = Omit<OpenSource, 'everyMin' | 'maxBytes' | 'read' | 'officialFor'> & Partial<Pick<OpenSource, 'everyMin' | 'maxBytes' | 'read' | 'officialFor'>>;
const HOME_CLUSTERS: ReadonlySet<string> = new Set(['base', 'agents', 'x402', 'launchpads']);
const row = (r: Row): OpenSource => ({
  ...r,
  officialFor: r.officialFor ?? [],
  everyMin: r.everyMin ?? (r.kind === 'json' ? SIX_HOURS : HOME_CLUSTERS.has(r.cluster) ? HOME : REST),
  maxBytes: r.maxBytes ?? (r.kind === 'feed' ? 2 * MB : r.kind === 'json' ? 2 * MB : 1536 * KB),
  read: r.read ?? true,
});
const github = (repo: string) => `https://github.com/${repo}/releases.atom`;

export const OPEN_SOURCES: readonly OpenSource[] = [
  row({ n: 1, id: 'b:llama-chains', name: 'DefiLlama chains', url: 'https://api.llama.fi/v2/chains', kind: 'json', reader: 'llama-chains', cluster: 'data', group: 'defillama', defaultKind: 'metric', page: 'https://defillama.com/chains', maxBytes: 1 * MB }),
  row({ n: 2, id: 'b:llama-fees', name: 'DefiLlama fees', url: 'https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', kind: 'json', reader: 'llama-overview', measures: 'protocol fees', cluster: 'data', group: 'defillama', defaultKind: 'metric', page: 'https://defillama.com/fees', maxBytes: 8 * MB }),
  row({ n: 3, id: 'b:llama-dexs', name: 'DefiLlama DEX volume', url: 'https://api.llama.fi/overview/dexs?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true', kind: 'json', reader: 'llama-overview', measures: 'dex volume', cluster: 'data', group: 'defillama', defaultKind: 'metric', page: 'https://defillama.com/dexs', maxBytes: 4 * MB }),
  row({ n: 4, id: 'b:llama-stablecoins', name: 'DefiLlama stablecoins', url: 'https://stablecoins.llama.fi/stablecoins?includePrices=false', kind: 'json', reader: 'llama-stablecoins', cluster: 'stablecoins', group: 'defillama', defaultKind: 'metric', page: 'https://defillama.com/stablecoins' }),
  row({ n: 5, id: 'b:llama-hacks', name: 'DefiLlama hacks', url: 'https://api.llama.fi/hacks', kind: 'json', reader: 'llama-hacks', cluster: 'security', group: 'defillama', entities: ['security'], defaultKind: 'incident', page: 'https://defillama.com/hacks' }),
  row({ n: 6, id: 'b:l2beat-summary', name: 'L2BEAT summary', url: 'https://l2beat.com/api/scaling/summary', kind: 'json', reader: 'l2beat-summary', cluster: 'l2', group: 'l2beat', defaultKind: 'metric', page: 'https://l2beat.com/scaling/summary' }),
  row({ n: 7, id: 'b:growthepie', name: 'growthepie', url: 'https://api.growthepie.xyz/v1/fundamentals.json', kind: 'json', reader: 'growthepie', cluster: 'l2', group: 'growthepie', defaultKind: 'metric', page: 'https://www.growthepie.xyz/fundamentals', hosts: ['www.growthepie.xyz', 'www.growthepie.com'], maxBytes: 6 * MB }),
  row({ n: 8, id: 'b:x402-catalogue', name: 'CDP x402 catalogue', url: 'https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?type=http&limit=1', kind: 'json', reader: 'x402-catalogue', cluster: 'x402', group: 'coinbase', officialFor: ['x402'], entities: ['x402'], defaultKind: 'metric', page: 'https://www.x402.org' }),
  row({ n: 9, id: 'b:coingecko', name: 'CoinGecko public API', url: 'https://api.coingecko.com/api/v3/ping', kind: 'json', cluster: 'data', group: 'coingecko', defaultKind: 'metric', read: false, reason: 'a ping carries nothing to record, and market caps of entities are not read in this stage' }),
  row({ n: 10, id: 'b:base-blog', name: 'Base blog', url: 'https://blog.base.org/', kind: 'html', reader: 'links', cluster: 'base', group: 'coinbase', officialFor: ['base'], entities: ['base'], defaultKind: 'statement', hosts: ['blog.base.dev'] }),
  row({ n: 11, id: 'b:base-docs', name: 'Base docs', url: 'https://docs.base.org/', kind: 'html', reader: 'links', cluster: 'base', group: 'coinbase', officialFor: ['base'], entities: ['base'], defaultKind: 'product' }),
  row({ n: 12, id: 'b:base-status', name: 'Base status', url: 'https://status.base.org/history.rss', kind: 'feed', cluster: 'base', group: 'coinbase', officialFor: ['base'], entities: ['base'], defaultKind: 'outage', hosts: ['base-l2.statuspage.io'] }),
  row({ n: 13, id: 'b:base-node', name: 'Base node releases', url: github('base/node'), kind: 'feed', cluster: 'base', group: 'coinbase', officialFor: ['base'], entities: ['base'], defaultKind: 'release' }),
  row({ n: 14, id: 'b:op-stack', name: 'OP Stack releases', url: github('ethereum-optimism/optimism'), kind: 'feed', cluster: 'l2', group: 'optimism', officialFor: ['optimism'], entities: ['optimism'], defaultKind: 'release' }),
  row({ n: 15, id: 'b:x402-releases', name: 'x402 releases', url: github('coinbase/x402'), kind: 'feed', cluster: 'x402', group: 'coinbase', officialFor: ['x402'], entities: ['x402'], defaultKind: 'release' }),
  row({ n: 16, id: 'b:x402-site', name: 'x402 site', url: 'https://www.x402.org/', kind: 'html', reader: 'links', cluster: 'x402', group: 'coinbase', officialFor: ['x402'], entities: ['x402'], defaultKind: 'product' }),
  row({ n: 17, id: 'b:agentkit', name: 'AgentKit releases', url: github('coinbase/agentkit'), kind: 'feed', cluster: 'agents', group: 'coinbase', officialFor: ['agentkit'], entities: ['agentkit'], defaultKind: 'release' }),
  row({ n: 18, id: 'b:cdp-docs', name: 'CDP docs', url: 'https://docs.cdp.coinbase.com/', kind: 'html', reader: 'links', cluster: 'base', group: 'coinbase', officialFor: ['coinbase'], entities: ['coinbase'], defaultKind: 'product' }),
  row({ n: 19, id: 'b:uniswap-v4', name: 'Uniswap v4 releases', url: github('Uniswap/v4-core'), kind: 'feed', cluster: 'defi', group: 'uniswap', officialFor: ['uniswap'], entities: ['uniswap'], defaultKind: 'release' }),
  row({ n: 20, id: 'b:elizaos', name: 'elizaOS releases', url: github('elizaOS/eliza'), kind: 'feed', cluster: 'agents', group: 'elizaos', officialFor: ['elizaos'], entities: ['elizaos'], defaultKind: 'release' }),
  row({ n: 21, id: 'b:mcp', name: 'MCP releases', url: github('modelcontextprotocol/modelcontextprotocol'), kind: 'feed', cluster: 'agents', group: 'mcp', officialFor: ['mcp'], entities: ['mcp'], defaultKind: 'release' }),
  row({ n: 22, id: 'b:ethereum-blog', name: 'Ethereum blog', url: 'https://blog.ethereum.org/feed.xml', kind: 'feed', cluster: 'ethereum', group: 'ethereum-foundation', officialFor: ['ethereum'], entities: ['ethereum'], defaultKind: 'statement' }),
  row({ n: 23, id: 'b:geth', name: 'geth releases', url: github('ethereum/go-ethereum'), kind: 'feed', cluster: 'ethereum', group: 'ethereum-foundation', officialFor: ['geth'], entities: ['geth'], defaultKind: 'release' }),
  row({ n: 24, id: 'b:reth', name: 'reth releases', url: github('paradigmxyz/reth'), kind: 'feed', cluster: 'ethereum', group: 'paradigm', officialFor: ['reth'], entities: ['reth'], defaultKind: 'release' }),
  row({ n: 25, id: 'b:eth-magicians', name: 'Ethereum Magicians', url: 'https://ethereum-magicians.org/latest.rss', kind: 'feed', cluster: 'ethereum', group: 'ethereum-magicians', entities: ['ethereum'], defaultKind: 'governance' }),
  row({ n: 26, id: 'b:ethresearch', name: 'ethresear.ch', url: 'https://ethresear.ch/latest.rss', kind: 'feed', cluster: 'ethereum', group: 'ethresearch', entities: ['ethereum'], defaultKind: 'research' }),
  row({ n: 27, id: 'b:erc-8004', name: 'ERC-8004', url: 'https://eips.ethereum.org/EIPS/eip-8004', kind: 'html', reader: 'watch', cluster: 'agents', group: 'ethereum-eips', officialFor: ['erc-8004'], entities: ['erc-8004'], defaultKind: 'governance', everyMin: REST, watch: { after: 'Status', values: ['Draft', 'Review', 'Last Call', 'Final', 'Stagnant', 'Withdrawn', 'Living'] } }),
  row({ n: 28, id: 'b:optimism-gov', name: 'Optimism governance', url: 'https://gov.optimism.io/latest.rss', kind: 'feed', cluster: 'governance', group: 'optimism', officialFor: ['optimism'], entities: ['optimism'], defaultKind: 'governance' }),
  row({ n: 29, id: 'b:arbitrum-gov', name: 'Arbitrum governance', url: 'https://forum.arbitrum.foundation/latest.rss', kind: 'feed', cluster: 'governance', group: 'arbitrum', officialFor: ['arbitrum'], entities: ['arbitrum'], defaultKind: 'governance' }),
  row({ n: 30, id: 'b:aave-gov', name: 'Aave governance', url: 'https://governance.aave.com/latest.rss', kind: 'feed', cluster: 'governance', group: 'aave', officialFor: ['aave'], entities: ['aave'], defaultKind: 'governance' }),
  row({ n: 31, id: 'b:uniswap-gov', name: 'Uniswap governance', url: 'https://gov.uniswap.org/latest.rss', kind: 'feed', cluster: 'governance', group: 'uniswap', officialFor: ['uniswap'], entities: ['uniswap'], defaultKind: 'governance' }),
  row({ n: 32, id: 'b:morpho-forum', name: 'Morpho forum', url: 'https://forum.morpho.org/latest.rss', kind: 'feed', cluster: 'governance', group: 'morpho', officialFor: ['morpho'], entities: ['morpho'], defaultKind: 'governance' }),
  row({ n: 33, id: 'b:lido-research', name: 'Lido research', url: 'https://research.lido.fi/latest.rss', kind: 'feed', cluster: 'governance', group: 'lido', officialFor: ['lido'], entities: ['lido'], defaultKind: 'governance' }),
  row({ n: 34, id: 'b:sec', name: 'SEC press releases', url: 'https://www.sec.gov/news/pressreleases.rss', kind: 'feed', cluster: 'regulators', group: 'sec', officialFor: ['sec'], entities: ['sec'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 35, id: 'b:cftc', name: 'CFTC press releases', url: 'https://www.cftc.gov/RSS/RSSGP/rssgp.xml', kind: 'feed', cluster: 'regulators', group: 'cftc', officialFor: ['cftc'], entities: ['cftc'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 36, id: 'b:federal-reserve', name: 'Federal Reserve', url: 'https://www.federalreserve.gov/feeds/press_all.xml', kind: 'feed', cluster: 'regulators', group: 'federal-reserve', officialFor: ['federal-reserve'], entities: ['federal-reserve'], defaultKind: 'regulation', needsTopic: true }),
  // The note leaves the search term open ("conditions[term]=…"); `stablecoin` is the one that was tried and answered.
  row({ n: 37, id: 'b:federal-register', name: 'US Federal Register', url: 'https://www.federalregister.gov/api/v1/documents.json?conditions%5Bterm%5D=stablecoin&order=newest&per_page=20', kind: 'json', reader: 'federal-register', cluster: 'regulators', group: 'us-federal-register', officialFor: ['us-rules'], entities: ['us-rules', 'stablecoins'], defaultKind: 'regulation' }),
  row({ n: 38, id: 'b:us-treasury', name: 'US Treasury', url: 'https://home.treasury.gov/news/press-releases', kind: 'html', reader: 'links', cluster: 'regulators', group: 'us-treasury', officialFor: ['us-treasury'], entities: ['us-treasury'], defaultKind: 'regulation', needsTopic: true, paths: ['/news/press-releases/'] }),
  row({ n: 39, id: 'b:fca', name: 'UK FCA', url: 'https://www.fca.org.uk/news/rss.xml', kind: 'feed', cluster: 'regulators', group: 'fca', officialFor: ['fca'], entities: ['fca'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 40, id: 'b:esma', name: 'ESMA', url: 'https://www.esma.europa.eu/rss.xml', kind: 'feed', cluster: 'regulators', group: 'esma', officialFor: ['esma'], entities: ['esma'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 41, id: 'b:ecb', name: 'ECB', url: 'https://www.ecb.europa.eu/rss/press.html', kind: 'feed', cluster: 'regulators', group: 'ecb', officialFor: ['ecb'], entities: ['ecb'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 42, id: 'b:bis', name: 'BIS', url: 'https://www.bis.org/doclist/all_pressrels.rss', kind: 'feed', cluster: 'regulators', group: 'bis', officialFor: ['bis'], entities: ['bis'], defaultKind: 'regulation', needsTopic: true }),
  row({ n: 43, id: 'b:anthropic', name: 'Anthropic news', url: 'https://www.anthropic.com/news', kind: 'html', reader: 'links', cluster: 'ai-labs', group: 'anthropic', officialFor: ['anthropic'], entities: ['anthropic'], defaultKind: 'statement', paths: ['/news/'] }),
  row({ n: 44, id: 'b:openai', name: 'OpenAI news', url: 'https://openai.com/news/rss.xml', kind: 'feed', cluster: 'ai-labs', group: 'openai', officialFor: ['openai'], entities: ['openai'], defaultKind: 'statement' }),
  row({ n: 45, id: 'b:deepmind', name: 'Google DeepMind', url: 'https://deepmind.google/blog/rss.xml', kind: 'feed', cluster: 'ai-labs', group: 'google', officialFor: ['google-deepmind'], entities: ['google-deepmind'], defaultKind: 'statement' }),
  row({ n: 46, id: 'b:google-ai', name: 'Google AI', url: 'https://blog.google/technology/ai/rss/', kind: 'feed', cluster: 'ai-labs', group: 'google', officialFor: ['google'], entities: ['google'], defaultKind: 'statement' }),
  row({ n: 47, id: 'b:meta-ai', name: 'Meta AI', url: 'https://ai.meta.com/blog/', kind: 'html', reader: 'links', cluster: 'ai-labs', group: 'meta', officialFor: ['meta-ai'], entities: ['meta-ai'], defaultKind: 'statement', paths: ['/blog/'] }),
  row({ n: 48, id: 'b:mistral', name: 'Mistral', url: 'https://mistral.ai/news', kind: 'html', reader: 'links', cluster: 'ai-labs', group: 'mistral', officialFor: ['mistral'], entities: ['mistral'], defaultKind: 'statement', paths: ['/news/'] }),
  row({ n: 49, id: 'b:hugging-face', name: 'Hugging Face', url: 'https://huggingface.co/blog/feed.xml', kind: 'feed', cluster: 'ai-labs', group: 'hugging-face', officialFor: ['hugging-face'], entities: ['hugging-face'], defaultKind: 'statement' }),
  row({ n: 50, id: 'b:arxiv-cs-ai', name: 'arXiv cs.AI', url: 'https://arxiv.org/rss/cs.AI', kind: 'feed', cluster: 'ai-research', group: 'arxiv', defaultKind: 'research', needsTopic: true }),
  row({ n: 51, id: 'b:simon-willison', name: 'Simon Willison', url: 'https://simonwillison.net/atom/everything/', kind: 'feed', cluster: 'ai-research', group: 'simon-willison', defaultKind: 'research', needsTopic: true }),
  row({ n: 52, id: 'b:x-changelog', name: 'X API changelog', url: 'https://docs.x.com/changelog', kind: 'html', reader: 'watch', cluster: 'x', group: 'x', officialFor: ['x-api'], entities: ['x-api'], defaultKind: 'product' }),
  row({ n: 53, id: 'b:x-dev-forum', name: 'X developer forum', url: 'https://devcommunity.x.com/latest.rss', kind: 'feed', cluster: 'x', group: 'x-dev-forum', entities: ['x-api'], defaultKind: 'statement' }),
  row({ n: 54, id: 'b:circle', name: 'Circle blog', url: 'https://www.circle.com/blog', kind: 'html', reader: 'links', cluster: 'stablecoins', group: 'circle', officialFor: ['circle', 'usdc'], entities: ['circle'], defaultKind: 'statement', paths: ['/blog/'] }),
  row({ n: 55, id: 'b:tether', name: 'Tether news', url: 'https://tether.io/news/', kind: 'html', reader: 'links', cluster: 'stablecoins', group: 'tether', officialFor: ['tether', 'usdt'], entities: ['tether'], defaultKind: 'statement', paths: ['/news/'] }),
  row({ n: 56, id: 'b:stripe', name: 'Stripe blog', url: 'https://stripe.com/blog/feed.rss', kind: 'feed', cluster: 'payments', group: 'stripe', officialFor: ['stripe'], entities: ['stripe'], defaultKind: 'statement', needsTopic: true }),
  row({ n: 57, id: 'b:rekt', name: 'rekt', url: 'https://rekt.news/', kind: 'html', reader: 'links', cluster: 'security', group: 'rekt', entities: ['security'], defaultKind: 'incident' }),
  row({ n: 58, id: 'b:a16z-crypto', name: 'a16z crypto', url: 'https://a16zcrypto.com/feed/', kind: 'feed', cluster: 'research', group: 'a16z', officialFor: ['a16z-crypto'], entities: ['a16z-crypto'], defaultKind: 'research' }),
  row({ n: 59, id: 'b:vitalik', name: "Vitalik's blog", url: 'https://vitalik.eth.limo/feed.xml', kind: 'feed', cluster: 'ethereum', group: 'vitalik', entities: ['vitalik'], defaultKind: 'research' }),
  row({ n: 60, id: 'b:bankr-docs', name: 'Bankr docs', url: 'https://docs.bankr.bot/', kind: 'html', reader: 'links', cluster: 'launchpads', group: 'bankr', officialFor: ['bankr'], entities: ['bankr'], defaultKind: 'product' }),
  row({ n: 61, id: 'b:clanker-docs', name: 'Clanker docs', url: 'https://clanker.gitbook.io/', kind: 'html', reader: 'links', cluster: 'launchpads', group: 'clanker', officialFor: ['clanker'], entities: ['clanker'], defaultKind: 'product' }),
  row({ n: 62, id: 'b:clanker-site', name: 'Clanker site', url: 'https://www.clanker.world/', kind: 'html', reader: 'links', cluster: 'launchpads', group: 'clanker', officialFor: ['clanker'], entities: ['clanker'], defaultKind: 'product', read: false, reason: 'the page is a live list of coins launched through Clanker: its links are coins, which lie outside the scope' }),
  row({ n: 63, id: 'b:virtuals', name: 'Virtuals whitepaper', url: 'https://whitepaper.virtuals.io/', kind: 'html', reader: 'links', cluster: 'agents', group: 'virtuals', officialFor: ['virtuals'], entities: ['virtuals'], defaultKind: 'product' }),
  row({ n: 64, id: 'b:coindesk', name: 'CoinDesk', url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', kind: 'feed', cluster: 'news', group: 'coindesk', defaultKind: 'statement', needsTopic: true }),
  row({ n: 65, id: 'b:the-block', name: 'The Block', url: 'https://www.theblock.co/rss.xml', kind: 'feed', cluster: 'news', group: 'the-block', defaultKind: 'statement', needsTopic: true }),
  row({ n: 66, id: 'b:decrypt', name: 'Decrypt', url: 'https://decrypt.co/feed', kind: 'feed', cluster: 'news', group: 'decrypt', defaultKind: 'statement', needsTopic: true }),
  row({ n: 67, id: 'b:cointelegraph', name: 'Cointelegraph', url: 'https://cointelegraph.com/rss', kind: 'feed', cluster: 'news', group: 'cointelegraph', defaultKind: 'statement', needsTopic: true }),
  row({ n: 68, id: 'b:blockworks', name: 'Blockworks', url: 'https://blockworks.co/feed', kind: 'feed', cluster: 'news', group: 'blockworks', defaultKind: 'statement', needsTopic: true }),
  row({ n: 69, id: 'b:dl-news', name: 'DL News', url: 'https://www.dlnews.com/arc/outboundfeeds/rss/', kind: 'feed', cluster: 'news', group: 'dl-news', defaultKind: 'statement', needsTopic: true }),
  row({ n: 70, id: 'b:the-defiant', name: 'The Defiant', url: 'https://thedefiant.io/api/feed', kind: 'feed', cluster: 'news', group: 'the-defiant', defaultKind: 'statement', needsTopic: true }),
  row({ n: 71, id: 'b:techcrunch', name: 'TechCrunch', url: 'https://techcrunch.com/feed/', kind: 'feed', cluster: 'news', group: 'techcrunch', defaultKind: 'statement', needsTopic: true }),
  row({ n: 72, id: 'b:l2beat-pages', name: 'L2BEAT pages', url: 'https://l2beat.com/scaling/summary', kind: 'html', cluster: 'l2', group: 'l2beat', defaultKind: 'metric', read: false, reason: 'the reading behind row 6: it is the link of that source’s records, not a second source' }),
];

/** The sources of layer a: Bootr's own index and the supervisor's own tables. They are official for Bootr. */
export const CHAIN_SOURCES = [
  { id: 'a:indexer', name: 'Bootr indexer', cluster: 'bootr', group: 'bootr', officialFor: ['bootr'] },
  { id: 'a:supervisor', name: 'Bootr supervisor', cluster: 'bootr', group: 'bootr', officialFor: ['bootr'] },
] as const;

export const SOURCE_BY_ID: ReadonlyMap<string, OpenSource> = new Map(OPEN_SOURCES.map((s) => [s.id, s]));

const hostOf = (url: string): string => new URL(url).hostname.toLowerCase();

/**
 * Every host a record may link to: the hosts of the listed URLs, their pages and their declared link hosts, without
 * `www.`. A link anywhere else is dropped before it is stored (clean.ts `canonicalLink`).
 */
export const LINK_HOSTS: ReadonlySet<string> = new Set(
  OPEN_SOURCES.flatMap((s) => [hostOf(s.url), ...(s.page ? [hostOf(s.page)] : []), ...(s.hosts ?? [])]).flatMap((h) => [h, h.replace(/^www\./, '')]).concat(['bootr.fun', 'basescan.org']),
);
