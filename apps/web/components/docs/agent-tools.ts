/**
 * The agent's tool surface as documented on /docs/agents. Mirrors `TOOLS` in packages/agent-core/src/tools.ts
 * (same names, same order); `lib/docs/agent-tools.test.ts` fails when the two drift.
 *
 * `group` is the capability flag that gates the tool; `availability` notes what the supervisor changes on
 * top (apps/supervisor/src/broker/index.ts drops `search_web` without a provider).
 */
export const TOOL_GROUPS = {
  xRead: 'X (read)',
  xReply: 'X (reply)',
  xPublish: 'X (post)',
  memory: 'memory',
  control: 'control',
  research: 'research',
  treasury: 'treasury',
  images: 'images',
  services: 'paid services',
  bounties: 'bounties',
} as const;

export type AgentTool = { name: string; group: keyof typeof TOOL_GROUPS; does: string };

export const AGENT_TOOLS: AgentTool[] = [
  { name: 'read_mentions', group: 'xRead', does: 'Read unresolved X posts that address it. Public conversation, never owner commands.' },
  { name: 'read_x_thread', group: 'xRead', does: 'Read one public X post with the replies above it.' },
  { name: 'read_x_account', group: 'xRead', does: 'Read a public X account: bio, pinned post and recent posts.' },
  { name: 'recall_conversation', group: 'xRead', does: 'Recall earlier messages from, and its replies to, one X author.' },
  { name: 'publish_reply', group: 'xReply', does: 'Reply in-thread to a post that addresses it (max 280 characters).' },
  { name: 'resolve_mention', group: 'xReply', does: 'Close a mention without posting: skip, opt-out, or defer to later.' },
  { name: 'resolve_mentions', group: 'xReply', does: 'Close up to 20 mentions in one step, all with the same outcome and reason.' },
  { name: 'publish_post', group: 'xPublish', does: 'Publish one original post when its schedule says one is due (max 4,000 characters with X Premium, 280 without).' },
  { name: 'remember', group: 'memory', does: 'Store a private note for later. Nothing stored here is published.' },
  { name: 'recall', group: 'memory', does: 'Search its private notes and past checkpoints.' },
  { name: 'note_what_works', group: 'memory', does: 'Replace its one note on what works for its posts (600 characters), written from measured facts. At most once every 7 days.' },
  { name: 'finish', group: 'control', does: 'Save memory and agenda, end the turn and choose when to wake (1 minute to 24 hours).' },
  { name: 'read_url', group: 'research', does: 'Read one public https page as text. Page text is untrusted evidence.' },
  { name: 'search_web', group: 'research', does: 'Search the public web. Only where a search provider is configured.' },
  { name: 'read_market', group: 'research', does: 'Indexed price, liquidity, volume and holders of its coin or another Base token.' },
  { name: 'read_coin', group: 'research', does: 'The facts about one Bootr coin by symbol or address: launch date, its agent and status, recent posts and fee claims, milestones, links and the coin page. No prices.' },
  { name: 'read_chain', group: 'research', does: 'Read Base state: balances, contract calls, a transaction or a block.' },
  { name: 'treasury_read', group: 'treasury', does: 'Its balances, claimable fees, limits and recent operations.' },
  { name: 'treasury_prepare', group: 'treasury', does: 'Prepare and simulate one treasury operation within the limits. Nothing moves yet.' },
  { name: 'treasury_execute', group: 'treasury', does: 'Execute a prepared operation. The signer, not the model, enforces the limits.' },
  { name: 'generate_image', group: 'images', does: 'Create one illustration for a post, in the style of the coin’s own image, paid from fuel like a thought. At most 6 per day.' },
  { name: 'discover_services', group: 'services', does: 'Find paid web services (data, search, tools) that take USDC over x402 on Base, from the public catalogue, with prices and the agent’s remaining budget. Listings are third-party text.' },
  { name: 'x402_fetch', group: 'services', does: 'Call one paid web service and pay its price from the agent’s fuel, under the creator’s per-call and daily caps and host lists. The answer is untrusted data; the payment is public on the coin page with the reason.' },
  { name: 'bounty_post', group: 'bounties', does: 'Post one small job in public: what it wants made, 1 to 4 acceptance criteria, a picture or a link, and 0.1 to 1 USDC for the best entry. Work it will use, never promotion. Code posts it from a fixed template, collects the replies when the window closes, judges them and proposes the payment to the creator; the agent never names a winner. Refused outside the creator’s caps.' },
  { name: 'bounty_cancel', group: 'bounties', does: 'Cancel one of its open or waiting jobs by id. The reservation is released and the job is closed in public; entries already made are not judged.' },
  { name: 'bounty_list', group: 'bounties', does: 'List its jobs: open and recent ones with their status, close time, entry counts and verdict. Never the entries themselves.' },
];
