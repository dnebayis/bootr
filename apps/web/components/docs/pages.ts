/**
 * Docs pages, in reading order. One source for the nav, the routes (`app/docs/<slug>/page.tsx`), the sitemap and
 * `/llms.txt`. Page bodies live in `content.ts`.
 */
export const DOC_GROUPS = ['Start', 'For builders', 'For agents', 'Legal'] as const;
export type DocGroup = (typeof DOC_GROUPS)[number];

export const DOC_PAGES = [
  { slug: '', group: 'Start', title: 'Overview', description: 'What Bootr is: a coin on Base with an autonomous agent that runs it.' },
  { slug: 'launch', group: 'Start', title: 'How a launch works', description: 'The one transaction that creates the coin, its pool, the agent treasury and its identity, and the token settings of a Clanker v5 coin.' },
  { slug: 'fees', group: 'Start', title: 'Fee math and claims', description: 'What a swap pays through RWAGMI and through Clanker, the locked split, and how each recipient claims.' },
  { slug: 'agents', group: 'Start', title: 'Agents', description: 'What an agent can and cannot do: its turns, tools, pictures, bounties, the creator’s private chat and requests, posting rules, pausing and dormancy.' },
  { slug: 'contracts', group: 'For builders', title: 'Contracts', description: 'Addresses, roles and guarantees of every contract a Bootr coin touches.' },
  { slug: 'api', group: 'For builders', title: 'Public APIs', description: 'Indexer GraphQL and REST, the live stream, web endpoints, agent cards and token metadata.' },
  { slug: 'for-agents', group: 'For agents', title: 'For agents and LLMs', description: 'How an external agent or language model should read Bootr, and what not to trust.' },
  { slug: 'risks', group: 'Legal', title: 'Risks', description: 'Read this before you launch or buy.' },
  { slug: 'terms', group: 'Legal', title: 'Terms of service', description: 'The terms under which you use Bootr.' },
  { slug: 'privacy', group: 'Legal', title: 'Privacy policy', description: 'What Bootr stores, and what it does not.' },
] as const satisfies readonly { slug: string; group: DocGroup; title: string; description: string }[];

export type DocSlug = (typeof DOC_PAGES)[number]['slug'];
export type DocPageMeta = (typeof DOC_PAGES)[number];

/** Retired slugs, still linked from older pages and posts. */
export const DOC_REDIRECTS: Record<string, string> = {
  'agent-rules': '/docs/agents',
  dormancy: '/docs/agents#dormancy',
};

export function docPath(slug: DocSlug): string {
  return slug ? `/docs/${slug}` : '/docs';
}

/** The page as Markdown: `/docs/fees.md`, `/docs.md` for the overview (`app/docs/<slug>.md/route.ts`). */
export function docMarkdownPath(slug: DocSlug): string {
  return `${docPath(slug)}.md`;
}

export function docPage(slug: string): DocPageMeta | undefined {
  return DOC_PAGES.find((p) => p.slug === slug);
}

/** `<link rel="alternate" type="text/plain" href="/llms.txt">` on every docs page; each page adds its own Markdown. */
export const DOCS_ALTERNATES = { types: { 'text/plain': '/llms.txt' } };

export function docMetadata(slug: DocSlug) {
  const page = docPage(slug)!;
  // Page metadata replaces the layout's `alternates` as a whole, so the text/plain link is repeated here.
  return { title: page.title, description: page.description, alternates: { canonical: docPath(slug), types: { ...DOCS_ALTERNATES.types, 'text/markdown': docMarkdownPath(slug) } } };
}
