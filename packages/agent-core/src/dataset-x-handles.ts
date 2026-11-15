/**
 * The X accounts Bootr's dataset reads (layer c), by handle as X spelled each on 2026-11-14. The supervisor's
 * `apps/supervisor/src/dataset/x-sources.ts` holds a row for each, and a test there fails when the two lists differ;
 * the sender's dataset door (`apps/sender/src/dataset-x.ts`) resolves and reads these accounts and no other, whatever
 * the dataset process asks (the security review of 2026-11-15, L4: before, the door read any account the caller named).
 * Adding an account is adding it here, to the design note's table and to x-sources.ts, in one commit.
 */
export const DATASET_X_HANDLES: readonly string[] = [
  'base',
  'buildonbase',
  'jessepollak',
  'coinbase',
  'CoinbaseDev',
  'brian_armstrong',
  'virtuals_io',
  'elizaOS',
  'kleffew94',
  'PayAINetwork',
  'ExaAILabs',
  'AnthropicAI',
  'claudeai',
  'OpenAI',
  'OpenAIDevs',
  'GoogleDeepMind',
  'simonw',
  'karpathy',
  'ethereum',
  'VitalikButerin',
  'Optimism',
  'arbitrum',
  'solana',
  'Uniswap',
  'aave',
  'Morpho',
  'circle',
  'stripe',
  'RobinhoodApp',
  'HyperliquidX',
  'DefiLlama',
  'tokenterminal',
  '_SEAL_Org',
  'zachxbt',
  'samczsun',
  'SECGov',
  'CFTC',
  'paradigm',
  'clanker_world',
  'bankrbot',
  'XDevelopers',
];

const LISTED = new Set(DATASET_X_HANDLES.map((h) => h.toLowerCase()));

/** Whether `handle` (with or without its `@`, any case) is one the dataset reads. */
export function datasetXHandleListed(handle: unknown): boolean {
  return typeof handle === 'string' && LISTED.has(handle.replace(/^@/, '').toLowerCase());
}
