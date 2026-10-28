import type { Metadata } from 'next';
import { notFound, permanentRedirect } from 'next/navigation';
import { DocArticle } from '@/components/docs/DocArticle';
import { DOC_PAGES, DOC_REDIRECTS, docMetadata, docPage, type DocSlug } from '@/components/docs/pages';

export function generateStaticParams() {
  return [...DOC_PAGES.filter((p) => p.slug).map((p) => ({ slug: p.slug })), ...Object.keys(DOC_REDIRECTS).map((slug) => ({ slug }))];
}

export async function generateMetadata({ params }: PageProps<'/docs/[slug]'>): Promise<Metadata> {
  const { slug } = await params;
  return docPage(slug) ? docMetadata(slug as DocSlug) : {};
}

export default async function DocPage({ params }: PageProps<'/docs/[slug]'>) {
  const { slug } = await params;
  const moved = DOC_REDIRECTS[slug];
  if (moved) permanentRedirect(moved);
  if (!slug || !docPage(slug)) notFound();
  return <DocArticle slug={slug as DocSlug} />;
}
