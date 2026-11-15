/**
 * The entity list of the dataset (docs/design/agent-behaviour.md section 6.4): the names a record can be about, each
 * with the spellings it is recognised by. Hand-kept and checked in: only a commit changes it. An id is what a record
 * stores, what a source is "official for" (sources.ts) and, in a later stage, what a creator picks as a topic.
 *
 * An alias is matched as whole words, without regard to case. An alias that starts with `=` is matched with its case
 * as written, for names that are also plain words ("Base", "Optimism", "Eco"); such a name gets the plain word only in
 * a phrase that cannot mean anything else ("on Base", "Base mainnet"), and a source that is about one entity says so
 * itself (`entities` in sources.ts), so its items carry the entity whatever their titles say.
 *
 * The note speaks of about 300 names; this list holds the ones the sources of section 6.7 and the first-tier accounts
 * of section 6.6 are about. It grows by commits as records show which names are missing.
 */
export interface Entity {
  id: string;
  aliases: readonly string[];
}

export const ENTITIES: readonly Entity[] = [
  // Home ground: Base, agents, agent payments, launchpads, Bootr
  { id: 'base', aliases: ['on base', 'base mainnet', 'base sepolia', 'base chain', 'base network', 'base l2', 'base app', 'base ecosystem', 'base node', 'base.org', '=Base Status', "=Base's", 'build on base', 'buildonbase'] },
  { id: 'coinbase', aliases: ['coinbase', 'coinbase developer platform', 'cdp sdk', '=CDP'] },
  { id: 'x402', aliases: ['x402', 'x402 bazaar', 'http 402', 'payment required protocol'] },
  { id: 'agentkit', aliases: ['agentkit', 'agent kit'] },
  { id: 'erc-8004', aliases: ['erc-8004', 'erc 8004', 'eip-8004', 'erc8004', 'trustless agents'] },
  { id: 'mcp', aliases: ['model context protocol', '=MCP'] },
  { id: 'a2a', aliases: ['agent2agent', 'a2a protocol', '=A2A'] },
  { id: 'agents', aliases: ['ai agent', 'ai agents', 'onchain agent', 'onchain agents', 'autonomous agent', 'autonomous agents', 'agentic', 'agent payments', 'agentic payments', 'agentic commerce'] },
  { id: 'elizaos', aliases: ['elizaos', 'eliza os', 'ai16z'] },
  { id: 'virtuals', aliases: ['virtuals protocol', 'virtuals', '=VIRTUAL'] },
  { id: 'clanker', aliases: ['clanker'] },
  { id: 'bankr', aliases: ['bankr', 'bankrbot'] },
  { id: 'zora', aliases: ['zora'] },
  { id: 'farcaster', aliases: ['farcaster', 'warpcast'] },
  { id: 'aerodrome', aliases: ['aerodrome'] },
  { id: 'pump-fun', aliases: ['pump.fun', 'pumpfun'] },
  { id: 'launchpads', aliases: ['launchpad', 'launchpads', 'token launcher', 'token launchpad'] },
  { id: 'bootr', aliases: ['bootr', 'bootr.fun'] },
  { id: 'aixbt', aliases: ['aixbt'] },
  { id: 'blockrun', aliases: ['blockrun'] },
  { id: 'payai', aliases: ['payai', 'payai network'] },
  { id: 'exa', aliases: ['=Exa', 'exa labs', 'exa search'] },
  { id: 'openrouter', aliases: ['openrouter'] },
  { id: 'eco', aliases: ['=Eco Protocol', 'eco.com'] },
  // Ethereum and the L2s
  { id: 'ethereum', aliases: ['ethereum', 'ethereum foundation', 'ethereum mainnet', '=EF'] },
  { id: 'eip', aliases: ['=EIP', '=EIPs', '=ERC', 'ethereum improvement proposal'] },
  { id: 'geth', aliases: ['geth', 'go-ethereum'] },
  { id: 'reth', aliases: ['reth'] },
  { id: 'optimism', aliases: ['op stack', 'op mainnet', 'optimism collective', 'optimism foundation', 'superchain', 'op labs', '=Optimism', 'op-node', 'op-geth', 'op-reth'] },
  { id: 'arbitrum', aliases: ['arbitrum', 'arbitrum one', 'arbitrum dao', 'offchain labs'] },
  { id: 'polygon', aliases: ['polygon pos', 'polygon labs', '=Polygon'] },
  { id: 'zksync', aliases: ['zksync', 'zk sync', 'matter labs'] },
  { id: 'starknet', aliases: ['starknet', 'starkware'] },
  { id: 'linea', aliases: ['linea'] },
  { id: 'scroll', aliases: ['=Scroll'] },
  { id: 'unichain', aliases: ['unichain'] },
  { id: 'ink', aliases: ['=Ink chain', 'inkonchain'] },
  { id: 'soneium', aliases: ['soneium'] },
  { id: 'world-chain', aliases: ['world chain', 'worldcoin', 'worldchain'] },
  { id: 'robinhood-chain', aliases: ['robinhood chain'] },
  { id: 'robinhood', aliases: ['robinhood'] },
  { id: 'megaeth', aliases: ['megaeth'] },
  { id: 'l2beat', aliases: ['l2beat'] },
  { id: 'growthepie', aliases: ['growthepie'] },
  { id: 'layer2', aliases: ['layer 2', 'layer-2', 'layer 2s', 'rollup', 'rollups', '=L2', '=L2s'] },
  { id: 'eigenlayer', aliases: ['eigenlayer', 'eigen layer', 'eigencloud'] },
  { id: 'flashbots', aliases: ['flashbots'] },
  // Other L1s
  { id: 'bitcoin', aliases: ['bitcoin', '=BTC'] },
  { id: 'solana', aliases: ['solana', '=SOL'] },
  { id: 'bnb-chain', aliases: ['bnb chain', 'bsc', 'binance smart chain'] },
  { id: 'avalanche', aliases: ['avalanche', 'ava labs'] },
  { id: 'sui', aliases: ['=Sui', 'mysten labs'] },
  { id: 'aptos', aliases: ['aptos'] },
  { id: 'ton', aliases: ['toncoin', 'the open network', '=TON'] },
  { id: 'tron', aliases: ['=Tron', '=TRON'] },
  { id: 'near', aliases: ['near protocol', '=NEAR'] },
  { id: 'monad', aliases: ['monad'] },
  { id: 'hyperliquid', aliases: ['hyperliquid', 'hyperevm'] },
  { id: 'tempo', aliases: ['=Tempo'] },
  { id: 'plasma', aliases: ['=Plasma'] },
  { id: 'cosmos', aliases: ['=Cosmos', 'cosmos hub'] },
  // Stablecoins and payments
  { id: 'stablecoins', aliases: ['stablecoin', 'stablecoins', 'stable coin', 'stable coins'] },
  { id: 'usdc', aliases: ['usdc', 'usd coin'] },
  { id: 'circle', aliases: ['=Circle', 'circle internet'] },
  { id: 'usdt', aliases: ['usdt'] },
  { id: 'tether', aliases: ['tether'] },
  { id: 'paypal', aliases: ['paypal', 'pyusd'] },
  { id: 'stripe', aliases: ['stripe'] },
  { id: 'visa', aliases: ['=Visa'] },
  { id: 'mastercard', aliases: ['mastercard'] },
  { id: 'ethena', aliases: ['ethena', 'usde'] },
  { id: 'sky', aliases: ['makerdao', 'sky protocol', '=DAI', '=USDS'] },
  // DeFi
  { id: 'defi', aliases: ['defi', 'decentralized finance', 'decentralised finance'] },
  { id: 'uniswap', aliases: ['uniswap', 'uniswap v4', 'uniswap labs', 'uniswap foundation'] },
  { id: 'aave', aliases: ['aave'] },
  { id: 'morpho', aliases: ['morpho'] },
  { id: 'lido', aliases: ['lido', 'steth'] },
  { id: 'compound', aliases: ['compound finance', 'compound dao'] },
  { id: 'curve', aliases: ['curve finance', 'crvusd'] },
  { id: 'pendle', aliases: ['pendle'] },
  { id: 'jupiter', aliases: ['jupiter exchange', '=Jupiter'] },
  { id: 'chainlink', aliases: ['chainlink'] },
  { id: 'the-graph', aliases: ['the graph'] },
  { id: 'safe', aliases: ['safe wallet', 'gnosis safe', '=Safe{Wallet}'] },
  { id: 'metamask', aliases: ['metamask', 'consensys'] },
  { id: 'layerzero', aliases: ['layerzero'] },
  { id: 'wormhole', aliases: ['wormhole'] },
  { id: 'across', aliases: ['across protocol'] },
  // Exchanges
  { id: 'binance', aliases: ['binance'] },
  { id: 'kraken', aliases: ['kraken'] },
  { id: 'okx', aliases: ['okx'] },
  { id: 'bybit', aliases: ['bybit'] },
  { id: 'gemini', aliases: ['=Gemini exchange'] },
  // Data and analytics
  { id: 'defillama', aliases: ['defillama', 'defi llama'] },
  { id: 'dune', aliases: ['dune analytics'] },
  { id: 'nansen', aliases: ['nansen'] },
  { id: 'messari', aliases: ['messari'] },
  { id: 'token-terminal', aliases: ['token terminal'] },
  { id: 'coingecko', aliases: ['coingecko'] },
  { id: 'etherscan', aliases: ['etherscan', 'basescan'] },
  // Security
  { id: 'security', aliases: ['exploit', 'exploited', 'hack', 'hacked', 'drained', 'vulnerability', 'post-mortem', 'postmortem'] },
  { id: 'rekt', aliases: ['rekt.news', '=REKT'] },
  { id: 'slowmist', aliases: ['slowmist'] },
  { id: 'peckshield', aliases: ['peckshield'] },
  { id: 'certik', aliases: ['certik'] },
  { id: 'openzeppelin', aliases: ['openzeppelin'] },
  { id: 'trail-of-bits', aliases: ['trail of bits'] },
  { id: 'chainalysis', aliases: ['chainalysis'] },
  { id: 'seal-911', aliases: ['seal 911', 'security alliance'] },
  { id: 'zachxbt', aliases: ['zachxbt'] },
  // Regulators and policy
  { id: 'sec', aliases: ['=SEC', 'securities and exchange commission'] },
  { id: 'cftc', aliases: ['cftc', 'commodity futures trading commission'] },
  { id: 'federal-reserve', aliases: ['federal reserve', 'fomc', '=the Fed'] },
  { id: 'us-treasury', aliases: ['u.s. treasury', 'us treasury', 'treasury department', 'department of the treasury', 'ofac', 'fincen'] },
  { id: 'us-congress', aliases: ['u.s. senate', 'us senate', 'house financial services', 'senate banking', 'genius act', 'clarity act', 'market structure bill'] },
  { id: 'occ', aliases: ['=OCC', 'comptroller of the currency'] },
  { id: 'fdic', aliases: ['fdic'] },
  { id: 'fca', aliases: ['=FCA', 'financial conduct authority'] },
  { id: 'esma', aliases: ['esma'] },
  { id: 'mica', aliases: ['=MiCA', 'markets in crypto-assets'] },
  { id: 'ecb', aliases: ['=ECB', 'european central bank', 'digital euro'] },
  { id: 'bis', aliases: ['=BIS', 'bank for international settlements'] },
  { id: 'fatf', aliases: ['fatf'] },
  { id: 'us-rules', aliases: ['federal register', 'proposed rule', 'final rule'] },
  // AI labs and tools
  { id: 'anthropic', aliases: ['anthropic', 'claude'] },
  { id: 'openai', aliases: ['openai', 'chatgpt', 'gpt-5', 'gpt-4', 'codex'] },
  { id: 'google-deepmind', aliases: ['deepmind', 'google deepmind'] },
  { id: 'google', aliases: ['google ai', '=Gemini', 'google cloud', '=Google'] },
  { id: 'meta-ai', aliases: ['meta ai', '=Llama'] },
  { id: 'mistral', aliases: ['mistral ai', '=Mistral'] },
  { id: 'xai', aliases: ['=xAI', '=Grok'] },
  { id: 'hugging-face', aliases: ['hugging face', 'huggingface'] },
  { id: 'nvidia', aliases: ['nvidia'] },
  { id: 'microsoft', aliases: ['microsoft', 'copilot'] },
  { id: 'deepseek', aliases: ['deepseek'] },
  { id: 'perplexity', aliases: ['perplexity'] },
  { id: 'langchain', aliases: ['langchain', 'langgraph'] },
  { id: 'cursor', aliases: ['=Cursor'] },
  { id: 'llm', aliases: ['large language model', 'language models', '=LLM', '=LLMs', 'foundation model'] },
  // X as a platform for developers
  { id: 'x-api', aliases: ['x api', 'twitter api', 'x developer', 'x developers', 'developer platform'] },
  // Research and funds
  { id: 'a16z-crypto', aliases: ['a16z crypto', 'a16z'] },
  { id: 'paradigm', aliases: ['=Paradigm'] },
  { id: 'vitalik', aliases: ['vitalik', 'buterin'] },
  { id: 'arxiv', aliases: ['arxiv'] },
];

interface Compiled {
  id: string;
  insensitive: RegExp | null;
  sensitive: RegExp | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const edge = (aliases: string[], flags: string) => (aliases.length ? new RegExp(`(?<![\\p{L}\\p{N}])(?:${aliases.map(escape).join('|')})(?![\\p{L}\\p{N}])`, flags) : null);

const COMPILED: readonly Compiled[] = ENTITIES.map((e) => ({
  id: e.id,
  insensitive: edge(e.aliases.filter((a) => !a.startsWith('=')), 'iu'),
  sensitive: edge(e.aliases.filter((a) => a.startsWith('=')).map((a) => a.slice(1)), 'u'),
}));

export const ENTITY_IDS: ReadonlySet<string> = new Set(ENTITIES.map((e) => e.id));
/** The most entities one sighting or record carries. */
export const ENTITIES_MAX = 8;

/** The ids of the entities `text` names, in list order, at most ENTITIES_MAX. `text` is cleaned text (clean.ts). */
export function entitiesOf(text: string): string[] {
  const out: string[] = [];
  for (const e of COMPILED) {
    if (out.length >= ENTITIES_MAX) break;
    if (e.insensitive?.test(text) || e.sensitive?.test(text)) out.push(e.id);
  }
  return out;
}
