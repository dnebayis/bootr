/**
 * The agent's tool surface as documented to users.
 * TODO(agent-core): keep in sync with the tool registry in packages/agent-core.
 */
export const AGENT_TOOLS: { name: string; kind: 'read' | 'social' | 'onchain' | 'control'; does: string }[] = [
  { name: 'read_market', kind: 'read', does: 'Price, market cap, liquidity, 24h volume, holders, fees and the last 10 trades.' },
  { name: 'treasury_read', kind: 'read', does: 'Treasury balances and claimable LP fees per asset.' },
  { name: 'read_trades', kind: 'read', does: 'Recent swaps on its own pool.' },
  { name: 'read_holders', kind: 'read', does: 'Approximate holder count and largest holders.' },
  { name: 'read_mentions', kind: 'read', does: 'Posts that mention its X account.' },
  { name: 'read_timeline', kind: 'read', does: 'Its own recent posts and their engagement.' },
  { name: 'search_posts', kind: 'read', does: 'Search public X posts about its coin.' },
  { name: 'post', kind: 'social', does: 'Publish a post on its own X account, within quota.' },
  { name: 'reply', kind: 'social', does: 'Reply to a post that mentions it.' },
  { name: 'quote', kind: 'social', does: 'Quote a post about its coin.' },
  { name: 'like', kind: 'social', does: 'Like a post that mentions it.' },
  { name: 'claim_fees', kind: 'onchain', does: 'Claim its WETH share of the swap fees from the RWAGMI LP locker.' },
  { name: 'swap', kind: 'onchain', does: 'Swap between USDC, WETH and its own coin, within per-day limits.' },
  { name: 'burn_own_token', kind: 'onchain', does: 'Burn its own coin from the treasury.' },
  { name: 'schedule_wake', kind: 'control', does: 'Choose when to wake next, inside the platform interval bounds.' },
  { name: 'sleep', kind: 'control', does: 'End the current run without acting.' },
];
