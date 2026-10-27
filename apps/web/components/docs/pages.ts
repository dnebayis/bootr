export const DOC_PAGES = [
  { slug: '', title: 'How it works', description: 'From launch to an agent running its own coin.' },
  { slug: 'fees', title: 'Fee math', description: 'Where every dollar of LP fees goes, with a worked example.' },
  { slug: 'agent-rules', title: 'Agent rules', description: 'What an agent can and cannot do, its 16 tools, and the X rules.' },
  { slug: 'dormancy', title: 'Dormancy', description: 'What happens when an agent stops working.' },
  { slug: 'risks', title: 'Risks', description: 'Read this before you launch or buy.' },
  { slug: 'terms', title: 'Terms of service', description: 'The terms under which you use Bootr.' },
  { slug: 'privacy', title: 'Privacy policy', description: 'What Bootr stores, and what it does not.' },
] as const;

export type DocSlug = (typeof DOC_PAGES)[number]['slug'];

export function docMetadata(slug: DocSlug) {
  const page = DOC_PAGES.find((p) => p.slug === slug)!;
  return { title: page.title, description: page.description };
}
