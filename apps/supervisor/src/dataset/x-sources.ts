/**
 * The X accounts of the dataset's layer c: the 41 rows of docs/design/agent-behaviour.md section 6.6 that are marked
 * tier 1 ("read from day one"), exactly as that table has them. This file is the list: only a commit changes which
 * accounts Bootr reads, which organisation each counts for and what each may speak for.
 *
 * WHERE THE HANDLES COME FROM. Not from memory: 18 of 175 handles written from memory were wrong and three belonged to
 * strangers. Every `handle` and every `followers` figure here is the cell of the note's table, which was filled by
 * opening each profile on 2026-11-14, and test/dataset-x-sources.test.ts reads the note and fails when a row here
 * differs from it. A handle is added by adding it to the note's table first (opened, with its follower count) and then
 * here.
 *
 * A HANDLE IS A LABEL, NOT AN ADDRESS. An account is read by its X user id and never by its handle (a handle can be
 * renamed or taken by a stranger; the id cannot). The id is not in this file because it can only be learnt from X: it
 * is looked up once through the sender (one user read) and pinned in `sv_ds_sources` (x-pin.ts), and it is trusted only
 * when X spells the handle exactly as `handle` below and the account has at least half of `followers` (the three
 * handles that had changed hands on 2026-11-14 had 7, 0 and 535 followers). From then on the handle is only what the
 * id was last seen as.
 *
 *  - `group` is the organisation that counts once for independence, in the ids sources.ts uses, so that an account and
 *    the same organisation's blog are one voice: the note's `ef` is `ethereum-foundation` and its `llama` is
 *    `defillama` here. `noteGroup` is the note's cell as written ("–" = its own).
 *  - `officialFor` are the entity ids (entities.ts) the account may lift a record to grade 4 for, and only for a post
 *    that is about that entity: its own words name it, or it links a page of that entity's own listed source
 *    (x-build.ts). `noteOfficialFor` is the note's cell as written. A person's account (`person`, the rows the note
 *    marks "(person)" and the researchers) is official for nothing: it is that person speaking, however senior, and a
 *    record that only a person's account carries stays a report. The person still counts in the organisation's group,
 *    so the founder and the company are never two independent sources.
 *  - `entities` are carried by every post of the account for matching and for the scope; they never make a post
 *    official.
 *  - `needsTopic`: an account that also speaks of things outside the scope (a person, a regulator, a payments company,
 *    a broker): its posts are kept only when they name an entity of the list or the subject (build.ts `TOPIC`). An
 *    entity the account is official for does not count (Stripe names Stripe on every post); a person's `entities` do
 *    (Jesse Pollak naming Base is on the subject).
 *  - `tier` 1 = read from day one. Tiers 2 and 3 of the note are not in this file yet.
 */
import type { Cluster } from './types.js';

export interface XSource {
  /** The handle as X spelled it on 2026-11-14, without the `@`. */
  handle: string;
  /** The section of the note's table (A to P). */
  section: string;
  cluster: Cluster;
  group: string;
  noteGroup: string;
  officialFor: readonly string[];
  noteOfficialFor: string;
  entities: readonly string[];
  person?: boolean;
  needsTopic?: boolean;
  tier: 1;
  /** The note's "Followers" cell, as the profile page showed it on 2026-11-14. */
  followers: string;
}

const row = (r: Omit<XSource, 'tier'>): XSource => ({ ...r, tier: 1 });

export const X_SOURCES: readonly XSource[] = [
  row({ handle: 'base', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'Base', officialFor: ['base'], entities: ['base'], followers: '1.5M' }),
  row({ handle: 'buildonbase', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'Base (builders)', officialFor: ['base'], entities: ['base'], followers: '610.5K' }),
  row({ handle: 'jessepollak', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'Base (person)', officialFor: [], entities: ['base'], person: true, needsTopic: true, followers: '355K' }),
  row({ handle: 'coinbase', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'Coinbase', officialFor: ['coinbase'], entities: ['coinbase'], followers: '7.1M' }),
  row({ handle: 'CoinbaseDev', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'CDP, x402', officialFor: ['coinbase', 'x402'], entities: ['coinbase'], followers: '65K' }),
  row({ handle: 'brian_armstrong', section: 'A', cluster: 'base', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'Coinbase (person)', officialFor: [], entities: ['coinbase'], person: true, needsTopic: true, followers: '3.9M' }),
  row({ handle: 'virtuals_io', section: 'B', cluster: 'agents', group: 'virtuals', noteGroup: '–', noteOfficialFor: 'Virtuals', officialFor: ['virtuals'], entities: ['virtuals'], followers: '291K' }),
  row({ handle: 'elizaOS', section: 'B', cluster: 'agents', group: 'elizaos', noteGroup: 'elizaos', noteOfficialFor: 'elizaOS', officialFor: ['elizaos'], entities: ['elizaos'], followers: '137.5K' }),
  row({ handle: 'kleffew94', section: 'B', cluster: 'x402', group: 'coinbase', noteGroup: 'coinbase', noteOfficialFor: 'x402 (person)', officialFor: [], entities: ['x402'], person: true, needsTopic: true, followers: '11.5K' }),
  row({ handle: 'PayAINetwork', section: 'B', cluster: 'x402', group: 'payai', noteGroup: '–', noteOfficialFor: 'PayAI', officialFor: ['payai'], entities: ['payai'], followers: '24.8K' }),
  row({ handle: 'ExaAILabs', section: 'B', cluster: 'x402', group: 'exa', noteGroup: '–', noteOfficialFor: 'Exa', officialFor: ['exa'], entities: ['exa'], followers: '66.6K' }),
  row({ handle: 'AnthropicAI', section: 'C', cluster: 'ai-labs', group: 'anthropic', noteGroup: 'anthropic', noteOfficialFor: 'Anthropic', officialFor: ['anthropic'], entities: ['anthropic'], followers: '1.9M' }),
  row({ handle: 'claudeai', section: 'C', cluster: 'ai-labs', group: 'anthropic', noteGroup: 'anthropic', noteOfficialFor: 'Claude', officialFor: ['anthropic'], entities: ['anthropic'], followers: '2M' }),
  row({ handle: 'OpenAI', section: 'C', cluster: 'ai-labs', group: 'openai', noteGroup: 'openai', noteOfficialFor: 'OpenAI', officialFor: ['openai'], entities: ['openai'], followers: '5.5M' }),
  row({ handle: 'OpenAIDevs', section: 'C', cluster: 'ai-labs', group: 'openai', noteGroup: 'openai', noteOfficialFor: 'OpenAI (developers)', officialFor: ['openai'], entities: ['openai'], followers: '483K' }),
  row({ handle: 'GoogleDeepMind', section: 'C', cluster: 'ai-labs', group: 'google', noteGroup: 'google', noteOfficialFor: 'Google DeepMind', officialFor: ['google-deepmind'], entities: ['google-deepmind'], followers: '1.6M' }),
  row({ handle: 'simonw', section: 'D', cluster: 'ai-research', group: 'simon-willison', noteGroup: '–', noteOfficialFor: '', officialFor: [], entities: [], person: true, needsTopic: true, followers: '254.7K' }),
  row({ handle: 'karpathy', section: 'D', cluster: 'ai-research', group: 'karpathy', noteGroup: '–', noteOfficialFor: '', officialFor: [], entities: [], person: true, needsTopic: true, followers: '4.4M' }),
  row({ handle: 'ethereum', section: 'E', cluster: 'ethereum', group: 'ethereum-foundation', noteGroup: 'ef', noteOfficialFor: 'Ethereum', officialFor: ['ethereum'], entities: ['ethereum'], followers: '4.5M' }),
  row({ handle: 'VitalikButerin', section: 'E', cluster: 'ethereum', group: 'ethereum-foundation', noteGroup: 'ef', noteOfficialFor: 'Ethereum (person)', officialFor: [], entities: ['ethereum', 'vitalik'], person: true, needsTopic: true, followers: '7.9M' }),
  row({ handle: 'Optimism', section: 'E', cluster: 'l2', group: 'optimism', noteGroup: '–', noteOfficialFor: 'Optimism', officialFor: ['optimism'], entities: ['optimism'], followers: '719.5K' }),
  row({ handle: 'arbitrum', section: 'E', cluster: 'l2', group: 'arbitrum', noteGroup: 'arbitrum', noteOfficialFor: 'Arbitrum', officialFor: ['arbitrum'], entities: ['arbitrum'], followers: '1.1M' }),
  row({ handle: 'solana', section: 'E', cluster: 'l1', group: 'solana', noteGroup: '–', noteOfficialFor: 'Solana', officialFor: ['solana'], entities: ['solana'], followers: '4.2M' }),
  row({ handle: 'Uniswap', section: 'F', cluster: 'defi', group: 'uniswap', noteGroup: 'uniswap', noteOfficialFor: 'Uniswap', officialFor: ['uniswap'], entities: ['uniswap'], followers: '1.4M' }),
  row({ handle: 'aave', section: 'F', cluster: 'defi', group: 'aave', noteGroup: 'aave', noteOfficialFor: 'Aave', officialFor: ['aave'], entities: ['aave'], followers: '702.1K' }),
  row({ handle: 'Morpho', section: 'F', cluster: 'defi', group: 'morpho', noteGroup: '–', noteOfficialFor: 'Morpho', officialFor: ['morpho'], entities: ['morpho'], followers: '140.8K' }),
  row({ handle: 'circle', section: 'G', cluster: 'stablecoins', group: 'circle', noteGroup: 'circle', noteOfficialFor: 'Circle, USDC', officialFor: ['circle', 'usdc'], entities: ['circle'], followers: '301.7K' }),
  row({ handle: 'stripe', section: 'G', cluster: 'payments', group: 'stripe', noteGroup: '–', noteOfficialFor: 'Stripe', officialFor: ['stripe'], entities: ['stripe'], needsTopic: true, followers: '296.8K' }),
  row({ handle: 'RobinhoodApp', section: 'H', cluster: 'exchanges', group: 'robinhood', noteGroup: 'robinhood', noteOfficialFor: 'Robinhood', officialFor: ['robinhood'], entities: ['robinhood'], needsTopic: true, followers: '1.3M' }),
  row({ handle: 'HyperliquidX', section: 'H', cluster: 'exchanges', group: 'hyperliquid', noteGroup: '–', noteOfficialFor: 'Hyperliquid', officialFor: ['hyperliquid'], entities: ['hyperliquid'], followers: '440.5K' }),
  row({ handle: 'DefiLlama', section: 'I', cluster: 'data', group: 'defillama', noteGroup: 'llama', noteOfficialFor: 'DefiLlama', officialFor: ['defillama'], entities: ['defillama'], followers: '371K' }),
  row({ handle: 'tokenterminal', section: 'I', cluster: 'data', group: 'token-terminal', noteGroup: '–', noteOfficialFor: 'Token Terminal', officialFor: ['token-terminal'], entities: ['token-terminal'], followers: '166.3K' }),
  row({ handle: '_SEAL_Org', section: 'J', cluster: 'security', group: 'seal', noteGroup: '–', noteOfficialFor: 'SEAL', officialFor: ['seal-911'], entities: ['seal-911'], followers: '21.7K' }),
  row({ handle: 'zachxbt', section: 'J', cluster: 'security', group: 'zachxbt', noteGroup: '–', noteOfficialFor: '–', officialFor: [], entities: ['zachxbt'], person: true, needsTopic: true, followers: '1.1M' }),
  row({ handle: 'samczsun', section: 'J', cluster: 'security', group: 'samczsun', noteGroup: '–', noteOfficialFor: '–', officialFor: [], entities: [], person: true, needsTopic: true, followers: '160.5K' }),
  row({ handle: 'SECGov', section: 'K', cluster: 'regulators', group: 'sec', noteGroup: '–', noteOfficialFor: 'US SEC', officialFor: ['sec'], entities: ['sec'], needsTopic: true, followers: '810.2K' }),
  row({ handle: 'CFTC', section: 'K', cluster: 'regulators', group: 'cftc', noteGroup: '–', noteOfficialFor: 'US CFTC', officialFor: ['cftc'], entities: ['cftc'], needsTopic: true, followers: '111.4K' }),
  row({ handle: 'paradigm', section: 'L', cluster: 'research', group: 'paradigm', noteGroup: 'paradigm', noteOfficialFor: 'Paradigm', officialFor: ['paradigm'], entities: ['paradigm'], followers: '1.6M' }),
  row({ handle: 'clanker_world', section: 'N', cluster: 'launchpads', group: 'clanker', noteGroup: 'clanker', noteOfficialFor: 'Clanker', officialFor: ['clanker'], entities: ['clanker'], followers: '36.4K' }),
  row({ handle: 'bankrbot', section: 'N', cluster: 'launchpads', group: 'bankr', noteGroup: '–', noteOfficialFor: 'Bankr', officialFor: ['bankr'], entities: ['bankr'], followers: '117.6K' }),
  row({ handle: 'XDevelopers', section: 'P', cluster: 'x', group: 'x', noteGroup: '–', noteOfficialFor: "X's developer platform", officialFor: ['x-api'], entities: ['x-api'], followers: '696.9K' }),
];

/** What a listed account is found by in `sv_ds_sources` (`state.listed`): its handle in lowercase. */
export const listedKey = (handle: string): string => handle.toLowerCase();

export const X_SOURCE_BY_KEY: ReadonlyMap<string, XSource> = new Map(X_SOURCES.map((s) => [listedKey(s.handle), s]));

/**
 * A follower figure as a profile page writes it (`1.5M`, `610.5K`, `4,870`) as a number, or null when it is not one.
 * The page rounds, so the number is the middle of what the page could have meant.
 */
export function followersOf(shown: string): number | null {
  const m = /^(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)([KM])?$/.exec(shown.trim());
  if (!m) return null;
  const n = Number(m[1]!.replace(/,/g, '')) * (m[2] === 'M' ? 1_000_000 : m[2] === 'K' ? 1_000 : 1);
  return Number.isFinite(n) ? Math.round(n) : null;
}
